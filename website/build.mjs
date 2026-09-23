// Builds shapeitup.dev into website/dist.
//
//   dist/index.html        landing page (website/public, copied as-is)
//   dist/app/index.html    the playground: editor + the REAL viewer
//   dist/app/viewer.html   the viewer page, from the same template both hosts use
//   dist/app/*.js|wasm     viewer, worker and kernels, straight from extension/dist
//
// The playground has no backend. The viewer picks its transport by looking for
// `acquireVsCodeApi()`, so viewer.html defines one that forwards to the parent
// page, and the parent plays host: it transpiles the editor's TypeScript, sends
// `execute-script`, and answers face-op / param commits by editing the source
// in the editor with the same pure functions the serve host writes files with.
//
// Needs `pnpm build` at the repo root first (for extension/dist).

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(here, "dist");
const extDist = path.join(root, "packages/extension/dist");

// MuJoCo (10 MB) is left out: without it Sim is disabled, nothing else changes.
const ASSETS = [
  "viewer.js",
  "worker.js",
  "replicad_single.js",
  "replicad_single.wasm",
  "manifold.js",
  "manifold.wasm",
];

for (const a of ASSETS) {
  if (!fs.existsSync(path.join(extDist, a))) {
    console.error(`missing ${a} in packages/extension/dist — run \`pnpm build\` at the repo root first`);
    process.exit(1);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "app"), { recursive: true });

// ── 1. Static site ────────────────────────────────────────────────────────
fs.cpSync(path.join(here, "public"), dist, { recursive: true });

// ── 2. Viewer assets ──────────────────────────────────────────────────────
for (const a of ASSETS) fs.copyFileSync(path.join(extDist, a), path.join(dist, "app", a));

// ── 3. viewer.html from the shared template ───────────────────────────────
// Rendered at build time, so asset URLs are placeholders that the page turns
// into absolute URLs at runtime: the worker runs from a blob: URL, and a
// relative URL resolved from there fails with "Failed to fetch OCCT loader".
{
  const out = await esbuild.build({
    stdin: {
      contents: `export { renderViewerHtml } from "@shapeitup/shared";`,
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const mod = await import(
    "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
  );
  const NONCE = "shapeitup-playground";
  const P = "__ASSET__";
  let html = mod.renderViewerHtml({
    assets: {
      viewerJs: "viewer.js",
      workerJs: P + "worker.js",
      wasmLoaderJs: P + "replicad_single.js",
      wasmFile: P + "replicad_single.wasm",
      manifoldLoaderJs: P + "manifold.js",
      manifoldWasmFile: P + "manifold.wasm",
      mujocoLoaderJs: P + "mujoco.js",
      mujocoWasmFile: P + "mujoco.wasm",
    },
    cspSource: "'self'",
    nonce: NONCE,
    workerSrc: "'self'",
  });
  html = html.replace(/"__ASSET__([^"]+)"/g, (_, f) => `new URL(${JSON.stringify(f)}, location.href).href`);
  const shim = fs.readFileSync(path.join(here, "src/viewer-shim.js"), "utf-8");
  html = html.replace(
    /<script nonce="[^"]+">\s*window\.__SHAPEITUP_CONFIG__/,
    (m) => `<script nonce="${NONCE}">\n${shim}\n</script>\n  ${m}`,
  );
  if (!html.includes("acquireVsCodeApi")) throw new Error("viewer shim was not injected");
  fs.writeFileSync(path.join(dist, "app/viewer.html"), html);
}

// ── 4. Playground host ────────────────────────────────────────────────────
await esbuild.build({
  entryPoints: [path.join(here, "src/playground.ts")],
  outfile: path.join(dist, "app/playground.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: true,
  logLevel: "warning",
});
fs.copyFileSync(path.join(here, "src/playground.html"), path.join(dist, "app/index.html"));
fs.copyFileSync(path.join(here, "src/playground.css"), path.join(dist, "app/playground.css"));

// ── 5. Example projects ───────────────────────────────────────────────────
// examples/<project>/<file>.shape.ts → one JSON the playground loads.
{
  const exDir = path.join(here, "examples");
  const order = JSON.parse(fs.readFileSync(path.join(exDir, "index.json"), "utf-8"));
  const projects = order.map((p) => ({
    ...p,
    files: p.files.map((name) => ({
      name,
      source: fs.readFileSync(path.join(exDir, p.id, name), "utf-8"),
    })),
  }));
  fs.writeFileSync(path.join(dist, "app/examples.json"), JSON.stringify(projects));
}

console.log("built website/dist");

// ── dev server ────────────────────────────────────────────────────────────
if (process.argv.includes("--serve")) {
  // A 1440-wide desktop render scaled into whatever window is looking at it.
  fs.copyFileSync(path.join(here, "src/dev-preview.html"), path.join(dist, "_preview.html"));
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  };
  const port = Number(process.env.PORT ?? 4321);
  http
    .createServer((req, res) => {
      // Dev-only: the playground's `?capture=` hook posts renders here.
      if (req.method === "POST" && req.url.startsWith("/__capture")) {
        const name = new URL(req.url, "http://x").searchParams.get("name")?.replace(/[^\w-]/g, "");
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const b64 = body.replace(/^data:image\/\w+;base64,/, "");
          const dir = path.join(here, "public/img");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(b64, "base64"));
          console.log(`captured public/img/${name}.png`);
          res.writeHead(200).end("ok");
        });
        return;
      }
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = path.join(dist, p);
      if (!file.startsWith(dist) || !fs.existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    })
    .listen(port, () => console.log(`http://localhost:${port}`));
}
