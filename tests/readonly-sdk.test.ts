import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("built ACP extension shares immutable retrieval over the real Pi SDK event bus in either load order", { timeout: 120000 }, () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  execFileSync("npm", ["run", "build"], { cwd, timeout: 60000, stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "acp-readonly-sdk-"));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|TOKEN|SECRET|BILLION_CONTEXT_PROXY|PI_ACP/.test(key)));
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("./readonly-sdk-fixture.mjs", import.meta.url))], {
      cwd: home, env: { ...env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), ACP_AUTO_UPDATE: "0" }, timeout: 60000, encoding: "utf8", stdio: "pipe",
    });
    assert.match(output, /both load orders.*passed/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
