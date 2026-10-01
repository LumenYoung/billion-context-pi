import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AcpReadonlyAcquireRequest, type AcpReadonlyAcquireResult } from "./readonly-context.js";
import { captureReadonlyProjection } from "./readonly-projection.js";
type CaptureInput = Omit<Parameters<typeof captureReadonlyProjection>[0], "sessionId" | "generation">;
export declare class ReadonlyContextBridge {
    private sessionId;
    private generation;
    private epoch;
    private latest;
    private unavailable;
    private timer;
    private leases;
    private pending;
    invalidate(): void;
    start(sessionId: string): void;
    begin(sessionId: string): number;
    capture(sessionId: string, generation: number, input: CaptureInput): void;
    acquire(request: AcpReadonlyAcquireRequest): Promise<AcpReadonlyAcquireResult>;
    accepts(sessionId: unknown): boolean;
}
export declare function wireReadonlyContext(pi: ExtensionAPI): ReadonlyContextBridge;
export {};
