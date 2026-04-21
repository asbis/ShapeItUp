/**
 * Bug C smoke tests for the armPendingRender / awaitNextRender handshake.
 *
 * The real ViewerProvider is coupled to `vscode` (not available in vitest),
 * so we copy the two methods' logic verbatim into a test double below. If
 * you edit armPendingRender/awaitNextRender in viewer-provider.ts, please
 * keep this double in sync — it's a behavior contract, not a mock.
 */
import { describe, it, expect } from "vitest";

class PendingRenderDouble {
  private pendingRenderResolve?: () => void;
  private pendingRenderReject?: (err: Error) => void;
  private pendingRenderPromise?: Promise<void>;
  // P1 fix: stale-PNG guard. Mirrors the real ViewerProvider's lastRenderError
  // field plus its takeLastRenderError consume-once accessor. Cleared on every
  // armPendingRender call so a worker error from a prior render can't leak
  // into the next render's response.
  private lastRenderError?: { message: string; stack?: string; operation?: string; timestamp: number };

  armPendingRender(): void {
    this.lastRenderError = undefined;
    if (this.pendingRenderReject) {
      this.pendingRenderReject(new Error("render superseded by new executeScript"));
    }
    this.pendingRenderPromise = new Promise<void>((resolve, reject) => {
      this.pendingRenderResolve = resolve;
      this.pendingRenderReject = reject;
    });
    this.pendingRenderPromise.catch(() => {});
  }

  takeLastRenderError(): { message: string; stack?: string; operation?: string; timestamp: number } | undefined {
    const err = this.lastRenderError;
    this.lastRenderError = undefined;
    return err;
  }

  async awaitNextRender(timeoutMs: number): Promise<void> {
    if (!this.pendingRenderPromise) return;
    const p = this.pendingRenderPromise;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRenderReject) {
          this.pendingRenderReject(
            new Error(`awaitNextRender: timed out after ${timeoutMs}ms`)
          );
        }
        reject(new Error(`awaitNextRender: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      p.then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  /** Simulate the viewer sending a render-success message. */
  simulateRenderSuccess(): void {
    if (this.pendingRenderResolve) this.pendingRenderResolve();
    this.pendingRenderResolve = undefined;
    this.pendingRenderReject = undefined;
    this.pendingRenderPromise = undefined;
  }

  /** Simulate the viewer sending an error message. */
  simulateRenderError(reason: string, opts?: { stack?: string; operation?: string }): void {
    // Mirrors the real ViewerProvider's `case "error":` — capture state
    // BEFORE rejecting, so a race where takeLastRenderError is called
    // synchronously from the reject handler still sees the error.
    this.lastRenderError = {
      message: reason,
      stack: opts?.stack,
      operation: opts?.operation,
      timestamp: Date.now(),
    };
    if (this.pendingRenderReject) this.pendingRenderReject(new Error(reason));
    this.pendingRenderResolve = undefined;
    this.pendingRenderReject = undefined;
    this.pendingRenderPromise = undefined;
  }
}

describe("viewer-provider pending-render handshake (Bug C)", () => {
  it("armPendingRender + render-success resolves awaitNextRender", async () => {
    const p = new PendingRenderDouble();
    p.armPendingRender();
    // Caller dispatches executeScript here; viewer eventually responds.
    setTimeout(() => p.simulateRenderSuccess(), 10);
    await expect(p.awaitNextRender(1000)).resolves.toBeUndefined();
  });

  it("awaitNextRender rejects on timeout when no render-success arrives", async () => {
    const p = new PendingRenderDouble();
    p.armPendingRender();
    await expect(p.awaitNextRender(50)).rejects.toThrow(/timed out after 50ms/);
  });

  it("awaitNextRender rejects when the viewer reports an error", async () => {
    const p = new PendingRenderDouble();
    p.armPendingRender();
    setTimeout(() => p.simulateRenderError("OCCT crash"), 10);
    await expect(p.awaitNextRender(1000)).rejects.toThrow(/OCCT crash/);
  });

  it("armPendingRender twice rejects the first caller with a superseded error", async () => {
    const p = new PendingRenderDouble();
    p.armPendingRender();
    const first = p.awaitNextRender(1000);
    // Re-arm mid-flight (simulates a second executeScript firing before the
    // first render completed). The prior caller should see a clear reason.
    p.armPendingRender();
    await expect(first).rejects.toThrow(/superseded/);
    // New armed promise is independent — resolving it should still succeed.
    setTimeout(() => p.simulateRenderSuccess(), 10);
    await expect(p.awaitNextRender(1000)).resolves.toBeUndefined();
  });

  it("awaitNextRender without armPendingRender is a no-op", async () => {
    const p = new PendingRenderDouble();
    // No arm call — should just return undefined immediately.
    await expect(p.awaitNextRender(50)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P1 — stale-PNG guard. When the webview worker posts an error, the render
// handler must surface that error INSTEAD of falling through to capture
// whatever is still on the Three.js scene (which would be the PREVIOUS
// successful render — a stale PNG masquerading as success).
// ---------------------------------------------------------------------------
describe("viewer-provider stale-PNG guard (P1)", () => {
  it("takeLastRenderError returns the error captured during simulateRenderError", async () => {
    const p = new PendingRenderDouble();
    p.armPendingRender();
    const awaiting = p.awaitNextRender(1000);
    p.simulateRenderError("require is not defined", {
      stack: "at main (foo.shape.ts:5:10)",
      operation: "extrude",
    });
    await expect(awaiting).rejects.toThrow(/require is not defined/);
    const err = p.takeLastRenderError();
    expect(err).toBeDefined();
    expect(err!.message).toBe("require is not defined");
    expect(err!.stack).toContain("foo.shape.ts");
    expect(err!.operation).toBe("extrude");
  });

  it("takeLastRenderError is consume-once (second call returns undefined)", () => {
    const p = new PendingRenderDouble();
    p.armPendingRender();
    p.simulateRenderError("oops");
    expect(p.takeLastRenderError()).toBeDefined();
    expect(p.takeLastRenderError()).toBeUndefined();
  });

  it("armPendingRender clears a prior render's error (no cross-render leak)", () => {
    const p = new PendingRenderDouble();
    p.armPendingRender();
    p.simulateRenderError("prior render failed");
    // New render armed — the prior error must NOT leak into this one.
    p.armPendingRender();
    expect(p.takeLastRenderError()).toBeUndefined();
  });

  it("takeLastRenderError is undefined on a successful render (no false positives)", async () => {
    const p = new PendingRenderDouble();
    p.armPendingRender();
    setTimeout(() => p.simulateRenderSuccess(), 10);
    await p.awaitNextRender(1000);
    expect(p.takeLastRenderError()).toBeUndefined();
  });
});
