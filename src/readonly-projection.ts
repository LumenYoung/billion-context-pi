import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { randomUUID } from "node:crypto";
import { ACP_READONLY_LIMITS as limits, AcpReadonlyError, type AcpReadonlyRecord, type AcpReadonlySnapshot } from "./readonly-context.js";

export interface ReadonlyCapture {
  readonly snapshot: AcpReadonlySnapshot;
  readonly context: readonly AcpReadonlyRecord[];
  readonly evidence: readonly AcpReadonlyRecord[];
  readonly targets: ReadonlyMap<string, readonly number[]>;
}

type Provenance = Pick<AcpReadonlyRecord, "toolNames" | "provenanceComplete">;
const retrievalTools = new Set(["decompress", "search_context", "acp_status"]);
const baseId = (id: string): string => id.split("#")[0]!;

export function frozenRecord(record: AcpReadonlyRecord): AcpReadonlyRecord {
  return Object.freeze({ ...record, refs: Object.freeze([...record.refs]), toolNames: Object.freeze([...record.toolNames]) });
}

function jsonArguments(value: unknown): string {
  const pending: { value: unknown; exit?: boolean }[] = [{ value }];
  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  while (pending.length) {
    const frame = pending.pop()!;
    const item = frame.value;
    if (frame.exit && item && typeof item === "object") { seen.delete(item); continue; }
    if (++nodes > limits.records || bytes > limits.captureBytes) throw new AcpReadonlyError("budget_exceeded");
    if (typeof item === "string") bytes += Buffer.byteLength(item);
    else if (item && typeof item === "object") {
      if (seen.has(item)) throw new AcpReadonlyError("invalid_request");
      seen.add(item);
      pending.push({ value: item, exit: true });
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        bytes += Buffer.byteLength(key) + 8;
        if (pending.length >= limits.records || bytes > limits.captureBytes) throw new AcpReadonlyError("budget_exceeded");
        pending.push({ value: (item as Record<string, unknown>)[key] });
      }
    }
  }
  if (bytes > limits.captureBytes) throw new AcpReadonlyError("budget_exceeded");
  const text = JSON.stringify(value) ?? "";
  if (Buffer.byteLength(text) > limits.captureBytes) throw new AcpReadonlyError("budget_exceeded");
  return text;
}

function messageText(message: SessionMessageEntry["message"]): string {
  const msg = message as { content?: unknown };
  if (typeof msg.content === "string") return msg.content;
  const parts: string[] = [];
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      const item = part as { type?: string; text?: string; name?: string; arguments?: unknown };
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      if (item.type === "toolCall") parts.push(`${item.name ?? "tool"}: ${jsonArguments(item.arguments)}`);
    }
  }
  return parts.join("\n");
}

export function captureReadonlyProjection(input: {
  sessionId: string;
  generation: number;
  originals: readonly CoreMessage[];
  originalMessages: ReadonlyMap<string, SessionMessageEntry["message"]>;
  unattributedIds?: ReadonlySet<string>;
  transformed: readonly CoreMessage[];
  output: readonly SessionMessageEntry["message"][];
  state: CompressionState;
  now?: number;
}): ReadonlyCapture {
  const { originals, transformed, output, state } = input;
  let bytes = 0;
  const charge = (value: unknown): void => {
    bytes += Buffer.byteLength(jsonArguments(value));
    if (bytes > limits.captureBytes) throw new AcpReadonlyError("budget_exceeded");
  };
  if (originals.length + output.length + state.blocks.length > limits.records) throw new AcpReadonlyError("budget_exceeded");
  // Account source strings and coverage metadata before allocating derived copies.
  for (const core of originals) charge(core);
  for (const block of state.blocks) charge(block);
  const byId = new Map(originals.map((core) => [core.id, core]));
  const blocks = new Map(state.blocks.map((block) => [block.blockId, block]));
  const callBlocks = new Map<string, string[]>();
  for (const block of state.blocks) {
    if (!block.compressCallId) continue;
    const ids = callBlocks.get(block.compressCallId) ?? [];
    ids.push(block.blockId);
    callBlocks.set(block.compressCallId, ids);
  }
  const union = (parts: Provenance[]): Provenance => ({
    toolNames: [...new Set(parts.flatMap((part) => part.toolNames))].sort(),
    provenanceComplete: parts.length > 0 && parts.every((part) => part.provenanceComplete),
  });
  const unknown: Provenance = { toolNames: [], provenanceComplete: false };
  const provenanceCache = new Map<string, Provenance>();
  const visiting = new Set<string>();
  const blockProvenance = (id: string): Provenance => {
    const cached = provenanceCache.get(id);
    if (cached) return cached;
    const block = blocks.get(id);
    if (!block || visiting.has(id) || visiting.size >= 64) return unknown;
    visiting.add(id);
    const parts = block.effectiveMessageIds.map((raw) => coreProvenance(byId.get(raw)));
    parts.push(...block.directBlockIds.map(blockProvenance));
    const result = union(parts);
    visiting.delete(id);
    provenanceCache.set(id, result);
    return result;
  };
  const coreProvenance = (core: CoreMessage | undefined): Provenance => {
    if (!core) return unknown;
    const names = core.toolName ? [core.toolName] : [];
    const originalRole = input.originalMessages.get(baseId(core.id))?.role;
    let complete = !input.unattributedIds?.has(baseId(core.id)) && core.role !== "system" && !(core.role === "tool" && !core.toolName) && (originalRole === undefined || originalRole === "user" || originalRole === "assistant" || originalRole === "toolResult");
    if (core.toolName && retrievalTools.has(core.toolName)) complete = false;
    const related = core.toolCallId ? callBlocks.get(core.toolCallId) : undefined;
    if (core.toolName === "compress" && !related) complete = false;
    return union([{ toolNames: names, provenanceComplete: complete }, ...(related ?? []).map(blockProvenance)]);
  };
  const grouped = new Map<string, CoreMessage[]>();
  for (const core of originals) {
    const group = grouped.get(baseId(core.id)) ?? [];
    group.push(core);
    grouped.set(baseId(core.id), group);
  }
  const evidence: AcpReadonlyRecord[] = [];
  const targets = new Map<string, readonly number[]>();
  const rawIndexes = new Map<string, number>();
  const refsFor = (cores: readonly CoreMessage[], index: number): string[] => cores.map((core, i) => {
    const ref = state.messageRefs.byRaw[core.id];
    return ref && /^m\d+$/.test(ref) ? ref : `o${index}_${i}`;
  });
  const add = (record: AcpReadonlyRecord): AcpReadonlyRecord => {
    charge(record);
    return frozenRecord(record);
  };
  for (const cores of grouped.values()) {
    const first = cores[0]!;
    const index = evidence.length;
    const refs = refsFor(cores, index);
    const kind = first.contentType === "tool-call" || first.contentType === "tool-result" ? first.contentType : first.role === "user" ? "user" : "assistant";
    const original = input.originalMessages.get(baseId(first.id));
    const text = (original ? messageText(original) : "") || cores.map((core) => core.text ?? "").join("\n");
    const record = add({ ref: refs[0]!, refs, kind, text, ...union(cores.map(coreProvenance)) });
    evidence.push(record);
    for (const ref of refs) {
      if (targets.has(ref)) throw new AcpReadonlyError("invalid_request");
      targets.set(ref, Object.freeze([index]));
    }
    for (const core of cores) rawIndexes.set(core.id, index);
  }
  for (const block of state.blocks) {
    if (!/^b\d+$/.test(block.blockId)) throw new AcpReadonlyError("invalid_request");
    const provenance = blockProvenance(block.blockId);
    evidence.push(add({ ref: block.blockId, refs: [block.blockId], kind: "summary", text: block.topic ? `${block.topic}\n${block.summary}` : block.summary, ...provenance }));
    const indexes = block.effectiveMessageIds.map((raw) => rawIndexes.get(raw));
    if (indexes.length && indexes.every((index): index is number => index !== undefined)) {
      targets.set(block.blockId, Object.freeze([...new Set(indexes)].sort((a, b) => a - b)));
    }
  }
  const outputIds = [...new Set(transformed.filter((core) => !core.id.startsWith("acp_summary_")).map((core) => baseId(core.id)))].filter((id) => input.originalMessages.has(id));
  const context: AcpReadonlyRecord[] = [];
  for (const [index, message] of output.entries()) {
    const msg = message as { role: string; content?: unknown; toolName?: string };
    if (msg.role === "system") continue;
    const cores = grouped.get(outputIds[index] ?? "");
    const refs = cores ? refsFor(cores, rawIndexes.get(cores[0]!.id)!) : [`s${index}`];
    const text = messageText(message);
    const kind = !cores ? "synthetic" : msg.role === "toolResult" ? "tool-result" : cores.some((core) => core.contentType === "tool-call") ? "tool-call" : msg.role === "assistant" ? "assistant" : "user";
    const provenance = cores ? union(cores.map(coreProvenance)) : unknown;
    context.push(add({ ref: refs[0]!, refs, kind, text, ...provenance }));
  }
  for (const [ref, indexes] of targets) charge([ref, indexes]);
  const createdAt = input.now ?? Date.now();
  const snapshot = Object.freeze({ id: randomUUID(), sessionId: input.sessionId, generation: input.generation, createdAt, expiresAt: createdAt + limits.lifetimeMs, fidelity: "acp-text-projection" as const });
  charge(snapshot);
  return Object.freeze({ snapshot, context: Object.freeze(context), evidence: Object.freeze(evidence), targets });
}
