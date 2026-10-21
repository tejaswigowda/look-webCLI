import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OPS, MESSAGES, BASES, expandSource, rawFallback, parseRunParams, isGlb, assertVrm, vrmVersionOf, sniffExt, outName, baseName,
  fetchInput, bytesToBase64, makeResult, failure,
} from '../docs/js/webcli.js';

// a minimal binary glTF: header, JSON chunk, no BIN chunk
function glb(json = { asset: { version: '2.0' } }) {
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const b = Buffer.alloc(20 + j.length);
  b.writeUInt32LE(0x46546c67, 0); b.writeUInt32LE(2, 4); b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(j.length, 12); b.writeUInt32LE(0x4e4f534a, 16); j.copy(b, 20);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}

test('the only op is export, and the message types are look-*', () => {
  assert.deepEqual(OPS, ['export']);
  assert.deepEqual(MESSAGES, { ready: 'look-editor-ready', load: 'look-load-vrm', apply: 'look-apply', edited: 'look-edited-vrm', failed: 'look-apply-failed' });
});

test('parseRunParams reads vrm and run from the query', () => {
  assert.deepEqual(parseRunParams('?vrm=https://x.test/a.vrm&run=export'), { vrm: 'https://x.test/a.vrm', run: 'export', requested: true });
  assert.deepEqual(parseRunParams('?vrm=/sample/a.vrm'), { vrm: '/sample/a.vrm', run: null, requested: true });
});

test('parseRunParams reads the #fragment too, and the fragment wins (long data: URLs never reach the server)', () => {
  const p = parseRunParams('', '#vrm=data:model/gltf-binary;base64,Z2xURg==&run=export');
  assert.equal(p.vrm, 'data:model/gltf-binary;base64,Z2xURg==');
  assert.equal(p.run, 'export');
  assert.equal(parseRunParams('?vrm=/a.vrm', '#vrm=/b.vrm').vrm, '/b.vrm');
  assert.equal(parseRunParams('?vrm=/a.vrm', '#run=export').run, 'export');
});

test('no parameters means nothing requested (the page just waits for input)', () => {
  assert.deepEqual(parseRunParams('', ''), { vrm: null, run: null, requested: false });
  assert.equal(parseRunParams('?x=1').requested, false);
});

test('an unknown run= value and run=export without vrm= are errors with a clear message', () => {
  assert.throws(() => parseRunParams('?vrm=/a.vrm&run=bake'), /Unknown run=bake\. Supported: export\./);
  assert.throws(() => parseRunParams('?run=export'), /run=export needs vrm=<url>/);
  assert.throws(() => parseRunParams('', '#run=nope&vrm=/a.vrm'), /Unknown run=nope/);
});

test('owner/repo@ref:path expands to jsDelivr; real URLs and paths are untouched', () => {
  assert.equal(expandSource('hinzka/52blendshapes-for-VRoid-face@main:Models/a.vrm'), 'https://cdn.jsdelivr.net/gh/hinzka/52blendshapes-for-VRoid-face@main/Models/a.vrm');
  assert.equal(expandSource('o/r@abc123:x.vrm'), 'https://cdn.jsdelivr.net/gh/o/r@abc123/x.vrm');
  assert.equal(expandSource('https://example.com/a.vrm'), 'https://example.com/a.vrm');
  assert.equal(expandSource('/sample/a.vrm'), '/sample/a.vrm');
  assert.equal(expandSource('data:model/gltf-binary;base64,AAAA'), 'data:model/gltf-binary;base64,AAAA');
});

test('raw.githubusercontent.com has a jsDelivr fallback; other hosts have none', () => {
  assert.equal(rawFallback('https://raw.githubusercontent.com/o/r/main/a/b.vrm'), 'https://cdn.jsdelivr.net/gh/o/r@main/a/b.vrm');
  assert.equal(rawFallback('https://example.com/a.vrm'), null);
});

test('isGlb, assertVrm and sniffExt recognise a binary glTF by its content', () => {
  const g = glb();
  assert.equal(isGlb(g), true);
  assert.equal(isGlb(new Uint8Array(g)), true);
  assert.equal(isGlb(new TextEncoder().encode('{"asset":{"version":"2.0"}} padding').buffer), false);
  assert.equal(isGlb(new ArrayBuffer(4)), false);
  assert.equal(sniffExt(g), '.vrm');
  assert.equal(sniffExt(new ArrayBuffer(64)), '');
  assert.doesNotThrow(() => assertVrm(g));
  assert.throws(() => assertVrm(new ArrayBuffer(64)), /Not a VRM/);
});

test('vrmVersionOf tells VRM 0.x from 1.0 from a plain glTF', () => {
  assert.equal(vrmVersionOf(glb({ asset: { version: '2.0' }, extensionsUsed: ['VRM'], extensions: { VRM: {} } })), '0.x');
  assert.equal(vrmVersionOf(glb({ asset: { version: '2.0' }, extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: {} } })), '1.0');
  assert.equal(vrmVersionOf(glb()), null);
  assert.equal(vrmVersionOf(new ArrayBuffer(8)), null);
  const sample = fileURLToPath(new URL('../docs/sample/VRoid_V110_Male_v1.1.3.vrm', import.meta.url));
  const b = fs.readFileSync(sample);
  assert.equal(vrmVersionOf(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), '0.x');
});

test('output names: <base>.look.vrm, whatever the input extension', () => {
  assert.equal(outName('avatar.vrm'), 'avatar.look.vrm');
  assert.equal(outName('avatar.GLB'), 'avatar.look.vrm');
  assert.equal(outName('my avatar.vrm'), 'my_avatar.look.vrm');
  assert.equal(outName(''), 'model.look.vrm');
  assert.equal(baseName('a.b.vrm'), 'a.b');
});

test('fetchInput is a GET with credentials omitted and no body, and names the file from the URL', async () => {
  const calls = [];
  const fakeFetch = async (u, init) => { calls.push([u, init]); return { ok: true, status: 200, arrayBuffer: async () => glb() }; };
  const f = await fetchInput('https://example.com/dir/My%20Avatar.vrm?x=1', 'model', fakeFetch);
  assert.equal(f.name, 'My_Avatar.vrm');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].body, undefined);
});

test('fetchInput: data: and extension-less URLs take their name from the content', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => glb() });
  assert.equal((await fetchInput('data:model/gltf-binary;base64,AAAA', 'model', fakeFetch)).name, 'model.vrm');
  assert.equal((await fetchInput('https://example.com/download/42', 'model', fakeFetch)).name, '42.vrm');
});

test('fetchInput retries a failed raw.githubusercontent.com URL once through jsDelivr', async () => {
  const urls = [];
  const fakeFetch = async u => { urls.push(u); return u.includes('raw.githubusercontent') ? { ok: false, status: 429 } : { ok: true, status: 200, arrayBuffer: async () => glb() }; };
  const f = await fetchInput('https://raw.githubusercontent.com/o/r/main/a.vrm', 'model', fakeFetch);
  assert.deepEqual(urls, ['https://raw.githubusercontent.com/o/r/main/a.vrm', 'https://cdn.jsdelivr.net/gh/o/r@main/a.vrm']);
  assert.equal(f.name, 'a.vrm');
});

test('fetchInput rejects HTTP errors and non-VRM content with a clear message', async () => {
  await assert.rejects(fetchInput('https://example.com/a.vrm', 'model', async () => ({ ok: false, status: 404 })), /404/);
  await assert.rejects(fetchInput('https://example.com/a.vrm', 'model', async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('<html>not a model at all</html>').buffer })), /Not a VRM/);
});

test('bytesToBase64 matches Buffer, including inputs larger than one chunk', () => {
  const big = new Uint8Array(100000).map((_, i) => (i * 31) & 255);
  assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'));
  assert.equal(bytesToBase64(new Uint8Array([103, 108, 84, 70])), 'Z2xURg==');
});

test('makeResult has the family shape; dataUrl is built lazily on first read', () => {
  const bytes = new Uint8Array(glb());
  const r = makeResult(bytes, 'a.look.vrm', { source: 's', bytesIn: 1, bytesOut: bytes.length, vrmVersion: null });
  assert.equal(r.ok, true); assert.equal(r.op, 'export'); assert.equal(r.error, null);
  assert.deepEqual(Object.keys(r.artifact), ['mime', 'name', 'size', 'dataUrl']);
  assert.equal(r.artifact.mime, 'model/gltf-binary'); assert.equal(r.artifact.name, 'a.look.vrm'); assert.equal(r.artifact.size, bytes.length);
  assert.equal(r.artifact.dataUrl, `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`);
  assert.deepEqual(failure(new Error('boom')), { ok: false, op: 'export', artifact: null, error: 'boom', meta: null });
});

test('vrm=male and vrm=female are aliases for the bundled bases (query or #fragment), same-origin relative paths', () => {
  assert.deepEqual(BASES, { male: 'sample/VRoid_V110_Male_v1.1.3.vrm', female: 'sample/VRoid_V110_Female_v1.1.3.vrm' });
  assert.deepEqual(parseRunParams('?vrm=female&run=export'), { vrm: 'female', run: 'export', requested: true });
  assert.deepEqual(parseRunParams('?vrm=male'), { vrm: 'male', run: null, requested: true });
  assert.deepEqual(parseRunParams('', '#vrm=female&run=export'), { vrm: 'female', run: 'export', requested: true });
  assert.equal(expandSource('male'), 'sample/VRoid_V110_Male_v1.1.3.vrm');
  assert.equal(expandSource('Female'), 'sample/VRoid_V110_Female_v1.1.3.vrm');
  assert.equal(expandSource(' male '), 'sample/VRoid_V110_Male_v1.1.3.vrm');
});

test('other names are still URLs: males.vrm, /male, male/x@y:z and toString are not aliases', () => {
  for (const spec of ['males.vrm', '/male', 'male.vrm', 'https://example.com/male', 'toString', 'constructor']) assert.equal(expandSource(spec), spec);
  assert.equal(expandSource('male/repo@main:a.vrm'), 'https://cdn.jsdelivr.net/gh/male/repo@main/a.vrm');
});

test('fetchInput on an alias is one GET of the bundled file and names it from the file', async () => {
  const calls = [];
  const fakeFetch = async (u, init) => { calls.push([u, init]); return { ok: true, status: 200, arrayBuffer: async () => glb() }; };
  const f = await fetchInput('female', 'model', fakeFetch);
  assert.deepEqual(calls.map(c => c[0]), ['sample/VRoid_V110_Female_v1.1.3.vrm']);
  assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(f.name, 'VRoid_V110_Female_v1.1.3.vrm');
  assert.equal(outName(f.name), 'VRoid_V110_Female_v1.1.3.look.vrm');
});
