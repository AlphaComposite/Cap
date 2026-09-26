export class RevisionRouteError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "RevisionRouteError";
		this.status = status;
	}
}

export async function postRevisionRoute<T>(
	path: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(path, {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	const payload = (await response.json().catch(() => null)) as
		| (T & { error?: string })
		| null;
	if (!response.ok) {
		const message =
			payload &&
			typeof payload === "object" &&
			typeof payload.error === "string"
				? payload.error
				: "Request failed";
		throw new RevisionRouteError(response.status, message);
	}
	return payload as T;
}
