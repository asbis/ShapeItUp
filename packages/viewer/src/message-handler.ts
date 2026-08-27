type MessageCallback = (data: any) => void;

const vscodeApi = (globalThis as any).acquireVsCodeApi?.();

const handlers: Map<string, MessageCallback> = new Map();

export function onMessage(type: string, callback: MessageCallback) {
  handlers.set(type, callback);
}

/**
 * Host transport.
 *
 * Inside a VSCode webview we talk to the extension host over the webview
 * bridge. Served over plain HTTP (the standalone `@shapeitup/serve` host, e.g.
 * the Claude Code browser pane) there is no such bridge, so we fall back to a
 * WebSocket on the same origin.
 *
 * Inbound messages from the socket are re-dispatched through `window.postMessage`
 * so `initMessageHandler` below stays identical for both hosts — the rest of the
 * viewer never learns which transport it is on.
 */
let socket: WebSocket | undefined;
let outboundQueue: any[] = [];

function connectSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener("open", () => {
    socket = ws;
    const queued = outboundQueue;
    outboundQueue = [];
    for (const m of queued) ws.send(JSON.stringify(m));
  });

  ws.addEventListener("message", (event) => {
    try {
      window.postMessage(JSON.parse(event.data), "*");
    } catch {
      // Malformed frame — ignore rather than tearing the viewer down.
    }
  });

  // The server dies with the session; keep retrying so a `pnpm dev` restart
  // reconnects without the user reloading the pane.
  ws.addEventListener("close", () => {
    socket = undefined;
    setTimeout(connectSocket, 1000);
  });

  ws.addEventListener("error", () => ws.close());
}

export function initMessageHandler() {
  if (!vscodeApi) connectSocket();

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    const handler = handlers.get(msg.type);
    if (handler) handler(msg);
  });
}

export function postToExtension(message: any) {
  if (vscodeApi) {
    vscodeApi.postMessage(message);
    return;
  }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  else outboundQueue.push(message);
}
