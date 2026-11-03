import { mergeConfig } from "/srv/styrir/apps/cap/node_modules/vitest/dist/config.js";
import base from "../apps/web/vitest.config";

export default mergeConfig(base, {
	root: "/srv/styrir/worktrees/cap-vk24-durable-hls/apps/web",
	resolve: {
		alias: [
			{
				find: "@cap/database/schema",
				replacement:
					"/srv/styrir/worktrees/cap-vk24-durable-hls/packages/database/schema.ts",
			},
		],
	},
});
