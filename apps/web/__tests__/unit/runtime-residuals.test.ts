// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Cause, Effect, Either, Exit, Layer, ManagedRuntime } from "effect";
import {
	act,
	type ComponentProps,
	createElement,
	createRef,
	type Ref,
	type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
	vi,
} from "vitest";
import { useComposedRefs } from "@/app/lib/compose-refs";
import type {
	MediaPlayerPlaybackSpeed,
	MediaPlayerSettings,
	MediaPlayerVolume,
} from "@/app/s/[videoId]/_components/video/media-player";
import EditLoading from "@/app/s/[videoId]/edit/loading";
import { useOpenEditor } from "../../hooks/use-open-editor";
import { makeUseEffectMutation } from "../../lib/effect-react-query";

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

const runtime = ManagedRuntime.make(Layer.empty);
const useMutation = makeUseEffectMutation(() => runtime);
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function renderHook<T>(hook: () => T) {
	let current!: T;
	function Probe() {
		current = hook();
		return null;
	}
	await act(async () => {
		root.render(
			createElement(QueryClientProvider, { client }, createElement(Probe)),
		);
	});
	return {
		get current() {
			return current;
		},
	};
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	client = new QueryClient({
		defaultOptions: { mutations: { retry: false, gcTime: 0 } },
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	vi.unstubAllGlobals();
});

describe("effect mutation runtime contract", () => {
	it.each([false, true] as const)(
		"projects failure callbacks with throwOnDefect=%s and awaits them",
		async (throwOnDefect) => {
			const failure = { tag: "typed" };
			const variables = { id: 7 };
			const context = { rollback: 4 };
			const order: string[] = [];
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const onError = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {
				order.push("error");
				await gate;
				order.push("released");
			});
			let settle!: () => void;
			const settledGate = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const onSettled = vi.fn<(...args: unknown[]) => Promise<void>>(
				async () => {
					order.push("settled");
					await settledGate;
				},
			);
			const perCall = vi.fn();
			const throwOnError = vi.fn(() => false);
			const view = await renderHook(() =>
				useMutation({
					throwOnDefect,
					throwOnError,
					mutationFn: (_variables: typeof variables) => Effect.fail(failure),
					onMutate: () => context,
					onError,
					onSettled,
				}),
			);
			let result!: Awaited<ReturnType<typeof view.current.mutateAsync>>;
			await act(async () => {
				const pending = view.current.mutateAsync(variables, {
					onError: perCall,
				});
				await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
				expect(order).toEqual(["error"]);
				expect(onSettled).not.toHaveBeenCalled();
				const [error, passedVariables, passedContext, trailing] = onError.mock
					.calls[0] as unknown as [
					unknown,
					unknown,
					unknown,
					{ client: QueryClient },
				];
				expect(throwOnDefect ? error === failure : Cause.isCause(error)).toBe(
					true,
				);
				expect(passedVariables).toBe(variables);
				expect(passedContext).toBe(context);
				expect(trailing.client).toBe(client);
				release();
				await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
				expect(perCall).not.toHaveBeenCalled();
				settle();
				result = await pending;
			});
			expect(order).toEqual(["error", "released", "settled"]);
			expect(onSettled.mock.calls[0]).toEqual([
				undefined,
				onError.mock.calls[0]?.[0],
				variables,
				context,
				expect.objectContaining({ client }),
			]);
			expect(Cause.isCause(perCall.mock.calls[0]?.[0])).toBe(true);
			expect(Exit.isFailure(result)).toBe(true);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(view.current.error).toBe(
				throwOnDefect ? failure : onError.mock.calls[0]?.[0],
			);
			expect(view.current.failureReason).toBe(view.current.error);
			expect(throwOnError).toHaveBeenCalledWith(view.current.error);
		},
	);

	it("keeps success callbacks and null settled error", async () => {
		const onSuccess = vi.fn();
		const onSettled = vi.fn();
		const view = await renderHook(() =>
			useMutation({
				mutationFn: (n: number) => Effect.succeed(n + 1),
				onSuccess,
				onSettled,
			}),
		);
		await act(async () => {
			expect(await view.current.mutateAsync(2)).toEqual(Exit.succeed(3));
		});
		expect(onSuccess).toHaveBeenCalledWith(
			3,
			2,
			undefined,
			expect.objectContaining({ client }),
		);
		expect(onSettled).toHaveBeenCalledWith(
			3,
			null,
			2,
			undefined,
			expect.objectContaining({ client }),
		);
	});

	it.each(["defect", "interrupt", "sync"] as const)(
		"does not expose %s as a typed error",
		async (kind) => {
			const onError = vi.fn();
			const onSettled = vi.fn();
			const throwOnError = vi.fn(() => false);
			const view = await renderHook(() =>
				useMutation({
					throwOnDefect: true,
					throwOnError,
					mutationFn: (): Effect.Effect<never, string> => {
						if (kind === "sync") throw new Error("sync");
						return kind === "defect" ? Effect.die("defect") : Effect.interrupt;
					},
					onError,
					onSettled,
				}),
			);
			await act(async () => {
				await view.current.mutateAsync(undefined);
				const mutation = client.getMutationCache().getAll()[0];
				if (!mutation) throw new Error("Missing mutation");
				expect(Cause.isCause(mutation.state.error)).toBe(true);
				const shouldThrow =
					"throwOnError" in mutation.options
						? mutation.options.throwOnError
						: undefined;
				expect(
					typeof shouldThrow === "function" &&
						shouldThrow(mutation.state.error),
				).toBe(true);
				root.render(null);
			});
			expect(onError).not.toHaveBeenCalled();
			expect(onSettled).not.toHaveBeenCalled();
			expect(throwOnError).not.toHaveBeenCalled();
		},
	);

	it.each(["defect", "interrupt", "sync"] as const)(
		"exposes a Cause for %s with throwOnDefect=false",
		async (kind) => {
			const onError = vi.fn();
			const onSettled = vi.fn();
			const view = await renderHook(() =>
				useMutation({
					mutationFn: () => {
						if (kind === "sync") throw new Error("sync");
						return kind === "defect" ? Effect.die("defect") : Effect.interrupt;
					},
					onError,
					onSettled,
				}),
			);
			await act(async () => {
				await view.current.mutateAsync(undefined);
			});
			const error = onError.mock.calls[0]?.[0];
			expect(Cause.isCause(error)).toBe(true);
			expect(onSettled.mock.calls[0]?.[1]).toBe(error);
			expect(Either.isRight(Cause.failureOrCause(error))).toBe(true);
		},
	);

	it.each([undefined, false])(
		"throws defects through React with throwOnError=%s when throwOnDefect=true",
		async (throwOnError) => {
			const view = await renderHook(() =>
				useMutation({
					throwOnDefect: true,
					throwOnError,
					mutationFn: () => Effect.die("defect"),
				}),
			);
			let caught: unknown;
			try {
				await act(async () => {
					await view.current.mutateAsync(undefined);
					await new Promise((resolve) => setTimeout(resolve, 10));
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toMatchObject({ _tag: "Die", defect: "defect" });
		},
	);

	it("preserves synchronous-throw escalation with a throwOnError predicate", async () => {
		const predicate = vi.fn(() => false);
		const view = await renderHook(() =>
			useMutation({
				mutationFn: () => {
					throw new Error("sync");
				},
				throwOnError: predicate,
			}),
		);
		let caught: unknown;
		try {
			await act(async () => {
				await view.current.mutateAsync(undefined);
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
		} catch (error) {
			caught = error;
		}
		expect(Cause.isCause(caught)).toBe(true);
		if (!Cause.isCause(caught) || !Cause.isDieType(caught))
			throw new Error("Expected a defect cause");
		expect(Cause.isUnknownException(caught.defect)).toBe(true);
		expect(predicate).not.toHaveBeenCalled();
	});

	it("returns adapter callback rejections unchanged to TanStack", async () => {
		const rejection = new Error("callback rejection");
		const failure = "typed";
		const view = await renderHook(() =>
			useMutation({
				throwOnDefect: true,
				mutationFn: (): Effect.Effect<number, string> => Effect.succeed(1),
				onError: () => Promise.reject(rejection),
				onSettled: (_data, error) =>
					error === null ? undefined : Promise.reject(rejection),
			}),
		);
		await act(async () => {
			await view.current.mutateAsync(undefined, { onSuccess: () => undefined });
			root.render(null);
		});
		const options = client
			.getMutationCache()
			.find<number, Cause.Cause<string>, void>({})?.options;
		if (!options) throw new Error("Missing mutation options");
		const args = [undefined, undefined, { client, meta: undefined }] as const;
		await expect(options.onError?.(Cause.fail(failure), ...args)).rejects.toBe(
			rejection,
		);
		await expect(
			options.onSettled?.(undefined, Cause.fail(failure), ...args),
		).rejects.toBe(rejection);
	});

	it("declares exposed callback and per-call Cause types", () => {
		expectTypeOf<
			Parameters<
				typeof useMutation<number, string, true, string, number>
			>[0]["onError"]
		>().toEqualTypeOf<
			| ((
					error: string,
					variables: number,
					context: unknown,
					trailing: {
						client: QueryClient;
						meta: Record<string, unknown> | undefined;
						mutationKey?: readonly unknown[];
					},
			  ) => unknown)
			| undefined
		>();
		type Result = ReturnType<
			typeof useMutation<number, string, true, string, number>
		>;
		type PerCall = NonNullable<Parameters<Result["mutate"]>[1]>;
		expectTypeOf<
			Parameters<NonNullable<PerCall["onError"]>>[0]
		>().toEqualTypeOf<Cause.Cause<string>>();
	});

	it("removes inherited unsupported control props without removing supported props", () => {
		type Volume = ComponentProps<typeof MediaPlayerVolume>;
		type Speed = ComponentProps<typeof MediaPlayerPlaybackSpeed>;
		type Settings = ComponentProps<typeof MediaPlayerSettings>;
		expectTypeOf<Extract<"asChild", keyof Volume>>().toEqualTypeOf<never>();
		expectTypeOf<Extract<"asChild", keyof Speed>>().toEqualTypeOf<never>();
		expectTypeOf<Extract<"asChild", keyof Settings>>().toEqualTypeOf<never>();
		expectTypeOf<Volume["orientation"]>().toEqualTypeOf<
			"horizontal" | "vertical" | undefined
		>();
		expectTypeOf<Speed["open"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<Settings["disabled"]>().toEqualTypeOf<boolean | undefined>();
	});
});

describe("three-ref memo and cleanup preservation", () => {
	it.each([0, 1, 2])(
		"updates ref %s independently without replacing its DOM owner",
		async (index) => {
			const cleanups = [vi.fn(), vi.fn(), vi.fn()];
			const refs = cleanups.map((cleanup) => vi.fn(() => cleanup));
			let composed: RefCallback<HTMLDivElement> | undefined;
			function Probe({ values }: { values: Ref<HTMLDivElement>[] }) {
				composed = useComposedRefs(values[0], values[1], values[2]);
				return createElement("div", { ref: composed });
			}
			await act(async () =>
				root.render(createElement(Probe, { values: refs })),
			);
			const node = container.firstChild;
			const initial = composed;
			await act(async () =>
				root.render(createElement(Probe, { values: [...refs] })),
			);
			expect(composed).toBe(initial);
			expect(refs.map((ref) => ref.mock.calls.length)).toEqual([1, 1, 1]);
			const replacement = createRef<HTMLDivElement>();
			const changed: Ref<HTMLDivElement>[] = [...refs];
			changed[index] = replacement;
			await act(async () =>
				root.render(createElement(Probe, { values: changed })),
			);
			expect(composed).not.toBe(initial);
			expect(container.firstChild).toBe(node);
			expect(replacement.current).toBe(node);
			for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
			await act(async () => root.render(null));
			expect(replacement.current).toBeNull();
		},
	);
});

describe("editor loading announcement and focus", () => {
	it("keeps the heading and actions outside the phrasing-only live output", async () => {
		await act(async () =>
			root.render(
				createElement(
					EditLoading,
					null,
					createElement("button", { type: "button" }, "Cancel"),
				),
			),
		);
		const main = container.querySelector("main");
		const output = main?.querySelector("output");
		expect(main?.hasAttribute("role")).toBe(false);
		expect(output?.getAttribute("aria-live")).toBe("polite");
		expect(output?.querySelector("h1, p, button, a")).toBeNull();
		expect(main?.querySelector("h1")?.textContent).toBe("Opening editor…");
		expect(main?.querySelector("button")?.closest("output")).toBeNull();
	});

	it("focuses the main landmark when opening and retains Cancel", async () => {
		let finish!: () => void;
		navigation.push.mockReturnValue(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
			configurable: true,
			value: vi.fn(),
		});
		Object.defineProperty(HTMLDialogElement.prototype, "close", {
			configurable: true,
			value: vi.fn(),
		});
		function Entry() {
			const { openEditor, openingOverlay } = useOpenEditor("video");
			return createElement(
				"div",
				null,
				createElement(
					"button",
					{ type: "button", onClick: openEditor },
					"Edit",
				),
				openingOverlay,
			);
		}
		await act(async () => root.render(createElement(Entry)));
		await act(async () => container.querySelector("button")?.click());
		expect(document.activeElement).toBe(
			document.querySelector("main[data-edit-opening-focus]"),
		);
		expect(document.querySelector("dialog output")?.textContent).toContain(
			"Opening editor…",
		);
		expect(document.querySelector("dialog button")?.textContent).toBe("Cancel");
		await act(async () => finish());
	});
});
