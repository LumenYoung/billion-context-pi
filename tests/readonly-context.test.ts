import assert from "node:assert/strict";
import { test } from "node:test";
import { ACP_READONLY_LIMITS as limits, type AcpReadonlyAcquireRequest, type AcpReadonlyRecord } from "../src/readonly-context.js";
import { captureReadonlyProjection } from "../src/readonly-projection.js";
import { acquire, capture, fixture, identity, assistant } from "./readonly-fixture.js";

const code = (value: string) => (error: unknown): boolean => !!error && typeof error === "object" && "code" in error && error.code === value;
const request = (changes: Partial<AcpReadonlyAcquireRequest> = {}): AcpReadonlyAcquireRequest => ({ version: 1, sessionId: "session-a", signal: new AbortController().signal, sanitize: identity, respond: () => {}, ...changes });

test("actual compression -> final ACP projection -> original inline evidence; immutable ref identity", async () => {
  const input = fixture();
  const bridge = capture(input);
  const lease = await acquire(bridge);
  try {
    const context = await lease.context();
    assert.equal(context.snapshotId, lease.snapshot.id);
    assert.equal(lease.snapshot.fidelity, "acp-text-projection");
    assert.ok(!context.records.some((record) => record.toolNames.length === 1 && record.toolNames[0] === "bash"));
    assert.ok(context.records.some((record) => record.text.includes("Summary reveals")));
    assert.ok(!JSON.stringify(context).includes("NEVER_REASONING"));
    assert.ok(Object.isFrozen(context.records[0]));
    const originals = await lease.decompress({ ref: "b1" });
    assert.match(JSON.stringify(originals), /echo evidence/);
    assert.match(JSON.stringify(originals), /ORIGINAL_EVIDENCE/);
    assert.ok(originals.records.every((record) => record.toolNames.includes("bash")));
    const hit = (await lease.search({ query: "ORIGINAL_EVIDENCE" })).records.find((record) => record.kind === "tool-result" && record.toolNames[0] === "bash")!;
    assert.ok(hit);
    assert.match(JSON.stringify(await lease.decompress({ ref: hit.ref })), /ORIGINAL_EVIDENCE/);
    input.state.blocks[0]!.summary = "MUTATED";
    input.output.length = 0;
    input.originals[2]!.text = "MUTATED";
    assert.ok(!JSON.stringify(await lease.context()).includes("MUTATED"));
    assert.ok(!JSON.stringify(await lease.decompress({ ref: "b1" })).includes("MUTATED"));
    const generation = bridge.begin("session-a");
    bridge.capture("session-a", generation, fixture("NEW_EVIDENCE"));
    assert.match(JSON.stringify(await lease.decompress({ ref: "b1" })), /ORIGINAL_EVIDENCE/);
  } finally { lease.release(); }
});

test("transitive block and compress-anchor disclosure fails closed, including unknown coverage", async () => {
  const input = fixture();
  input.state.blocks.push({ ...input.state.blocks[0]!, blockId: "b2", directBlockIds: ["b1"], summary: "nested secret", compressCallId: "nested" });
  const projection = captureReadonlyProjection({ ...input, sessionId: "session-a", generation: 1 });
  assert.deepEqual(projection.evidence.find((record) => record?.ref === "b2")!.toolNames, ["bash"]);
  assert.ok(projection.context.filter((record) => record.toolNames.includes("compress")).every((record) => record.toolNames.includes("bash")));
  const sanitizer = (record: AcpReadonlyRecord): string | null => !record.provenanceComplete || record.toolNames.includes("bash") ? null : record.text;
  const lease = await acquire(capture(input), { sanitize: sanitizer });
  try {
    assert.ok(!JSON.stringify(await lease.context()).includes("secret-secret"));
    assert.deepEqual((await lease.search({ query: "secret" })).records, []);
    await assert.rejects(lease.decompress({ ref: "b1" }), code("unknown_ref"));
    await assert.rejects(lease.decompress({ ref: "b2" }), code("unknown_ref"));
  } finally { lease.release(); }
  input.state.blocks[0]!.effectiveMessageIds.push("missing-original");
  const unknown = captureReadonlyProjection({ ...input, sessionId: "session-a", generation: 2 });
  assert.equal(unknown.evidence.find((record) => record?.ref === "b1")!.provenanceComplete, false);
  assert.equal(unknown.targets.has("b1"), false);
});

test("sanitization precedes initial payload, search, and UTF-8 bounded pages, including split secrets", async () => {
  const text = `${"é🦉".repeat(500)}password=secret-secret${"z".repeat(9000)}`;
  const calls: string[] = [];
  const lease = await acquire(capture(fixture(text)), { sanitize: (record) => { calls.push(record.text); return record.text.replaceAll("password=secret-secret", "[REDACTED]"); } });
  try {
    assert.ok(!calls.some((value) => value.includes(text)));
    const context = await lease.context({ maxBytes: 1024 });
    assert.ok(!JSON.stringify(context).includes("secret-secret"));
    assert.deepEqual((await lease.search({ query: "secret-secret" })).records, []);
    assert.ok(calls.some((value) => value.includes(text)));
    let cursor: string | undefined;
    let combined = "";
    do {
      const page = await lease.decompress({ ref: "b1", maxBytes: 1024, cursor });
      assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(page)));
      assert.ok(page.bytes <= 1024);
      assert.ok(!JSON.stringify(page).includes("secret-secret"));
      combined += page.records.map((record) => record.text).join("");
      cursor = page.nextCursor;
    } while (cursor);
    assert.match(combined, /\[REDACTED\]/);
    assert.ok(combined.includes("é🦉".repeat(500)));
  } finally { lease.release(); }
});

test("sanitizer failures and attempts to mutate records never expose raw data", async () => {
  const bridge = capture();
  for (const sanitize of [() => { throw new Error("secret"); }, () => Promise.resolve("oops"), (record: AcpReadonlyRecord) => { Object.assign(record, { text: "mutated" }); return record.text; }]) {
    const result = await bridge.acquire(request({ sanitize: sanitize as AcpReadonlyAcquireRequest["sanitize"] }));
    assert.deepEqual(result, { ok: false, error: "sanitizer_failed" });
  }
  const result = await bridge.acquire(request({ sanitize: () => "x".repeat(limits.captureBytes + 1) }));
  assert.deepEqual(result, { ok: false, error: "budget_exceeded" });
});

test("session/epoch lifecycle invalidates old leases and in-flight acquisitions without ref collisions", async () => {
  const bridge = capture();
  const old = await acquire(bridge);
  const other = await acquire(capture(fixture("OTHER_SESSION"), "session-b"), { sessionId: "session-b" });
  assert.ok(!JSON.stringify(await old.decompress({ ref: "b1" })).includes("OTHER_SESSION"));
  assert.match(JSON.stringify(await other.decompress({ ref: "b1" })), /OTHER_SESSION/);
  const generation = bridge.begin("session-a");
  bridge.invalidate();
  bridge.capture("session-a", generation, fixture());
  assert.deepEqual(await bridge.acquire(request()), { ok: false, error: "stale" });
  assert.equal(old.signal.aborted, true);
  assert.ok(code("stale")(old.signal.reason));
  assert.equal(other.signal.aborted, false);
  await assert.rejects(old.context(), code("stale"));
  bridge.start("session-b");
  assert.deepEqual(await bridge.acquire(request()), { ok: false, error: "unavailable" });
  bridge.capture("session-b", bridge.begin("session-b"), fixture());
  const pending = bridge.acquire(request({ sessionId: "session-b" }));
  bridge.invalidate();
  assert.deepEqual(await pending, { ok: false, error: "stale" });
  other.release();
});

test("clear absent/version/invalid errors, cancellation and concurrent lease/request limits", async () => {
  const bridge = capture();
  assert.deepEqual(await bridge.acquire(request({ version: 99 })), { ok: false, error: "unsupported_version" });
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await bridge.acquire(request({ signal: aborted.signal })), { ok: false, error: "aborted" });
  const controller = new AbortController();
  const lease = await acquire(bridge, { signal: controller.signal });
  const second = await acquire(bridge);
  assert.deepEqual(await bridge.acquire(request()), { ok: false, error: "busy" });
  const pending = lease.context();
  await assert.rejects(lease.search({ query: "evidence" }), code("busy"));
  await pending;
  const requestAbort = new AbortController();
  const read = lease.context({ signal: requestAbort.signal });
  requestAbort.abort();
  await assert.rejects(read, code("aborted"));
  await assert.rejects(lease.decompress({ ref: "/tmp/session.jsonl" }), code("unknown_ref"));
  await assert.rejects(lease.decompress({ ref: "b1", cursor: "foreign-cursor" }), code("invalid_request"));
  await assert.rejects(lease.decompress({ ref: "b1", path: "/tmp" } as Parameters<typeof lease.decompress>[0]), code("invalid_request"));
  await assert.rejects(lease.search({ query: "[.*".repeat(1000) }), code("invalid_request"));
  controller.abort();
  assert.equal(lease.signal.aborted, true);
  assert.ok(code("aborted")(lease.signal.reason));
  assert.equal(second.signal.aborted, false);
  await assert.rejects(lease.context(), code("aborted"));
  second.release();
  assert.equal(second.signal.aborted, true);
  (await acquire(bridge)).release();
});

test("capture and lease byte/request/TTL budgets are enforced without file fallback", async (t) => {
  const bridge = capture(fixture("x".repeat(limits.captureBytes + 1)));
  const oversized = await acquire(bridge);
  assert.ok((await oversized.context()).records.length);
  await assert.rejects(oversized.decompress({ ref: "b1" }), code("budget_exceeded"));
  oversized.release();
  const lease = await acquire(capture(fixture("x".repeat(180000))));
  let exhausted = false;
  for (let i = 0; i < 12; i++) {
    try { await lease.decompress({ ref: "b1" }); } catch (error) { assert.ok(code("budget_exceeded")(error)); exhausted = true; break; }
  }
  assert.equal(exhausted, true);
  lease.release();
  const limited = await acquire(capture());
  for (let i = 0; i < limits.requests; i++) await limited.search({ query: "not-found" });
  await assert.rejects(limited.context(), code("budget_exceeded"));
  limited.release();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const expiringBridge = capture();
  const expiring = await acquire(expiringBridge);
  t.mock.timers.tick(limits.lifetimeMs + 1);
  assert.equal(expiring.signal.aborted, true);
  assert.ok(code("stale")(expiring.signal.reason));
  await assert.rejects(expiring.context(), code("stale"));
  assert.deepEqual(await expiringBridge.acquire(request()), { ok: false, error: "stale" });
});

test("acquisition and retrieval deadlines include sanitizer work and event-loop delay", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const bridge = capture();
  assert.deepEqual(await bridge.acquire(request({ sanitize: (record) => { t.mock.timers.tick(limits.operationMs + 1); return record.text; } })), { ok: false, error: "timeout" });
  const lease = await acquire(bridge);
  const pending = lease.context();
  t.mock.timers.tick(limits.operationMs + 1);
  await assert.rejects(pending, code("timeout"));
  lease.release();
});

test("projection preserves multi-call assistant prose, omits images and unsupported provenance", () => {
  const input = fixture();
  const message = assistant([{ type: "text", text: "MULTI_CALL_PROSE" }, { type: "toolCall", name: "read", id: "one", arguments: { path: "safe" } }, { type: "toolCall", name: "bash", id: "two", arguments: { command: "echo" } }, { type: "image", data: "NEVER_IMAGE" }]);
  input.originalMessages.set("answer", message);
  const projection = captureReadonlyProjection({ ...input, unattributedIds: new Set(["answer"]), sessionId: "session-a", generation: 1 });
  const record = projection.evidence.find((record) => record?.text.includes("MULTI_CALL_PROSE"))!;
  assert.ok(record);
  assert.equal(record.provenanceComplete, false);
  assert.ok(!JSON.stringify(projection.context).includes("NEVER_IMAGE"));
  assert.ok(!JSON.stringify(projection.evidence).includes("NEVER_IMAGE"));
});
