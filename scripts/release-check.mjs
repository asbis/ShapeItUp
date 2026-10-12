import { readFileSync, existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
const run = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
const runOr = (cmd, fallback) => {
  try { return run(cmd); } catch { return fallback; }
};

const ext = read("packages/extension/package.json");
const mcp = read("packages/mcp-server/package.json");
const marketplace = read(".claude-plugin/marketplace.json");

const failures = [];
const warnings = [];
const pass = (msg) => console.log(`[ OK ] ${msg}`);
const fail = (msg) => { failures.push(msg); console.log(`[FAIL] ${msg}`); };
const warn = (msg) => { warnings.push(msg); console.log(`[WARN] ${msg}`); };

console.log(`Extension   : ${ext.version}`);
console.log(`MCP server  : ${mcp.version}`);
console.log("");

// 1. Working tree must be clean (staged + unstaged + untracked tracked files).
const status = runOr("git status --porcelain", "");
if (status) {
  fail(`Working tree is dirty:\n${status.split("\n").map((l) => "       " + l).join("\n")}`);
} else {
  pass("Working tree is clean");
}

// 2. Published mcp-server version on npm — the exact silent-skip trap.
// If current local version equals what's on npm, the publish step is a no-op
// (continue-on-error: true hides it) and Marketplace users end up on stale
// code pointed at by `npx -y @shapeitup/mcp-server`.
const publishedMcp = runOr("npm view @shapeitup/mcp-server version", "");
if (!publishedMcp) {
  warn("Could not query npm for @shapeitup/mcp-server (offline?). Skipping version check.");
} else if (publishedMcp === mcp.version) {
  fail(
    `npm already has @shapeitup/mcp-server@${publishedMcp}. ` +
    `Bump packages/mcp-server/package.json before releasing, or the publish step will silently skip.`,
  );
} else {
  pass(`npm has @shapeitup/mcp-server@${publishedMcp}; local is ${mcp.version} (will publish).`);
}

// 3. Git tag for this release must not already exist.
const tagName = `v${ext.version}`;
const localTag = runOr(`git tag -l ${tagName}`, "");
if (localTag) {
  fail(`Local git tag ${tagName} already exists. Bump packages/extension/package.json or delete the tag.`);
} else {
  pass(`Local tag ${tagName} is free`);
}

const remoteTag = runOr(`git ls-remote --tags origin ${tagName}`, "");
if (remoteTag) {
  fail(`Remote tag ${tagName} already exists on origin. Bump packages/extension/package.json.`);
} else {
  pass(`Remote tag ${tagName} is free`);
}

// 4. Extension + mcp-server versions usually move in lockstep (per CLAUDE.md).
// This is a soft warning — current shipping state (ext 1.7.0 / mcp 1.6.3)
// drifted legitimately, so a hard rule would be wrong. Flag so the human
// notices when the gap widens.
if (ext.version !== mcp.version) {
  warn(
    `Extension (${ext.version}) and mcp-server (${mcp.version}) versions diverge. ` +
    `CLAUDE.md says they should usually move in lockstep — confirm this is intentional.`,
  );
} else {
  pass("Extension and mcp-server versions match");
}

// 5. Every install manifest must track the extension version. Each client
// reads its own file, and nothing else corrects a stale one: the Claude
// marketplace entry drifted 1.3.0 -> 1.23.0 unnoticed once because no check
// looked at it. server.json must also match npm exactly — the registry
// refuses a version npm doesn't have.
const claudePlugin = read(".claude-plugin/plugin.json");
const codexPlugin = read(".codex-plugin/plugin.json");
const gemini = read("gemini-extension.json");
const server = read("server.json");
const manifestVersions = [
  ...(marketplace.plugins ?? []).map((p) => [`.claude-plugin/marketplace.json plugin '${p.name}'`, p.version, ext.version]),
  [".claude-plugin/plugin.json", claudePlugin.version, ext.version],
  [".codex-plugin/plugin.json", codexPlugin.version, ext.version],
  ["gemini-extension.json", gemini.version, ext.version],
  ["server.json version", server.version, mcp.version],
  ["server.json packages[0].version", server.packages?.[0]?.version, mcp.version],
];
for (const [label, actual, expected] of manifestVersions) {
  if (actual !== expected) {
    fail(`${label} is at ${actual}, expected ${expected}. Bump it to match.`);
  } else {
    pass(`${label} is at ${expected}`);
  }
}
if (mcp.mcpName !== server.name) {
  fail(
    `packages/mcp-server/package.json mcpName is '${mcp.mcpName}' but server.json names '${server.name}'. ` +
    `The MCP Registry rejects the publish unless they match.`,
  );
} else {
  pass(`mcpName matches server.json (${server.name})`);
}

// 6. Every declared skills path must resolve to a directory holding at
// least one `<skill>/SKILL.md`. A skill is a DIRECTORY containing SKILL.md —
// pointing at a bare SKILL.md, or at a path that doesn't exist, loads
// nothing and fails silently at install time. Claude Code scans `skills/`
// by default; Codex is told to via its manifest.
const skillPaths = new Set(["./skills"]);
for (const manifest of [claudePlugin, codexPlugin]) {
  for (const rel of [manifest.skills ?? []].flat()) skillPaths.add(rel.replace(/\/+$/, ""));
}
for (const rel of skillPaths) {
  const dir = resolve(root, rel);
  if (!existsSync(dir)) {
    fail(`A plugin manifest declares skills path '${rel}' but ${dir} does not exist.`);
    continue;
  }
  const found = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(dir, e.name, "SKILL.md")))
    .map((e) => e.name);
  if (found.length === 0) {
    fail(`Skills path '${rel}' contains no <skill>/SKILL.md. Skills must be directories: ${rel}/<name>/SKILL.md`);
  } else {
    pass(`Skills path '${rel}' resolves ${found.length} skill(s): ${found.join(", ")}`);
  }
}

// 7. The npm package must carry the browser bundles `open_viewer` serves.
// They're mirrored into packages/mcp-server/dist by an esbuild onEnd plugin —
// if that mirror ever breaks, the package still publishes and `open_viewer`
// fails only at runtime, for npm users only.
for (const asset of ["viewer.js", "worker.js"]) {
  const p = resolve(root, "packages/mcp-server/dist", asset);
  if (!existsSync(p)) {
    fail(
      `packages/mcp-server/dist/${asset} is missing — run \`pnpm build\`. ` +
      `Without it, open_viewer is broken for npx/npm installs.`,
    );
  } else {
    pass(`npm package carries ${asset}`);
  }
}

// 8. Are we on master? Releases are cut from master.
const branch = runOr("git rev-parse --abbrev-ref HEAD", "");
if (branch !== "master") {
  warn(`On branch '${branch}', not 'master'. Releases are normally cut from master.`);
} else {
  pass("On master branch");
}

console.log("");
if (failures.length) {
  console.log(`Release check FAILED with ${failures.length} blocker(s)${warnings.length ? ` and ${warnings.length} warning(s)` : ""}.`);
  process.exit(1);
}
if (warnings.length) {
  console.log(`Release check passed with ${warnings.length} warning(s). Review above before running \`gh release create ${tagName}\`.`);
} else {
  console.log(`Release check passed. Ready to run:\n  gh release create ${tagName}`);
}
