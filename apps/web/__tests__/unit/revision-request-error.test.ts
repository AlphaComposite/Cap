import { describe, expect, it } from "vitest";
import {
	isAbortLike,
	summarizeRevisionError,
} from "@/lib/revision-request-error";

describe("aborted revision reads", () => {
	it("treats AbortError and ResponseAborted as aborts, including a wrapped cause", () => {
		expect(
			isAbortLike(new DOMException("The operation was aborted.", "AbortError")),
		).toBe(true);
		expect(
			isAbortLike({ name: "ResponseAborted", message: "ResponseAborted" }),
		).toBe(true);
		expect(
			isAbortLike({
				name: "StorageError",
				message: "storage",
				cause: {
					name: "S3Error",
					cause: { name: "AbortError", message: "Request aborted" },
				},
			}),
		).toBe(true);
		expect(isAbortLike(new Error("database unavailable"))).toBe(false);
	});

	it("summarizes a cause without keeping long tokens", () => {
		const summary = summarizeRevisionError({
			name: "StorageError",
			message: "read failed",
			cause: {
				name: "AbortError",
				message: `token ${"a".repeat(40)}`,
			},
		});
		expect(summary).toContain("StorageError");
		expect(summary).toContain("AbortError");
		expect(summary).toContain("[redacted]");
		expect(summary).not.toContain("a".repeat(40));
	});
});
