import { videoUploads } from "@cap/database/schema";
import { describe, expect, it } from "vitest";

describe("video upload recovery schema", () => {
	it("defaults new uploads to an unused recovery budget without an active claim", () => {
		expect(videoUploads.recoveryAttemptCount.notNull).toBe(true);
		expect(videoUploads.recoveryAttemptCount.hasDefault).toBe(true);
		expect(videoUploads.recoveryAttemptCount.default).toBe(0);
		expect(videoUploads.recoveryClaimId.notNull).toBe(false);
		expect(videoUploads.recoveryClaimId.hasDefault).toBe(false);
		expect(videoUploads.recoveryLeaseExpiresAt.notNull).toBe(false);
		expect(videoUploads.recoveryLeaseExpiresAt.hasDefault).toBe(false);
	});
});
