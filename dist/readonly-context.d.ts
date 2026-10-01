export declare const ACP_READONLY_CONTEXT_EVENT = "billion-context-pi:readonly-context:v1:acquire";
export declare const ACP_READONLY_CONTEXT_VERSION = 1;
export declare const ACP_READONLY_LIMITS: Readonly<{
    captureBytes: number;
    historyBytes: number;
    metadataBytes: number;
    recordBytes: number;
    searchBytes: number;
    traversalNodes: 262144;
    metadataDepth: 64;
    pageBytes: number;
    totalBytes: number;
    requests: 64;
    leases: 2;
    lifetimeMs: number;
    operationMs: 5000;
    records: 32768;
}>;
export type AcpReadonlyErrorCode = "unavailable" | "unsupported_version" | "stale" | "aborted" | "budget_exceeded" | "busy" | "invalid_request" | "unknown_ref" | "sanitizer_failed" | "timeout";
export declare class AcpReadonlyError extends Error {
    readonly code: AcpReadonlyErrorCode;
    constructor(code: AcpReadonlyErrorCode);
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
    decompress(request: AcpReadonlyPageRequest & {
        readonly ref: string;
    }): Promise<AcpReadonlyPage>;
    release(): void;
}
export type AcpReadonlyAcquireResult = {
    readonly ok: true;
    readonly lease: AcpReadonlyLease;
} | {
    readonly ok: false;
    readonly error: AcpReadonlyErrorCode;
};
export interface AcpReadonlyAcquireRequest {
    readonly version: number;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly sanitize: (record: AcpReadonlyRecord) => string | null;
    readonly respond: (result: AcpReadonlyAcquireResult) => void;
}
