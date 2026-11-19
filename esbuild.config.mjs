import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const mode = process.argv[2];

if (mode === "test") {
	// Bundle the pure sync-planning tests for node's built-in test runner.
	await esbuild.build({
		entryPoints: ["test/plan.test.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		outfile: "test-dist/plan.test.mjs",
		logLevel: "info",
	});
	process.exit(0);
}

const prod = mode === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtins,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
