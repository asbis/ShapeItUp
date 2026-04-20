/**
 * Resolve raw WASM exception pointers into human-readable messages.
 *
 * Emscripten throws C++ exceptions as bare numeric pointers into the WASM
 * heap. When such a number bubbles up to JS, `e.message` is undefined and
 * `String(e)` yields the pointer's decimal representation — e.g. "8540320" —
 * which is useless to the user (and to any AI agent trying to self-correct).
 *
 * OCCT's Emscripten build exposes a handful of helpers that, given the
 * pointer, can materialize the original C++ exception's type and `what()`
 * string. We try them in order of specificity and return the first result
 * that doesn't throw. If everything fails we still replace the raw number
 * with a useful fallback — we never surface a pointer unchanged.
 *
 * This helper is transparent for normal `Error` objects: if `e.message` is
 * already a string, we return it as-is. Callers can route every catch block
 * through `resolveWasmException` without worrying about double-handling.
 */

/**
 * Bug #8: track whether ANY execute() has already completed successfully in
 * this process. When an "OCCT exception (pointer N)" surfaces AFTER a prior
 * success with a small pointer value, the overwhelmingly likely cause is heap
 * corruption from an earlier WASM-level failure — not a user-script mistake
 * like a bad import path (the existing `inferErrorHint` fallback). The flag
 * lets us steer the hint toward "retry after reset" instead of sending the
 * agent down the wrong trail.
 *
 * Reset on every resetCore() (engine drops the core; we also drop the flag so
 * the freshly-booted core starts clean — a first-render failure on the new
 * instance is NOT the wedged-heap signature).
 */
let hasSucceededOnce = false;

export function markExecutionSucceeded(): void {
  hasSucceededOnce = true;
}

export function resetWedgeTracking(): void {
  hasSucceededOnce = false;
}

/**
 * Read-only accessor for callers that need to branch (e.g. inferErrorHint in
 * mcp-server's engine.ts).
 */
export function hasSucceededBefore(): boolean {
  return hasSucceededOnce;
}

function isPointerish(e: unknown): boolean {
  if (typeof e === "number" && Number.isFinite(e)) return true;
  if (typeof e === "bigint") return true;
  // A Number wrapper object (rare but possible).
  if (e && typeof e === "object" && (e as any) instanceof Number) return true;
  // Some Emscripten builds throw plain objects with no stack/message. Treat
  // those as pointer-ish only when they coerce to a finite integer string.
  if (
    e &&
    typeof e === "object" &&
    typeof (e as any).stack === "undefined" &&
    typeof (e as any).message === "undefined"
  ) {
    const s = String(e);
    if (/^\d+$/.test(s)) return true;
  }
  return false;
}

function pointerValue(e: unknown): number | undefined {
  if (typeof e === "number" && Number.isFinite(e)) return e;
  if (typeof e === "bigint") return Number(e);
  if (e && typeof e === "object") {
    if ((e as any) instanceof Number) return Number(e);
    const s = String(e);
    if (/^\d+$/.test(s)) return Number(s);
  }
  return undefined;
}

/**
 * Attempt each known OCCT/Emscripten exception-resolution path. Returns the
 * first non-empty string produced; returns undefined if every path throws or
 * yields nothing usable.
 */
function tryResolveViaOc(ptr: number, oc: any): string | undefined {
  if (!oc) return undefined;

  // 1. Modern Emscripten: `getExceptionMessage(ptr)` returns [type, message].
  try {
    if (typeof oc.getExceptionMessage === "function") {
      const out = oc.getExceptionMessage(ptr);
      if (Array.isArray(out)) {
        const [type, message] = out;
        const joined = [type, message].filter((s) => typeof s === "string" && s.length > 0).join(": ");
        if (joined) return joined;
      } else if (typeof out === "string" && out.length > 0) {
        return out;
      }
    }
  } catch {}

  // 2. Legacy: oc.Runtime.getExceptionMessage(ptr).
  try {
    const rt = oc.Runtime;
    if (rt && typeof rt.getExceptionMessage === "function") {
      const out = rt.getExceptionMessage(ptr);
      if (Array.isArray(out)) {
        const joined = out.filter((s: unknown) => typeof s === "string" && (s as string).length > 0).join(": ");
        if (joined) return joined;
      } else if (typeof out === "string" && out.length > 0) {
        return out;
      }
    }
  } catch {}

  // 3. Emscripten ExceptionInfo wrapper — exposes .get_type() / .get_message().
  try {
    if (typeof oc.ExceptionInfo === "function") {
      const info = new oc.ExceptionInfo(ptr);
      const type = typeof info.get_type === "function" ? info.get_type() : undefined;
      const message = typeof info.get_message === "function" ? info.get_message() : undefined;
      const joined = [type, message]
        .filter((s: unknown) => typeof s === "string" && (s as string).length > 0)
        .join(": ");
      if (joined) return joined;
    }
  } catch {}

  // 4. Treat the pointer as a Standard_Failure* and read GetMessageString().
  //    OCCT's own exception base class — works when OCCT threw directly.
  try {
    if (typeof oc.Standard_Failure === "function") {
      const f = new oc.Standard_Failure(ptr);
      const msg = typeof f.GetMessageString === "function" ? f.GetMessageString() : undefined;
      if (typeof msg === "string" && msg.length > 0) return msg;
    }
  } catch {}

  return undefined;
}

/**
 * Main entry point. Returns a resolved message string for any thrown value:
 *   - Normal Error          → e.message (unchanged)
 *   - Numeric/pointer-ish   → resolved via oc, or a descriptive fallback
 *   - Anything else         → String(e)
 *
 * When `operationName` is supplied (typically the `err.operation` tag set
 * by instrumentation's `tagError()` — e.g. `"_3DShape.cut"`,
 * `"_3DShape.fillet"`), the resolver can steer the fallback message toward
 * the most likely cause. Boolean ops (cut/fuse/intersect) almost always fail
 * due to coincident/tangent faces; fillet/chamfer almost always fail due to
 * a radius that's too large or edges that vanished after a prior op. Giving
 * a generic "simplify geometry" hint for these misdirects the user.
 */
export function resolveWasmException(e: unknown, oc: any, operationName?: string): string {
  // Pass normal Error objects through untouched.
  if (e instanceof Error) {
    return e.message || String(e);
  }
  if (e && typeof e === "object" && typeof (e as any).message === "string" && (e as any).message.length > 0) {
    return (e as any).message;
  }

  if (isPointerish(e)) {
    const ptr = pointerValue(e);
    if (ptr !== undefined) {
      const resolved = tryResolveViaOc(ptr, oc);
      if (resolved) return resolved;
      // Operation-specific fallbacks — the generic "simplify geometry" hint
      // sends boolean/fillet failures down the wrong trail. Branch on the
      // instrumentation-tagged operation name when present.
      if (operationName) {
        const lowerOp = operationName.toLowerCase();
        const isBoolean = /\b(cut|fuse|intersect)\b/.test(lowerOp);
        const isFillet = /\b(fillet|chamfer)\b/.test(lowerOp);
        if (isBoolean) {
          return (
            `OCCT boolean operation (${operationName}) failed at a low level. ` +
            `The most common cause is coincident or tangent faces between the operands. Try:\n` +
            `  - nudging one operand by >= 0.01mm so faces overlap instead of kissing,\n` +
            `  - inflating a cutter by a small epsilon (e.g. 0.01mm) so cuts pass clearly through instead of ending on a face,\n` +
            `  - checking for self-intersecting or zero-thickness geometry in either operand.`
          );
        }
        if (isFillet) {
          return (
            `OCCT ${operationName} failed at a low level. ` +
            `Common causes: radius larger than the shortest adjacent edge, ` +
            `fillet crossing a tangent face boundary, or the selected edges no longer exist after a prior operation.`
          );
        }
      }
      const opSuffix = operationName ? ` during ${operationName}` : "";
      return `OCCT exception (pointer ${ptr})${opSuffix}; try simplifying geometry or reducing complexity.`;
    }
  }

  // Fallback for anything else — String() on non-numeric values is at least
  // readable (e.g. "[object Object]" beats nothing, though it's still poor).
  return String(e);
}
