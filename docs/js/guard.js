// Egress guard for the look-webCLI wrapper page. Loaded first, as a classic script, before app.js.
//
// A second line behind the page's Content-Security-Policy; the editor iframe has its own, stricter, policy.
// Allowed from this window: fetch / XMLHttpRequest with method GET, no body, to this origin, to a blob: or data: URL
// (in-memory data), or to a URL the user named as the VRM (registered with window.__look_allow right before the GET).
// Refused: any other method, any body, any other destination, navigator.sendBeacon, WebSocket, EventSource, WebRTC,
// WebTransport, Worker, SharedWorker, service workers and window.open. Every request is recorded in window.__look_net.
// It cannot stop a browser extension or a host that replaces this file; the Network tab is the audit.
(function () {
  const log = window.__look_net = [];
  const allowed = new Set();
  window.__look_allow = url => { allowed.add(new URL(url, location.href).href); };

  const refuse = (kind, detail = {}) => { log.push({ kind, blocked: true, ...detail }); return new Error(`look-webCLI egress guard: ${kind} is not allowed`); };
  const destinationOk = url => {
    let u;
    try { u = new URL(url, location.href); } catch { return false; }
    return u.origin === location.origin || u.protocol === 'blob:' || u.protocol === 'data:' || allowed.has(u.href);
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const method = ((init && init.method) || (req && req.method) || 'GET').toUpperCase();
    const hasBody = (init && init.body != null) || (req && req.body != null);
    const url = String(req ? req.url : input);
    if (method !== 'GET' || hasBody || !destinationOk(url)) return Promise.reject(refuse(`fetch ${method}`, { method, url: url.slice(0, 200) }));
    log.push({ kind: 'fetch', method, url: url.slice(0, 200), blocked: false });
    return realFetch(input, init);
  };

  const xhrOpen = XMLHttpRequest.prototype.open, xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(method).toUpperCase() !== 'GET' || !destinationOk(String(url))) throw refuse(`XMLHttpRequest ${method}`, { method, url: String(url).slice(0, 200) });
    log.push({ kind: 'xhr', method: 'GET', url: String(url).slice(0, 200), blocked: false });
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (body != null) throw refuse('XMLHttpRequest body');
    return xhrSend.call(this);
  };

  if (navigator.sendBeacon) navigator.sendBeacon = () => { refuse('sendBeacon'); return false; };
  window.open = () => { refuse('window.open'); return null; };
  if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(refuse('serviceWorker.register'));
  for (const name of ['Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
    if (name in window) window[name] = function () { throw refuse(name); };
  }
})();
