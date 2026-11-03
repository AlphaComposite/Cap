"""Read-only editing workspace report; never an eviction authorization.

Usage: python3 scripts/retention-dry-run.py --root CACHE --now ISO8601 --output PRIVATE.json
       python3 scripts/retention-dry-run.py --self-test

Optional --facts is a trusted, operator-supplied JSON snapshot, not raw receipts:
{candidate, capturedAt, provenance: {source, queryShape}, videos: {videoId: facts}}.
Each video's facts may contain recordingCompletedAt, lifecycleEvents (all observed
recording/edit/draft timestamps), lifecycleComplete, identity, metadataSnapshot,
artifactState and attestations. No file mtime is an activity clock.
For eligibility, capturedAt must equal --now: historical zero-activity snapshots
cannot establish current quiescence. Identity includes the registered sourceSha256.
Attestations require candidate, binding, observedAt, evidence (a nonempty reference).
Binding is SHA256 of UTF-8 JSON {identity, metadataSnapshot}, sort_keys=True,
separators=(",", ":"), ensure_ascii=True, allow_nan=False. The snapshot must contain
the actual receipt and side snapshot passed to the EXISTING validators; this script
never reimplements them. Validator attestation names verifiedDownloadReceipt and
verifiedHlsReceipt, each exactly true, under attestations.validators. A separate
attestations.media must attest pinnedReadbackAndColdPlayback=true. Attestations.jobs
needs complete=true, unresolved=0; readers needs complete=true, active=0. Recovery
needs emptyWorkspaceReedit=true bound to the same source/namespace/encoder identity
(including cacheId, the exact mapped source directory name). Jobs completeness must
cover all outbox rows (including exhausted/expired leases), artifact work, uploads,
draft/prepare/publish revisions and nonterminal relocation, not only active leases.
Facts are assertions by the snapshot producer, not independently verified here.
No SELECT-only production snapshot or recovery proof is bundled. Missing facts HOLD.
All maps, metadata, edit instructions, captions, chapters, ranges, namespaces and
remote originals/durable media/versions are retained. Only the local original.mp4
working copy, mezz.mp4, packet index and PCM are enumerated as workspace files.
"""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from datetime import datetime, timedelta, timezone

CANDIDATE = "3e8caba82b5c4fed4d2f13737ed4e6b9732f3fd3"
DAYS = timedelta(days=14)
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
WORKSPACE = {"original.mp4", "mezz.mp4", "original.mp4.apackets.npz",
             "mezz.mp4.apackets.npz", "original.mp4.ppcm", "mezz.mp4.ppcm"}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("timestamp missing")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone missing")
    return parsed.astimezone(timezone.utc)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def open_directory(path):
    absolute = Path(os.path.abspath(path))
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in absolute.parts[1:]:
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def inventory(root):
    files, rejected, mappings = [], [], {}
    root_fd = open_directory(root)
    device = os.fstat(root_fd).st_dev

    def walk(fd, parts):
        try:
            names = sorted(os.listdir(fd))
        except OSError:
            rejected.append({"path": "/".join(parts), "reason": "directory_unreadable"})
            return
        for name in names:
            path = parts + [name]
            relative = "/".join(path)
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if info.st_dev != device:
                    rejected.append({"path": relative, "reason": "mount_boundary"})
                elif stat.S_ISDIR(info.st_mode):
                    child = os.open(name, DIR_FLAGS, dir_fd=fd)
                    try:
                        current = os.fstat(child)
                        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                            raise OSError("directory changed")
                        walk(child, path)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    workspace = len(path) == 3 and path[0] == "sources" and name in WORKSPACE
                    files.append({"path": relative, "device": info.st_dev, "inode": info.st_ino,
                                  "bytes": info.st_size, "links": info.st_nlink,
                                  "mtimeNs": info.st_mtime_ns, "workspace": workspace,
                                  "cacheId": path[1] if workspace else None})
                    if len(path) == 2 and path[0] == "by-video" and name.endswith(".json"):
                        video = name[:-5]
                        if not SAFE_ID.fullmatch(video) or info.st_size > 4096 or info.st_nlink != 1:
                            raise ValueError("mapping bounds")
                        mapping_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                        try:
                            opened = os.fstat(mapping_fd)
                            if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (
                                    info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
                                raise ValueError("mapping changed")
                            data = os.read(mapping_fd, 4097)
                            after = os.fstat(mapping_fd)
                            if len(data) > 4096 or after.st_mtime_ns != opened.st_mtime_ns:
                                raise ValueError("mapping changed")
                            cache = json.loads(data).get("cacheId")
                            if not isinstance(cache, str) or not SAFE_ID.fullmatch(cache):
                                raise ValueError("mapping cacheId")
                            mappings.setdefault(cache, set()).add(video)
                        finally:
                            os.close(mapping_fd)
                else:
                    rejected.append({"path": relative, "reason": "symlink_or_special_retained"})
            except (OSError, ValueError, TypeError, AttributeError):
                rejected.append({"path": relative, "reason": "unreadable_changed_or_invalid_retained"})

    try:
        walk(root_fd, [])
    finally:
        os.close(root_fd)
    return files, rejected, mappings


def evaluate(facts, snapshot, now):
    reasons = []
    anchor = None
    captured = None
    try:
        events = facts["lifecycleEvents"]
        if not isinstance(events, list):
            raise ValueError("lifecycle list required")
        anchor = max([timestamp(facts["recordingCompletedAt"])] + [timestamp(t) for t in events])
        if facts.get("lifecycleComplete") is not True or anchor > now:
            raise ValueError("lifecycle incomplete or future")
        age = anchor <= now - DAYS
    except (KeyError, ValueError, TypeError):
        age = None
        reasons.append("timestamp_unknown_or_incomplete")
    if age is False:
        reasons.append("younger_than_14_days")
    try:
        captured = timestamp(snapshot["capturedAt"])
        provenance = snapshot["provenance"]
        valid_snapshot = (snapshot["candidate"] == CANDIDATE and captured == now
                          and all(isinstance(provenance.get(key), str) and provenance[key]
                                  for key in ("source", "queryShape")))
        identity = facts["identity"]
        required = ("ownerId", "videoId", "revisionId", "generation", "sourceId", "sourceSha256",
                    "namespace", "encoderIdentity", "cacheId")
        if not all(key in identity and identity[key] is not None for key in required):
            raise ValueError("identity incomplete")
        binding = digest({"identity": identity, "metadataSnapshot": facts["metadataSnapshot"]})
    except (KeyError, ValueError, TypeError, AttributeError):
        valid_snapshot, binding = False, None

    def attested(name, fields):
        proof = facts.get("attestations", {}).get(name, {})
        try:
            return (valid_snapshot and proof.get("candidate") == CANDIDATE
                    and proof.get("binding") == binding
                    and isinstance(proof.get("evidence"), str) and bool(proof["evidence"])
                    and timestamp(proof["observedAt"]) == captured
                    and all(type(proof.get(k)) is type(v) and proof.get(k) == v for k, v in fields.items()))
        except (KeyError, ValueError, TypeError):
            return False

    gates = {
        "durability": facts.get("artifactState") == "READY" and attested("validators", {
            "verifiedDownloadReceipt": True, "verifiedHlsReceipt": True}) and attested("media", {
                "pinnedReadbackAndColdPlayback": True}),
        "recovery": attested("recovery", {"emptyWorkspaceReedit": True}),
        "jobs": attested("jobs", {"complete": True, "unresolved": 0}),
        "readers": attested("readers", {"complete": True, "active": 0}),
    }
    reasons.extend(f"{name}_unknown_or_unproved" for name, passed in gates.items() if not passed)
    source_fields = ("recordingCompletedAt", "lifecycleEvents", "lifecycleComplete", "identity",
                     "metadataSnapshot", "artifactState", "attestations")
    return {"anchor": anchor.isoformat() if anchor else None, "ageCandidate": age,
            "currentIdentity": facts.get("identity"), "gates": gates,
            "sourceFieldEvidence": {key: "supplied" if key in facts else "missing" for key in source_fields},
            "reasons": reasons, "eligible": not reasons, "deleteEnabled": False}


def report(root, now, snapshot=None):
    snapshot = snapshot or {}
    files, rejected, mappings = inventory(root)
    groups = {}
    for item in files:
        groups.setdefault((item["device"], item["inode"]), []).append(item)
    candidates, retained = [], []
    for aliases in groups.values():
        reasons = []
        if not all(item["workspace"] for item in aliases):
            retained.append(aliases)
            continue
        owners = set().union(*(mappings.get(item["cacheId"], set()) for item in aliases))
        if len(owners) != 1:
            reasons.append("ownership_unknown_or_shared")
        if any(item["links"] != 1 for item in aliases):
            reasons.append("hardlink_retained")
        if len({item["bytes"] for item in aliases}) != 1:
            reasons.append("inode_changed_during_scan")
        if rejected:
            reasons.append("inventory_incomplete_or_ambiguous")
        video = next(iter(owners)) if len(owners) == 1 else None
        facts = snapshot.get("videos", {}).get(video, {})
        evaluated = evaluate(facts, snapshot, now)
        if facts.get("identity", {}).get("videoId") != video:
            reasons.append("identity_video_binding_missing")
        if {item["cacheId"] for item in aliases} != {facts.get("identity", {}).get("cacheId")}:
            reasons.append("identity_cache_binding_missing")
        evaluated["reasons"].extend(reasons)
        evaluated["eligible"] = not evaluated["reasons"]
        candidates.append({"paths": [item["path"] for item in aliases],
                           "owners": sorted(owners), "bytes": max(item["bytes"] for item in aliases),
                           **evaluated})
    summary = {
        "regularPaths": len(files), "uniqueInodes": len(groups),
        "logicalBytes": sum(max(item["bytes"] for item in aliases) for aliases in groups.values()),
        "workspaceInodes": len(candidates), "workspaceBytes": sum(item["bytes"] for item in candidates),
        "retainedInodes": len(retained),
        "retainedBytes": sum(max(item["bytes"] for item in aliases) for aliases in retained),
        "ageCandidateInodes": sum(item["ageCandidate"] is True for item in candidates),
        "ageUnknownInodes": sum(item["ageCandidate"] is None for item in candidates),
        "eligibleInodes": sum(item["eligible"] for item in candidates),
        "eligibleBytes": sum(item["bytes"] for item in candidates if item["eligible"]),
        "mappedVideos": len(set().union(*mappings.values())) if mappings else 0,
        "rejectedEntries": len(rejected), "deleteEnabled": False,
    }
    return {"now": now.isoformat(), "cutoff": (now - DAYS).isoformat(), "candidate": CANDIDATE,
            "root": os.path.abspath(root), "summary": summary, "workspace": candidates,
            "retainedPaths": [item["path"] for aliases in retained for item in aliases],
            "rejected": rejected, "factsProvenance": snapshot.get("provenance"),
            "factsDigest": digest(snapshot) if snapshot else None,
            "limitations": ["Live non-atomic inventory, not an eviction authorization",
                            "Logical st_size bytes, not allocated or guaranteed reclaimable bytes",
                            "No remote requests or DB queries; supplied attestations are trusted inputs",
                            "No production reader/job counts inferred; all nonworkspace paths retained"]}


def self_test():
    now = timestamp("2026-11-03T12:00:00Z")
    old = (now - DAYS).isoformat()
    facts = {"recordingCompletedAt": old, "lifecycleEvents": [], "lifecycleComplete": True,
             "artifactState": "READY", "identity": {"ownerId": "owner", "videoId": "video0001",
             "revisionId": "rev", "generation": 1, "sourceId": "source", "namespace": "ns",
             "sourceSha256": "synthetic", "encoderIdentity": "encoder", "cacheId": "cache1"},
             "metadataSnapshot": {"downloadArtifact": "synthetic"}}
    snap = {"candidate": CANDIDATE, "capturedAt": now.isoformat(),
            "provenance": {"source": "synthetic self-test only", "queryShape": "fixture"}}
    binding = digest({"identity": facts["identity"], "metadataSnapshot": facts["metadataSnapshot"]})
    common = {"candidate": CANDIDATE, "binding": binding, "observedAt": now.isoformat(), "evidence": "synthetic"}
    facts["attestations"] = {key: {**common, **value} for key, value in {
        "validators": {"verifiedDownloadReceipt": True, "verifiedHlsReceipt": True},
        "media": {"pinnedReadbackAndColdPlayback": True}, "recovery": {"emptyWorkspaceReedit": True},
        "jobs": {"complete": True, "unresolved": 0}, "readers": {"complete": True, "active": 0}}.items()}
    assert evaluate(facts, snap, now)["eligible"]
    for seconds, expected in ((-1, False), (0, True), (1, True)):
        changed = {**facts, "recordingCompletedAt": (now - DAYS - timedelta(seconds=seconds)).isoformat()}
        assert evaluate(changed, snap, now)["eligible"] is expected
    assert not evaluate({**facts, "lifecycleEvents": [now.isoformat()]}, snap, now)["eligible"]
    assert not evaluate({**facts, "recordingCompletedAt": None}, snap, now)["eligible"]
    assert not evaluate({**facts, "lifecycleComplete": False}, snap, now)["eligible"]
    assert not evaluate({**facts, "attestations": {}}, snap, now)["eligible"]
    for name in facts["attestations"]:
        changed = copy.deepcopy(facts)
        del changed["attestations"][name]
        assert not evaluate(changed, snap, now)["eligible"]
    for name, field, value in (("validators", "verifiedDownloadReceipt", False),
                               ("validators", "verifiedHlsReceipt", False),
                               ("jobs", "unresolved", 1), ("readers", "active", 1)):
        changed = copy.deepcopy(facts)
        changed["attestations"][name][field] = value
        assert not evaluate(changed, snap, now)["eligible"]
    changed = copy.deepcopy(facts)
    changed["metadataSnapshot"]["chapters"] = "changed"
    assert not evaluate(changed, snap, now)["eligible"]
    assert not evaluate(facts, {**snap, "candidate": "wrong"}, now)["eligible"]
    assert not evaluate(facts, snap, now + timedelta(seconds=1))["eligible"]
    with tempfile.TemporaryDirectory(prefix="retention-", dir=os.environ.get("TMPDIR")) as temp:
        root = Path(temp) / "cache"
        source = root / "sources" / "cache1"
        source.mkdir(parents=True)
        (root / "by-video").mkdir()
        (root / "by-video" / "video0001.json").write_text('{"cacheId":"cache1"}')
        (source / "original.mp4").write_bytes(b"fixture")
        (source / "metadata.json").write_text("{}")
        snap["videos"] = {"video0001": facts}
        result = report(root, now, snap)
        assert result["summary"]["eligibleBytes"] == 7
        assert result["summary"]["logicalBytes"] == 29
        mismatch = copy.deepcopy(snap)
        mismatch["videos"]["video0001"]["identity"]["cacheId"] = "other"
        assert report(root, now, mismatch)["summary"]["eligibleBytes"] == 0
        os.link(source / "original.mp4", source / "mezz.mp4")
        result = report(root, now, snap)
        assert result["summary"]["logicalBytes"] == 29
        assert result["summary"]["workspaceBytes"] == 7
        assert result["summary"]["eligibleBytes"] == 0
        (root / "by-video" / "video0002.json").write_text('{"cacheId":"cache1"}')
        result = report(root, now, snap)
        assert "ownership_unknown_or_shared" in result["workspace"][0]["reasons"]
        (source / "escape").symlink_to(Path(temp))
        result = report(root, now, snap)
        assert result["summary"]["rejectedEntries"] == 1
        assert result["summary"]["eligibleBytes"] == 0
        assert not report(root, now)["summary"]["eligibleBytes"]
        (Path(temp) / "alias").symlink_to(root)
        try:
            inventory(Path(temp) / "alias")
        except OSError:
            pass
        else:
            raise AssertionError("symlink root accepted")
        os.link(source / "original.mp4", root / "retained-alias")
        assert report(root, now, snap)["summary"]["workspaceInodes"] == 0
    print("PASS: 14-day boundaries, recent-edit reset, missing/invalid attested proof, jobs/readers/recovery, identity binding, symlinks, hardlinks and shared ownership")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--root")
    parser.add_argument("--now")
    parser.add_argument("--output")
    parser.add_argument("--facts")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not all((args.root, args.now, args.output)):
        parser.error("--root, --now and --output are required")
    output = Path(args.output).absolute()
    if output.resolve().is_relative_to(Path(args.root).resolve()):
        parser.error("output must be outside cache")
    snapshot = json.loads(Path(args.facts).read_text()) if args.facts else None
    if snapshot is not None:
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("videos", {}), dict):
            parser.error("facts must be an object with a videos object")
        for facts in snapshot.get("videos", {}).values():
            if (not isinstance(facts, dict) or not isinstance(facts.get("identity", {}), dict)
                    or not isinstance(facts.get("attestations", {}), dict)
                    or not all(isinstance(proof, dict) for proof in facts.get("attestations", {}).values())):
                parser.error("each video's identity and attestations must be objects")
    result = report(args.root, timestamp(args.now), snapshot)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps(result["summary"], sort_keys=True))


if __name__ == "__main__":
    main()
