import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACP_READONLY_CONTEXT_EVENT, ACP_READONLY_CONTEXT_VERSION, ACP_READONLY_LIMITS as limits, AcpReadonlyError, type AcpReadonlyAcquireRequest, type AcpReadonlyAcquireResult, type AcpReadonlyErrorCode } from "./readonly-context.js";
import { captureReadonlyProjection, type ReadonlyCapture } from "./readonly-projection.js";
import { createReadonlyLease, sanitizeCapture } from "./readonly-lease.js";

type CaptureInput = Omit<Parameters<typeof captureReadonlyProjection>[0], "sessionId" | "generation">;

export class ReadonlyContextBridge {
  private sessionId: string | undefined;
  private generation = 0;
  private epoch = 0;
  private latest: ReadonlyCapture | undefined;
  private unavailable: AcpReadonlyErrorCode = "unavailable";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private leases = new Set<() => void>();
  private pending = 0;

  invalidate(): void {
    this.epoch++;
    this.generation++;
    this.latest = undefined;
    this.unavailable = "stale";
    clearTimeout(this.timer);
    for (const invalidate of [...this.leases]) invalidate();
  }

  start(sessionId: string): void {
    this.invalidate();
    this.sessionId = sessionId;
    this.unavailable = "unavailable";
  }

  begin(sessionId: string): number {
    if (this.sessionId !== sessionId) this.start(sessionId);
    this.latest = undefined;
    this.unavailable = "stale";
    clearTimeout(this.timer);
    return ++this.generation;
  }

  capture(sessionId: string, generation: number, input: CaptureInput): void {
    if (this.sessionId !== sessionId || generation !== this.generation) return;
    try {
      this.latest = captureReadonlyProjection({ ...input, sessionId, generation });
      const captured = this.latest;
      this.timer = setTimeout(() => {
        if (this.latest === captured) { this.latest = undefined; this.unavailable = "stale"; }
      }, limits.lifetimeMs);
      this.timer.unref();
    } catch (error) {
      this.latest = undefined;
      this.unavailable = error instanceof AcpReadonlyError ? error.code : "unavailable";
    }
  }

  async acquire(request: AcpReadonlyAcquireRequest): Promise<AcpReadonlyAcquireResult> {
    const capture = this.latest;
    const epoch = this.epoch;
    const deadline = Date.now() + limits.operationMs;
    const check = (): void => {
      if (request.signal.aborted) throw new AcpReadonlyError("aborted");
      if (this.epoch !== epoch || this.latest !== capture || (capture && Date.now() >= capture.snapshot.expiresAt)) throw new AcpReadonlyError("stale");
      if (Date.now() >= deadline) throw new AcpReadonlyError("timeout");
    };
    let reserved = false;
    try {
      if (!request || typeof request !== "object" || request.version !== ACP_READONLY_CONTEXT_VERSION) throw new AcpReadonlyError("unsupported_version");
      if (typeof request.sessionId !== "string" || !(request.signal instanceof AbortSignal) || typeof request.sanitize !== "function") throw new AcpReadonlyError("invalid_request");
      if (request.sessionId !== this.sessionId) throw new AcpReadonlyError("unavailable");
      if (!capture) throw new AcpReadonlyError(this.unavailable);
      check();
      if (this.pending + this.leases.size >= limits.leases) throw new AcpReadonlyError("busy");
      this.pending++;
      reserved = true;
      const data = await sanitizeCapture(capture, request, check);
      check();
      const handle = createReadonlyLease(capture.snapshot, data, request.signal, () => this.leases.delete(handle.invalidate));
      this.leases.add(handle.invalidate);
      return Object.freeze({ ok: true, lease: handle.lease });
    } catch (error) {
      return Object.freeze({ ok: false, error: error instanceof AcpReadonlyError ? error.code : "unavailable" });
    } finally {
      if (reserved) this.pending--;
    }
  }

  accepts(sessionId: unknown): boolean { return sessionId === this.sessionId; }
}

export function wireReadonlyContext(pi: ExtensionAPI): ReadonlyContextBridge {
  const bridge = new ReadonlyContextBridge();
  let unsubscribe: (() => void) | undefined;
  const listen = (): void => {
    if (unsubscribe || !pi.events?.on) return;
    unsubscribe = pi.events.on(ACP_READONLY_CONTEXT_EVENT, (value) => {
      if (!value || typeof value !== "object") return;
      const request = value as AcpReadonlyAcquireRequest;
      if (typeof request.respond !== "function" || !bridge.accepts(request.sessionId)) return;
      void bridge.acquire(request).then((result) => {
        try { request.respond(result); }
        catch { if (result.ok) result.lease.release(); }
      });
    });
  };
  listen();
  pi.on("session_start", (_event, ctx) => { bridge.start(ctx.sessionManager.getSessionId()); listen(); });
  const invalidate = (): void => bridge.invalidate();
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("session_before_compact", invalidate);
  pi.on("session_compact", invalidate);
  pi.on("session_shutdown", () => { bridge.invalidate(); unsubscribe?.(); unsubscribe = undefined; });
  return bridge;
}

