// Injected into viewer.html ahead of viewer.js.
//
// The viewer uses `acquireVsCodeApi()` when it exists and a WebSocket when it
// doesn't. Defining it here makes the parent page (the playground) the host:
// everything the viewer posts goes up, and the parent answers by posting into
// this window, which is exactly where the viewer listens for host messages.
(function () {
  var state;
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        window.parent.postMessage({ __shapeitup: "viewer", msg: msg }, location.origin);
      },
      getState: function () { return state; },
      setState: function (s) { state = s; return s; },
    };
  };
})();
