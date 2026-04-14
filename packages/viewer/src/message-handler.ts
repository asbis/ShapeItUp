type MessageCallback = (data: any) => void;

const vscodeApi = (globalThis as any).acquireVsCodeApi?.();

const handlers: Map<string, MessageCallback> = new Map();

export function onMessage(type: string, callback: MessageCallback) {
  handlers.set(type, callback);
}

export function initMessageHandler() {
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    const handler = handlers.get(msg.type);
    if (handler) handler(msg);
  });
}

export function postToExtension(message: any) {
  vscodeApi?.postMessage(message);
}
