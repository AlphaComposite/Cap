import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SignInView } from "./sign-in-view";

describe("popup server setup", () => {
	it.each([false, true])(
		"prompts for a server instead of signing in (pending=%s)",
		(authPending) => {
			const html = renderToStaticMarkup(
				createElement(SignInView, {
					configured: false,
					authPending,
					busy: false,
					onSignIn: vi.fn(),
				}),
			);
			expect(html).toContain("Set your Cap server URL");
			expect(html).toContain("Open Options");
			expect(html).not.toContain("Sign in to Cap");
			expect(html).not.toContain("Waiting for the Cap sign-in window");
		},
	);

	it("keeps sign-in for a configured server", () => {
		const html = renderToStaticMarkup(
			createElement(SignInView, {
				configured: true,
				authPending: false,
				busy: false,
				onSignIn: vi.fn(),
			}),
		);
		expect(html).toContain("Sign in to Cap");
		expect(html).not.toContain("Set your Cap server URL");
	});
});
