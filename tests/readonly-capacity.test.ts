import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadonlyBudget, readonlyJsonBytes } from "../src/readonly-budget.js";
import { ACP_READONLY_LIMITS as limits } from "../src/readonly-context.js";
import { acquire, capture, fixture, result } from "./readonly-fixture.js";

function history(sizes: number[]) {
  const input = fixture("RETRIEVABLE_ORIGINAL");
  const source = input.originals.find((core) => core.id === "result")!;
  for (const [i, size] of sizes.entries()) {
    const id = `older-${i}`;
    const text = `HISTORICAL_${i} ` + "x".repeat(size);
    input.originals.push({ ...source, id, text });
    input.originalMessages.set(id, result("bash", `old-call-${i}`, text));
    input.state.messageRefs.byRaw[id] = `m${100 + i}`;
  }
  return input;
}

test("small current view acquires independently of >8 MiB immutable compressed history", async () => {
  const input = history(Array(4).fill(3 * 1024 * 1024));
  let sanitized = 0;
  const bridge = capture(input);
  const lease = await acquire(bridge, { sanitize: (record) => { sanitized++; return record.text; } });
  assert.ok(sanitized <= input.output.length, "acquisition must not sanitize historical evidence");
  assert.ok((await lease.context()).bytes < 10_000);
  input.originals.at(-1)!.text = "MUTATED_CORE";
  input.originalMessages.set("older-3", result("bash", "changed", "MUTATED_ORIGINAL"));
  input.state.messageRefs.byRaw["older-3"] = "m999";
  const page = await lease.decompress({ ref: "m103" });
  assert.ok(page.records[0]!.text.startsWith("HISTORICAL_3 "));
  assert.equal(page.records[0]!.complete, false);
  assert.ok(page.bytes <= limits.pageBytes);
  assert.ok((await lease.search({ query: "RETRIEVABLE_ORIGINAL", limit: 1 })).records.length);
  lease.release();
});

test("oversized originals are known capacity failures without poisoning small refs or current context", async () => {
  const input = history([limits.recordBytes + 1, 128]);
  const lease = await acquire(capture(input));
  assert.ok((await lease.context()).records.length);
  await assert.rejects(lease.decompress({ ref: "m100" }), { code: "budget_exceeded" });
  assert.ok((await lease.decompress({ ref: "m101" })).records[0]!.text.includes("HISTORICAL_1"));
  await assert.rejects(lease.search({ query: "not present" }), { code: "budget_exceeded" });
  assert.equal((await lease.search({ query: "RETRIEVABLE_ORIGINAL", limit: 1 })).records.length, 1);
  lease.release();
});

test("history retention/work ceiling leaves the small current view usable and never reports an incomplete scan as empty", async () => {
  const lease = await acquire(capture(history(Array(23).fill(3 * 1024 * 1024))));
  assert.ok((await lease.context()).bytes < 10_000);
  await assert.rejects(lease.decompress({ ref: "m122" }), { code: "budget_exceeded" });
  assert.ok((await lease.decompress({ ref: "m100", maxBytes: 1024 })).records.length);
  await assert.rejects(lease.search({ query: "no such evidence" }), { code: "budget_exceeded" });
  assert.ok((await lease.decompress({ ref: "b1", maxBytes: 1024 })).records.length);
  lease.release();
});

test("full-record lazy sanitization precedes matching and denied evidence produces no snippets or pages", async () => {
  const input = history([3 * 1024 * 1024, 16]);
  let historicalCalls = 0;
  const lease = await acquire(capture(input), { sanitize: (record) => {
    if (record.ref !== "m100") return record.text;
    historicalCalls++;
    assert.ok(Object.isFrozen(record));
    assert.ok(Object.isFrozen(record.refs));
    assert.ok(Object.isFrozen(record.toolNames));
    assert.equal(record.text, input.originals.find((core) => core.id === "older-0")!.text);
    return null;
  } });
  assert.equal(historicalCalls, 0);
  assert.deepEqual((await lease.search({ query: "HISTORICAL_0" })).records, []);
  await assert.rejects(lease.decompress({ ref: "m100" }), { code: "unknown_ref" });
  assert.equal(historicalCalls, 1);
  assert.ok((await lease.decompress({ ref: "m101" })).records.length);
  lease.release();
});

test("sanitizer errors/expansion are memoized retrieval-local failures, never unsanitized fallback", async () => {
  for (const failure of ["throws", "expands", "escaped", "invalid", "mutation"] as const) {
    let calls = 0;
    const lease = await acquire(capture(history([16, 16])), { sanitize: (record) => {
      if (record.ref !== "m100") return record.text;
      calls++;
      if (failure === "throws") throw new Error("private sanitizer detail");
      if (failure === "expands") return "x".repeat(limits.recordBytes + 1);
      if (failure === "escaped") return "\0".repeat(2 * 1024 * 1024);
      if (failure === "mutation") return Object.assign(record, { text: "mutated" }).text;
      return 1 as unknown as string;
    } });
    const code = failure === "expands" || failure === "escaped" ? "budget_exceeded" : "sanitizer_failed";
    await assert.rejects(lease.decompress({ ref: "m100" }), { code });
    await assert.rejects(lease.decompress({ ref: "m100" }), { code });
    assert.equal(calls, 1);
    assert.ok((await lease.context()).records.length);
    assert.ok((await lease.decompress({ ref: "m101" })).records.length);
    await assert.rejects(lease.search({ query: "HISTORICAL_0" }), { code });
    lease.release();
  }
});

test("sanitized historical cache is bounded independently of page/output bytes", async () => {
  const lease = await acquire(capture(history(Array(10).fill(16))), { sanitize: (record) =>
    record.ref.startsWith("m10") ? record.text + "z".repeat(7 * 1024 * 1024) : record.text });
  for (let i = 0; i < 9; i++) assert.ok((await lease.decompress({ ref: `m${100 + i}`, maxBytes: 1024 })).records.length);
  await assert.rejects(lease.decompress({ ref: "m109", maxBytes: 1024 }), { code: "budget_exceeded" });
  assert.ok((await lease.context()).records.length);
  assert.ok((await lease.decompress({ ref: "b1", maxBytes: 1024 })).records.length);
  lease.release();
});

test("expired/replaced captures retain no mutable originals and session invalidation cancels pending lazy work", async () => {
  const input = history([1024]);
  const bridge = capture(input);
  const lease = await acquire(bridge);
  input.originals.at(-1)!.toolName = "DENIED_MUTATION";
  input.state.blocks[0]!.effectiveMessageIds.length = 0;
  input.state.blocks[0]!.summary = "MUTATED_SUMMARY";
  const generation = bridge.begin("session-a");
  bridge.capture("session-a", generation, fixture("NEW_CAPTURE"));
  const old = await lease.decompress({ ref: "m100" });
  assert.deepEqual(old.records[0]!.toolNames, ["bash"]);
  assert.ok((await lease.decompress({ ref: "b1" })).records.length);
  assert.equal((await lease.search({ query: "MUTATED_SUMMARY" })).records.length, 0);
  const latest = await acquire(bridge);
  await assert.rejects(latest.decompress({ ref: "m100" }), { code: "unknown_ref" });
  const pending = lease.search({ query: "HISTORICAL_0" });
  bridge.invalidate();
  await assert.rejects(pending, { code: "stale" });
  await assert.rejects(latest.context(), { code: "stale" });
  const expired = capture({ ...fixture(), now: Date.now() - limits.lifetimeMs - 1 });
  assert.deepEqual(await expired.acquire({ version: 1, sessionId: "session-a", signal: new AbortController().signal, sanitize: (record) => record.text, respond: () => {} }), { ok: false, error: "stale" });
});

test("search yields during large sanitized records and abort checks stop further sanitizer work", async () => {
  const controller = new AbortController();
  let visited = 0;
  const lease = await acquire(capture(history(Array(4).fill(3 * 1024 * 1024))), { sanitize: (record) => {
    if (record.ref.startsWith("m10")) {
      visited++;
      if (visited === 1) setImmediate(() => controller.abort());
    }
    return record.text;
  } });
  await assert.rejects(lease.search({ query: "not present", signal: controller.signal }), { code: "aborted" });
  assert.equal(visited, 1);
  assert.ok((await lease.context()).records.length);
  lease.release();
});

test("malformed/cyclic or over-budget coverage metadata fails capture closed", async () => {
  for (const scenario of ["cycle", "malformed", "oversized", "wide", "duplicates"] as const) {
    const input = fixture();
    const block = input.state.blocks[0]!;
    if (scenario === "cycle") block.directBlockIds.push(block.blockId);
    if (scenario === "malformed") block.effectiveMessageIds.push([] as unknown as string);
    if (scenario === "oversized") block.effectiveMessageIds.push("x".repeat(limits.metadataBytes + 1));
    if (scenario === "wide") block.effectiveMessageIds.push(...Array(limits.records).fill("result"));
    if (scenario === "duplicates") input.state.blocks.push({ ...block });
    const bridge = capture(input);
    const outcome = await bridge.acquire({ version: 1, sessionId: "session-a", signal: new AbortController().signal, sanitize: (record) => record.text, respond: () => {} });
    assert.deepEqual(outcome, { ok: false, error: scenario === "oversized" || scenario === "wide" ? "budget_exceeded" : "invalid_request" });
  }
});

test("rejected UTF-8 expansion consumes projection work before repeated string scans", () => {
  const work = new ReadonlyBudget(4);
  assert.throws(() => readonlyJsonBytes("éé", limits.recordBytes, work), { code: "budget_exceeded" });
  assert.throws(() => readonlyJsonBytes("x", limits.recordBytes, work), { code: "budget_exceeded" });
});
