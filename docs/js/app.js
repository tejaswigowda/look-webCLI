// app.js -- a thin wrapper around the embedded editor (docs/editor, ?embed=1). It gets the VRM bytes (a File, a drop or a read-only GET of a URL),
// hands them to the editor with postMessage, and asks the editor to bake and send the edited VRM back. Both ends of every message are checked:
// same origin and the editor's own window, and the target origin is always location.origin, never '*'.
// The progress bar covers the whole time until the editor itself reports the VRM loaded (look-vrm-loaded), then the bake.
import {
  parseRunParams, fetchInput, readStream, assertVrm, vrmVersionOf, outName, makeResult, failure, stageProgress, creepPercent, MESSAGES,
} from './webcli.js';

const $ = id => document.getElementById(id);
const frame = $('editor');
const EDITOR_URL = 'editor/index.html?embed=1';
const RETRY_MS = 500;
const CREEP_MS = 250;
// ?timeout=<seconds> shortens the load and bake deadlines (default 120); it exists so the tests can exercise the timeout path.
const TIMEOUT_MS = (Number(new URLSearchParams(location.search).get('timeout')) || 120) * 1000;

const state = { current: null, ready: false, sent: false, loaded: false, loading: null, bake: null, job: 0 };

// ---------- agent contract: data-webcli-status + window.__webcli_result (same shape across the family) ----------
function webcliStatus(s) { document.body.setAttribute('data-webcli-status', s); if (s === 'running') window.__webcli_result = null; }
webcliStatus('idle');

// ---------- status + progress ----------
const kb = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
function setStatus(text, mode = 'ready') { $('statusText').textContent = text; $('dot').className = `dot ${mode}`; }
const shortSource = s => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

// The bar is visible exactly while view.active: body[data-loading=true], window.__look_loading and aria-busy say the same.
const view = { active: false, stage: null, label: '', percent: null, timer: 0 };

function paint() {
  const on = view.active, bar = $('busyBar'), pct = view.percent == null ? null : Math.round(view.percent);
  bar.hidden = $('spinner').hidden = !on;
  $('busyPct').hidden = !on || pct == null;
  document.body.setAttribute('aria-busy', on ? 'true' : 'false');
  document.body.setAttribute('data-loading', on ? 'true' : 'false');
  window.__look_loading = on;
  if (!on) return;
  bar.classList.toggle('indeterminate', pct == null);
  bar.classList.toggle('determinate', pct != null);
  if (pct == null) { bar.removeAttribute('aria-valuenow'); $('busyFill').style.removeProperty('width'); } else { bar.setAttribute('aria-valuenow', String(pct)); $('busyFill').style.width = `${pct}%`; }
  bar.setAttribute('aria-valuetext', pct == null ? view.label : `${view.label}, ${pct}%`);
  $('busyPct').textContent = `${pct}%`;
  setStatus(`${view.label}...`, 'busy');
}

// A new job starts from zero; within one job the percentage never decreases.
function progressBegin() { clearInterval(view.timer); view.timer = 0; view.percent = null; view.stage = null; }
function progressSet(stage, fraction = null) {
  const p = stageProgress(stage, fraction);
  clearInterval(view.timer); view.timer = 0;
  view.active = true; view.stage = stage; view.label = p.label;
  if (p.percent != null) view.percent = Math.max(p.percent, view.percent ?? 0);
  else if (stage === 'bake') view.percent = null;
  if (p.ceiling != null) view.timer = setInterval(() => { if (view.percent != null && view.percent < p.ceiling) { view.percent = creepPercent(view.percent, p.ceiling); paint(); } }, CREEP_MS);
  paint();
}
function progressEnd() { clearInterval(view.timer); view.timer = 0; view.active = false; view.percent = null; view.stage = null; paint(); }

// ---------- jobs: only the latest load may touch the bar or the editor ----------
const superseded = () => Object.assign(new Error('A new VRM was loaded.'), { superseded: true });
const latest = id => id === state.job;

function abandonLoading() {
  const L = state.loading;
  if (L && !L.done) { L.done = true; clearTimeout(L.timer); L.reject(superseded()); }
  if (state.bake) state.bake.fail(superseded());
  state.loading = null; state.loaded = false;
  $('btnDownload').disabled = true;
}
function startJob() { abandonLoading(); progressBegin(); return ++state.job; }

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
  progressSet('render');
  if (state.bake) state.bake.attempt();
}

function beginLoading() {
  const L = state.loading = { done: false, timer: 0 };
  L.promise = new Promise((resolve, reject) => { L.resolve = resolve; L.reject = reject; });
  L.promise.catch(() => {});
  L.timer = setTimeout(() => failLoad(new Error('The editor did not finish loading the VRM in time. Try again, or try a smaller VRM.')), TIMEOUT_MS);
}
function failLoad(err) {
  const L = state.loading;
  if (!L || L.done) return;
  L.done = true; clearTimeout(L.timer); L.reject(err);
  fail(err);
}
function finishLoad() {
  const L = state.loading, { name, buf } = state.current;
  L.done = true; clearTimeout(L.timer); state.loaded = true;
  progressSet('loaded'); progressEnd();
  $('btnDownload').disabled = false;
  $('resultInfo').textContent = `${name} (${kb(buf.byteLength)}, VRM ${vrmVersionOf(buf) || 'unknown'}) loaded. Edit it below, then download.`;
  setStatus(`${name} loaded. Edit it, then Download VRM.`);
  L.resolve();
}

// One bake at a time. The editor answers look-apply-failed until it has parsed the VRM; the load wait makes that rare, so a failure is just retried until the deadline.
function bake() {
  if (state.bake) return state.bake.promise;
  const b = state.bake = { retry: 0 };
  b.promise = new Promise((resolve, reject) => { b.resolve = resolve; b.reject = reject; });
  const settle = (fn, v) => { clearTimeout(b.retry); clearTimeout(b.deadline); if (state.bake === b) state.bake = null; fn(v); };
  b.finish = v => settle(b.resolve, v);
  b.fail = e => settle(b.reject, e);
  b.deadline = setTimeout(() => b.fail(new Error('The editor did not return a baked VRM in time.')), TIMEOUT_MS);
  b.attempt = () => { if (state.bake === b && state.sent) post({ type: MESSAGES.apply }); };
  b.attempt();
  return b.promise;
}

// Messages about a load count only from the current editor document: after ready, and after this VRM was sent to it.
const live = () => !!state.loading && !state.loading.done && state.ready && state.sent;

window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== frame.contentWindow || !e.data) return;
  const d = e.data;
  if (d.type === MESSAGES.ready) {
    state.ready = true;
    if (!state.current && document.body.getAttribute('data-webcli-status') === 'idle') setStatus('Editor ready. Choose a VRM or load a base.');
    sendVrm();
  } else if (d.type === MESSAGES.progress) {
    if (live() && d.stage === 'viewer') progressSet('textures');
  } else if (d.type === MESSAGES.loaded) {
    if (live()) finishLoad();
  } else if (d.type === MESSAGES.loadFailed) {
    if (live()) failLoad(new Error(`The editor could not load this VRM${d.message ? `: ${String(d.message).slice(0, 200)}` : '.'}`));
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
function adopt({ name, buf, source }, id) {
  assertVrm(buf);
  if (!latest(id)) return;
  if (state.sent) openEditor(); // a fresh editor per VRM: nothing of the previous model can be baked into this one
  state.current = { name, buf, source };
  beginLoading();
  $('dropZone').classList.add('loaded');
  $('btnDownload').disabled = true;
  $('resultInfo').textContent = `Loading ${name} (${kb(buf.byteLength)}) into the editor...`;
  progressSet('hand');
  sendVrm();
}

// The only cross-origin request this page can make: a read-only GET of the URL the user (or the agent) named, registered with the guard first.
const guardedFetch = (u, init) => { window.__look_allow(u); return fetch(u, init); };
async function loadUrl(spec, id) {
  const f = await fetchInput(spec, 'model', guardedFetch, fr => { if (latest(id)) progressSet('fetch', fr); });
  adopt({ name: f.name, buf: f.buf, source: shortSource(f.url) }, id);
}

// A manual load: the status stays idle (the bar and #resultInfo show the progress); only a failure makes it error.
async function manualLoad(stage, load) {
  const id = startJob();
  progressSet(stage);
  try { await load(id); } catch (e) { if (latest(id)) fail(e); return; }
  if (latest(id)) webcliStatus('idle');
}
const loadFile = file => manualLoad('read', async id => {
  const buf = await readStream(file.stream(), file.size, fr => { if (latest(id)) progressSet('read', fr); });
  adopt({ name: file.name, buf, source: `file:${file.name}` }, id);
});
const loadFromField = spec => manualLoad('fetch', id => loadUrl(spec, id));

// ---------- export: wait for the editor to report the VRM loaded, bake, publish the handle ----------
async function exportNow() {
  webcliStatus('running');
  try {
    if (!state.loading) throw new Error('Load a VRM first.');
    await state.loading.promise;
    progressBegin(); progressSet('bake');
    const { name, buf, source } = state.current;
    const bytes = await bake();
    progressEnd();
    const out = outName(name);
    const result = makeResult(bytes, out, { source, bytesIn: buf.byteLength, bytesOut: bytes.byteLength, vrmVersion: vrmVersionOf(bytes) });
    window.__webcli_result = result;
    $('resultInfo').textContent = `${out}: ${kb(bytes.byteLength)}, VRM ${result.meta.vrmVersion || 'unknown'}.`;
    setStatus(`Baked ${out} (${kb(bytes.byteLength)}).`);
    webcliStatus('done');
    return bytes;
  } catch (e) { fail(e); return null; }
}

function saveBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function fail(e) {
  if (e && e.superseded) return;
  console.error(e);
  const r = failure(e);
  window.__webcli_result = r;
  progressEnd();
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
  $('btnDownload').disabled = !state.loaded;
  if (bytes) saveBytes(bytes, window.__webcli_result.artifact.name);
});

// ---------- run from the URL: input by GET, no click, result via the handle ----------
async function autoRun(p) {
  webcliStatus('running');
  const id = startJob();
  progressSet('fetch');
  try { await loadUrl(p.vrm, id); } catch (e) { if (latest(id)) fail(e); return; }
  if (!latest(id)) return;
  if (p.run) { await exportNow(); return; }
  try { await state.loading.promise; } catch { return; } // a failed load has already been reported
  if (latest(id)) webcliStatus('idle');
}

paint();
openEditor();
try {
  const params = parseRunParams(location.search, location.hash);
  if (params.requested) autoRun(params);
} catch (e) { fail(e); }
