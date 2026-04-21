import { describe, it, expect } from "vitest";
import {
  sanitizeSchemaForStrictClients,
  sanitizeToolListResponse,
} from "./schema-sanitizer.js";

// ---------------------------------------------------------------------------
// Pure-function unit tests for the sanitizer.
//
// The sanitizer's job is to turn zod-to-json-schema's default output into
// something Gemini CLI's stricter OpenAPI-3.0-subset validator will accept,
// without losing any runtime-validation behaviour. These tests lock in each
// transformation individually so a regression in any single rule is visible.
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForStrictClients — single-field transformations", () => {
  it("strips $schema at the root", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
    };
    const out = sanitizeSchemaForStrictClients(input) as Record<string, unknown>;
    expect(out.$schema).toBeUndefined();
    expect(out.type).toBe("object");
  });

  it("strips propertyNames wherever it appears", () => {
    const input = {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: { type: "number" },
    };
    const out = sanitizeSchemaForStrictClients(input) as Record<string, unknown>;
    expect(out.propertyNames).toBeUndefined();
  });

  it("collapses object-valued additionalProperties to `true`", () => {
    const input = {
      type: "object",
      additionalProperties: { type: "number" },
    };
    const out = sanitizeSchemaForStrictClients(input) as Record<string, unknown>;
    expect(out.additionalProperties).toBe(true);
  });

  it("preserves boolean additionalProperties unchanged", () => {
    const inputTrue = { type: "object", additionalProperties: true };
    const inputFalse = { type: "object", additionalProperties: false };
    expect(
      (sanitizeSchemaForStrictClients(inputTrue) as any).additionalProperties,
    ).toBe(true);
    expect(
      (sanitizeSchemaForStrictClients(inputFalse) as any).additionalProperties,
    ).toBe(false);
  });

  it("omits additionalProperties when it was absent", () => {
    const input = { type: "object", properties: { a: { type: "number" } } };
    const out = sanitizeSchemaForStrictClients(input) as Record<string, unknown>;
    expect("additionalProperties" in out).toBe(false);
  });

  it("truncates descriptions longer than 1000 chars with an ellipsis", () => {
    const longDesc = "x".repeat(1500);
    const input = { description: longDesc, type: "string" };
    const out = sanitizeSchemaForStrictClients(input) as Record<string, unknown>;
    const desc = out.description as string;
    expect(desc.length).toBe(1000);
    expect(desc.endsWith("\u2026")).toBe(true);
    // First 999 chars are the original 999 chars.
    expect(desc.slice(0, 999)).toBe("x".repeat(999));
  });

  it("leaves descriptions 1000 chars or shorter unchanged", () => {
    const exactly1000 = "y".repeat(1000);
    const shorter = "short description";
    expect(
      (sanitizeSchemaForStrictClients({ description: exactly1000 }) as any)
        .description,
    ).toBe(exactly1000);
    expect(
      (sanitizeSchemaForStrictClients({ description: shorter }) as any)
        .description,
    ).toBe(shorter);
  });
});

describe("sanitizeSchemaForStrictClients — recursion", () => {
  it("recurses into properties", () => {
    const input = {
      type: "object",
      properties: {
        inner: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: { type: "number" },
        },
      },
    };
    const out = sanitizeSchemaForStrictClients(input) as any;
    expect(out.properties.inner.$schema).toBeUndefined();
    expect(out.properties.inner.additionalProperties).toBe(true);
  });

  it("recurses into items (single-schema form)", () => {
    const input = {
      type: "array",
      items: {
        $schema: "http://json-schema.org/draft-07/schema#",
        propertyNames: { type: "string" },
        type: "object",
      },
    };
    const out = sanitizeSchemaForStrictClients(input) as any;
    expect(out.items.$schema).toBeUndefined();
    expect(out.items.propertyNames).toBeUndefined();
  });

  it("recurses into anyOf / oneOf / allOf arrays", () => {
    const input = {
      anyOf: [
        { $schema: "http://json-schema.org/draft-07/schema#", type: "string" },
        { propertyNames: { type: "string" }, type: "object" },
      ],
      oneOf: [
        { additionalProperties: { type: "number" }, type: "object" },
      ],
      allOf: [
        { $schema: "http://json-schema.org/draft-07/schema#" },
      ],
    };
    const out = sanitizeSchemaForStrictClients(input) as any;
    expect(out.anyOf[0].$schema).toBeUndefined();
    expect(out.anyOf[1].propertyNames).toBeUndefined();
    expect(out.oneOf[0].additionalProperties).toBe(true);
    expect(out.allOf[0].$schema).toBeUndefined();
  });

  it("recurses through deeply nested structures", () => {
    const input = {
      type: "object",
      properties: {
        outer: {
          type: "array",
          items: {
            type: "object",
            properties: {
              deep: {
                $schema: "http://json-schema.org/draft-07/schema#",
                propertyNames: { type: "string" },
                additionalProperties: { type: "number" },
                description: "a".repeat(2000),
              },
            },
          },
        },
      },
    };
    const out = sanitizeSchemaForStrictClients(input) as any;
    const deep = out.properties.outer.items.properties.deep;
    expect(deep.$schema).toBeUndefined();
    expect(deep.propertyNames).toBeUndefined();
    expect(deep.additionalProperties).toBe(true);
    expect(deep.description.length).toBe(1000);
  });

  it("truncates nested property descriptions", () => {
    const input = {
      type: "object",
      properties: {
        x: { description: "x".repeat(1200), type: "string" },
      },
    };
    const out = sanitizeSchemaForStrictClients(input) as any;
    expect(out.properties.x.description.length).toBe(1000);
    expect(out.properties.x.description.endsWith("\u2026")).toBe(true);
  });
});

describe("sanitizeSchemaForStrictClients — preservation & purity", () => {
  it("preserves unaffected fields exactly", () => {
    const input = {
      type: "object",
      title: "Widget",
      description: "a widget",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 50,
          pattern: "^[a-z]+$",
          default: "bob",
          enum: ["bob", "alice"],
        },
      },
      additionalProperties: false,
    };
    const out = sanitizeSchemaForStrictClients(input) as any;
    expect(out.title).toBe("Widget");
    expect(out.description).toBe("a widget");
    expect(out.required).toEqual(["name"]);
    expect(out.properties.name.minLength).toBe(1);
    expect(out.properties.name.maxLength).toBe(50);
    expect(out.properties.name.pattern).toBe("^[a-z]+$");
    expect(out.properties.name.default).toBe("bob");
    expect(out.properties.name.enum).toEqual(["bob", "alice"]);
    expect(out.additionalProperties).toBe(false);
  });

  it("does NOT mutate the input (purity)", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: { type: "number" },
      description: "x".repeat(1500),
      properties: {
        nested: {
          $schema: "http://json-schema.org/draft-07/schema#",
          additionalProperties: { type: "string" },
        },
      },
    };
    // Take a structural snapshot before sanitizing.
    const before = JSON.stringify(input);
    sanitizeSchemaForStrictClients(input);
    const after = JSON.stringify(input);
    expect(after).toBe(before);
    // Explicit checks on the most-sensitive fields.
    expect(input.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(input.propertyNames).toEqual({ type: "string" });
    expect(input.additionalProperties).toEqual({ type: "number" });
    expect(input.description.length).toBe(1500);
    expect(input.properties.nested.$schema).toBe(
      "http://json-schema.org/draft-07/schema#",
    );
  });

  it("handles primitives, null, and non-plain objects gracefully", () => {
    expect(sanitizeSchemaForStrictClients(42)).toBe(42);
    expect(sanitizeSchemaForStrictClients("string")).toBe("string");
    expect(sanitizeSchemaForStrictClients(true)).toBe(true);
    expect(sanitizeSchemaForStrictClients(null)).toBe(null);
    expect(sanitizeSchemaForStrictClients(undefined)).toBe(undefined);
  });

  it("handles arrays at the top level", () => {
    const input = [
      { $schema: "x", type: "string" },
      { propertyNames: { type: "string" }, type: "object" },
    ];
    const out = sanitizeSchemaForStrictClients(input) as any[];
    expect(out[0].$schema).toBeUndefined();
    expect(out[1].propertyNames).toBeUndefined();
  });
});

describe("sanitizeToolListResponse", () => {
  it("sanitizes every tool's inputSchema", () => {
    const response = {
      tools: [
        {
          name: "foo",
          description: "foo tool",
          inputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            propertyNames: { type: "string" },
            additionalProperties: { type: "number" },
          },
        },
        {
          name: "bar",
          description: "bar tool",
          inputSchema: {
            type: "object",
            properties: {
              x: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
          },
        },
      ],
    };
    const out = sanitizeToolListResponse(response) as any;
    expect(out.tools[0].inputSchema.$schema).toBeUndefined();
    expect(out.tools[0].inputSchema.propertyNames).toBeUndefined();
    expect(out.tools[0].inputSchema.additionalProperties).toBe(true);
    expect(out.tools[1].inputSchema.properties.x.additionalProperties).toBe(true);
  });

  it("truncates a tool's top-level description past 1000 chars", () => {
    const response = {
      tools: [
        {
          name: "verbose",
          description: "z".repeat(1500),
          inputSchema: { type: "object" },
        },
      ],
    };
    const out = sanitizeToolListResponse(response) as any;
    expect(out.tools[0].description.length).toBe(1000);
    expect(out.tools[0].description.endsWith("\u2026")).toBe(true);
  });

  it("passes non-tool-list responses through unchanged", () => {
    expect(sanitizeToolListResponse({ foo: "bar" })).toEqual({ foo: "bar" });
    expect(sanitizeToolListResponse(null)).toBe(null);
    expect(sanitizeToolListResponse(42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Regression gate: hit the real registerTools() → tools/list flow and assert
// every emitted schema is Gemini-safe. If anyone adds a new tool with a
// too-long description or a `z.record(z.string(), z.X())` param in the
// future without updating the sanitizer, CI catches it here.
// ---------------------------------------------------------------------------
describe("tools/list emission is Gemini-safe", () => {
  it("every tool inputSchema clean of $schema, propertyNames, and object-valued additionalProperties", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerTools } = await import("./tools.js");

    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerTools(server);

    // Reach into the low-level Server and invoke the tools/list handler
    // the way the transport would. This is the same path the real server
    // takes on the wire.
    const lowLevel: any = (server as any).server;
    const handler = lowLevel._requestHandlers.get("tools/list");
    expect(typeof handler).toBe("function");

    const response = await handler(
      { method: "tools/list", params: {} },
      { signal: new AbortController().signal, sendRequest: async () => ({}), sendNotification: async () => {}, requestId: 1 },
    );
    expect(response).toBeTruthy();
    expect(Array.isArray(response.tools)).toBe(true);
    expect(response.tools.length).toBeGreaterThan(0);

    // Walk every schema in every tool and assert it is Gemini-safe.
    const DESC_MAX = 1024;
    const offenders: string[] = [];

    function walk(node: unknown, path: string): void {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      if ("$schema" in obj) {
        offenders.push(`$schema present at ${path}`);
      }
      if ("propertyNames" in obj) {
        offenders.push(`propertyNames present at ${path}`);
      }
      const ap = obj.additionalProperties;
      if (ap !== undefined && ap !== true && ap !== false) {
        offenders.push(
          `object-valued additionalProperties at ${path} (value: ${JSON.stringify(ap)})`,
        );
      }
      if (typeof obj.description === "string" && obj.description.length > DESC_MAX) {
        offenders.push(
          `description > ${DESC_MAX} chars at ${path} (length: ${obj.description.length})`,
        );
      }
      for (const [k, v] of Object.entries(obj)) {
        walk(v, `${path}.${k}`);
      }
    }

    for (const tool of response.tools) {
      if (typeof tool.description === "string" && tool.description.length > DESC_MAX) {
        offenders.push(
          `tool '${tool.name}' description > ${DESC_MAX} chars (length: ${tool.description.length})`,
        );
      }
      if (tool.inputSchema) {
        walk(tool.inputSchema, `${tool.name}.inputSchema`);
      }
      if (tool.outputSchema) {
        walk(tool.outputSchema, `${tool.name}.outputSchema`);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        "tools/list emitted Gemini-incompatible schema fields:\n  " +
          offenders.join("\n  "),
      );
    }
  });
});
