import { Cause, Exit } from "effect";

export type RpcDownloadPresentation =
	| { action: "save"; fileName: string; downloadUrl: string }
	| { action: "notice"; message: string }
	| { action: "error"; message: "Failed to get download URL" };

export type DashboardDownloadResult =
	| { kind: "preparing"; message: string }
	| { kind: "started" };

const DOWNLOAD_ERROR_FALLBACK = "Failed to download video - please try again.";

export function presentRpcDownload(
	result:
		| { _tag: "Some"; value: { fileName: string; downloadUrl: string } }
		| { _tag: "None" }
		| { _tag: "DownloadPreparingError"; message: string },
): RpcDownloadPresentation {
	if (result._tag === "DownloadPreparingError") {
		return { action: "notice", message: result.message };
	}
	if (result._tag === "None") {
		return { action: "error", message: "Failed to get download URL" };
	}
	return {
		action: "save",
		fileName: result.value.fileName,
		downloadUrl: result.value.downloadUrl,
	};
}

export function isDownloadPreparingError(
	error: unknown,
): error is { _tag: "DownloadPreparingError"; message: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		"_tag" in error &&
		error._tag === "DownloadPreparingError" &&
		"message" in error &&
		typeof error.message === "string"
	);
}

function isPreparingResult(
	value: unknown,
): value is { kind: "preparing"; message: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "preparing" &&
		"message" in value &&
		typeof value.message === "string"
	);
}

function isStartedResult(value: unknown): value is { kind: "started" } {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "started"
	);
}

function successValue(settled: unknown): unknown {
	if (Exit.isExit(settled) && Exit.isSuccess(settled)) return settled.value;
	return settled;
}

function nestedFailure(value: unknown, depth = 0): unknown {
	if (depth > 6 || value == null || typeof value !== "object") return value;
	if (isDownloadPreparingError(value)) return value;
	if (Exit.isExit(value) && Exit.isFailure(value)) {
		return nestedFailure(value.cause, depth + 1);
	}
	if (Cause.isCause(value)) {
		const failure = Cause.failureOption(value);
		if (failure._tag === "Some") return nestedFailure(failure.value, depth + 1);
		return value;
	}
	if ("_tag" in value && value._tag === "Fail" && "error" in value) {
		return nestedFailure(value.error, depth + 1);
	}
	return value;
}

function messageFrom(value: unknown) {
	if (value instanceof Error && value.message.length > 0) return value.message;
	if (
		typeof value === "object" &&
		value !== null &&
		"message" in value &&
		typeof value.message === "string" &&
		value.message.length > 0
	) {
		return value.message;
	}
	return DOWNLOAD_ERROR_FALLBACK;
}

export function readDashboardDownloadResult(
	settled: unknown,
): DashboardDownloadResult {
	const value = successValue(settled);
	if (isPreparingResult(value)) {
		return { kind: "preparing", message: value.message };
	}
	if (isStartedResult(value)) return { kind: "started" };
	const failure = nestedFailure(settled);
	if (isDownloadPreparingError(failure)) {
		return { kind: "preparing", message: failure.message };
	}
	throw new Error(messageFrom(failure));
}
