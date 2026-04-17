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
 */
export function resolveWasmException(e: unknown, oc: any): string {
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
      return `OCCT exception (pointer ${ptr}); try simplifying geometry or reducing complexity.`;
    }
  }

  // Fallback for anything else — String() on non-numeric values is at least
  // readable (e.g. "[object Object]" beats nothing, though it's still poor).
  return String(e);
}
