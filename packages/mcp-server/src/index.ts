import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { getSubscriberBus, defaultGlobalStorageDir } from "./subscriber-bus.js";

/**
 * Shield stdout from non-JSON-RPC noise. OCCT's STEP writer prints transfer
 * statistics through a syscall path that bypasses Emscripten's `print` hook
 * — those lines would corrupt the JSON-RPC channel and break every client.
 *
 * We wrap process.stdout.write so anything that doesn't start with `{` (every
 * JSON-RPC message does) gets rerouted to stderr instead. Pure JSON traffic
 * passes through untouched.
 */
function muzzleStdout() {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    const s = typeof chunk === "string" ? chunk : chunk?.toString?.() ?? "";
    if (s.trimStart().startsWith("{")) {
      return realWrite(chunk, ...rest);
    }
    // Not JSON — funnel to stderr for visibility without poisoning the
    // protocol stream.
    process.stderr.write(s);
    return true;
  }) as typeof process.stdout.write;
}

/**
 * Fix A (Bug #6) — process-level safety net. `safeHandler` in tools.ts
 * catches every exception thrown synchronously or via awaited promises inside
 * a tool handler, but background tasks (setImmediate, unhandled worker
 * callbacks, stray promises) can still escape to the process level. If one
 * does, the default Node behavior is to print and exit — which closes stdio
 * and kills the MCP connection, exactly the symptom Bug #6 described.
 *
 * Log to stderr (never stdout, which is the JSON-RPC channel) and KEEP the
 * process alive. The handler-local wrapping remains the authoritative fix;
 * this is defensive-in-depth for anything that slipped past it.
 */
function installProcessSafetyNet() {
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      `[shapeitup-mcp] uncaughtException: ${err?.stack ?? err}\n`,
    );
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`[shapeitup-mcp] unhandledRejection: ${msg}\n`);
  });
}

async function main() {
  muzzleStdout();
  installProcessSafetyNet();

  const server = new McpServer({
    name: "shapeitup",
    version: "0.3.0",
  });

  // Start the subscriber bus BEFORE registering tools — callers gate on
  // `bus.publishEvent` return value, but the bus needs to be listening
  // before any tool runs. Failure to bind (port exhaustion, sandbox
  // restriction) is non-fatal: we log to stderr and continue so the MCP
  // server still answers tool calls that don't need viewer sync.
  const bus = getSubscriberBus(defaultGlobalStorageDir(), "0.3.0");
  try {
    const port = await bus.start();
    process.stderr.write(`[shapeitup-mcp] subscriber bus listening on 127.0.0.1:${port}\n`);
  } catch (err: any) {
    process.stderr.write(
      `[shapeitup-mcp] subscriber bus failed to start: ${err?.message ?? err}\n`,
    );
  }

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("ShapeItUp MCP server failed to start:", err);
  process.exit(1);
});
