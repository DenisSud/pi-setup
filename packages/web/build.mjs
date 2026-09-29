import { cpSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundles the browser app. Two resolutions need help:
// - @pi/fork/* are source modules in the pi checkout (the published coding-agent
//   package does not ship experimental/).
// - the pi packages in the checkout are workspace symlinks whose dist/ is not
//   built, so map them to the built copies this repo depends on.

const packageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageDir, "../..");
const sourceDir = process.env.PI_SOURCE_DIR ?? join(homedir(), "dev", "pi");
const modules = join(repoRoot, "node_modules", "@earendil-works");
const outDir = join(packageDir, "dist");

const forkModule = {
	name: "fork-module",
	setup(build) {
		build.onResolve({ filter: /^@pi\/fork\// }, (args) => ({
			path: join(sourceDir, "packages", "coding-agent", "src", args.path.slice("@pi/fork/".length)),
		}));
	},
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	entryPoints: [join(packageDir, "src", "main.ts")],
	outfile: join(outDir, "app.js"),
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2023",
	sourcemap: true,
	logLevel: "warning",
	plugins: [forkModule],
	alias: {
		"@earendil-works/pi-client": join(modules, "pi-client", "dist", "index.js"),
		"@earendil-works/chord/context": join(modules, "chord", "dist", "context", "index.js"),
		"@earendil-works/chord": join(modules, "chord", "dist", "index.js"),
	},
});

cpSync(join(packageDir, "src", "index.html"), join(outDir, "index.html"));
cpSync(join(packageDir, "src", "style.css"), join(outDir, "style.css"));
const blobatar = join(repoRoot, "node_modules", "blobatar", "dist");
cpSync(join(blobatar, "motion.css"), join(outDir, "blobatar-motion.css"));
cpSync(join(blobatar, "gaze.css"), join(outDir, "blobatar-gaze.css"));
console.log(`built ${outDir}`);
