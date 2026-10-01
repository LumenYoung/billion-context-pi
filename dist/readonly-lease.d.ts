import { AcpReadonlyError, type AcpReadonlyAcquireRequest, type AcpReadonlyLease, type AcpReadonlyRecord, type AcpReadonlySnapshot } from "./readonly-context.js";
import { type ReadonlyCapture } from "./readonly-projection.js";
interface LeaseData {
    context: readonly AcpReadonlyRecord[];
    evidence: readonly (AcpReadonlyRecord | null)[];
    targets: ReadonlyMap<string, readonly number[]>;
    sanitize: AcpReadonlyAcquireRequest["sanitize"];
    cache: Map<number, AcpReadonlyRecord | null | AcpReadonlyError>;
    cacheBytes: number;
}
export declare function sanitizeCapture(capture: ReadonlyCapture, request: AcpReadonlyAcquireRequest, check: () => void): Promise<LeaseData>;
export declare function createReadonlyLease(snapshot: AcpReadonlySnapshot, initialData: LeaseData, signal: AbortSignal, onClose: () => void): {
    lease: AcpReadonlyLease;
    invalidate: () => void;
};
export {};
