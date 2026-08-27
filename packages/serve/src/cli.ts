#!/usr/bin/env node
/**
 * Standalone viewer host CLI — runs the ShapeItUp 3D preview in any browser
 * (e.g. the Claude Code browser pane) with no VSCode webview involved.
 *
 * The MCP server embeds the same `ViewerHost` and drives it through the
 * `open_viewer` tool; this CLI exists for running the viewer on its own.
 *
 *   shapeitup-serve <file.shape.ts> [--port 4444] [--dist <dir>]
 */
import * as path from "node:path";
import { ViewerHost, directoryAssetResolver } from "./host.js";
import { bundleShapeFile } from "./bundle.js";

async function main() {
  const argv = process.argv.slice(2);
  const rest: string[] = [];
  let port = 4444;
  let dist = path.resolve(__dirname, "../../extension/dist");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--dist") dist = path.resolve(argv[++i]);
    else rest.push(argv[i]);
  }
  if (!rest[0]) {
    console.error("usage: shapeitup-serve <file.shape.ts> [--port N] [--dist DIR]");
    process.exit(1);
  }

  const host = new ViewerHost({
    resolveAsset: directoryAssetResolver(dist),
    port,
    bundle: bundleShapeFile,
    log: (l) => console.log(`[serve] ${l}`),
  });
  await host.start();
  await host.setFile(path.resolve(rest[0]));
}

main().catch((e) => {
  console.error(`[serve] ${e?.message ?? e}`);
  process.exit(1);
});
