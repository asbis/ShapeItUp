/**
 * Fastener library — positive shapes for screws, nuts, washers, inserts.
 *
 * Each factory returns a Shape3D representing the physical part. Shaft axis is
 * Z by default; head sits at Z=0 and the shaft extends into -Z.
 *
 * Exported as four namespace objects — `screws`, `nuts`, `washers`, `inserts` —
 * which the stdlib barrel re-exports so user scripts can write:
 *   import { screws, nuts } from "shapeitup";
 *   const bolt = screws.socketHead("M3x10");
 *
 * Implementation: see agent-A worktree.
 */

export const screws = {};
export const nuts = {};
export const washers = {};
export const inserts = {};
