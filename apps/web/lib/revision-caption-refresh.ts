import { createHash } from "node:crypto";
import type { db } from "@cap/database";
import { editIntent, editRevision, revisionArtifactStatus, sourceObject, videoPublication, videos } from "@cap/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { loadStoredEditTranscript } from "@/lib/revision-publication";
import { deriveRevisionCaptions, requireV2Spec } from "@/lib/revision-publication-metadata";
import type { OriginClient } from "@/lib/revision-publication-origin";
import { captionsHaveCues } from "@/lib/source-prepare";

type Database = ReturnType<typeof db>;

export async function refreshCurrentRevisionCaptions(
  app: Database,
  id: string,
  origin: OriginClient,
): Promise<"ready" | "pending" | "unavailable"> {
  const vid = id as typeof videos.$inferSelect.id;
  const [video] = await app.select().from(videos).where(eq(videos.id, vid));
  const [publication] = await app.select().from(videoPublication).where(eq(videoPublication.videoId, vid));
  if (!video || !publication?.currentRevisionId) return "pending";
  const [revision] = await app.select().from(editRevision).where(and(eq(editRevision.videoId, vid),
    eq(editRevision.revisionId, publication.currentRevisionId)));
  const [source] = await app.select().from(sourceObject).where(eq(sourceObject.videoId, vid));
  if (!revision || revision.state !== "CURRENT" || publication.currentGeneration !== revision.generation ||
    !source || !/^[a-f0-9]{64}$/.test(source.sha256)) return "pending";
  const [intent] = await app.select().from(editIntent).where(and(eq(editIntent.videoId, vid),
    eq(editIntent.generation, revision.generation), eq(editIntent.intentId, revision.intentId)));
  if (!intent || intent.sourceId !== revision.sourceId) return "pending";
  const spec = requireV2Spec(intent.canonicalSpec);
  const existing = revision.metadataSnapshot?.captionsVtt ?? "";
  const unavailable = ["ERROR", "SKIPPED", "NO_AUDIO"].includes(video.transcriptionStatus ?? "");
  let vtt = existing;
  if (!captionsHaveCues(existing)) {
    const transcript = await loadStoredEditTranscript(app, id, spec);
    if (!transcript) return unavailable ? "unavailable" : "pending";
    vtt = deriveRevisionCaptions({transcript, nextSpec: spec}).vtt;
    if (!captionsHaveCues(vtt)) return unavailable ? "unavailable" : "pending";
    if (!origin.writeCaptions) throw new Error("caption-only origin operation is not configured");
    const written = await origin.writeCaptions({
      videoId: id, revisionId: revision.revisionId, intentId: revision.intentId, sourceId: revision.sourceId,
      generation: revision.generation, publicationEpoch: publication.publicationEpoch, policyEpoch: publication.policyEpoch,
      sourceSha256: source.sha256, captionsVtt: vtt,
    });
    if (written.sha256 !== createHash("sha256").update(vtt).digest("hex")) throw new Error("caption write hash did not match");
  }
  const artifact = await origin.fetchArtifact({videoId:id, revisionId:revision.revisionId, name:"captions.vtt", method:"GET"});
  if (artifact.status !== 200 || artifact.body.toString("utf8") !== vtt || !captionsHaveCues(artifact.body.toString("utf8"))) {
    throw new Error("caption readback did not match genuine cues");
  }
  const applied = await app.transaction(async tx => {
    await tx.select({id:videos.id}).from(videos).where(eq(videos.id,vid)).for("update");
    const [current] = await tx.select().from(videoPublication).where(eq(videoPublication.videoId,vid)).for("update");
    const [currentSource] = await tx.select().from(sourceObject).where(eq(sourceObject.videoId,vid));
    const [currentRevision] = await tx.select().from(editRevision).where(eq(editRevision.revisionId,revision.revisionId));
    if (!current || current.currentRevisionId !== revision.revisionId || current.currentGeneration !== revision.generation ||
      current.publicationEpoch !== publication.publicationEpoch || current.policyEpoch !== publication.policyEpoch ||
      current.generation !== publication.generation || currentSource?.sha256 !== source.sha256 || currentSource.liveKey !== source.liveKey ||
      currentRevision?.state !== "CURRENT" || currentRevision.sourceId !== revision.sourceId || currentRevision.intentId !== revision.intentId) return false;
    await tx.update(editRevision).set({metadataSnapshot: sql`JSON_SET(${editRevision.metadataSnapshot}, '$.captionsVtt', ${vtt})`})
      .where(and(eq(editRevision.videoId,vid),eq(editRevision.revisionId,revision.revisionId),eq(editRevision.state,"CURRENT")));
    await tx.insert(revisionArtifactStatus).values({revisionId:revision.revisionId,artifact:"captions",state:"READY",attempts:0})
      .onDuplicateKeyUpdate({set:{state:"READY",leaseUntil:null,heartbeatAt:new Date()}});
    return true;
  });
  return applied ? "ready" : "pending";
}
