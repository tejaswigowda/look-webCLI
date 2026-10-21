// app.js -- a thin wrapper around the embedded editor (docs/editor, ?embed=1). It gets the VRM bytes (a File, a drop or a read-only GET of a URL),
// hands them to the editor with postMessage, and asks the editor to bake and send the edited VRM back. Both ends of every message are checked:
// same origin and the editor's own window, and the target origin is always location.origin, never '*'.
import { parseRunParams, fetchInput, assertVrm, vrmVersionOf, outName, makeResult, failure, MESSAGES } from './webcli.js';

const $ = id => document.getElementById(id);
const frame = $('editor');
const EDITOR_URL = 'editor/index.html?embed=1';
const BAKE_TIMEOUT_MS = 120000;
const RETRY_MS = 500;

const state = { current: null, ready: false, sent: false, bake: null, busy: 0 };

// ---------- agent contract: data-webcli-status + window.__webcli_result (same shape across the family) ----------
function webcliStatus(s) { document.body.setAttribute('data-webcli-status', s); if (s === 'running') window.__webcli_result = null; }
webcliStatus('idle');

// ---------- status + progress ----------
const kb = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
function setStatus(text, mode = 'ready') { $('statusText').textContent = text; $('dot').className = `dot ${mode}`; }
function busy(on) {
  state.busy = Math.max(0, state.busy + (on ? 1 : -1));
  $('spinner').hidden = $('busyBar').hidden = !state.busy;
  document.body.setAttribute('aria-busy', state.busy ? 'true' : 'false');
}
const shortSource = s => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

// ---------- the editor frame ----------
function openEditor() {
  state.ready = false; state.sent = false;
  frame.src = EDITOR_URL;
}
const post = (msg, transfer) => frame.contentWindow.postMessage(msg, location.origin, transfer);

function sendVrm() {
  if (!state.ready || !state.current || state.sent) return;
  const copy = state.current.buf.slice(0);
  post({ type: MESSAGES.load, name: state.current.name, bytes: copy }, [copy]);
  state.sent = true;
  if (state.bake) state.bake.attempt();
}

// One bake at a time. The editor answers look-apply-failed until it has parsed the VRM, so a failure is retried until the deadline.
function bake(timeoutMs = BAKE_TIMEOUT_MS) {
  if (!state.current) return Promise.reject(new Error('Load a VRM first.'));
  if (state.bake) return state.bake.promise;
  const b = state.bake = { retry: 0 };
  b.promise = new Promise((resolve, reject) => { b.resolve = resolve; b.reject = reject; });
  const settle = (fn, v) => { clearTimeout(b.retry); clearTimeout(b.deadline); if (state.bake === b) state.bake = null; fn(v); };
  b.finish = v => settle(b.resolve, v);
  b.fail = e => settle(b.reject, e);
  b.deadline = setTimeout(() => b.fail(new Error('The editor did not return a baked VRM in time. Wait for the model to load, then try again.')), timeoutMs);
  b.attempt = () => { if (state.bake === b && state.sent) post({ type: MESSAGES.apply }); };
  b.attempt();
  return b.promise;
}

window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== frame.contentWindow || !e.data) return;
  const d = e.data;
  if (d.type === MESSAGES.ready) {
    state.ready = true;
    if (!state.current && document.body.getAttribute('data-webcli-status') === 'idle') setStatus('Editor ready. Choose a VRM or load a base.');
    sendVrm();
  } else if (d.type === MESSAGES.failed) {
    const b = state.bake;
    if (b) { clearTimeout(b.retry); b.retry = setTimeout(b.attempt, RETRY_MS); }
  } else if (d.type === MESSAGES.edited && d.bytes instanceof ArrayBuffer) {
    const b = state.bake;
    if (!b) return;
    try { assertVrm(d.bytes); b.finish(new Uint8Array(d.bytes)); } catch (err) { b.fail(err); }
  }
});

// ---------- loading a VRM ----------
function adopt({ name, buf, source }) {
  assertVrm(buf);
  if (state.bake) state.bake.fail(new Error('A new VRM was loaded.'));
  if (state.sent) openEditor(); // a fresh editor per VRM: nothing of the previous model can be baked into this one
  state.current = { name, buf, source };
  $('dropZone').classList.add('loaded');
  $('btnDownload').disabled = false;
  $('resultInfo').textContent = `${name} (${kb(buf.byteLength)}, VRM ${vrmVersionOf(buf) || 'unknown'}) loaded. Edit it below, then download.`;
  setStatus(`${name} loaded. Edit it, then Download VRM.`);
  sendVrm();
}

// The only cross-origin request this page can make: a read-only GET of the URL the user (or the agent) named, registered with the guard first.
const guardedFetch = (u, init) => { window.__look_allow(u); return fetch(u, init); };
async function loadUrl(spec) {
  const f = await fetchInput(spec, 'model', guardedFetch);
  adopt({ name: f.name, buf: f.buf, source: shortSource(f.url) });
}

// A manual load: status goes back to idle once the VRM is in the editor.
async function manualLoad(label, load) {
  busy(true); setStatus(label, 'busy');
  try { await load(); webcliStatus('idle'); } catch (e) { fail(e); } finally { busy(false); }
}
const loadFile = file => manualLoad(`Reading ${file.name}...`, async () => adopt({ name: file.name, buf: await file.arrayBuffer(), source: `file:${file.name}` }));
const loadFromField = spec => manualLoad('Fetching the VRM (read-only GET)...', () => loadUrl(spec));

// ---------- export: bake through the editor, publish the handle ----------
async function exportNow() {
  webcliStatus('running'); busy(true); setStatus('Baking the edits into the VRM...', 'busy');
  const { name, buf, source } = state.current;
  try {
    const bytes = await bake();
    const out = outName(name);
    const result = makeResult(bytes, out, { source, bytesIn: buf.byteLength, bytesOut: bytes.byteLength, vrmVersion: vrmVersionOf(bytes) });
    window.__webcli_result = result;
    $('resultInfo').textContent = `${out}: ${kb(bytes.byteLength)}, VRM ${result.meta.vrmVersion || 'unknown'}.`;
    setStatus(`Baked ${out} (${kb(bytes.byteLength)}).`);
    webcliStatus('done');
    return bytes;
  } catch (e) { fail(e); return null; } finally { busy(false); }
}

function saveBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function fail(e) {
  console.error(e);
  const r = failure(e);
  window.__webcli_result = r;
  setStatus(r.error, 'error');
  $('resultInfo').textContent = r.error;
  webcliStatus('error');
}

// ---------- controls ----------
const pick = $('vrmInput');
$('dropZone').addEventListener('click', () => pick.click());
$('dropZone').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick.click(); } });
pick.addEventListener('change', () => { if (pick.files[0]) loadFile(pick.files[0]); pick.value = ''; });
for (const t of ['dragenter', 'dragover']) window.addEventListener(t, e => { e.preventDefault(); $('dropZone').classList.toggle('over', $('dropZone').contains(e.target)); });
window.addEventListener('dragleave', () => $('dropZone').classList.remove('over'));
window.addEventListener('drop', e => {
  e.preventDefault(); $('dropZone').classList.remove('over');
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) loadFile(f);
});
$('btnLoad').addEventListener('click', () => { const v = $('vrmUrl').value.trim(); if (v) loadFromField(v); else setStatus('Type a URL first.', 'error'); });
$('vrmUrl').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnLoad').click(); });
$('btnBase').addEventListener('click', () => { $('vrmUrl').value = ''; loadFromField($('base').value); });
$('btnDownload').addEventListener('click', async () => {
  $('btnDownload').disabled = true;
  const bytes = await exportNow();
  $('btnDownload').disabled = !state.current;
  if (bytes) saveBytes(bytes, window.__webcli_result.artifact.name);
});

// ---------- run from the URL: input by GET, no click, result via the handle ----------
async function autoRun(p) {
  webcliStatus('running'); busy(true); setStatus('Fetching the VRM (read-only GET)...', 'busy');
  try { await loadUrl(p.vrm); } catch (e) { fail(e); return; } finally { busy(false); }
  if (p.run) await exportNow(); else webcliStatus('idle');
}

openEditor();
try {
  const params = parseRunParams(location.search, location.hash);
  if (params.requested) autoRun(params);
} catch (e) { fail(e); }
