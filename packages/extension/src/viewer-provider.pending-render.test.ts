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

  armPendingRender(): void {
    if (this.pendingRenderReject) {
      this.pendingRenderReject(new Error("render superseded by new executeScript"));
    }
    this.pendingRenderPromise = new Promise<void>((resolve, reject) => {
      this.pendingRenderResolve = resolve;
      this.pendingRenderReject = reject;
    });
    this.pendingRenderPromise.catch(() => {});
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
  simulateRenderError(reason: string): void {
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
