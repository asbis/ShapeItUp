/**
 * Browser-side WASM loaders. Fetch the Emscripten JS loader as text and
 * eval it — `importScripts` doesn't work inside a webview worker that runs
 * from a blob URL, and the loaders ship as ES modules that importScripts
 * can't consume anyway.
 */

async function fetchWithRetry(url: string, label: string): Promise<string> {
  // Bug #2: the watchdog-triggered worker respawn routinely races the webview's
  // content server — the new Worker starts fetching its WASM loader microseconds
  // after terminate() and before the webview's resource subsystem has settled,
  // producing a 408 "request timeout". We raise the cap from 3 to 5 and add an
  // extra ~1.5s of backoff on the FIRST retry (the one that most often catches
  // the webview-content-ready race). Subsequent retries keep the original
  // linear-backoff schedule so total wait stays bounded.
  const MAX_ATTEMPTS = 5;
  let response: Response | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      response = await fetch(url);
      if (response.ok) break;
    } catch {}
    if (attempt < MAX_ATTEMPTS - 1) {
      // First retry: base 1s + extra 1.5s to cover webview content-ready.
      // Later retries: original linear backoff.
      const extra = attempt === 0 ? 1500 : 0;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) + extra));
    }
  }
  if (!response || !response.ok) {
    throw new Error(
      `Failed to fetch ${label} after ${MAX_ATTEMPTS} attempts: ${response?.status || "network error"}`,
    );
  }
  return response.text();
}

export async function loadOCCTBrowser(
  wasmLoaderUrl: string,
  wasmUrl: string,
): Promise<any> {
  let loaderCode = await fetchWithRetry(wasmLoaderUrl, "OCCT loader");
  loaderCode = loaderCode.replace(/export\s+default\s+Module\s*;?\s*$/, "");

  const initFn = new Function(`
    ${loaderCode}
    return Module;
  `)();

  if (!initFn || typeof initFn !== "function") {
    throw new Error("OCCT loader did not produce a Module function");
  }

  return initFn({
    locateFile: (filename: string) => {
      if (filename.endsWith(".wasm")) return wasmUrl;
      return filename;
    },
  });
}

/**
 * Loads manifold-3d for mesh-level boolean operations. Returns the initialized
 * Manifold module ready to pass to replicad's `setManifold()`.
 */
export async function loadManifoldBrowser(
  loaderUrl: string,
  wasmUrl: string,
): Promise<any> {
  let loaderCode = await fetchWithRetry(loaderUrl, "Manifold loader");
  // manifold.js is shipped as an ES module: strip `export{Module as default}`.
  loaderCode = loaderCode.replace(/export\s*\{\s*Module\s+as\s+default\s*\}\s*;?\s*$/, "");
  loaderCode = loaderCode.replace(/export\s+default\s+Module\s*;?\s*$/, "");
  // `import.meta` is only valid in ES modules — but manifold's Node-specific
  // branch references it (`createRequire(import.meta.url)`) even though that
  // branch can never execute in a web worker. Replace with a parse-safe stub;
  // ENVIRONMENT_IS_NODE guards the runtime behavior.
  loaderCode = loaderCode.replace(/import\.meta/g, '({url:""})');

  const initFn = new Function(`
    ${loaderCode}
    return Module;
  `)();

  if (!initFn || typeof initFn !== "function") {
    throw new Error("Manifold loader did not produce a Module function");
  }

  return initFn({
    locateFile: (filename: string) => {
      if (filename.endsWith(".wasm")) return wasmUrl;
      return filename;
    },
  });
}
