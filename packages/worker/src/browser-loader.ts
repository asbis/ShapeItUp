/**
 * Browser-side OCCT WASM loader. Fetches the Emscripten JS loader as text
 * and eval's it — `importScripts` doesn't work inside a webview worker that
 * runs from a blob URL, and the loader ships as an ES module which
 * importScripts can't consume anyway.
 */

export async function loadOCCTBrowser(
  wasmLoaderUrl: string,
  wasmUrl: string
): Promise<any> {
  // Retry fetch up to 3 times — rapid VSCode reloads can return 408s.
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(wasmLoaderUrl);
      if (response.ok) break;
    } catch {}
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  if (!response || !response.ok) {
    throw new Error(
      `Failed to fetch WASM loader after 3 attempts: ${response?.status || "network error"}`
    );
  }
  let loaderCode = await response.text();
  loaderCode = loaderCode.replace(/export\s+default\s+Module\s*;?\s*$/, "");

  const initFn = new Function(`
    ${loaderCode}
    return Module;
  `)();

  if (!initFn || typeof initFn !== "function") {
    throw new Error("WASM loader did not produce a Module function");
  }

  return initFn({
    locateFile: (filename: string) => {
      if (filename.endsWith(".wasm")) return wasmUrl;
      return filename;
    },
  });
}
