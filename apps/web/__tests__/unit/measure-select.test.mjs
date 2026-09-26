import assert from "node:assert/strict";
import test from "node:test";
import {
	countSeg0Gets,
	legacyLargeAction,
	selectPublish,
	selectSeg0End,
} from "../../lib/measure-select.mjs";

const net = [
	{
		method: "POST",
		kind: "action",
		bytes: 30000,
		status: 200,
		hasPlaylistUrl: true,
		start: 100,
		responseAt: 200,
		path: "/api/video/revision/publish",
	},
	{
		method: "POST",
		kind: "action",
		bytes: 30000,
		status: 500,
		hasPlaylistUrl: false,
		start: 300,
		responseAt: 400,
		path: "/s/video/edit",
	},
];

test("publish selector ignores a later 500 prepare body", () => {
	assert.equal(legacyLargeAction(net).status, 500);
	const publish = selectPublish(net);
	assert.equal(publish.status, 200);
	assert.equal(publish.hasPlaylistUrl, true);
});

test("seg0 end is the share-page append, not a prefetch that finished first", () => {
	const playlistStart = 200;
	const networkSeg0End = 50;
	assert.ok(networkSeg0End < playlistStart);
	const end = selectSeg0End({
		networkSeg0End,
		playlistStart,
		seg0ByteLength: 7912,
		appends: [
			{ share: false, byteLength: 7912, wall: networkSeg0End },
			{ share: true, byteLength: 1206, wall: 240 },
			{ share: true, byteLength: 7912, wall: 310 },
		],
	});
	assert.equal(end, 310);
	assert.notEqual(end, networkSeg0End);
});

test("seg0 get count is one for the new revision", () => {
	const rows = [
		{
			method: "GET",
			kind: "seg0",
			path: "/media/video/r/rev-new/seg/0.m4s",
		},
		{
			method: "GET",
			kind: "seg0",
			path: "/media/video/r/rev-old/seg/0.m4s",
		},
	];
	assert.equal(countSeg0Gets(rows, "rev-new"), 1);
});
