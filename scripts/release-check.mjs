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

// 5. Claude Code plugin entry must track the extension version.
// `strict: false` means the marketplace entry IS the whole plugin definition,
// so nothing else corrects a stale version here. It drifted 1.3.0 -> 1.23.0
// unnoticed once already because no check looked at this file.
for (const plugin of marketplace.plugins ?? []) {
  if (plugin.version !== ext.version) {
    fail(
      `.claude-plugin/marketplace.json plugin '${plugin.name}' is at ${plugin.version}, ` +
      `extension is at ${ext.version}. Bump the plugin entry to match.`,
    );
  } else {
    pass(`Plugin entry '${plugin.name}' matches extension version ${ext.version}`);
  }

  // 6. Every declared skills path must resolve to a directory holding at
  // least one `<skill>/SKILL.md`. A skill is a DIRECTORY containing SKILL.md —
  // pointing at a bare SKILL.md, or at a path that doesn't exist, loads
  // nothing and fails silently at install time.
  const skillPaths = typeof plugin.skills === "string" ? [plugin.skills] : plugin.skills ?? [];
  for (const rel of skillPaths) {
    const dir = resolve(root, rel);
    if (!existsSync(dir)) {
      fail(`Plugin '${plugin.name}' declares skills path '${rel}' but ${dir} does not exist.`);
      continue;
    }
    const found = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(resolve(dir, e.name, "SKILL.md")))
      .map((e) => e.name);
    if (found.length === 0) {
      fail(
        `Plugin '${plugin.name}' skills path '${rel}' contains no <skill>/SKILL.md. ` +
        `Skills must be directories: ${rel}/<name>/SKILL.md`,
      );
    } else {
      pass(`Skills path '${rel}' resolves ${found.length} skill(s): ${found.join(", ")}`);
    }
  }
}

// 7. Are we on master? Releases are cut from master.
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
