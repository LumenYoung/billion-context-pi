import { type AcpReadonlyRecord } from "./readonly-context.js";
export declare class ReadonlyBudget {
    private readonly cap;
    private bytes;
    private nodes;
    constructor(cap: number);
    charge(bytes: number): void;
    visit(): void;
}
export declare function readonlyJsonBytes(value: unknown, cap: number, work?: ReadonlyBudget): number;
export declare function readonlyRecordBytes(record: AcpReadonlyRecord): number;
