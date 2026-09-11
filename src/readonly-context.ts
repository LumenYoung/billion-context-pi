export const ACP_READONLY_CONTEXT_EVENT = "billion-context-pi:readonly-context:v1:acquire";
export const ACP_READONLY_CONTEXT_VERSION = 1;
export const ACP_READONLY_LIMITS = Object.freeze({
  captureBytes: 8 * 1024 * 1024,
  pageBytes: 64 * 1024,
  totalBytes: 512 * 1024,
  requests: 64,
  leases: 2,
  lifetimeMs: 5 * 60 * 1000,
  operationMs: 5000,
  records: 32768,
});

export type AcpReadonlyErrorCode =
  | "unavailable" | "unsupported_version" | "stale" | "aborted"
  | "budget_exceeded" | "busy" | "invalid_request" | "unknown_ref"
  | "sanitizer_failed" | "timeout";

export class AcpReadonlyError extends Error {
  constructor(readonly code: AcpReadonlyErrorCode) {
    super(`ACP read-only context: ${code}`);
    this.name = "AcpReadonlyError";
  }
}

export interface AcpReadonlyRecord {
  readonly ref: string;
  readonly refs: readonly string[];
  readonly kind: "user" | "assistant" | "tool-call" | "tool-result" | "summary" | "synthetic";
  readonly text: string;
  readonly toolNames: readonly string[];
  readonly provenanceComplete: boolean;
}

export interface AcpReadonlySnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly fidelity: "acp-text-projection";
}

export interface AcpReadonlyPageRequest {
  readonly cursor?: string;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface AcpReadonlyChunk extends AcpReadonlyRecord {
  readonly offset: number;
  readonly complete: boolean;
}

export interface AcpReadonlyPage {
  readonly snapshotId: string;
  readonly records: readonly AcpReadonlyChunk[];
  readonly nextCursor?: string;
  readonly bytes: number;
}

export interface AcpReadonlySearchRequest {
  readonly query: string;
  readonly limit?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface AcpReadonlyLease {
  readonly signal: AbortSignal;
  readonly snapshot: AcpReadonlySnapshot;
  context(request?: AcpReadonlyPageRequest): Promise<AcpReadonlyPage>;
  search(request: AcpReadonlySearchRequest): Promise<AcpReadonlyPage>;
  decompress(request: AcpReadonlyPageRequest & { readonly ref: string }): Promise<AcpReadonlyPage>;
  release(): void;
}

export type AcpReadonlyAcquireResult =
  | { readonly ok: true; readonly lease: AcpReadonlyLease }
  | { readonly ok: false; readonly error: AcpReadonlyErrorCode };

// Trusted extension-host callback, never exposed as a model tool or to model arguments.
// Applied to a complete frozen record before any search, snippet, or page slicing.
export interface AcpReadonlyAcquireRequest {
  readonly version: number;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly sanitize: (record: AcpReadonlyRecord) => string | null;
  readonly respond: (result: AcpReadonlyAcquireResult) => void;
}
