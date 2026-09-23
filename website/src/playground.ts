/**
 * The playground: an in-browser host for the real ShapeItUp viewer.
 *
 * The VS Code extension and the serve host both keep the `.shape.ts` on disk
 * and edit it. Here the "disk" is the editor. Everything the viewer can write —
 * a committed slider, a fillet, a join, a move, a mirror — goes through the
 * same pure edit functions from `@shapeitup/shared` that the serve host uses,
 * lands in the editor as text, and is re-run from there. So the playground
 * shows the actual promise: every click becomes code.
 *
 * Bundling: the serve host runs esbuild. That is 14 MB of WASM, so the
 * playground uses Sucrase instead: each file is stripped of types and turned
 * into a CommonJS-style module, and the modules are stitched into one script.
 * `require("replicad")` / `require("shapeitup")` need nothing from us — the
 * executor already rewrites `__require("replicad")` to its own module object.
 */
import { transform } from "sucrase";
import {
  buildFaceOpCall,
  computeArrangeEdit,
  computeCombineEdit,
  computeParamEdit,
  computeTransformEdit,
  describeArrangeFailure,
  describeCombineFailure,
  describeTransformFailure,
  ensureStdlibImport,
  type FaceOpResultMessage,
} from "@shapeitup/shared";

interface ShapeFile {
  name: string;
  source: string;
}
interface Project {
  id: string;
  title: string;
  blurb: string;
  entry: string;
  files: ShapeFile[];
}
interface Edit {
  start: number;
  end: number;
  text: string;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const frame = $<HTMLIFrameElement>("#viewer");
const editor = $<HTMLTextAreaElement>("#code");
const highlight = $<HTMLElement>("#highlight code");
const gutter = $<HTMLElement>("#gutter");
const tabs = $<HTMLElement>("#tabs");
const picker = $<HTMLSelectElement>("#project");
const log = $<HTMLElement>("#log");
const statusDot = $<HTMLElement>("#status-dot");
const statusText = $<HTMLElement>("#status-text");

const params = new URLSearchParams(location.search);
if (params.has("embed")) {
  document.body.classList.add("embed");
  // The viewer's toolbar needs ~760 px; give it the room inside the landing page.
  $<HTMLElement>("main").style.setProperty("--code-w", "36%");
}
if (params.get("layout") === "viewer") document.body.classList.add("viewer-only");

let projects: Project[] = [];
let project: Project;
let active = 0; // index of the open tab, which is also the file rendered
let viewerReady = false;
let runTimer: ReturnType<typeof setTimeout> | undefined;
let lastRunSource = "";
let frameCameraOnce = true;

// ── Logging ───────────────────────────────────────────────────────────────

type LogKind = "info" | "ok" | "err" | "edit";
function note(kind: LogKind, text: string) {
  const row = document.createElement("div");
  row.className = `log-row ${kind}`;
  const t = new Date();
  const stamp = document.createElement("span");
  stamp.className = "log-time";
  stamp.textContent = t.toTimeString().slice(0, 8);
  const body = document.createElement("span");
  body.className = "log-body";
  body.textContent = text;
  row.append(stamp, body);
  log.append(row);
  while (log.children.length > 60) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
}

function setStatus(kind: "busy" | "ok" | "err", text: string) {
  statusDot.dataset.kind = kind;
  statusText.textContent = text;
}

// ── Editor ────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(
  "import export from default function return const let var if else for of in new as typeof type interface extends true false null undefined while break continue throw try catch".split(
    " ",
  ),
);

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A small tokenizer: enough to make TypeScript readable, not a parser. */
function highlightTs(src: string): string {
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;
  let out = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [tok, comment, str, num, ident] = m;
    if (comment) out += `<span class="t-com">${escapeHtml(comment)}</span>`;
    else if (str) out += `<span class="t-str">${escapeHtml(str)}</span>`;
    else if (num) out += `<span class="t-num">${num}</span>`;
    else if (ident) {
      if (KEYWORDS.has(ident)) out += `<span class="t-kw">${ident}</span>`;
      else if (src[re.lastIndex] === "(") out += `<span class="t-fn">${ident}</span>`;
      else out += ident;
    } else out += escapeHtml(tok);
  }
  // A trailing newline needs a character after it or the <pre> drops the line.
  return out + "\n ";
}

function paintEditor() {
  highlight.innerHTML = highlightTs(editor.value);
  const lines = editor.value.split("\n").length;
  let g = "";
  for (let i = 1; i <= lines; i++) g += i + "\n";
  gutter.textContent = g;
}

function syncScroll() {
  const pre = highlight.parentElement!;
  pre.scrollTop = editor.scrollTop;
  pre.scrollLeft = editor.scrollLeft;
  gutter.scrollTop = editor.scrollTop;
}

editor.addEventListener("input", () => {
  project.files[active].source = editor.value;
  paintEditor();
  scheduleRun();
});
editor.addEventListener("scroll", syncScroll);
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: t } = editor;
    editor.setRangeText("  ", s, t, "end");
    editor.dispatchEvent(new Event("input"));
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    run("saved");
  }
});

/** Replace the open file's text, keeping the caret where it was if possible. */
function replaceSource(next: string, flashRanges?: Array<[number, number]>) {
  const caret = editor.selectionStart;
  project.files[active].source = next;
  editor.value = next;
  editor.selectionStart = editor.selectionEnd = Math.min(caret, next.length);
  paintEditor();
  if (flashRanges?.length) flashLines(next, flashRanges);
}

/** Briefly mark the lines each edit touched, so the click → code link is visible. */
function flashLines(src: string, ranges: Array<[number, number]>) {
  const layer = $<HTMLElement>("#flash");
  layer.innerHTML = "";
  const lh = parseFloat(getComputedStyle(editor).lineHeight);
  const pad = parseFloat(getComputedStyle(editor).paddingTop);
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const rows = ranges.map(([s, e]) => [lineOf(s), lineOf(Math.max(s, e))] as const);

  // Bring the LAST edit into view — the import it may have added sits at the
  // top of the file, but the interesting line is the call.
  const target = pad + (rows[rows.length - 1][0] - 1) * lh;
  if (target < editor.scrollTop || target > editor.scrollTop + editor.clientHeight - 2 * lh) {
    editor.scrollTop = Math.max(0, target - editor.clientHeight / 3);
    syncScroll();
  }
  for (const [first, last] of rows) {
    const bar = document.createElement("div");
    bar.className = "flash-bar";
    bar.style.top = `${pad + (first - 1) * lh - editor.scrollTop}px`;
    bar.style.height = `${(last - first + 1) * lh}px`;
    layer.append(bar);
    setTimeout(() => bar.classList.add("fade"), 1800);
    setTimeout(() => bar.remove(), 2800);
  }
}

// ── Tabs & projects ───────────────────────────────────────────────────────

function renderTabs() {
  tabs.innerHTML = "";
  project.files.forEach((f, i) => {
    const b = document.createElement("button");
    b.className = "tab" + (i === active ? " active" : "");
    b.textContent = f.name;
    if (f.name === project.entry && project.files.length > 1) {
      const badge = document.createElement("span");
      badge.className = "tab-badge";
      badge.textContent = "entry";
      b.append(badge);
    }
    b.onclick = () => openTab(i);
    tabs.append(b);
  });
}

function openTab(i: number) {
  active = i;
  frameCameraOnce = true;
  editor.value = project.files[i].source;
  editor.scrollTop = 0;
  paintEditor();
  syncScroll();
  renderTabs();
  run("opened");
}

function loadProject(id: string) {
  const p = projects.find((x) => x.id === id) ?? projects[0];
  // Deep copy so "Reset" can always go back to the shipped text.
  project = JSON.parse(JSON.stringify(p));
  picker.value = project.id;
  $<HTMLElement>("#blurb").textContent = project.blurb;
  const entry = project.files.findIndex((f) => f.name === project.entry);
  const url = new URL(location.href);
  url.searchParams.set("example", project.id);
  history.replaceState(null, "", url);
  openTab(entry >= 0 ? entry : 0);
}

// ── Bundling ──────────────────────────────────────────────────────────────

const moduleKey = (spec: string) =>
  spec
    .replace(/^.*\//, "")
    .replace(/\.ts$/, "")
    .replace(/\.shape$/, "");

/**
 * Stitch the project into one script whose entry is the open tab.
 *
 * Mirrors what the esbuild wrapper in `bundle-spec.ts` produces: the entry's
 * exports are stamped onto the sentinel-gated globals, which is how the
 * executor finds `main` / `params` in a multi-file bundle.
 */
function bundle(entryName: string): string {
  const defs: string[] = [];
  for (const f of project.files) {
    let code: string;
    try {
      code = transform(f.source, {
        transforms: ["typescript", "imports"],
        filePath: f.name,
        disableESTransforms: true,
        production: true,
      }).code;
    } catch (e: any) {
      throw new Error(`${f.name}: ${e?.message ?? e}`);
    }
    code = code.replace(/\brequire\(/g, "__require(");
    defs.push(`${JSON.stringify(moduleKey(f.name))}: function (exports, module) {\n${code}\n}`);
  }
  const entry = JSON.stringify(moduleKey(entryName));
  return `
var __defs = {${defs.join(",\n")}};
var __cache = {};
function __require(spec) {
  var key = String(spec).replace(/^.*\\//, "").replace(/\\.ts$/, "").replace(/\\.shape$/, "");
  if (__cache[key]) return __cache[key].exports;
  var def = __defs[key];
  if (!def) throw new Error("Cannot find module '" + spec + "' — the playground only resolves files open in its tabs");
  var module = { exports: {} };
  __cache[key] = module;
  def(module.exports, module);
  return module.exports;
}
var __entry = __require(${entry});
globalThis.__SHAPEITUP_ENTRY_MAIN__ = __entry.default;
globalThis.__SHAPEITUP_ENTRY_PARAMS__ = __entry.params;
globalThis.__SHAPEITUP_ENTRY_MATERIAL__ = __entry.material;
globalThis.__SHAPEITUP_ENTRY_CONFIG__ = __entry.config;
globalThis.__SHAPEITUP_ENTRY_SIM__ = __entry.sim;
globalThis.__SHAPEITUP_ENTRY_SENTINEL__ = true;
`;
}

// ── Talking to the viewer ─────────────────────────────────────────────────

function toViewer(msg: Record<string, unknown>) {
  frame.contentWindow?.postMessage(msg, location.origin);
}

function scheduleRun() {
  clearTimeout(runTimer);
  runTimer = setTimeout(() => run("edited"), 450);
}

function run(reason: string) {
  if (!viewerReady) return;
  const file = project.files[active];
  let js: string;
  try {
    js = bundle(file.name);
  } catch (e: any) {
    setStatus("err", "Syntax error");
    note("err", String(e?.message ?? e));
    return;
  }
  if (reason === "edited" && js === lastRunSource) return;
  lastRunSource = js;
  setStatus("busy", "Building…");
  toViewer({ type: "execute-script", js, fileName: file.name });
}

/** Apply edits; returns the new text and where each edit landed in it. */
function applyEdits(source: string, edits: Edit[]): { next: string; spans: Array<[number, number]> } {
  let next = source;
  // Descending, so each edit's offsets still describe the text they were
  // computed against.
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, e.start) + e.text + next.slice(e.end);
  }
  // Ascending again to find the final positions: each edit shifts the ones
  // after it by its change in length.
  const spans: Array<[number, number]> = [];
  let shift = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    const start = e.start + shift;
    spans.push([start, start + e.text.length]);
    shift += e.text.length - (e.end - e.start);
  }
  return { next, spans };
}

function commitGeometry(
  kind: FaceOpResultMessage["kind"],
  requestId: number,
  built: { ok: true; edits: Edit[]; applied: string; addedImport?: boolean } | { ok: false; reason: string },
) {
  if (!built.ok) {
    note("err", built.reason);
    toViewer({ type: "face-op-result", kind, requestId, ok: false, reason: built.reason });
    return;
  }
  const source = project.files[active].source;
  const { next, spans } = applyEdits(source, built.edits);
  replaceSource(next, spans);
  note("edit", built.applied);
  toViewer({
    type: "face-op-result",
    kind,
    requestId,
    ok: true,
    applied: built.applied,
    addedImport: built.addedImport,
  } satisfies FaceOpResultMessage);
  // The geometry now exists only in the text — rebuild from it, as the
  // serve host's file watcher would.
  run("applied");
}

function download(name: string, data: BlobPart, type = "application/octet-stream") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Dev-only: `?capture=name` screenshots the first render through the viewer's
// own capture path and POSTs it to the dev server (`build.mjs --serve`), which
// is how the landing page's renders are produced. A no-op anywhere else.
const capture = params.get("capture");
let captured = false;
function maybeCapture() {
  if (!capture || captured) return;
  captured = true;
  setTimeout(() => {
    toViewer({
      type: "viewer-command",
      command: "prepare-screenshot",
      renderMode: params.get("mode") ?? "dark",
      cameraAngle: params.get("angle") ?? "isometric",
      showDimensions: params.has("dims"),
      showCompass: false,
    });
    setTimeout(
      () =>
        toViewer({
          type: "request-screenshot",
          width: Number(params.get("w") ?? 1600),
          height: Number(params.get("h") ?? 1200),
        }),
      400,
    );
  }, 600);
}

const stem = () =>project.files[active].name.replace(/\.shape\.ts$/, "");

function onViewerMessage(msg: any) {
  const source = () => project.files[active].source;
  switch (msg.type) {
    case "request-wasm-assets":
      // Mandatory reply; empty means "fetch the wasm by URL yourself".
      toViewer({ type: "wasm-assets" });
      break;
    case "ready":
      viewerReady = true;
      document.body.classList.add("ready");
      note("ok", "OpenCascade kernel loaded in this tab — no server involved");
      run("ready");
      break;
    case "render-success": {
      const bb = msg.boundingBox;
      const dims = bb ? `${bb.x.toFixed(1)} × ${bb.y.toFixed(1)} × ${bb.z.toFixed(1)} mm` : "";
      setStatus("ok", dims || "Rendered");
      const t = msg.timings?.total ?? msg.timings?.execute;
      note(
        "ok",
        `${project.files[active].name} → ${msg.partCount} part${msg.partCount === 1 ? "" : "s"}` +
          (dims ? ` · ${dims}` : "") +
          (t ? ` · ${Math.round(t)} ms` : ""),
      );
      for (const w of msg.warnings ?? []) note("info", w);
      if (frameCameraOnce) {
        // The viewer's default camera looks at the back of these examples.
        frameCameraOnce = false;
        toViewer({ type: "viewer-command", command: "set-camera-angle", angle: "isometric" });
      }
      maybeCapture();
      break;
    }
    case "screenshot-data":
      if (capture) {
        void fetch(`/__capture?name=${encodeURIComponent(capture)}`, { method: "POST", body: msg.dataUrl }).then(
          (r) => note(r.ok ? "ok" : "err", `captured ${capture}: ${r.status}`),
        );
      }
      break;
    case "error":
      setStatus("err", "Error");
      note("err", (msg.line ? `line ${msg.line}: ` : "") + msg.message);
      break;
    case "part-warning":
      note("info", msg.message);
      break;
    case "param-changed":
      for (const [name, value] of Object.entries(msg.params ?? {})) {
        if (typeof value !== "number") continue;
        const r = computeParamEdit(source(), name, value);
        if (!r.ok) {
          const ok = r.reason === "unchanged";
          toViewer({ type: "param-commit-result", name, value, ok, reason: ok ? undefined : r.reason });
          continue;
        }
        const next = source().slice(0, r.edit.start) + r.edit.text + source().slice(r.edit.end);
        replaceSource(next, [[r.edit.start, r.edit.start + r.edit.text.length]]);
        lastRunSource = bundle(project.files[active].name); // already rendering this value
        note("edit", `params.${name} = ${r.edit.text}`);
        toViewer({ type: "param-commit-result", name, value, ok: true });
      }
      break;
    case "face-op": {
      const built = buildFaceOpCall(source(), msg);
      commitGeometry("face-op", msg.requestId, built.ok ? built : { ok: false, reason: built.reason });
      break;
    }
    case "combine": {
      const built = computeCombineEdit(source(), {
        op: msg.op,
        targetName: msg.targetName,
        toolNames: msg.toolNames,
        keepTools: msg.keepTools === true,
      });
      commitGeometry(
        "combine",
        msg.requestId,
        built.ok ? built : { ok: false, reason: describeCombineFailure(built.reason, built.detail) },
      );
      break;
    }
    case "transform": {
      const built = computeTransformEdit(source(), {
        partName: msg.partName,
        rotate: msg.rotate,
        translate: msg.translate,
        copyAs: msg.copyAs,
      });
      commitGeometry(
        "transform",
        msg.requestId,
        built.ok
          ? built
          : {
              ok: false,
              reason: describeTransformFailure(
                built.reason,
                built.reason === "name-taken" ? msg.copyAs : msg.partName,
              ),
            },
      );
      break;
    }
    case "arrange": {
      const built = computeArrangeEdit(source(), {
        partName: msg.partName,
        spec: msg.spec,
        asNewBody: msg.asNewBody,
      });
      if (!built.ok) {
        commitGeometry("arrange", msg.requestId, {
          ok: false,
          reason: describeArrangeFailure(
            built.reason,
            built.reason === "name-taken" ? msg.asNewBody : msg.partName,
          ),
        });
        break;
      }
      const edits: Edit[] = [...built.edits];
      if (built.needsImport) {
        const imp = ensureStdlibImport(source(), built.needsImport);
        if (imp) edits.push(imp);
      }
      commitGeometry("arrange", msg.requestId, { ok: true, edits, applied: built.applied });
      break;
    }
    case "toolbar-export":
      toViewer({ type: msg.split ? "request-export-split" : "request-export", format: msg.format });
      break;
    case "export-data":
      download(`${stem()}.${msg.format}`, msg.data);
      note("ok", `Exported ${stem()}.${msg.format}`);
      break;
    case "export-split-data":
      for (const item of msg.items ?? []) download(`${item.name}.${msg.format}`, item.data);
      note("ok", `Exported ${msg.items?.length ?? 0} files`);
      break;
    case "toolbar-open-in-app":
      note("info", "Open in slicer/CAD needs the desktop install — export the file instead.");
      break;
  }
}

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  const d = e.data;
  if (d && d.__shapeitup === "viewer" && d.msg) onViewerMessage(d.msg);
});

// ── Chrome ────────────────────────────────────────────────────────────────

$<HTMLButtonElement>("#run").onclick = () => run("saved");
$<HTMLButtonElement>("#reset").onclick = () => loadProject(project.id);
$<HTMLButtonElement>("#download").onclick = () => {
  const f = project.files[active];
  download(f.name, f.source, "text/plain");
};
picker.onchange = () => loadProject(picker.value);

// Splitter between editor and viewer.
{
  const split = $<HTMLElement>("#split");
  const main = $<HTMLElement>("main");
  split.addEventListener("pointerdown", (e) => {
    split.setPointerCapture(e.pointerId);
    frame.style.pointerEvents = "none";
    const move = (ev: PointerEvent) => {
      const r = main.getBoundingClientRect();
      const pct = Math.min(70, Math.max(22, ((ev.clientX - r.left) / r.width) * 100));
      main.style.setProperty("--code-w", `${pct}%`);
    };
    const up = () => {
      frame.style.pointerEvents = "";
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", up);
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
  });
}

async function boot() {
  setStatus("busy", "Loading kernel…");
  note("info", "Fetching OpenCascade (WASM, ~4.5 MB gzipped)…");
  projects = await (await fetch("examples.json")).json();
  for (const p of projects) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.title;
    picker.append(o);
  }
  loadProject(params.get("example") ?? projects[0].id);
  frame.src = "viewer.html";
}

void boot();
