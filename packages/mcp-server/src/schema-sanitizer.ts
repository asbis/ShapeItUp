/**
 * JSON Schema sanitizer for strict MCP clients (Gemini CLI).
 *
 * Gemini CLI enforces a stricter OpenAPI-3.0-subset than Claude Code or
 * Cursor: when the server answers `tools/list`, Gemini rejects the *whole*
 * tool catalog (HTTP 400 INVALID_ARGUMENT) if any single tool's inputSchema
 * uses features outside that subset. Three offenders come from
 * zod-to-json-schema's defaults:
 *
 *  - `$schema`: the draft-07 URL annotation on every root schema.
 *  - `propertyNames`: emitted by `z.record(z.string(), …)` to constrain keys.
 *  - object-valued `additionalProperties`: emitted by the same `z.record(…)`
 *    calls to constrain value types.
 *
 * Plus Gemini caps per-function descriptions at ~1024 chars. We safely clip
 * anything longer than 1000 chars at emit time as defense-in-depth.
 *
 * This sanitizer ONLY affects the JSON Schema advertised to the client. The
 * runtime zod validation inside the MCP SDK still enforces the original
 * value types — Gemini just can't express the shape, so we advertise
 * "arbitrary keys" and let the server reject bad input the usual way.
 *
 * Safe for all MCP clients — Claude Code / Cursor / Claude Desktop accept
 * the simpler form just as happily as the strict one.
 */

/** Max description length. Clip to this many chars then append an ellipsis. */
const MAX_DESCRIPTION_CHARS = 1000;
const TRUNCATION_SUFFIX = "\u2026"; // single-char ellipsis
const TRUNCATION_KEEP = MAX_DESCRIPTION_CHARS - 1; // 999, so total length === 1000

/** Recursive schema-shaped keys whose values are themselves schemas. */
const SCHEMA_CHILD_KEYS = [
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
] as const;

/** Keys whose value is a single nested schema. */
const SINGLE_SCHEMA_KEYS = [
  "contains",
  "if",
  "then",
  "else",
  "not",
  // NOTE 1: `items` is handled separately below so we can rewrite draft-07
  // tuple syntax (`items: [schemaA, schemaB]`) into the uniform-array form
  // accepted by both JSON Schema 2020-12 and OpenAPI 3.0.
  // NOTE 2: we intentionally do NOT recurse into `additionalProperties` — if
  // it is an object schema, the whole field is collapsed to `true` below.
] as const;

/**
 * Normalize a draft-07 tuple-style `items: [schemaA, schemaB, ...]` into the
 * uniform `items: <schema>` + `minItems`/`maxItems` form that validates
 * under BOTH JSON Schema 2020-12 (Claude's default validator, where
 * `items: [array]` is invalid and `prefixItems` is the 2020-12 replacement —
 * which Gemini's OpenAPI-3.0 subset rejects) AND OpenAPI 3.0 (Gemini).
 *
 * - Homogeneous tuple (every element's schema is identical): collapse to
 *   `{ items: <common schema>, minItems: N, maxItems: N }`. Full type info
 *   preserved — a [number,number,number] tuple still says "array of 3
 *   numbers" on the wire.
 * - Heterogeneous tuple: drop element typing and just pin length. The
 *   runtime zod validator still enforces per-position types; the schema
 *   just advertises "array of N items" to the model.
 *
 * Mutates `out` (the schema object being built) — adds items/minItems/
 * maxItems entries as appropriate.
 */
function normalizeTupleItems(
  tuple: unknown[],
  out: Record<string, unknown>,
): void {
  const len = tuple.length;
  if (len === 0) {
    delete out.items;
  } else {
    const sanitized = tuple.map((item) => sanitizeSchemaForStrictClients(item));
    const fingerprint = JSON.stringify(sanitized[0] ?? {});
    const homogeneous = sanitized.every(
      (item) => JSON.stringify(item) === fingerprint,
    );
    if (homogeneous) {
      out.items = sanitized[0];
    } else {
      delete out.items;
    }
  }
  if (out.minItems === undefined) out.minItems = len;
  if (out.maxItems === undefined) out.maxItems = len;
}

/** Keys whose value is an array of nested schemas. */
const SCHEMA_ARRAY_KEYS = [
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function truncateDescription(desc: unknown): unknown {
  if (typeof desc !== "string") return desc;
  if (desc.length <= MAX_DESCRIPTION_CHARS) return desc;
  return desc.slice(0, TRUNCATION_KEEP) + TRUNCATION_SUFFIX;
}

/**
 * Pure, recursive sanitizer. Clones the input — the original is never
 * mutated, so the result is safe to hand to the SDK without side-effects
 * on cached zod-compiled schemas.
 */
export function sanitizeSchemaForStrictClients(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForStrictClients(item));
  }
  if (!isPlainObject(schema)) {
    return schema;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // --- Offending keys: drop outright ---------------------------------
    if (key === "$schema" || key === "propertyNames") {
      continue;
    }

    // --- additionalProperties: object-form → `true` --------------------
    // `true`, `false`, or absent are all fine for Gemini. Only
    // object-valued additionalProperties (e.g. `{ type: "number" }` from
    // z.record) gets rejected. We advertise "arbitrary keys" and rely on
    // zod to reject wrong value types at runtime.
    if (key === "additionalProperties") {
      if (isPlainObject(value)) {
        out[key] = true;
      } else {
        out[key] = value;
      }
      continue;
    }

    // --- description: clip at 1000 chars -------------------------------
    if (key === "description") {
      out[key] = truncateDescription(value);
      continue;
    }

    // --- items: handle draft-07 tuple arrays OR single schema ---------
    if (key === "items") {
      if (Array.isArray(value)) {
        // Draft-07 tuple syntax → rewrite to uniform-array form.
        normalizeTupleItems(value, out);
      } else {
        out[key] = sanitizeSchemaForStrictClients(value);
      }
      continue;
    }

    // --- Recurse into child schemas ------------------------------------
    if ((SCHEMA_CHILD_KEYS as readonly string[]).includes(key) && isPlainObject(value)) {
      // Map of name → child schema (e.g. `properties`).
      const mapped: Record<string, unknown> = {};
      for (const [childName, childSchema] of Object.entries(value)) {
        mapped[childName] = sanitizeSchemaForStrictClients(childSchema);
      }
      out[key] = mapped;
      continue;
    }

    if ((SINGLE_SCHEMA_KEYS as readonly string[]).includes(key)) {
      out[key] = sanitizeSchemaForStrictClients(value);
      continue;
    }

    if ((SCHEMA_ARRAY_KEYS as readonly string[]).includes(key) && Array.isArray(value)) {
      out[key] = value.map((item) => sanitizeSchemaForStrictClients(item));
      continue;
    }

    // --- Everything else: copy through. --------------------------------
    // Deep-clone plain objects / arrays encountered in unknown positions
    // so the returned value is fully decoupled from the input. Primitives
    // are copied by reference (immutable anyway).
    if (isPlainObject(value)) {
      out[key] = sanitizeSchemaForStrictClients(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        isPlainObject(item) || Array.isArray(item)
          ? sanitizeSchemaForStrictClients(item)
          : item,
      );
    } else {
      out[key] = value;
    }
  }

  return out;
}

/**
 * Sanitize a tool-list response in place-preserving fashion. Returns a new
 * array with every tool's `inputSchema` (and `outputSchema`, if present)
 * passed through `sanitizeSchemaForStrictClients`, and every top-level
 * `description` clipped at 1000 chars.
 *
 * Shape matches what MCP SDK emits from `tools/list`.
 */
export function sanitizeToolListResponse(response: unknown): unknown {
  if (!isPlainObject(response)) return response;
  const tools = response.tools;
  if (!Array.isArray(tools)) return response;

  const sanitizedTools = tools.map((tool) => {
    if (!isPlainObject(tool)) return tool;
    const t: Record<string, unknown> = { ...tool };
    if (typeof t.description === "string") {
      t.description = truncateDescription(t.description);
    }
    if (t.inputSchema !== undefined) {
      t.inputSchema = sanitizeSchemaForStrictClients(t.inputSchema);
    }
    if (t.outputSchema !== undefined) {
      t.outputSchema = sanitizeSchemaForStrictClients(t.outputSchema);
    }
    return t;
  });

  return { ...response, tools: sanitizedTools };
}
