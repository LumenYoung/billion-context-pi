import { accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const omitted = (process.env.npm_config_omit ?? "").split(/\s+/);
const production = omitted.includes("dev") || process.env.NODE_ENV === "production";

if (production) {
	// Pi omits development dependencies and may suppress peer dependencies.
	// Maintained Git releases must include their prebuilt dist directory.
	const required = ["index.js", "contract.js", "index.d.ts", "contract.d.ts"];
	try {
		for (const file of required) {
			accessSync(resolve(root, "dist", file), constants.R_OK);
		}
		// The contract has no host dependencies and shares the runtime chunk with
		// the extension. Import it to reject missing or invalid shared artifacts.
		await import(pathToFileURL(resolve(root, "dist", "contract.js")).href);
	} catch (error) {
		console.error(
			"Production installation requires prebuilt dist artifacts. " +
				"Install a maintained release commit, or install development and " +
				"peer dependencies and run npm run build before publishing.",
		);
		console.error(error.message);
		process.exit(1);
	}
	console.log("Using prebuilt dist artifacts for production installation.");
} else {
	const result = spawnSync(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["run", "build"],
		{ cwd: root, stdio: "inherit", shell: process.platform === "win32" },
	);
	if (result.error) console.error(result.error.message);
	process.exit(result.status ?? 1);
}
