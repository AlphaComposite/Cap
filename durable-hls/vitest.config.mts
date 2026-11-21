import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import base from "../apps/web/vitest.config";

export default mergeConfig(base, {
	root: fileURLToPath(new URL("../apps/web", import.meta.url)),
	resolve: {
		alias: [
			{
				find: "@cap/database/schema",
				replacement: fileURLToPath(
					new URL("../packages/database/schema.ts", import.meta.url),
				),
			},
		],
	},
});
