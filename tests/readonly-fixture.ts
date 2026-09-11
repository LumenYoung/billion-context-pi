import assert from "node:assert/strict";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { coreOutToAgentMessages, entriesToCoreMessages } from "../src/messages.js";
import { ReadonlyContextBridge } from "../src/readonly-bridge.js";
import type { AcpReadonlyAcquireRequest, AcpReadonlyLease, AcpReadonlyRecord } from "../src/readonly-context.js";

export type Message = SessionMessageEntry["message"];
export const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
export const assistant = (content: unknown[]): Message => ({ role: "assistant", content, timestamp: 0 }) as unknown as Message;
export const result = (toolName: string, toolCallId: string, text: string): Message => ({ role: "toolResult", toolName, toolCallId, content: [{ type: "text", text }], isError: false, timestamp: 0 });
export const entry = (message: Message, id: string): SessionMessageEntry => ({ type: "message", id, parentId: null, timestamp: "", message });

export function fixture(text = "ORIGINAL_EVIDENCE password=secret-secret . ".repeat(100)) {
  const entries = [
    entry(user("Task: diagnose safely"), "root"),
    entry(assistant([{ type: "toolCall", id: "read-1", name: "bash", arguments: { command: "echo evidence" } }]), "call"),
    entry(result("bash", "read-1", text), "result"),
    entry(assistant([{ type: "text", text: "Diagnosis so far" }, { type: "thinking", thinking: "NEVER_REASONING" }]), "answer"),
    entry(user("Continue"), "next"),
  ];
  const core = createCore();
  const config = { ...defaultConfig(), modelContextLimit: 200000, preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 0, minSummaryLength: 0, maxSummaryLength: 0 } };
  const originals = entriesToCoreMessages(entries);
  const first = core.processTurn({ messages: originals, state: createInitialState(), config, tokenCount: 2000 });
  const compression = core.applyCompression({ messages: originals, state: first.state, config, ranges: [{ startRef: first.state.messageRefs.byRaw.call!, endRef: first.state.messageRefs.byRaw.result!, summary: "Summary reveals ORIGINAL_EVIDENCE password=secret-secret", compressCallId: "compress-1" }] });
  assert.equal(compression.result.blocksCreated, 1, compression.result.errors.join(";"));
  entries.push(entry(assistant([{ type: "toolCall", name: "compress", id: "compress-1", arguments: { content: [{ summary: "Summary reveals ORIGINAL_EVIDENCE password=secret-secret" }] } }]), "compress-call"));
  entries.push(entry(result("compress", "compress-1", "Compressed b1: Summary reveals ORIGINAL_EVIDENCE password=secret-secret"), "compress-result"));
  const all = entriesToCoreMessages(entries);
  const turn = core.processTurn({ messages: all, state: compression.state, config, tokenCount: 2000 });
  const originalMessages = new Map(entries.map((item) => [item.id, item.message]));
  const output = coreOutToAgentMessages(turn.messages, originalMessages);
  return { originals: all, originalMessages, transformed: turn.messages, output, state: turn.state, entries };
}

export function capture(input = fixture(), sessionId = "session-a") {
  const bridge = new ReadonlyContextBridge();
  bridge.start(sessionId);
  bridge.capture(sessionId, bridge.begin(sessionId), input);
  return bridge;
}

export const identity = (record: AcpReadonlyRecord): string => record.text;
export async function acquire(bridge: ReadonlyContextBridge, changes: Partial<AcpReadonlyAcquireRequest> = {}): Promise<AcpReadonlyLease> {
  const result = await bridge.acquire({ version: 1, sessionId: "session-a", signal: new AbortController().signal, sanitize: identity, respond: () => {}, ...changes });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.ok(result.ok);
  return result.lease;
}
