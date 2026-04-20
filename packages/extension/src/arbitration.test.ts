/**
 * Multi-window arbitration tests.
 *
 * The real arbitrate() is coupled to `vscode` (not available in vitest), so
 * we copy its logic verbatim into a test double below. If you edit arbitrate
 * in extension.ts, keep this double in sync — it's a behavior contract, not
 * a mock. Covers the cross-window cross-talk bug: without correct gating, an
 * MCP render-preview fired at one workspace's file would execute in EVERY
 * open VSCode window's extension host simultaneously.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";

interface TestWindow {
  pid: number;
  workspaceFolders: string[];
}

/** Mirrors extension.ts isWorkspaceMatch + arbitrate. */
function makeArbitrator(win: TestWindow, claimDir: string) {
  const isWorkspaceMatch = (root: string): boolean => {
    const normalized = resolve(root).toLowerCase();
    return win.workspaceFolders.some(
      (ws) => resolve(ws).toLowerCase() === normalized,
    );
  };

  return async (id: string, cmd: any): Promise<boolean> => {
    const fs = require("fs");

    // Layer 1: explicit targetWorkspaceRoot.
    if (typeof cmd?.targetWorkspaceRoot === "string" && cmd.targetWorkspaceRoot.length > 0) {
      if (!isWorkspaceMatch(cmd.targetWorkspaceRoot)) return false;
      const claimPath = join(claimDir, `${id}.lock`);
      try {
        fs.writeFileSync(claimPath, `${win.pid}\n0\n`, { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    }

    // Layer 2: legacy priority-based arbitration.
    let priority = 1;
    if (cmd?.filePath && typeof cmd.filePath === "string" && win.workspaceFolders.length > 0) {
      const fp = resolve(cmd.filePath).toLowerCase();
      const inWs = win.workspaceFolders.some((ws) => {
        const root = resolve(ws).toLowerCase();
        return fp === root || fp.startsWith(root + sep.toLowerCase()) || fp.startsWith(root + "/");
      });
      priority = inWs ? 0 : 2;
    }
    if (priority === 2) return false;
    if (priority > 0) await new Promise((r) => setTimeout(r, priority * 10));
    const claimPath = join(claimDir, `${id}.lock`);
    try {
      fs.writeFileSync(claimPath, `${win.pid}\n${priority}\n`, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
}

describe("multi-window arbitration", () => {
  let claimDir: string;
  let wsA: string;
  let wsB: string;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), "shapeitup-arb-"));
    claimDir = join(tmp, "claims");
    require("fs").mkdirSync(claimDir, { recursive: true });
    wsA = join(tmp, "workspace-A");
    wsB = join(tmp, "workspace-B");
    require("fs").mkdirSync(wsA, { recursive: true });
    require("fs").mkdirSync(wsB, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(claimDir, { recursive: true, force: true });
    } catch {}
  });

  it("targetWorkspaceRoot: only the matching window wins", async () => {
    const fileInA = join(wsA, "part.shape.ts");
    writeFileSync(fileInA, "// test");

    const winA = makeArbitrator({ pid: 1001, workspaceFolders: [wsA] }, claimDir);
    const winB = makeArbitrator({ pid: 1002, workspaceFolders: [wsB] }, claimDir);

    const cmd = { filePath: fileInA, targetWorkspaceRoot: wsA };

    const [wonA, wonB] = await Promise.all([
      winA("id-1", cmd),
      winB("id-1", cmd),
    ]);

    expect(wonA).toBe(true);
    expect(wonB).toBe(false);
  });

  it("targetWorkspaceRoot: non-matching window drops out WITHOUT racing", async () => {
    // Even if winB would have won the legacy priority race (e.g. because
    // the filePath happens to live in its workspace under some symlink-y
    // scenario), the explicit targetWorkspaceRoot overrides that.
    const fileInA = join(wsA, "part.shape.ts");
    const winB = makeArbitrator({ pid: 1002, workspaceFolders: [wsB] }, claimDir);

    // winB is NOT in the target workspace — must return false immediately
    // without ever touching the claim directory.
    const won = await winB("id-2", { filePath: fileInA, targetWorkspaceRoot: wsA });
    expect(won).toBe(false);
    // And the lock file was never created by winB.
    expect(existsSync(join(claimDir, "id-2.lock"))).toBe(false);
  });

  it("targetWorkspaceRoot: two windows with matching workspace — exactly one wins", async () => {
    // Pathological: user opened the same folder in two VSCode windows.
    // targetWorkspaceRoot alone can't disambiguate, but the lock race still
    // guarantees only ONE of them claims the command.
    const winA1 = makeArbitrator({ pid: 2001, workspaceFolders: [wsA] }, claimDir);
    const winA2 = makeArbitrator({ pid: 2002, workspaceFolders: [wsA] }, claimDir);

    const cmd = { filePath: join(wsA, "x.shape.ts"), targetWorkspaceRoot: wsA };

    const results = await Promise.all([
      winA1("id-3", cmd),
      winA2("id-3", cmd),
    ]);

    const winners = results.filter((x) => x).length;
    expect(winners).toBe(1);
  });

  it("legacy path (no targetWorkspaceRoot): file-in-workspace window wins over neutral", async () => {
    const fileInA = join(wsA, "part.shape.ts");
    const winA = makeArbitrator({ pid: 3001, workspaceFolders: [wsA] }, claimDir);
    const winOther = makeArbitrator({ pid: 3002, workspaceFolders: [wsB] }, claimDir);

    // No targetWorkspaceRoot — falls through to priority logic.
    const cmd = { filePath: fileInA };

    const [wonA, wonOther] = await Promise.all([
      winA("id-4", cmd),
      winOther("id-4", cmd),
    ]);

    expect(wonA).toBe(true);
    expect(wonOther).toBe(false);
  });

  it("legacy path: window with workspaces but file outside all of them drops out", async () => {
    const fileElsewhere = "/tmp/outside/anything.shape.ts";
    const winB = makeArbitrator({ pid: 4001, workspaceFolders: [wsB] }, claimDir);

    const won = await winB("id-5", { filePath: fileElsewhere });
    expect(won).toBe(false);
  });

  it("legacy path: command with no filePath is handled by any window (priority 1)", async () => {
    // This is the "set-render-mode" / "toggle-dimensions" / "list-installed-apps"
    // path — no file to resolve, so every window participates and the lock
    // race decides.
    const winA = makeArbitrator({ pid: 5001, workspaceFolders: [wsA] }, claimDir);
    const winB = makeArbitrator({ pid: 5002, workspaceFolders: [wsB] }, claimDir);

    const cmd = { mode: "dark" };
    const results = await Promise.all([
      winA("id-6", cmd),
      winB("id-6", cmd),
    ]);
    const winners = results.filter((x) => x).length;
    expect(winners).toBe(1);
  });
});
