import { describe, expect, it } from "vitest";
import { deletionPlan, originObjectPolicy } from "@/lib/origin-object-policy";

describe("origin object policy", () => {
	it("allows only the recorded private keys and no bucket wildcard", () => {
		const liveKey = "private/source/video1/opaquekey";
		const policy = originObjectPolicy("cap", [
			liveKey,
			"owner/video1/source/original.mp4",
			"private/rollback/video1/other",
		]);
		const encoded = JSON.stringify(policy);
		expect(encoded).not.toContain("cap/*");
		expect(encoded).not.toContain("*");
		expect(policy.Statement[0]?.Resource).toEqual([
			"arn:aws:s3:::cap/private/source/video1/opaquekey",
			"arn:aws:s3:::cap/private/rollback/video1/other",
		]);
		expect(policy.Statement[1]?.Condition?.StringEquals["s3:prefix"]).toEqual([
			liveKey,
			"private/rollback/video1/other",
		]);
		expect(encoded).not.toContain("original.mp4");
	});

	it("refuses a wildcard key", () => {
		expect(() =>
			originObjectPolicy("cap", ["private/source/video1/*"]),
		).toThrow(/wildcard/);
	});
});

describe("unversioned object deletion plan", () => {
	it("deletes the current object when ListObjectVersions omits VersionId", () => {
		expect(
			deletionPlan(
				[{ Key: "owner/video/source/original.mp4" }],
				"owner/video/source/original.mp4",
			),
		).toEqual({ versionIds: [], deleteCurrent: true });
		expect(
			deletionPlan(
				[{ Key: "owner/video/source/original.mp4", VersionId: "null" }],
				"owner/video/source/original.mp4",
			),
		).toEqual({ versionIds: [], deleteCurrent: true });
	});

	it("deletes by VersionId when versioning is on and does not add a marker", () => {
		expect(
			deletionPlan(
				[{ Key: "owner/video/source/original.mp4", VersionId: "v1" }],
				"owner/video/source/original.mp4",
			),
		).toEqual({ versionIds: ["v1"], deleteCurrent: false });
	});
});
