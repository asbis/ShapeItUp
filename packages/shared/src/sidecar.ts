/**
 * The `.shapeitup-params.json` sidecar — parameter overrides persisted next to
 * a shape file by `tune_params --persist`, and applied by the MCP tools on
 * every later execution.
 *
 * NODE ONLY. This module is deliberately absent from the package barrel and
 * reachable only as `@shapeitup/shared/sidecar`, because `@shapeitup/shared` is
 * imported by the viewer, which runs in a browser. A `node:fs` import in the
 * barrel would break that bundle.
 *
 * ## Why the writers care
 *
 * The sidecar is read by the MCP tools layer and by nothing else — not the
 * viewer, not either viewer host, not the core. So the two paths already
 * disagree about what a model is:
 *
 *     file declares gussetH: 45, sidecar pins gussetH: 120
 *       verify_shape / export_shape / render_preview -> bbox Z = 126
 *       the viewer, and open_viewer                  -> bbox Z = 51
 *
 * Slider writeback makes that worse rather than better. A user drags a
 * parameter, commits it to the file, sees the viewer agree — and every export
 * silently keeps using the pinned value instead.
 *
 * The resolution is precedence, not detection: the file is the durable
 * artifact and the sidecar is a scratch overlay, so committing a value to the
 * file clears the scratch entry for THAT parameter. Other pinned parameters
 * are left alone; a commit says nothing about them.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const SIDECAR_FILENAME = ".shapeitup-params.json";

export type SidecarValue = number | boolean | string;
/** Keyed by shape-file basename, so several files in one directory coexist. */
export type SidecarMap = Record<string, Record<string, SidecarValue>>;

/** Read the sidecar in `dir`. A missing or malformed file reads as empty. */
export function readSidecar(dir: string): SidecarMap {
  try {
    const p = join(dir, SIDECAR_FILENAME);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as SidecarMap) : {};
  } catch {
    return {};
  }
}

export function writeSidecar(dir: string, map: SidecarMap): void {
  const p = join(dir, SIDECAR_FILENAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(map, null, 2), "utf-8");
}

/** The persisted override for one parameter, or undefined. */
export function readSidecarParam(
  absShapePath: string,
  name: string,
): SidecarValue | undefined {
  return readSidecar(dirname(absShapePath))[basename(absShapePath)]?.[name];
}

/**
 * Drop one parameter's persisted override. Returns true when something was
 * actually removed, so a caller can tell the user their pin is gone.
 *
 * Empties are cleaned up as it unwinds: an entry with no parameters left is
 * removed, and a sidecar with no entries left is deleted rather than left
 * behind as an empty file for someone to wonder about later.
 */
export function clearSidecarParam(absShapePath: string, name: string): boolean {
  const dir = dirname(absShapePath);
  const base = basename(absShapePath);
  const map = readSidecar(dir);
  const entry = map[base];
  if (!entry || !(name in entry)) return false;

  delete entry[name];
  if (Object.keys(entry).length === 0) delete map[base];

  if (Object.keys(map).length === 0) {
    try {
      rmSync(join(dir, SIDECAR_FILENAME), { force: true });
    } catch {
      // Best effort — an empty sidecar is untidy, not harmful.
    }
    return true;
  }
  writeSidecar(dir, map);
  return true;
}
