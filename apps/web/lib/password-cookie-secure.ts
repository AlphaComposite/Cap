export function passwordCookieSecure(webUrl: string): boolean {
	return new URL(webUrl).protocol === "https:";
}
