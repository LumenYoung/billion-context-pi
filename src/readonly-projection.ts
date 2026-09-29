import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { randomUUID } from "node:crypto";
import { ReadonlyBudget, readonlyJsonBytes, readonlyRecordBytes } from "./readonly-budget.js";
import { ACP_READONLY_LIMITS as limits, AcpReadonlyError, type AcpReadonlyRecord, type AcpReadonlySnapshot } from "./readonly-context.js";

export interface ReadonlyCapture {
  readonly snapshot: AcpReadonlySnapshot;
  readonly context: readonly AcpReadonlyRecord[];
  readonly evidence: readonly (AcpReadonlyRecord | null)[];
  readonly targets: ReadonlyMap<string, readonly number[]>;
}

type Provenance = Pick<AcpReadonlyRecord, "toolNames" | "provenanceComplete">;
const retrievalTools = new Set(["decompress", "search_context", "acp_status"]);
const baseId = (id: string): string => id.split("#")[0]!;

export function frozenRecord(record: AcpReadonlyRecord): AcpReadonlyRecord {
  return Object.freeze({ ...record, refs: Object.freeze([...record.refs]), toolNames: Object.freeze([...record.toolNames]) });
}

function messageText(value: unknown, work: ReadonlyBudget): string {
  const message = value as { content?: unknown };
  const parts: string[] = [];
  let bytes = 0;
  const append = (...segments: string[]): void => {
    let size = parts.length ? 1 : 0;
    work.charge(size);
    for (const text of segments) {
      if (text.length > limits.recordBytes - bytes - size) throw new AcpReadonlyError("budget_exceeded");
      work.charge(text.length);
      const textBytes = Buffer.byteLength(text);
      work.charge(textBytes - text.length);
      size += textBytes;
      if (size > limits.recordBytes - bytes) throw new AcpReadonlyError("budget_exceeded");
    }
    bytes += size;
    parts.push(segments.join(""));
  };
  if (typeof message.content === "string") append(message.content);
  else if (Array.isArray(message.content)) {
    if (message.content.length > limits.records) throw new AcpReadonlyError("budget_exceeded");
    for (const part of message.content) {
      work.visit();
      if (!part || typeof part !== "object") continue;
      const item = part as { type?: string; text?: string; name?: string; arguments?: unknown };
      if (item.type === "text" && typeof item.text === "string") append(item.text);
      if (item.type === "toolCall") {
        readonlyJsonBytes(item.arguments, limits.recordBytes - bytes, work);
        append(item.name ?? "tool", ": ", JSON.stringify(item.arguments) ?? "");
      }
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
  const metadata = new ReadonlyBudget(limits.metadataBytes);
  const historyWork = new ReadonlyBudget(limits.historyBytes);
  const currentWork = new ReadonlyBudget(limits.captureBytes);
  let historyBytes = 0;
  let currentBytes = 0;
  const chargeMetadata = (value: unknown): void => { readonlyJsonBytes(value, limits.metadataBytes, metadata); };
  if (originals.length + output.length + state.blocks.length + transformed.length > limits.records) throw new AcpReadonlyError("budget_exceeded");
  for (const core of originals) chargeMetadata([core.id, core.role, core.contentType, core.toolName, core.toolCallId, state.messageRefs.byRaw[core.id]]);
  for (const core of transformed) chargeMetadata(core.id);
  for (const block of state.blocks) {
    if (typeof block.blockId !== "string" || !Array.isArray(block.effectiveMessageIds) || !Array.isArray(block.directBlockIds)) throw new AcpReadonlyError("invalid_request");
    if (block.effectiveMessageIds.length + block.directBlockIds.length > limits.records) throw new AcpReadonlyError("budget_exceeded");
    if (!block.effectiveMessageIds.every((id) => typeof id === "string") || !block.directBlockIds.every((id) => typeof id === "string")) throw new AcpReadonlyError("invalid_request");
    chargeMetadata([block.blockId, block.compressCallId, block.effectiveMessageIds, block.directBlockIds]);
  }
  const byId = new Map(originals.map((core) => [core.id, core]));
  const blocks = new Map(state.blocks.map((block) => [block.blockId, block]));
  if (blocks.size !== state.blocks.length || byId.size !== originals.length) throw new AcpReadonlyError("invalid_request");
  const callBlocks = new Map<string, string[]>();
  for (const block of state.blocks) {
    if (!block.compressCallId) continue;
    const ids = callBlocks.get(block.compressCallId) ?? [];
    ids.push(block.blockId);
    callBlocks.set(block.compressCallId, ids);
  }
  const union = (parts: Provenance[]): Provenance => {
    const names = new Set<string>();
    let complete = parts.length > 0;
    for (const part of parts) {
      metadata.visit();
      complete &&= part.provenanceComplete;
      for (const name of part.toolNames) {
        metadata.visit();
        if (!names.has(name)) { metadata.charge(Buffer.byteLength(name)); names.add(name); }
      }
    }
    return { toolNames: [...names].sort(), provenanceComplete: complete };
  };
  const unknown: Provenance = { toolNames: [], provenanceComplete: false };
  const provenanceCache = new Map<string, Provenance>();
  const visiting = new Set<string>();
  const blockProvenance = (id: string): Provenance => {
    const cached = provenanceCache.get(id);
    if (cached) return cached;
    const block = blocks.get(id);
    if (!block) return unknown;
    if (visiting.has(id)) throw new AcpReadonlyError("invalid_request");
    if (visiting.size >= limits.metadataDepth) throw new AcpReadonlyError("budget_exceeded");
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
  const evidence: (AcpReadonlyRecord | null)[] = [];
  const targets = new Map<string, readonly number[]>();
  const rawIndexes = new Map<string, number>();
  const refsFor = (cores: readonly CoreMessage[], index: number): string[] => cores.map((core, i) => {
    const ref = state.messageRefs.byRaw[core.id];
    return ref && /^m\d+$/.test(ref) ? ref : `o${index}_${i}`;
  });
  const historical = (project: () => AcpReadonlyRecord): AcpReadonlyRecord | null => {
    try {
      const record = project();
      const size = readonlyRecordBytes(record);
      if (size > limits.historyBytes - historyBytes) throw new AcpReadonlyError("budget_exceeded");
      historyBytes += size;
      return frozenRecord(record);
    } catch (error) {
      if (error instanceof AcpReadonlyError && error.code === "budget_exceeded") return null;
      throw error;
    }
  };
  for (const cores of grouped.values()) {
    const first = cores[0]!;
    const index = evidence.length;
    const refs = refsFor(cores, index);
    const kind = first.contentType === "tool-call" || first.contentType === "tool-result" ? first.contentType : first.role === "user" ? "user" : "assistant";
    const original = input.originalMessages.get(baseId(first.id));
    const provenance = union(cores.map(coreProvenance));
    chargeMetadata([refs, provenance]);
    const record = historical(() => {
      const text = (original ? messageText(original, historyWork) : "") || messageText({ content: cores.map((core) => ({ type: "text", text: core.text ?? "" })) }, historyWork);
      return { ref: refs[0]!, refs, kind, text, ...provenance };
    });
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
    chargeMetadata(provenance);
    evidence.push(historical(() => ({ ref: block.blockId, refs: [block.blockId], kind: "summary", text: messageText({ content: [...(block.topic ? [{ type: "text", text: block.topic }] : []), { type: "text", text: block.summary }] }, historyWork), ...provenance })));
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
    const text = messageText(message, currentWork);
    const kind = !cores ? "synthetic" : msg.role === "toolResult" ? "tool-result" : cores.some((core) => core.contentType === "tool-call") ? "tool-call" : msg.role === "assistant" ? "assistant" : "user";
    const provenance = cores ? union(cores.map(coreProvenance)) : unknown;
    const record: AcpReadonlyRecord = { ref: refs[0]!, refs, kind, text, ...provenance };
    currentBytes += readonlyRecordBytes(record);
    if (currentBytes > limits.captureBytes) throw new AcpReadonlyError("budget_exceeded");
    context.push(frozenRecord(record));
  }
  for (const [ref, indexes] of targets) chargeMetadata([ref, indexes]);
  const createdAt = input.now ?? Date.now();
  const snapshot = Object.freeze({ id: randomUUID(), sessionId: input.sessionId, generation: input.generation, createdAt, expiresAt: createdAt + limits.lifetimeMs, fidelity: "acp-text-projection" as const });
  chargeMetadata(snapshot);
  return Object.freeze({ snapshot, context: Object.freeze(context), evidence: Object.freeze(evidence), targets });
}
