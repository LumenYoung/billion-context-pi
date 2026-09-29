import { ACP_READONLY_LIMITS as limits, AcpReadonlyError, type AcpReadonlyRecord } from "./readonly-context.js";

export class ReadonlyBudget {
  private bytes = 0;
  private nodes = 0;
  constructor(private readonly cap: number) {}

  charge(bytes: number): void {
    if (bytes > this.cap - this.bytes) throw new AcpReadonlyError("budget_exceeded");
    this.bytes += bytes;
  }

  visit(): void {
    if (++this.nodes > limits.traversalNodes) throw new AcpReadonlyError("budget_exceeded");
  }
}

export function readonlyJsonBytes(value: unknown, cap: number, work?: ReadonlyBudget): number {
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  const charge = (size: number): void => {
    if (size > cap - bytes) throw new AcpReadonlyError("budget_exceeded");
    work?.charge(size);
    bytes += size;
  };
  const string = (text: string): void => {
    if (text.length > cap - bytes) throw new AcpReadonlyError("budget_exceeded");
    charge(text.length + 2);
    charge(Buffer.byteLength(text) - text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) charge(1);
      else if (code < 32) charge(5);
      else if (code >= 0xD800 && code <= 0xDBFF && text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF) i++;
      else if (code >= 0xD800 && code <= 0xDFFF) charge(3);
    }
  };
  while (pending.length) {
    const frame = pending.pop()!;
    const item = frame.value;
    if (frame.exit && item && typeof item === "object") { seen.delete(item); continue; }
    work?.visit();
    if (++nodes > limits.traversalNodes || frame.depth > limits.metadataDepth) throw new AcpReadonlyError("budget_exceeded");
    if (typeof item === "string") string(item);
    else if (typeof item === "number") charge(Number.isFinite(item) ? String(item).length : 4);
    else if (item === null || item === undefined || typeof item === "boolean") charge(5);
    else if (typeof item === "object") {
      if (seen.has(item)) throw new AcpReadonlyError("invalid_request");
      const prototype = Object.getPrototypeOf(item);
      if ((prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) || "toJSON" in item) throw new AcpReadonlyError("invalid_request");
      seen.add(item);
      charge(2);
      pending.push({ value: item, depth: frame.depth, exit: true });
      if (Array.isArray(item)) {
        if (item.length > limits.records || pending.length + item.length > limits.traversalNodes) throw new AcpReadonlyError("budget_exceeded");
        for (let i = 0; i < item.length; i++) {
          charge(1);
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (descriptor?.get || descriptor?.set) throw new AcpReadonlyError("invalid_request");
          pending.push({ value: descriptor?.value, depth: frame.depth + 1 });
        }
        continue;
      }
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || descriptor.get || descriptor.set) throw new AcpReadonlyError("invalid_request");
        string(key);
        charge(2);
        if (pending.length >= limits.traversalNodes) throw new AcpReadonlyError("budget_exceeded");
        pending.push({ value: (item as Record<string, unknown>)[key], depth: frame.depth + 1 });
      }
    } else throw new AcpReadonlyError("invalid_request");
  }
  return bytes;
}

export function readonlyRecordBytes(record: AcpReadonlyRecord): number {
  return readonlyJsonBytes(record, limits.recordBytes);
}
