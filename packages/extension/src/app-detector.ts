import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

export type AppId =
  | "prusaslicer"
  | "cura"
  | "bambustudio"
  | "orcaslicer"
  | "freecad"
  | "fusion360";

export type ExportFormatForApp = "step" | "stl";

export interface DetectedApp {
  id: AppId;
  name: string;
  /** Preferred export format. STEP for CAD + modern slicers; STL fallback for Cura. */
  preferredFormat: ExportFormatForApp;
  /** Absolute path to the executable. Undefined when the app is launched via URL scheme only. */
  execPath?: string;
  /** If set, the app is opened via this URL scheme instead of spawning the binary. %FILE% gets replaced. */
  urlScheme?: string;
}

const APP_NAMES: Record<AppId, string> = {
  prusaslicer: "PrusaSlicer",
  cura: "Cura",
  bambustudio: "Bambu Studio",
  orcaslicer: "OrcaSlicer",
  freecad: "FreeCAD",
  fusion360: "Fusion 360",
};

const PREFERRED_FORMAT: Record<AppId, ExportFormatForApp> = {
  prusaslicer: "step",
  cura: "stl",
  bambustudio: "step",
  orcaslicer: "step",
  freecad: "step",
  fusion360: "step",
};

let cached: DetectedApp[] | undefined;
let inflight: Promise<DetectedApp[]> | undefined;

export function getDetectedApps(): DetectedApp[] {
  if (!cached) cached = detectApps();
  return cached;
}

/**
 * Async variant — the one the MCP command handler should use. Dedupes
 * concurrent scans (if two MCP calls hit the extension before the first
 * finishes, both get the same promise) and populates the sync cache so later
 * `getDetectedApps()` calls are instant.
 */
export function getDetectedAppsAsync(): Promise<DetectedApp[]> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = detectAppsAsync()
    .then((apps) => {
      cached = apps;
      return apps;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

export function rescanApps(): DetectedApp[] {
  cached = detectApps();
  return cached;
}

/** Kick off detection in the background so the first MCP call hits a warm cache. */
export function warmAppCache(): void {
  if (cached || inflight) return;
  void getDetectedAppsAsync();
}

function detectApps(): DetectedApp[] {
  const platform = process.platform;
  if (platform === "win32") return detectWindows();
  if (platform === "darwin") return detectMac();
  return detectLinux();
}

async function detectAppsAsync(): Promise<DetectedApp[]> {
  const platform = process.platform;
  if (platform === "win32") return detectWindowsAsync();
  // macOS and Linux detection is already fast (no reg queries, no glob walks on
  // huge directories). The sync implementation is fine; run it on the next tick.
  await Promise.resolve();
  if (platform === "darwin") return detectMac();
  return detectLinux();
}

// --- Windows ----------------------------------------------------------------

function detectWindows(): DetectedApp[] {
  const out: DetectedApp[] = [];
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");

  // PrusaSlicer — use the console variant when available so we don't spawn a detached GUI-only process
  const prusaConsole = firstExisting([
    path.join(programFiles, "Prusa3D", "PrusaSlicer", "prusa-slicer-console.exe"),
    path.join(programFilesX86, "Prusa3D", "PrusaSlicer", "prusa-slicer-console.exe"),
  ]);
  const prusa = firstExisting([
    prusaConsole,
    path.join(programFiles, "Prusa3D", "PrusaSlicer", "prusa-slicer.exe"),
    path.join(programFilesX86, "Prusa3D", "PrusaSlicer", "prusa-slicer.exe"),
    path.join(localAppData, "Programs", "Prusa3D", "PrusaSlicer", "prusa-slicer.exe"),
  ]);
  if (prusa) out.push(makeApp("prusaslicer", prusa));

  // Cura — install dir contains the version number, so we glob
  const curaPatterns = [
    path.join(programFiles, "UltiMaker Cura *"),
    path.join(programFiles, "Ultimaker Cura *"),
    path.join(programFilesX86, "UltiMaker Cura *"),
    path.join(programFilesX86, "Ultimaker Cura *"),
  ];
  const curaDir = findGlob(curaPatterns);
  if (curaDir) {
    const curaExe = firstExisting([
      path.join(curaDir, "UltiMaker-Cura.exe"),
      path.join(curaDir, "Ultimaker-Cura.exe"),
    ]);
    if (curaExe) out.push(makeApp("cura", curaExe));
  }

  // Bambu Studio
  const bambu = firstExisting([
    path.join(programFiles, "Bambu Studio", "bambu-studio.exe"),
    path.join(programFilesX86, "Bambu Studio", "bambu-studio.exe"),
  ]);
  if (bambu) out.push(makeApp("bambustudio", bambu));

  // OrcaSlicer
  const orca = firstExisting([
    path.join(programFiles, "OrcaSlicer", "OrcaSlicer.exe"),
    path.join(programFilesX86, "OrcaSlicer", "OrcaSlicer.exe"),
    path.join(localAppData, "Programs", "OrcaSlicer", "OrcaSlicer.exe"),
  ]);
  if (orca) out.push(makeApp("orcaslicer", orca));

  // FreeCAD — also version-suffixed in some installs
  const freecadDir = findGlob([
    path.join(programFiles, "FreeCAD *"),
    path.join(programFilesX86, "FreeCAD *"),
  ]);
  const freecad = firstExisting([
    freecadDir ? path.join(freecadDir, "bin", "FreeCAD.exe") : undefined,
    path.join(programFiles, "FreeCAD", "bin", "FreeCAD.exe"),
  ]);
  if (freecad) out.push(makeApp("freecad", freecad));

  // Fusion 360 — uses URL scheme, not exe. Detect by registry.
  if (hasFusion360UrlScheme()) {
    out.push({
      id: "fusion360",
      name: APP_NAMES.fusion360,
      preferredFormat: PREFERRED_FORMAT.fusion360,
      urlScheme: "fusion360://host/?command=open&file=%FILE%",
    });
  }

  return out;
}

function hasFusion360UrlScheme(): boolean {
  // Fusion writes an HKCU\Software\Classes\fusion360 key when installed. A
  // lightweight `reg query` shell-out is cheaper than adding a native dep.
  try {
    execFileSync("reg", ["query", "HKCU\\Software\\Classes\\fusion360"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 2000,
    });
    return true;
  } catch {
    // Fallback: look for the versioned webdeploy directory
    const localAppData = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
    const webdeploy = path.join(localAppData, "Autodesk", "webdeploy", "production");
    return fs.existsSync(webdeploy);
  }
}

async function detectWindowsAsync(): Promise<DetectedApp[]> {
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");

  // Kick off all the independent checks in parallel. Each resolves to a
  // DetectedApp or undefined — then we filter out the misses at the end.
  const checks: Array<Promise<DetectedApp | undefined>> = [
    // PrusaSlicer
    firstExistingAsync([
      path.join(programFiles, "Prusa3D", "PrusaSlicer", "prusa-slicer-console.exe"),
      path.join(programFilesX86, "Prusa3D", "PrusaSlicer", "prusa-slicer-console.exe"),
      path.join(programFiles, "Prusa3D", "PrusaSlicer", "prusa-slicer.exe"),
      path.join(programFilesX86, "Prusa3D", "PrusaSlicer", "prusa-slicer.exe"),
      path.join(localAppData, "Programs", "Prusa3D", "PrusaSlicer", "prusa-slicer.exe"),
    ]).then((p) => (p ? makeApp("prusaslicer", p) : undefined)),

    // Cura — version-suffixed; glob the parent dirs
    findGlobAsync([
      path.join(programFiles, "UltiMaker Cura *"),
      path.join(programFiles, "Ultimaker Cura *"),
      path.join(programFilesX86, "UltiMaker Cura *"),
      path.join(programFilesX86, "Ultimaker Cura *"),
    ]).then(async (dir) => {
      if (!dir) return undefined;
      const exe = await firstExistingAsync([
        path.join(dir, "UltiMaker-Cura.exe"),
        path.join(dir, "Ultimaker-Cura.exe"),
      ]);
      return exe ? makeApp("cura", exe) : undefined;
    }),

    // Bambu Studio
    firstExistingAsync([
      path.join(programFiles, "Bambu Studio", "bambu-studio.exe"),
      path.join(programFilesX86, "Bambu Studio", "bambu-studio.exe"),
    ]).then((p) => (p ? makeApp("bambustudio", p) : undefined)),

    // OrcaSlicer
    firstExistingAsync([
      path.join(programFiles, "OrcaSlicer", "OrcaSlicer.exe"),
      path.join(programFilesX86, "OrcaSlicer", "OrcaSlicer.exe"),
      path.join(localAppData, "Programs", "OrcaSlicer", "OrcaSlicer.exe"),
    ]).then((p) => (p ? makeApp("orcaslicer", p) : undefined)),

    // FreeCAD
    findGlobAsync([
      path.join(programFiles, "FreeCAD *"),
      path.join(programFilesX86, "FreeCAD *"),
    ]).then(async (dir) => {
      const candidates = [
        dir ? path.join(dir, "bin", "FreeCAD.exe") : undefined,
        path.join(programFiles, "FreeCAD", "bin", "FreeCAD.exe"),
      ].filter((p): p is string => !!p);
      const exe = await firstExistingAsync(candidates);
      return exe ? makeApp("freecad", exe) : undefined;
    }),

    // Fusion 360 — non-fs check, can hang. Timebox it aggressively.
    detectFusion360Async(localAppData),
  ];

  // Give the whole batch a hard 10s ceiling. Any individual check that hasn't
  // resolved by then gets treated as "not detected" so we return a partial
  // result rather than letting a single stuck `reg` spawn block the MCP tool.
  const ceiling = new Promise<DetectedApp[]>((resolve) => {
    setTimeout(() => resolve([]), 10000);
  });
  const done = Promise.all(checks).then((results) =>
    results.filter((r): r is DetectedApp => !!r)
  );
  return Promise.race([done, ceiling]);
}

async function detectFusion360Async(localAppData: string): Promise<DetectedApp | undefined> {
  const fusionApp: DetectedApp = {
    id: "fusion360",
    name: APP_NAMES.fusion360,
    preferredFormat: PREFERRED_FORMAT.fusion360,
    urlScheme: "fusion360://host/?command=open&file=%FILE%",
  };
  // Fastest check first: does the webdeploy directory exist? If so we can
  // skip the reg query entirely.
  const webdeploy = path.join(localAppData, "Autodesk", "webdeploy", "production");
  if (await existsAsync(webdeploy)) return fusionApp;

  // Fallback to `reg query`. Cap it at 800ms — if it's slower than that,
  // Fusion almost certainly isn't installed and we shouldn't wait.
  const found = await new Promise<boolean>((resolve) => {
    try {
      const { execFile } = require("child_process");
      const child = execFile(
        "reg",
        ["query", "HKCU\\Software\\Classes\\fusion360"],
        { timeout: 800 },
        (err: unknown) => resolve(!err)
      );
      child.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
  return found ? fusionApp : undefined;
}

async function firstExistingAsync(paths: Array<string | undefined>): Promise<string | undefined> {
  for (const p of paths) {
    if (p && (await existsAsync(p))) return p;
  }
  return undefined;
}

async function existsAsync(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findGlobAsync(patterns: string[]): Promise<string | undefined> {
  for (const pattern of patterns) {
    const star = pattern.lastIndexOf("*");
    if (star === -1) {
      if (await existsAsync(pattern)) return pattern;
      continue;
    }
    const parent = path.dirname(pattern);
    const prefix = path.basename(pattern).replace(/\*$/, "");
    if (!(await existsAsync(parent))) continue;
    try {
      const entries = await fs.promises.readdir(parent, { withFileTypes: true });
      const matches = entries
        .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
        .map((e) => path.join(parent, e.name))
        .sort()
        .reverse();
      if (matches[0]) return matches[0];
    } catch {
      // ignore permission errors
    }
  }
  return undefined;
}

// --- macOS ------------------------------------------------------------------

function detectMac(): DetectedApp[] {
  const out: DetectedApp[] = [];
  const apps = "/Applications";

  const candidates: Array<[AppId, string, string]> = [
    ["prusaslicer", path.join(apps, "PrusaSlicer.app"), "Contents/MacOS/PrusaSlicer"],
    ["cura", path.join(apps, "UltiMaker Cura.app"), "Contents/MacOS/UltiMaker-Cura"],
    ["bambustudio", path.join(apps, "BambuStudio.app"), "Contents/MacOS/BambuStudio"],
    ["orcaslicer", path.join(apps, "OrcaSlicer.app"), "Contents/MacOS/OrcaSlicer"],
    ["freecad", path.join(apps, "FreeCAD.app"), "Contents/MacOS/FreeCAD"],
  ];

  for (const [id, bundle, binRel] of candidates) {
    if (fs.existsSync(bundle)) {
      const bin = path.join(bundle, binRel);
      out.push(makeApp(id, fs.existsSync(bin) ? bin : bundle));
    }
  }

  // Fusion 360 — user-scoped webdeploy path
  const fusionBase = path.join(os.homedir(), "Library", "Application Support", "Autodesk", "webdeploy", "production");
  if (fs.existsSync(fusionBase)) {
    out.push({
      id: "fusion360",
      name: APP_NAMES.fusion360,
      preferredFormat: PREFERRED_FORMAT.fusion360,
      urlScheme: "fusion360://host/?command=open&file=%FILE%",
    });
  }

  return out;
}

// --- Linux ------------------------------------------------------------------

function detectLinux(): DetectedApp[] {
  const out: DetectedApp[] = [];
  const binaries: Array<[AppId, string[]]> = [
    ["prusaslicer", ["prusa-slicer", "PrusaSlicer"]],
    ["cura", ["cura", "UltiMaker-Cura"]],
    ["bambustudio", ["bambu-studio", "BambuStudio"]],
    ["orcaslicer", ["orca-slicer", "OrcaSlicer"]],
    ["freecad", ["freecad", "FreeCAD"]],
  ];

  for (const [id, names] of binaries) {
    for (const name of names) {
      const p = whichSync(name);
      if (p) {
        out.push(makeApp(id, p));
        break;
      }
    }
  }

  // Fusion 360 on Linux runs only under Wine — not supporting auto-detect here.
  return out;
}

function whichSync(bin: string): string | undefined {
  try {
    const out = execFileSync("which", [bin], { encoding: "utf-8", timeout: 2000 }).trim();
    return out && fs.existsSync(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

// --- helpers ----------------------------------------------------------------

function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

function findGlob(patterns: string[]): string | undefined {
  // Mini-glob: only supports a single trailing `*` on the last path segment.
  for (const pattern of patterns) {
    const star = pattern.lastIndexOf("*");
    if (star === -1) {
      if (fs.existsSync(pattern)) return pattern;
      continue;
    }
    const parent = path.dirname(pattern);
    const prefix = path.basename(pattern).replace(/\*$/, "");
    if (!fs.existsSync(parent)) continue;
    try {
      const matches = fs
        .readdirSync(parent)
        .filter((name) => name.startsWith(prefix))
        .map((name) => path.join(parent, name))
        .filter((p) => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        })
        .sort()
        .reverse();
      if (matches[0]) return matches[0];
    } catch {
      // ignore permission errors
    }
  }
  return undefined;
}

function makeApp(id: AppId, execPath: string): DetectedApp {
  return {
    id,
    name: APP_NAMES[id],
    preferredFormat: PREFERRED_FORMAT[id],
    execPath,
  };
}
