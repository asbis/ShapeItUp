import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

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

async function main() {
  muzzleStdout();

  const server = new McpServer({
    name: "shapeitup",
    version: "0.3.0",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("ShapeItUp MCP server failed to start:", err);
  process.exit(1);
});
