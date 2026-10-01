import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { type AcpReadonlyRecord, type AcpReadonlySnapshot } from "./readonly-context.js";
export interface ReadonlyCapture {
    readonly snapshot: AcpReadonlySnapshot;
    readonly context: readonly AcpReadonlyRecord[];
    readonly evidence: readonly (AcpReadonlyRecord | null)[];
    readonly targets: ReadonlyMap<string, readonly number[]>;
}
export declare function frozenRecord(record: AcpReadonlyRecord): AcpReadonlyRecord;
export declare function captureReadonlyProjection(input: {
    sessionId: string;
    generation: number;
    originals: readonly CoreMessage[];
    originalMessages: ReadonlyMap<string, SessionMessageEntry["message"]>;
    unattributedIds?: ReadonlySet<string>;
    transformed: readonly CoreMessage[];
    output: readonly SessionMessageEntry["message"][];
    state: CompressionState;
    now?: number;
}): ReadonlyCapture;
