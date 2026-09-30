import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: {
		jsx: "automatic",
	},
	test: {
		// Hoisted UI peers must use web React; CommonJS UI imports still need require in Node-based jsdom tests.
		server: {
			deps: {
				inline: [
					"framer-motion",
					"motion",
					"media-chrome",
					/[/\\]node_modules[/\\]@radix-ui[/\\]/,
					"@tanstack/react-query",
					"@floating-ui/react-dom",
				],
			},
		},
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: ["next/link", "next/image", "react-remove-scroll"],
				},
				web: {
					enabled: true,
					include: ["next/link", "next/image", "react-remove-scroll"],
					esbuildOptions: {
						banner: {
							js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
						},
					},
				},
			},
		},
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
		globals: true,
		setupFiles: ["./__tests__/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["lib/**/*.ts", "workflows/**/*.ts", "actions/**/*.ts"],
			exclude: [
				"**/*.d.ts",
				"**/__tests__/**",
				"**/node_modules/**",
				"**/.next/**",
			],
		},
		testTimeout: 30000,
		hookTimeout: 30000,
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: /^@cap\/web-backend$/,
				replacement: join(
					process.cwd(),
					"../../packages/web-backend/src/index.ts",
				),
			},
			{
				find: /^@cap\/web-backend\/(.*)$/,
				replacement: join(process.cwd(), "../../packages/web-backend/$1"),
			},
			{ find: "@/app", replacement: join(process.cwd(), "app") },
			{ find: "@/components", replacement: join(process.cwd(), "components") },
			{ find: "@/pages", replacement: join(process.cwd(), "components/pages") },
			{ find: "@/utils", replacement: join(process.cwd(), "utils") },
			{ find: "@/lib", replacement: join(process.cwd(), "lib") },
			{ find: "@/actions", replacement: join(process.cwd(), "actions") },
			{ find: "@/data", replacement: join(process.cwd(), "data") },
			{ find: "@/services", replacement: join(process.cwd(), "services") },
			{ find: "@/workflows", replacement: join(process.cwd(), "workflows") },
			{ find: "hooks", replacement: join(process.cwd(), "hooks") },
		],
	},
});
