/**
 * Tests for in-process ("local") bus subscribers — the mechanism the browser
 * viewer host uses so it receives the same events as a VSCode extension
 * without a loopback socket. Covers:
 *   - a local subscriber receives publishEvent without a hello handshake
 *   - publishAndAwait round-trips through a local subscriber's reply
 *   - targetWorkspaceRoot routing applies to local subscribers too
 *   - dispose() detaches it
 *   - wire and local subscribers both receive the same event
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocket } from "ws";
import { SubscriberBus } from "./subscriber-bus.js";

/**
 * Local delivery is deferred one tick, so assertions need to wait for it.
 * Poll rather than sleeping a fixed span — a fixed sleep is the classic way
 * these tests go flaky on a loaded CI box.
 */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("SubscriberBus — local subscribers", () => {
  let storageDir: string;
  let bus: SubscriberBus;

  beforeEach(async () => {
    storageDir = mkdtempSync(join(tmpdir(), "bus-local-"));
    bus = new SubscriberBus(storageDir, "1.0.0-test");
    await bus.start();
  });

  afterEach(() => {
    bus.stop();
    try { rmSync(storageDir, { recursive: true, force: true }); } catch {}
  });

  it("delivers publishEvent without a hello handshake", async () => {
    const seen: any[] = [];
    bus.addLocalSubscriber([], (msg) => seen.push(msg));

    const { delivered } = bus.publishEvent("set-render-mode", { mode: "ai" });
    expect(delivered).toBe(1);
    expect(bus.getSubscriberCount()).toBe(1);

    await until(() => seen.length === 1);
    expect(seen).toEqual([{ event: "set-render-mode", mode: "ai" }]);
  });

  it("round-trips publishAndAwait through a local reply", async () => {
    bus.addLocalSubscriber([], (msg, reply) => {
      reply(msg.event === "open-shape", msg.event === "open-shape" ? undefined : "nope");
    });

    const ok = await bus.publishAndAwait("open-shape", { filePath: "/tmp/a.shape.ts" });
    expect(ok).toMatchObject({ delivered: 1, ok: true });

    const bad = await bus.publishAndAwait("mystery-event", {});
    expect(bad).toMatchObject({ delivered: 1, ok: false, error: "nope" });
  });

  it("times out cleanly when a local subscriber never replies", async () => {
    bus.addLocalSubscriber([], () => {
      /* deliberately silent */
    });
    const r = await bus.publishAndAwait("open-shape", {}, { timeoutMs: 150 });
    expect(r).toMatchObject({ delivered: 1, error: "timeout" });
  });

  it("honours targetWorkspaceRoot routing", async () => {
    const mine: any[] = [];
    const theirs: any[] = [];
    bus.addLocalSubscriber(["/work/a"], (m) => mine.push(m));
    bus.addLocalSubscriber(["/work/b"], (m) => theirs.push(m));

    const r = bus.publishEvent("open-shape", { filePath: "x" }, { targetWorkspaceRoot: "/work/a" });
    expect(r.delivered).toBe(1);

    await until(() => mine.length === 1);
    expect(theirs).toHaveLength(0);
  });

  it("stops delivering after dispose()", async () => {
    const seen: any[] = [];
    const sub = bus.addLocalSubscriber([], (m) => seen.push(m));

    expect(bus.publishEvent("set-render-mode", { mode: "ai" }).delivered).toBe(1);
    sub.dispose();
    expect(bus.publishEvent("set-render-mode", { mode: "dark" }).delivered).toBe(0);
    expect(bus.getSubscriberCount()).toBe(0);

    await until(() => seen.length === 1);
    // Give a second delivery a chance to (wrongly) arrive before asserting none did.
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
  });

  it("fans out to wire and local subscribers together", async () => {
    const port = (bus as any).wss.address().port as number;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello", workspaceRoots: [] }));
    await until(() => bus.getSubscriberCount() === 1);

    const local: any[] = [];
    bus.addLocalSubscriber([], (m) => local.push(m));

    const wireMsg = new Promise<any>((resolve) => {
      ws.once("message", (d) => resolve(JSON.parse(d.toString("utf-8"))));
    });

    const { delivered } = bus.publishEvent("toggle-dimensions", { show: true });
    expect(delivered).toBe(2);

    expect(await wireMsg).toEqual({ event: "toggle-dimensions", show: true });
    await until(() => local.length === 1);
    expect(local).toEqual([{ event: "toggle-dimensions", show: true }]);

    ws.close();
  });
});
