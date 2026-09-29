import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const sdk = process.env.ACP_TEST_SDK ? await import(pathToFileURL(join(process.env.ACP_TEST_SDK, "dist/index.js")).href) : await import("@earendil-works/pi-coding-agent");
const { createAcpExtension, ACP_READONLY_CONTEXT_EVENT } = await import("../dist/index.js");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = sdk;
const cwd = process.env.HOME;
const agentDir = join(cwd, ".pi", "agent");
await mkdir(agentDir, { recursive: true });
const assistant = (content) => ({ role: "assistant", content, api: "openai-completions", provider: "offline", model: "offline", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 });
const user = (text) => ({ role: "user", content: text, timestamp: 0 });
const toolResult = (name, id, text) => ({ role: "toolResult", toolName: name, toolCallId: id, content: [{ type: "text", text }], isError: false, timestamp: 0 });
const sessions = [];
const files = async () => {
  const entries = await readdir(cwd, { recursive: true, withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => [join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name), "utf8")]));
};

async function setup(order, evidence) {
  let consumer;
  const consumerFactory = (pi) => { consumer = pi; };
  const acpFactory = createAcpExtension({ autoUpdate: false, delegate: false, preserveRecentMessages: 0, modelContextLimit: 200000, compress: { minCompressRange: 0, minSummaryLength: 0, maxSummaryLength: 0 } });
  const manager = SessionManager.create(cwd, join(cwd, `sessions-${sessions.length}`));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: order === "acp-first" ? [acpFactory, consumerFactory] : [consumerFactory, acpFactory] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, settingsManager, resourceLoader: loader, modelRuntime, noTools: "builtin" });
  sessions.push(session);
  await session.bindExtensions({ onError: (error) => { throw new Error(JSON.stringify(error)); } });
  const runner = session.extensionRunner;
  manager.appendMessage(user("Executor task"));
  manager.appendMessage(assistant([{ type: "toolCall", id: "evidence-call", name: "bash", arguments: { command: "echo offline" } }]));
  manager.appendMessage(toolResult("bash", "evidence-call", evidence.repeat(1000)));
  manager.appendMessage(user("Continue the task"));
  const context = () => runner.emitContext(manager.buildSessionContext().messages);
  const acquire = (changes = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("read-only event was not answered")), 2000);
    consumer.events.emit(ACP_READONLY_CONTEXT_EVENT, { version: 1, sessionId: manager.getSessionId(), signal: new AbortController().signal, sanitize: (record) => record.provenanceComplete ? record.text.replaceAll("password=secret", "[REDACTED]") : null, ...changes, respond: (result) => { clearTimeout(timer); resolve(result); } });
  });
  assert.deepEqual(await acquire(), { ok: false, error: "unavailable" });
  await context();
  const initial = await acquire(); assert.ok(initial.ok);
  const hits = await initial.lease.search({ query: evidence.split(" ")[0] });
  const ref = hits.records.find((record) => record.kind === "tool-result").ref;
  initial.lease.release();
  const args = { content: [{ startId: ref, endId: ref, summary: "A safe summary of offline evidence collected by the Executor for the ongoing task." }] };
  manager.appendMessage(assistant([{ type: "toolCall", id: "compress-test", name: "compress", arguments: args }]));
  const compressed = await runner.getToolDefinition("compress").execute("compress-test", args, new AbortController().signal, undefined, runner.createContext());
  assert.match(JSON.stringify(compressed), /blocks: b1=/);
  assert.ok(!JSON.stringify(compressed).includes("Error:"), JSON.stringify(compressed));
  manager.appendMessage(toolResult("compress", "compress-test", compressed.content.map((part) => part.text ?? "").join("\n")));
  const output = await context();
  assert.ok(!JSON.stringify(output).includes(evidence.repeat(10)));
  const filesBefore = await files();
  const result = await acquire(); assert.ok(result.ok, JSON.stringify(result));
  const lease = result.lease;
  const evidencePage = await lease.decompress({ ref: "b1" });
  assert.match(JSON.stringify(evidencePage), new RegExp(evidence.split(" ")[0]));
  assert.ok(!JSON.stringify(evidencePage).includes("password=secret"));
  assert.ok(!JSON.stringify(await lease.context()).includes(evidence.repeat(10)));
  assert.deepEqual(await acquire({ version: 2 }), { ok: false, error: "unsupported_version" });
  assert.deepEqual(await files(), filesBefore, "acquire/context/search/decompress must not modify any fixture files");
  return { session, manager, runner, context, acquire, lease };
}

try {
  const first = await setup("acp-first", "SESSION_A password=secret ");
  const second = await setup("consumer-first", "SESSION_B password=secret ");
  assert.ok(!JSON.stringify(await first.lease.decompress({ ref: "b1" })).includes("SESSION_B"));
  assert.ok(!JSON.stringify(await second.lease.decompress({ ref: "b1" })).includes("SESSION_A"));
  const firstSnapshot = first.lease.snapshot.id;
  await first.context();
  assert.equal(first.lease.snapshot.id, firstSnapshot);
  for (const type of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact"]) {
    const acquired = await first.acquire(); assert.ok(acquired.ok);
    await first.runner.emit({ type, reason: "resume", sessionPath: "unused", entryId: "unused", targetId: "unused" });
    await assert.rejects(acquired.lease.context(), (error) => error.code === "stale");
    assert.deepEqual(await first.acquire(), { ok: false, error: "stale" });
    await first.context();
  }
  const reopenLease = (await second.acquire()).lease;
  await second.runner.emit({ type: "session_start", reason: "resume" });
  await assert.rejects(reopenLease.context(), (error) => error.code === "stale");
  assert.deepEqual(await second.acquire(), { ok: false, error: "unavailable" });
  const enabledLease = (await first.acquire()).lease;
  await writeFile(join(cwd, ".pi", "acp.json"), JSON.stringify({ enabled: false }));
  await first.context();
  await assert.rejects(enabledLease.context(), (error) => error.code === "stale");
  assert.deepEqual(await first.acquire(), { ok: false, error: "stale" });
  console.log("real SDK built ACP: both load orders, compression, context, retrieval, isolated sessions, lifecycle, disabled config, redaction passed");
} finally {
  for (const session of sessions) {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
}
