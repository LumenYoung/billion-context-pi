import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function fixture(t, artifacts = true, build = "node -e \"console.log('development-build')\"") {
	const root = mkdtempSync(join(tmpdir(), "acp-prepare-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "scripts"));
	copyFileSync(new URL("../scripts/prepare.mjs", import.meta.url), join(root, "scripts/prepare.mjs"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { build } }));
	if (artifacts) {
		mkdirSync(join(root, "dist"));
		for (const file of ["index.js", "contract.js", "index.d.ts", "contract.d.ts"]) {
			writeFileSync(join(root, "dist", file), "");
		}
	}
	return root;
}

function prepare(root, env = {}) {
	return spawnSync(process.execPath, [join(root, "scripts/prepare.mjs")], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, NODE_ENV: "", npm_config_omit: "", ...env },
	});
}

test("production install uses prebuilt artifacts without invoking the build", (t) => {
	const root = fixture(t, true, "node -e \"process.exit(99)\"");
	const result = prepare(root, { npm_config_omit: "dev" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Using prebuilt dist/);
	assert.doesNotMatch(result.stdout, /development-build/);
});

test("production NODE_ENV and multi-value omit are supported", (t) => {
	const root = fixture(t, true, "node -e \"process.exit(99)\"");
	for (const env of [{ NODE_ENV: "production" }, { npm_config_omit: "optional\ndev" }]) {
		const result = prepare(root, env);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Using prebuilt dist/);
	}
});

test("missing production artifacts fail with actionable guidance", (t) => {
	const result = prepare(fixture(t, false), { npm_config_omit: "dev" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Production installation requires prebuilt dist artifacts/);
	assert.doesNotMatch(result.stdout, /development-build/);
});

test("partial production artifacts fail", (t) => {
	const root = fixture(t);
	rmSync(join(root, "dist", "contract.js"));
	const result = prepare(root, { npm_config_omit: "dev" });
	assert.equal(result.status, 1);
});

test("missing shared runtime chunks fail production installation", (t) => {
	const root = fixture(t);
	writeFileSync(join(root, "dist", "contract.js"), 'import "./missing-chunk.js";\n');
	const result = prepare(root, { npm_config_omit: "dev" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /missing-chunk/);
});

test("development install still builds, even without existing dist", (t) => {
	const result = prepare(fixture(t, false));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /development-build/);
});

test("development build failures propagate", (t) => {
	const result = prepare(fixture(t, false, "node -e \"process.exit(23)\""));
	assert.equal(result.status, 23);
});
