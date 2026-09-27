const ABORT_NAMES = new Set(["AbortError", "ResponseAborted"]);

function recordOf(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function looksAborted(value: unknown): boolean {
	const record = recordOf(value);
	if (!record) return false;
	const name = textOf(record.name);
	const code = textOf(record.code);
	const message = textOf(record.message);
	if (ABORT_NAMES.has(name) || ABORT_NAMES.has(code)) return true;
	if (code === "ABORT_ERR" || code === "ERR_ABORTED") return true;
	if (
		message === "ResponseAborted" ||
		message === "Request aborted" ||
		message.includes("The operation was aborted")
	) {
		return true;
	}
	return false;
}

function nextCause(value: unknown): unknown {
	const record = recordOf(value);
	if (!record) return undefined;
	if (record.cause !== undefined && record.cause !== value) return record.cause;
	if (record.error !== undefined && record.error !== value) return record.error;
	return undefined;
}

export function isAbortLike(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current && !seen.has(current); depth++) {
		if (looksAborted(current)) return true;
		seen.add(current);
		current = nextCause(current);
	}
	return false;
}

export function summarizeRevisionError(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current && !seen.has(current); depth++) {
		seen.add(current);
		const record = recordOf(current);
		if (!record) {
			parts.push(String(current).slice(0, 180));
			break;
		}
		const name = textOf(record.name) || textOf(record._tag) || "Error";
		const message = textOf(record.message)
			.replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]")
			.slice(0, 180);
		parts.push(message ? `${name}: ${message}` : name);
		current = nextCause(current);
	}
	return parts.join(" | ") || "unknown";
}
