/**
 * Tests for the ported open-in-app logic that now lives in the MCP server.
 * Avoids actually launching external apps by injecting a mock spawn.
 */
import { describe, it, expect, vi } from "vitest";
import type { DetectedApp } from "@shapeitup/shared";
import { buildLaunchArgs, openFileInApp } from "./app-launcher.js";

const curaApp: DetectedApp = {
  id: "cura",
  name: "Cura",
  preferredFormat: "stl",
  execPath: "C:/Program Files/UltiMaker Cura 5.6.0/UltiMaker-Cura.exe",
};

const prusaApp: DetectedApp = {
  id: "prusaslicer",
  name: "PrusaSlicer",
  preferredFormat: "step",
  execPath: "/usr/bin/prusa-slicer",
};

const fusionApp: DetectedApp = {
  id: "fusion360",
  name: "Fusion 360",
  preferredFormat: "step",
  urlScheme: "fusion360://host/?command=open&file=%FILE%",
};

describe("buildLaunchArgs", () => {
  it("adds --single-instance when launching Cura in reuse mode", () => {
    const args = buildLaunchArgs(curaApp, "/tmp/foo.stl", "reuse");
    expect(args).toEqual(["--single-instance", "/tmp/foo.stl"]);
  });

  it("omits the flag in `new` mode even for Cura", () => {
    const args = buildLaunchArgs(curaApp, "/tmp/foo.stl", "new");
    expect(args).toEqual(["/tmp/foo.stl"]);
  });

  it("passes just the file path for apps without a single-instance flag", () => {
    const args = buildLaunchArgs(prusaApp, "/tmp/foo.step", "reuse");
    expect(args).toEqual(["/tmp/foo.step"]);
  });
});

describe("openFileInApp", () => {
  it("spawns the detected app with the expected command line (Cura reuse)", () => {
    const spawnFn = vi.fn().mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(),
    });

    const result = openFileInApp("/tmp/foo.stl", curaApp, { spawn: spawnFn as any });

    expect(result.launched).toBe(true);
    expect(result.command).toBe(curaApp.execPath);
    expect(result.args).toEqual(["--single-instance", "/tmp/foo.stl"]);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe(curaApp.execPath);
    expect(args).toEqual(["--single-instance", "/tmp/foo.stl"]);
    expect(opts).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
  });

  it("spawns PrusaSlicer with just the file path", () => {
    const spawnFn = vi.fn().mockReturnValue({ unref: vi.fn(), on: vi.fn() });
    const result = openFileInApp("/tmp/bar.step", prusaApp, { spawn: spawnFn as any });
    expect(result.launched).toBe(true);
    expect(result.args).toEqual(["/tmp/bar.step"]);
  });

  it("returns a URL-scheme result for Fusion 360 without spawning anything", () => {
    const spawnFn = vi.fn();
    const result = openFileInApp("/tmp/baz.step", fusionApp, { spawn: spawnFn as any });
    expect(result.launched).toBe(false);
    expect(result.urlScheme).toContain("fusion360://");
    expect(result.urlScheme).toContain(encodeURIComponent("/tmp/baz.step"));
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("returns an error when the app has neither execPath nor urlScheme", () => {
    const broken: DetectedApp = {
      id: "freecad",
      name: "FreeCAD",
      preferredFormat: "step",
    };
    const result = openFileInApp("/tmp/x.step", broken);
    expect(result.launched).toBe(false);
    expect(result.error).toMatch(/neither an exec path nor a URL scheme/);
  });

  it("returns launched=false and surfaces the spawn exception", () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });
    const result = openFileInApp("/tmp/foo.stl", curaApp, { spawn: spawnFn as any });
    expect(result.launched).toBe(false);
    expect(result.error).toBe("ENOENT: no such file");
    expect(result.command).toBe(curaApp.execPath);
  });
});
