// webcli.js -- the pure-transform contract: URL / dropped file in, artifact handle out. Read-only GETs; no git, token, repo write or versioning.
// Pure functions (no DOM) so the page and the unit tests share them.
//   ?vrm=<url>[&run=export]      (the same parameters are read from the #fragment)

export const OPS = ['export'];
export const STATUSES = ['idle', 'running', 'done', 'error'];
export const MIME = 'model/gltf-binary';
export const MESSAGES = Object.freeze({
  ready: 'look-editor-ready', load: 'look-load-vrm', apply: 'look-apply', edited: 'look-edited-vrm', failed: 'look-apply-failed',
  progress: 'look-vrm-progress', loaded: 'look-vrm-loaded', loadFailed: 'look-vrm-failed',
});

// The progress bar is stage-driven. `percent` is where a stage starts (null: indeterminate), `ceiling` is where the bar may creep to while the
// editor works without reporting; fetch/read span from..to by bytes when the length is known.
export const STAGES = Object.freeze({
  fetch: { label: 'Fetching the VRM', from: 2, to: 30 },
  read: { label: 'Reading the file', from: 2, to: 30 },
  hand: { label: 'Handing the VRM to the editor', percent: 35 },
  render: { label: 'Rendering the model', percent: 45, ceiling: 68 },
  textures: { label: 'Reading textures and materials', percent: 70, ceiling: 98 },
  loaded: { label: 'Loaded', percent: 100 },
  bake: { label: 'Baking the edits into the VRM', percent: null },
});

// -> { stage, label, percent: integer 0..100 | null, ceiling: number | null }. fraction (0..1) only matters for fetch and read.
export function stageProgress(stage, fraction = null) {
  const st = STAGES[stage];
  if (!st) throw new Error(`Unknown stage ${stage}`);
  let percent = st.percent ?? null;
  if (st.from != null && typeof fraction === 'number' && Number.isFinite(fraction)) percent = Math.round(st.from + (st.to - st.from) * Math.min(1, Math.max(0, fraction)));
  return { stage, label: st.label, percent, ceiling: st.ceiling ?? null };
}

// One creep step toward the ceiling: never decreases, never passes the ceiling.
export const creepPercent = (p, ceiling, rate = 0.06) => Math.min(ceiling, p + Math.max(0.15, (ceiling - p) * rate));


// The bundled VRoid bases: vrm=male and vrm=female are same-origin GETs of these files.
export const BASES = Object.freeze({ male: 'sample/VRoid_V110_Male_v1.1.3.vrm', female: 'sample/VRoid_V110_Female_v1.1.3.vrm' });

const KNOWN_EXT = /\.(vrm|glb)$/i;
const SHORTHAND = /^([\w.-]+)\/([\w.-]+)@([^:\s]+):(.+)$/;
const RAW = /^https:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([^/]+)\/(.+)$/;

// `male` / `female` name a bundled base; `owner/repo@ref:path` is optional sugar for the jsDelivr URL; any other string is already a URL.
export function expandSource(spec) {
  const key = spec.trim().toLowerCase();
  if (Object.hasOwn(BASES, key)) return BASES[key];
  const m = SHORTHAND.exec(spec);
  return m ? `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}` : spec;
}

// raw.githubusercontent.com rate-limits; the same file is served by jsDelivr.
export function rawFallback(url) {
  const m = RAW.exec(url);
  return m ? `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}` : null;
}

// The same parameters are read from the #fragment too: it never reaches the server, so a long data: URL does not hit request-size limits.
export function parseRunParams(search, hash = '') {
  const q = new URLSearchParams(search), h = new URLSearchParams(hash.replace(/^#/, ''));
  const get = k => h.get(k) ?? q.get(k);
  const p = { vrm: get('vrm'), run: get('run') };
  if (p.run && !OPS.includes(p.run)) throw new Error(`Unknown run=${p.run}. Supported: ${OPS.join(', ')}.`);
  if (p.run && !p.vrm) throw new Error(`run=${p.run} needs vrm=<url>.`);
  p.requested = !!(p.vrm || p.run);
  return p;
}

// A VRM is a binary glTF: 'glTF' magic, version 2, then a JSON chunk.
export function isGlb(buf) {
  if (!buf || buf.byteLength < 20) return false;
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  return dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(4, true) === 2 && dv.getUint32(16, true) === 0x4e4f534a;
}

export function assertVrm(buf) {
  if (!isGlb(buf)) throw new Error('Not a VRM: expected a binary glTF (.vrm or .glb) file.');
}

// '0.x', '1.0' or null (a plain glTF without a VRM extension), read from the JSON chunk only.
export function vrmVersionOf(buf) {
  if (!isGlb(buf)) return null;
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(12, true);
  try {
    const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len)));
    const used = json.extensionsUsed || [];
    if (used.includes('VRMC_vrm') || json.extensions?.VRMC_vrm) return '1.0';
    if (used.includes('VRM') || json.extensions?.VRM) return '0.x';
  } catch { /* not JSON: fall through */ }
  return null;
}

// data: and blob: URLs and extension-less URLs have no usable file name; the content decides the extension.
export function sniffExt(buf) {
  return isGlb(buf) ? '.vrm' : '';
}

const safeName = s => s.replace(/[\s"'\\/]+/g, '_');
export const baseName = n => n.replace(/\.(vrm|glb)$/i, '');
export const outName = n => `${baseName(safeName(n || 'model'))}.look.vrm`;

function nameFromUrl(url) {
  if (/^(data|blob):/i.test(url)) return '';
  try { return decodeURIComponent(new URL(url, 'http://x/').pathname.split('/').pop() || ''); } catch { return ''; }
}

// Reads a byte stream to one ArrayBuffer. onProgress gets 0..1 when the total is known (>0) and null when it is not.
export async function readStream(stream, total = 0, onProgress = null) {
  const reader = stream.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (onProgress) onProgress(total > 0 ? Math.min(1, got / total) : null);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}

// Returns { name, buf, url }. Only ever a GET with no body and no credentials. onProgress(fraction | null) is called while the body streams in.
export async function fetchInput(spec, fallbackName = 'model', fetchImpl = globalThis.fetch, onProgress = null) {
  const url = expandSource(spec);
  const get = async u => {
    const res = await fetchImpl(u, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`GET ${u.slice(0, 120)}: ${res.status}`);
    if (onProgress && res.body && typeof res.body.getReader === 'function') return readStream(res.body, Number(res.headers?.get?.('content-length')) || 0, onProgress);
    return res.arrayBuffer();
  };
  let buf;
  try { buf = await get(url); } catch (e) {
    const alt = rawFallback(url);
    if (!alt) throw e;
    buf = await get(alt);
  }
  assertVrm(buf);
  let name = nameFromUrl(url);
  if (!KNOWN_EXT.test(name)) name = `${name ? safeName(name) : fallbackName}${sniffExt(buf)}`;
  return { name: safeName(name), buf, url };
}

export function bytesToBase64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

// What window.__webcli_result holds. dataUrl is built on first read: only agents need it.
export function makeResult(bytes, name, meta) {
  let dataUrl;
  const artifact = { mime: MIME, name, size: bytes.byteLength };
  Object.defineProperty(artifact, 'dataUrl', { enumerable: true, get: () => (dataUrl ??= `data:${MIME};base64,${bytesToBase64(bytes)}`) });
  return { ok: true, op: 'export', artifact, error: null, meta };
}

export const failure = e => ({ ok: false, op: 'export', artifact: null, error: String((e && e.message) || e), meta: null });
