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

/**
 * Cached WASM bytes the extension host shipped to the webview during the
 * `init` handshake. When present, callers skip the URL fetch + eval and pass
 * the raw WASM directly to Emscripten via `wasmBinary`. Both fields must be
 * present together — passing only one is a programmer error and falls through
 * to the URL-fetch path with a warning.
 */
export interface CachedWasmInputs {
  loaderJs: string;
  wasmBytes: Uint8Array;
}

export async function loadOCCTBrowser(
  wasmLoaderUrl: string | undefined,
  wasmUrl: string | undefined,
  cached?: CachedWasmInputs,
): Promise<any> {
  // Fast path: extension shipped cached bytes. Skip both the loader fetch
  // and Emscripten's internal `fetch(.wasm)` by passing wasmBinary.
  if (cached?.loaderJs && cached?.wasmBytes && cached.wasmBytes.byteLength > 0) {
    let loaderCode = cached.loaderJs.replace(/export\s+default\s+Module\s*;?\s*$/, "");
    const initFn = new Function(`
      ${loaderCode}
      return Module;
    `)();
    if (!initFn || typeof initFn !== "function") {
      throw new Error("OCCT loader (cached) did not produce a Module function");
    }
    return initFn({
      // Emscripten reads `wasmBinary` before locateFile and skips its own
      // fetch entirely when present — exactly the cold-cost we want to elide.
      wasmBinary: cached.wasmBytes,
      locateFile: (filename: string) => {
        // Still provide a URL fallback for any sidecar files the loader may
        // request (in practice OCCT only loads the .wasm — but harmless).
        if (filename.endsWith(".wasm") && wasmUrl) return wasmUrl;
        return filename;
      },
    });
  }

  // URL-fetch fallback (pre-cache behavior). Used when activation lost the
  // race or the bundled .wasm is missing from dist/.
  if (!wasmLoaderUrl || !wasmUrl) {
    throw new Error(
      "loadOCCTBrowser: no cached WASM bytes provided AND no fallback URLs — cannot initialize OCCT",
    );
  }
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
  loaderUrl: string | undefined,
  wasmUrl: string | undefined,
  cached?: CachedWasmInputs,
): Promise<any> {
  // Same scrubbing logic as the URL path — manifold's loader needs the ES
  // module exports stripped and `import.meta` stubbed before eval.
  const scrub = (raw: string): string => {
    let code = raw;
    code = code.replace(/export\s*\{\s*Module\s+as\s+default\s*\}\s*;?\s*$/, "");
    code = code.replace(/export\s+default\s+Module\s*;?\s*$/, "");
    code = code.replace(/import\.meta/g, '({url:""})');
    return code;
  };

  if (cached?.loaderJs && cached?.wasmBytes && cached.wasmBytes.byteLength > 0) {
    const loaderCode = scrub(cached.loaderJs);
    const initFn = new Function(`
      ${loaderCode}
      return Module;
    `)();
    if (!initFn || typeof initFn !== "function") {
      throw new Error("Manifold loader (cached) did not produce a Module function");
    }
    return initFn({
      wasmBinary: cached.wasmBytes,
      locateFile: (filename: string) => {
        if (filename.endsWith(".wasm") && wasmUrl) return wasmUrl;
        return filename;
      },
    });
  }

  if (!loaderUrl || !wasmUrl) {
    throw new Error(
      "loadManifoldBrowser: no cached WASM bytes provided AND no fallback URLs",
    );
  }
  const loaderCode = scrub(await fetchWithRetry(loaderUrl, "Manifold loader"));

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
