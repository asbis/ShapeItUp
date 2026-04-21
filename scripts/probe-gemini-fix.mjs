#!/usr/bin/env node
// Boot-probe for the Gemini-schema-fix: spawns the built mcp-server over
// stdio, runs initialize + tools/list, and asserts every emitted schema is
// Gemini-safe.
//
// Run: `node scripts/probe-gemini-fix.mjs`

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "packages", "mcp-server", "dist", "index.js");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let stdoutBuf = "";
const pending = new Map(); // id → { resolve, reject }
let nextId = 1;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  process.stderr.write(`[server stderr] ${chunk}`);
});

child.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.error(`[probe] server exited early with code ${code}`);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }
    }, 30000);
  });
}

function sendNotification(method, params = {}) {
  const msg = { jsonrpc: "2.0", method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
}

try {
  const initResp = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gemini-probe", version: "0.0.0" },
  });
  if (initResp.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initResp.error)}`);
  }
  // Send the initialized notification (required by protocol handshake).
  sendNotification("notifications/initialized");

  const listResp = await send("tools/list");
  if (listResp.error) {
    throw new Error(`tools/list failed: ${JSON.stringify(listResp.error)}`);
  }
  const tools = listResp.result?.tools ?? [];

  let schemaCount = 0;
  let propertyNamesCount = 0;
  let objectAdditionalPropsCount = 0;
  let longestDesc = 0;
  let longestDescTool = "";
  const offenders = [];

  function walk(node, path) {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if ("$schema" in node) {
      schemaCount++;
      offenders.push(`$schema present at ${path}`);
    }
    if ("propertyNames" in node) {
      propertyNamesCount++;
      offenders.push(`propertyNames present at ${path}`);
    }
    const ap = node.additionalProperties;
    if (ap !== undefined && ap !== true && ap !== false) {
      objectAdditionalPropsCount++;
      offenders.push(
        `object-valued additionalProperties at ${path} (value: ${JSON.stringify(ap)})`,
      );
    }
    if (typeof node.description === "string" && node.description.length > longestDesc) {
      longestDesc = node.description.length;
      longestDescTool = path;
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  }

  for (const tool of tools) {
    if (typeof tool.description === "string" && tool.description.length > longestDesc) {
      longestDesc = tool.description.length;
      longestDescTool = `${tool.name}.description`;
    }
    if (tool.inputSchema) walk(tool.inputSchema, `${tool.name}.inputSchema`);
    if (tool.outputSchema) walk(tool.outputSchema, `${tool.name}.outputSchema`);
  }

  console.log(
    `${tools.length} tools, ${schemaCount} $schema, ${propertyNamesCount} propertyNames, ` +
      `${objectAdditionalPropsCount} object-additionalProperties, ` +
      `longest description: ${longestDesc} chars (${longestDescTool})`,
  );

  const anyDescOver1024 = longestDesc > 1024;
  const anyOffender =
    schemaCount > 0 ||
    propertyNamesCount > 0 ||
    objectAdditionalPropsCount > 0 ||
    anyDescOver1024;

  if (anyOffender) {
    console.error("\nOffenders:");
    for (const o of offenders) console.error(`  - ${o}`);
    if (anyDescOver1024) console.error(`  - longest description > 1024: ${longestDesc}`);
    process.exitCode = 1;
  } else {
    console.log("\nALL CHECKS PASSED.");
  }
} catch (err) {
  console.error(`[probe] FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  try {
    child.stdin.end();
  } catch {}
  // Give the server a moment to exit, then kill.
  setTimeout(() => {
    try {
      child.kill();
    } catch {}
  }, 1000);
}
