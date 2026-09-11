import { randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { ACP_READONLY_LIMITS as limits, AcpReadonlyError, type AcpReadonlyAcquireRequest, type AcpReadonlyChunk, type AcpReadonlyLease, type AcpReadonlyPage, type AcpReadonlyPageRequest, type AcpReadonlyRecord, type AcpReadonlySnapshot, type AcpReadonlySearchRequest } from "./readonly-context.js";
import { frozenRecord, type ReadonlyCapture } from "./readonly-projection.js";

interface LeaseData {
  context: readonly AcpReadonlyRecord[];
  evidence: readonly (AcpReadonlyRecord | null)[];
  targets: ReadonlyMap<string, readonly number[]>;
}

export async function sanitizeCapture(capture: ReadonlyCapture, request: AcpReadonlyAcquireRequest, check: () => void): Promise<LeaseData> {
  let bytes = 0;
  let count = 0;
  const sanitize = async (records: readonly AcpReadonlyRecord[]): Promise<(AcpReadonlyRecord | null)[]> => {
    const result: (AcpReadonlyRecord | null)[] = [];
    for (const record of records) {
      if (++count % 32 === 0) await yieldTurn();
      check();
      let text: unknown;
      try { text = request.sanitize(record); }
      catch { throw new AcpReadonlyError("sanitizer_failed"); }
      if (text !== null && typeof text !== "string") throw new AcpReadonlyError("sanitizer_failed");
      if (text === null) { result.push(null); continue; }
      bytes += Buffer.byteLength(text);
      if (bytes > limits.captureBytes) throw new AcpReadonlyError("budget_exceeded");
      const clean = frozenRecord({ ...record, text });
      bytes += Buffer.byteLength(JSON.stringify({ ...clean, text: "" }));
      if (bytes > limits.captureBytes) throw new AcpReadonlyError("budget_exceeded");
      result.push(clean);
    }
    return result;
  };
  const context = (await sanitize(capture.context)).filter((record): record is AcpReadonlyRecord => record !== null);
  const evidence = await sanitize(capture.evidence);
  check();
  return { context, evidence, targets: capture.targets };
}

function pageBytes(page: AcpReadonlyPage): number {
  return Buffer.byteLength(JSON.stringify(page));
}

function finishPage(page: AcpReadonlyPage): AcpReadonlyPage {
  let result = { ...page, bytes: 0 };
  for (let i = 0; i < 4; i++) result = { ...result, bytes: pageBytes(result) };
  return Object.freeze({ ...result, records: Object.freeze([...result.records]) });
}

function maxBytes(value: number | undefined): number {
  if (value !== undefined && (!Number.isInteger(value) || value < 1024 || value > limits.pageBytes)) throw new AcpReadonlyError("invalid_request");
  return value ?? limits.pageBytes;
}

function validatePage(request: AcpReadonlyPageRequest, keys: string[]): void {
  if (!request || typeof request !== "object" || Object.keys(request).some((key) => !keys.includes(key))) throw new AcpReadonlyError("invalid_request");
  if (request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length > 64)) throw new AcpReadonlyError("invalid_request");
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) throw new AcpReadonlyError("invalid_request");
}

export function createReadonlyLease(snapshot: AcpReadonlySnapshot, initialData: LeaseData, signal: AbortSignal, onClose: () => void): { lease: AcpReadonlyLease; invalidate: () => void } {
  const lifetime = new AbortController();
  let data: LeaseData | undefined = initialData;
  let closed: "stale" | "aborted" | undefined;
  let active = false;
  let requests = 0;
  let bytes = Buffer.byteLength(JSON.stringify(snapshot));
  const cursors = new Map<string, { target: string; index: number; offset: number }>();
  const close = (reason: "stale" | "aborted"): void => {
    if (closed) return;
    closed = reason;
    data = undefined;
    cursors.clear();
    clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
    onClose();
    lifetime.abort(new AcpReadonlyError(reason));
  };
  const aborted = (): void => close("aborted");
  const timer = setTimeout(() => close("stale"), Math.max(0, snapshot.expiresAt - Date.now()));
  timer.unref();
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) close("aborted");
  const check = (operationSignal?: AbortSignal, deadline = Infinity): void => {
    if (signal.aborted || operationSignal?.aborted) throw new AcpReadonlyError("aborted");
    if (closed || Date.now() >= snapshot.expiresAt) { close("stale"); throw new AcpReadonlyError(closed ?? "stale"); }
    if (Date.now() >= deadline) throw new AcpReadonlyError("timeout");
  };
  const run = async (request: AcpReadonlyPageRequest, operation: (check: () => void) => Promise<AcpReadonlyPage>): Promise<AcpReadonlyPage> => {
    if (!request || typeof request !== "object") throw new AcpReadonlyError("invalid_request");
    if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) throw new AcpReadonlyError("invalid_request");
    check(request.signal);
    if (active) throw new AcpReadonlyError("busy");
    if (++requests > limits.requests || bytes >= limits.totalBytes) throw new AcpReadonlyError("budget_exceeded");
    active = true;
    const deadline = Date.now() + limits.operationMs;
    try {
      await yieldTurn();
      check(request.signal, deadline);
      const page = await operation(() => check(request.signal, deadline));
      check(request.signal, deadline);
      if (bytes + page.bytes > limits.totalBytes) throw new AcpReadonlyError("budget_exceeded");
      bytes += page.bytes;
      return page;
    } finally { active = false; }
  };
  const page = (records: readonly AcpReadonlyRecord[], target: string, request: AcpReadonlyPageRequest): AcpReadonlyPage => {
    const cap = maxBytes(request.maxBytes);
    const cursor = request.cursor ? cursors.get(request.cursor) : { target, index: 0, offset: 0 };
    if (!cursor || cursor.target !== target) throw new AcpReadonlyError("invalid_request");
    let { index, offset } = cursor;
    const chunks: AcpReadonlyChunk[] = [];
    const nextCursor = randomUUID();
    const build = (next: boolean): AcpReadonlyPage => finishPage({ snapshotId: snapshot.id, records: chunks, ...(next ? { nextCursor } : {}), bytes: 0 });
    while (index < records.length) {
      const record = records[index]!;
      const chunk = (end: number): AcpReadonlyChunk => Object.freeze({ ...record, text: record.text.slice(offset, end), offset, complete: end === record.text.length });
      const remaining = record.text.length;
      chunks.push(chunk(remaining));
      if (build(true).bytes <= cap) { index++; offset = 0; continue; }
      chunks.pop();
      let low = offset;
      let high = remaining;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        chunks.push(chunk(mid));
        const fits = build(true).bytes <= cap;
        chunks.pop();
        if (fits) low = mid; else high = mid - 1;
      }
      if (low < remaining && low > offset && /[\uD800-\uDBFF]/.test(record.text[low - 1]!)) low--;
      if (low === offset) {
        if (!chunks.length) throw new AcpReadonlyError("budget_exceeded");
        break;
      }
      chunks.push(chunk(low));
      offset = low;
      break;
    }
    const hasNext = index < records.length;
    if (hasNext) cursors.set(nextCursor, { target, index, offset });
    return build(hasNext);
  };
  const lease: AcpReadonlyLease = Object.freeze({
    snapshot,
    signal: lifetime.signal,
    context(request: AcpReadonlyPageRequest = {}) {
      return run(request, async () => {
        validatePage(request, ["cursor", "maxBytes", "signal"]);
        return page(data!.context, "context", request);
      });
    },
    decompress(request: AcpReadonlyPageRequest & { readonly ref: string }) {
      return run(request, async () => {
        validatePage(request, ["ref", "cursor", "maxBytes", "signal"]);
        if (typeof request.ref !== "string" || request.ref.length > 64) throw new AcpReadonlyError("invalid_request");
        const indexes = data!.targets.get(request.ref);
        if (!indexes) throw new AcpReadonlyError("unknown_ref");
        const records = indexes.map((index) => data!.evidence[index]).filter((record): record is AcpReadonlyRecord => record !== null && record !== undefined);
        if (!records.length) throw new AcpReadonlyError("unknown_ref");
        return page(records, `ref:${request.ref}`, request);
      });
    },
    search(request: AcpReadonlySearchRequest) {
      return run(request, async (checkOperation) => {
        validatePage(request, ["query", "limit", "maxBytes", "signal"]);
        if (typeof request.query !== "string" || !request.query.trim() || request.query.length > 256 || (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 20))) throw new AcpReadonlyError("invalid_request");
        const query = request.query.toLocaleLowerCase();
        const records: AcpReadonlyRecord[] = [];
        for (let i = 0; i < data!.evidence.length; i++) {
          if (i % 32 === 0) { await yieldTurn(); checkOperation(); }
          const record = data!.evidence[i];
          if (!record) continue;
          const at = record.text.toLocaleLowerCase().indexOf(query);
          if (at < 0) continue;
          records.push(frozenRecord({ ...record, text: record.text.slice(Math.max(0, at - 160), at + query.length + 320) }));
          if (records.length >= (request.limit ?? 10)) break;
        }
        const result = page(records, "search", request);
        if (result.nextCursor) cursors.delete(result.nextCursor);
        return finishPage({ snapshotId: snapshot.id, records: result.records, bytes: 0 });
      });
    },
    release: () => close("stale"),
  });
  return { lease, invalidate: () => close("stale") };
}
