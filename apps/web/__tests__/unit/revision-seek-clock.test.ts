import { describe, expect, it } from "vitest";
import { revisionSeek } from "@/lib/revision-seek";
import {
	displayedSeekTime,
	sampleClockUntilSeeked,
	startSeekClockPoll,
	subscribeSeekClock,
} from "@/lib/revision-seek-clock";

describe("seek clock sampling", () => {
	it("samples currentTime when the element never fires timeupdate or seeked", async () => {
		const fired: string[] = [];
		const frames: Array<() => void> = [];
		const video = {
			currentTime: 5,
			duration: 120,
			paused: true,
			pause() {
				this.paused = true;
			},
			play() {
				this.paused = false;
			},
			addEventListener(type: string) {
				fired.push(`listen:${type}`);
			},
			removeEventListener(type: string) {
				fired.push(`unlisten:${type}`);
			},
			dispatchEvent() {
				throw new Error("element must not emit media events");
			},
		};
		const samples: number[] = [];
		subscribeSeekClock(video, (time) => samples.push(time));
		await revisionSeek(video, null, {
			target: 30,
			correctOvershoot: false,
			requestFrame: (callback) => {
				frames.push(callback);
				return frames.length;
			},
		});
		expect(video.currentTime).toBe(30);
		expect(fired.filter((event) => event === "timeupdate")).toEqual([]);
		expect(fired.filter((event) => event === "seeked")).toEqual([]);
		for (const frame of frames) frame();
		expect(samples).toContain(30);
		expect(displayedSeekTime(5, 30)).toBe(30);
		expect(displayedSeekTime(30, 30)).toBe(30);
	});

	it("stops the short poll when seeked fires", () => {
		const listeners = new Map<string, () => void>();
		const frames: Array<() => void> = [];
		const media = {
			currentTime: 1,
			addEventListener(type: string, listener: () => void) {
				listeners.set(type, listener);
			},
			removeEventListener(type: string) {
				listeners.delete(type);
			},
		};
		const samples: number[] = [];
		sampleClockUntilSeeked(media, (time) => samples.push(time), {
			requestFrame: (callback) => {
				frames.push(callback);
				return frames.length;
			},
			maxFrames: 8,
		});
		media.currentTime = 4;
		listeners.get("seeked")?.();
		const before = samples.length;
		for (const frame of frames) frame();
		expect(samples).toContain(4);
		expect(samples.length).toBe(before);
	});

	it("polls after an explicit start when no events fire", () => {
		const frames: Array<() => void> = [];
		const media = { currentTime: 8 };
		const samples: number[] = [];
		subscribeSeekClock(media, (time) => samples.push(time));
		startSeekClockPoll(media, {
			requestFrame: (callback) => {
				frames.push(callback);
				return frames.length;
			},
			maxFrames: 2,
		});
		media.currentTime = 11;
		for (const frame of frames) frame();
		expect(samples).toContain(11);
	});
});
