/**
 * Tests for the WebSocket subscriber bus that replaces the file-based
 * mcp-command.json IPC bridge. Covers:
 *   - listener starts and advertises a port via heartbeat
 *   - a subscriber can connect, say hello, and receive published events
 *   - targetWorkspaceRoot routing excludes non-matching subscribers
 *   - publishAndAwait resolves on reply, times out cleanly on silence
 *   - with zero subscribers, publishEvent returns delivered=0 without hanging
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocket } from "ws";
import { SubscriberBus, readMcpServerHeartbeat, resolveGlobalStorageDir } from "./subscriber-bus.js";

// Tiny helper so each test's subscriber can block until it sees a message.
function awaitMessage(ws: WebSocket, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws message")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString("utf-8"))); } catch (e) { reject(e); }
    });
  });
}

function awaitOpen(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

describe("SubscriberBus", () => {
  let storageDir: string;
  let bus: SubscriberBus;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "subscriber-bus-"));
    bus = new SubscriberBus(storageDir, "1.0.0-test");
  });

  afterEach(() => {
    bus.stop();
    try { rmSync(storageDir, { recursive: true, force: true }); } catch {}
  });

  it("starts a listener and writes a heartbeat advertising the port", async () => {
    const port = await bus.start();
    expect(port).toBeGreaterThan(0);
    const hb = readMcpServerHeartbeat(storageDir);
    expect(hb).not.toBeNull();
    expect(hb!.port).toBe(port);
    expect(hb!.pid).toBe(process.pid);
    expect(hb!.version).toBe("1.0.0-test");
  });

  it("publishEvent delivers to a subscriber that sent hello", async () => {
    const port = await bus.start();
    const sub = new WebSocket(`ws://127.0.0.1:${port}`);
    await awaitOpen(sub);
    sub.send(JSON.stringify({ type: "hello", workspaceRoots: ["/tmp/ws-a"] }));

    // Give the server one tick to process hello before we publish.
    await new Promise((r) => setTimeout(r, 50));

    const recv = awaitMessage(sub);
    const { delivered } = bus.publishEvent("set-render-mode", { mode: "ai" });
    expect(delivered).toBe(1);
    const msg = await recv;
    expect(msg.event).toBe("set-render-mode");
    expect(msg.mode).toBe("ai");

    sub.close();
  });

  it("targetWorkspaceRoot routes only to subscribers whose roots match", async () => {
    const port = await bus.start();
    const subA = new WebSocket(`ws://127.0.0.1:${port}`);
    const subB = new WebSocket(`ws://127.0.0.1:${port}`);
    await Promise.all([awaitOpen(subA), awaitOpen(subB)]);
    subA.send(JSON.stringify({ type: "hello", workspaceRoots: ["/tmp/ws-a"] }));
    subB.send(JSON.stringify({ type: "hello", workspaceRoots: ["/tmp/ws-b"] }));
    await new Promise((r) => setTimeout(r, 50));

    const recvA = awaitMessage(subA, 1000);
    // subB should NOT receive — install a guard that fails if it does.
    let bGot = false;
    subB.once("message", () => { bGot = true; });

    const { delivered } = bus.publishEvent(
      "open-shape",
      { filePath: "/tmp/ws-a/x.shape.ts" },
      { targetWorkspaceRoot: "/tmp/ws-a" },
    );
    expect(delivered).toBe(1);
    const msg = await recvA;
    expect(msg.event).toBe("open-shape");
    // Give subB a beat to (wrongly) receive.
    await new Promise((r) => setTimeout(r, 100));
    expect(bGot).toBe(false);

    subA.close();
    subB.close();
  });

  it("publishAndAwait resolves on subscriber reply", async () => {
    const port = await bus.start();
    const sub = new WebSocket(`ws://127.0.0.1:${port}`);
    await awaitOpen(sub);
    sub.send(JSON.stringify({ type: "hello", workspaceRoots: ["/tmp/ws"] }));
    await new Promise((r) => setTimeout(r, 50));

    sub.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf-8"));
      if (msg._id) {
        sub.send(JSON.stringify({ _id: msg._id, ok: true }));
      }
    });

    const result = await bus.publishAndAwait("open-in-app", { appId: "cura" }, { timeoutMs: 2000 });
    expect(result.delivered).toBe(1);
    expect(result.ok).toBe(true);

    sub.close();
  });

  it("publishAndAwait times out cleanly when nobody replies", async () => {
    const port = await bus.start();
    const sub = new WebSocket(`ws://127.0.0.1:${port}`);
    await awaitOpen(sub);
    sub.send(JSON.stringify({ type: "hello", workspaceRoots: ["/tmp/ws"] }));
    await new Promise((r) => setTimeout(r, 50));

    // Deliberately do NOT reply to any message.
    const t0 = Date.now();
    const result = await bus.publishAndAwait("open-in-app", { appId: "cura" }, { timeoutMs: 200 });
    const elapsed = Date.now() - t0;
    expect(result.delivered).toBe(1);
    expect(result.error).toBe("timeout");
    // Generous upper bound for slow CI; verifies we didn't hang.
    expect(elapsed).toBeLessThan(2000);

    sub.close();
  });

  it("publish with zero subscribers returns delivered=0 without hanging", async () => {
    await bus.start();
    const { delivered } = bus.publishEvent("set-render-mode", { mode: "dark" });
    expect(delivered).toBe(0);

    // publishAndAwait should resolve synchronously too — it never waits when
    // nobody matched. Bound the test so an accidental hang still fails.
    const t0 = Date.now();
    const result = await bus.publishAndAwait("open-in-app", { appId: "cura" }, { timeoutMs: 10_000 });
    const elapsed = Date.now() - t0;
    expect(result.delivered).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });

  it("stop() removes the heartbeat file", async () => {
    await bus.start();
    const before = readdirSync(storageDir).filter((n) => n.startsWith("mcp-server-heartbeat-"));
    expect(before.length).toBe(1);
    bus.stop();
    const after = readdirSync(storageDir).filter((n) => n.startsWith("mcp-server-heartbeat-"));
    expect(after.length).toBe(0);
    expect(existsSync(storageDir)).toBe(true); // the dir itself stays
  });
});

describe("resolveGlobalStorageDir", () => {
  const ID = "shapeitup.shapeitup-vscode";
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "global-storage-"));
  });

  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });

  // What the extension leaves behind: a heartbeat in its own globalStorage.
  function extensionHeartbeat(dir: string, ageSeconds: number, name = "shapeitup-heartbeat.json") {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "{}");
    const t = Date.now() / 1000 - ageSeconds;
    utimesSync(file, t, t);
  }

  it("uses VS Code's macOS location, not ~/.config", () => {
    expect(resolveGlobalStorageDir({ home, platform: "darwin", env: {} })).toBe(
      join(home, "Library", "Application Support", "Code", "User", "globalStorage", ID),
    );
  });

  it("follows APPDATA on Windows and XDG_CONFIG_HOME on Linux", () => {
    expect(resolveGlobalStorageDir({ home, platform: "win32", env: { APPDATA: join(home, "Roaming") } })).toBe(
      join(home, "Roaming", "Code", "User", "globalStorage", ID),
    );
    expect(resolveGlobalStorageDir({ home, platform: "linux", env: {} })).toBe(
      join(home, ".config", "Code", "User", "globalStorage", ID),
    );
    expect(resolveGlobalStorageDir({ home, platform: "linux", env: { XDG_CONFIG_HOME: join(home, "xdg") } })).toBe(
      join(home, "xdg", "Code", "User", "globalStorage", ID),
    );
  });

  it("picks the editor the extension ran in, even when VS Code's dir exists", () => {
    const root = join(home, "Library", "Application Support");
    // This server creates VS Code's dir on its own, so its existence proves nothing.
    mkdirSync(join(root, "Code", "User", "globalStorage", ID), { recursive: true });
    extensionHeartbeat(join(root, "Cursor", "User", "globalStorage", ID), 60, "shapeitup-heartbeat-123.json");
    expect(resolveGlobalStorageDir({ home, platform: "darwin", env: {} })).toBe(
      join(root, "Cursor", "User", "globalStorage", ID),
    );
  });

  it("prefers the editor with the most recent heartbeat", () => {
    const root = join(home, ".config");
    extensionHeartbeat(join(root, "Cursor", "User", "globalStorage", ID), 3600);
    extensionHeartbeat(join(root, "Code", "User", "globalStorage", ID), 5);
    expect(resolveGlobalStorageDir({ home, platform: "linux", env: {} })).toBe(
      join(root, "Code", "User", "globalStorage", ID),
    );
  });
});
