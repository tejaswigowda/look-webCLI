import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = '/sample/VRoid_V110_Male_v1.1.3.vrm';
const FEMALE = '/sample/VRoid_V110_Female_v1.1.3.vrm';
const SAMPLE_FILE = path.join(here, '..', 'docs', SAMPLE);
const DONE = 'body[data-webcli-status=done], body[data-webcli-status=error]';
const T = { timeout: 240000 };
const FEMALE_FILE = path.join(here, '..', 'docs', FEMALE);
const SAMPLE_SHA = crypto.createHash('sha256').update(fs.readFileSync(SAMPLE_FILE)).digest('hex');

let server, origin, browser;
before(async () => {
  server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  // the editor draws with WebGL; SwiftShader keeps it working on machines without a GPU
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => { await browser?.close(); await new Promise(r => server?.close(r)); });

// Records every change of the progress bar (not a poll, so nothing between two samples is missed) in window.__prog.
const OBSERVER = () => {
  window.__prog = [];
  new MutationObserver(() => {
    const bar = document.querySelector('[data-testid=progress]');
    if (!bar || !document.body) return;
    window.__prog.push({ hidden: bar.hidden, now: bar.getAttribute('aria-valuenow'), text: bar.getAttribute('aria-valuetext'), loading: document.body.dataset.loading, role: bar.getAttribute('role'), busy: document.body.getAttribute('aria-busy'), flag: window.__look_loading });
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-valuenow', 'aria-valuetext', 'data-loading', 'aria-busy'] });
};

async function open(url, { watch = false, observe = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
  if (observe) await page.addInitScript(OBSERVER);
  const requests = [];
  if (watch) page.on('request', r => requests.push({ url: r.url(), method: r.method(), body: r.postData(), frame: r.frame() === page.mainFrame() ? 'main' : 'sub' }));
  await page.goto(`${origin}${url}`);
  return { page, requests };
}

const readResult = page => page.evaluate(async () => {
  const r = window.__webcli_result;
  if (!r) return null;
  if (!r.artifact) return { ok: r.ok, op: r.op, artifact: null, error: r.error, meta: r.meta };
  const bin = atob(r.artifact.dataUrl.split(',')[1]);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return { ok: r.ok, op: r.op, error: r.error, meta: r.meta, artifact: { mime: r.artifact.mime, name: r.artifact.name, size: r.artifact.size, dataUrlMime: r.artifact.dataUrl.slice(0, r.artifact.dataUrl.indexOf(',')), bytes: [...u.subarray(0, 4)], b64: r.artifact.dataUrl.split(',')[1] } };
});

const sha = b64 => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');

function parseGlb(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'glTF');
  assert.equal(buf.readUInt32LE(4), 2);
  assert.equal(buf.readUInt32LE(8), buf.length, 'GLB header length matches the file');
  const jsonLen = buf.readUInt32LE(12);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a);
  return JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
}

test('(a) zero egress: loading the page and the sample makes only same-origin GET requests with no body', T, async () => {
  const { page, requests } = await open(`/index.html?vrm=${SAMPLE}`, { watch: true });
  await page.waitForSelector('body[data-webcli-status=idle]', { timeout: 120000 });
  await page.locator('#editor').contentFrame().locator('canvas').first().waitFor({ timeout: 60000 });
  assert.ok(requests.some(r => r.url.endsWith(SAMPLE)), 'the sample VRM was requested');
  assert.ok(requests.some(r => r.frame === 'sub' && r.url.includes('/editor/js/')), 'the editor loaded in the iframe');
  const bad = requests.filter(r => !r.url.startsWith(origin + '/') && !/^(blob|data):/.test(r.url));
  assert.deepEqual(bad.map(r => r.url), [], 'a request left the origin');
  assert.deepEqual(requests.filter(r => r.method !== 'GET' || r.body).map(r => `${r.method} ${r.url}`), [], 'a non-GET request or request body was sent');
  // the guard blocks what the CSP would also block: a body, another method, a foreign origin without registration
  const probes = await page.evaluate(async () => {
    const tryIt = async f => { try { await f(); return 'allowed'; } catch (e) { return String(e.message); } };
    return {
      post: await tryIt(() => fetch('/index.html', { method: 'POST', body: 'x' })),
      foreign: await tryIt(() => fetch('https://example.com/a.vrm')),
      beacon: navigator.sendBeacon('/x', 'y'),
      ws: await tryIt(() => new WebSocket('wss://example.com')),
    };
  });
  assert.match(probes.post, /egress guard/); assert.match(probes.foreign, /egress guard/); assert.equal(probes.beacon, false); assert.match(probes.ws, /egress guard/);
  assert.equal(requests.filter(r => r.method !== 'GET').length, 0, 'the blocked probes never reached the network');
  await page.close();
});

test('(b) ?vrm=<sample>&run=export bakes a valid VRM through the editor, and a second run is byte-identical', T, async () => {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const { page } = await open(`/index.html?vrm=${SAMPLE}&run=export`);
    assert.match(await page.getAttribute('body', 'data-webcli-status'), /idle|running/);
    await page.waitForSelector(DONE, { timeout: 200000 });
    const r = await readResult(page);
    assert.equal(r.ok, true, r.error); assert.equal(r.op, 'export'); assert.equal(r.error, null);
    assert.equal(await page.getAttribute('body', 'data-webcli-status'), 'done');
    assert.equal(r.artifact.mime, 'model/gltf-binary'); assert.equal(r.artifact.name, 'VRoid_V110_Male_v1.1.3.look.vrm');
    assert.equal(r.artifact.dataUrlMime, 'data:model/gltf-binary;base64');
    assert.ok(r.artifact.size > 1e6);
    const buf = Buffer.from(r.artifact.b64, 'base64');
    assert.equal(buf.length, r.artifact.size);
    const json = parseGlb(buf);
    assert.ok(json.extensions?.VRM || json.extensions?.VRMC_vrm, 'the baked file still carries the VRM extension');
    assert.ok(json.meshes.length > 0 && json.materials.length > 0);
    assert.equal(r.meta.bytesIn, fs.statSync(SAMPLE_FILE).size);
    assert.equal(r.meta.bytesOut, buf.length);
    assert.equal(r.meta.vrmVersion, '0.x');
    assert.ok(r.meta.source.endsWith(SAMPLE));
    await expectResultCard(page);
    runs.push({ size: buf.length, hash: sha(r.artifact.b64) });
    await page.close();
  }
  console.log(`# export run 1: ${runs[0].size} bytes ${runs[0].hash.slice(0, 12)}, run 2: ${runs[1].size} bytes ${runs[1].hash.slice(0, 12)}`);
  assert.equal(runs[0].size, runs[1].size, 'the same input and no edits give the same size');
  assert.equal(runs[0].hash, runs[1].hash, 'the editor writer is deterministic: the same input and no edits give the same bytes');
  assert.equal(runs[0].hash, SAMPLE_SHA, 'with no edits the editor hands the input back unchanged');
});

async function expectResultCard(page) {
  assert.match(await page.getByTestId('result').textContent(), /look\.vrm/);
}

test('(c) a bad run= value, run=export without vrm=, and an unreadable input all end in status=error with a message', T, async () => {
  for (const [url, re] of [
    [`/index.html?vrm=${SAMPLE}&run=bake`, /Unknown run=bake/],
    ['/index.html?run=export', /needs vrm=/],
    ['/index.html?vrm=/sample/missing.vrm&run=export', /404/],
    ['/index.html?vrm=/index.html&run=export', /Not a VRM/],
  ]) {
    const { page } = await open(url);
    await page.waitForSelector('body[data-webcli-status=error]', { timeout: 60000 });
    const r = await page.evaluate(() => window.__webcli_result);
    assert.deepEqual({ ok: r.ok, op: r.op, artifact: r.artifact }, { ok: false, op: 'export', artifact: null }, url);
    assert.match(r.error, re, url);
    assert.match(await page.locator('#statusText').textContent(), re);
    await page.close();
  }
});

test('(d) by hand: choose the male base as a file, edit nothing, press Download, get <name>.look.vrm', T, async () => {
  const { page } = await open('/index.html');
  assert.equal(await page.getAttribute('body', 'data-webcli-status'), 'idle');
  assert.equal(await page.getByTestId('download').isDisabled(), true, 'nothing to download before a VRM is loaded');
  await page.getByTestId('vrm-input').setInputFiles(SAMPLE_FILE);
  await expect(page, '#resultInfo', /loaded/);
  assert.equal(await page.getByTestId('download').isDisabled(), false);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 200000 }), page.getByTestId('download').click()]);
  assert.equal(download.suggestedFilename(), 'VRoid_V110_Male_v1.1.3.look.vrm');
  const file = await download.path();
  const buf = fs.readFileSync(file);
  parseGlb(buf);
  await page.waitForSelector('body[data-webcli-status=done]');
  assert.equal((await page.evaluate(() => window.__webcli_result)).artifact.size, buf.length);
  await page.close();
});

test('(e) the URL field loads the sample and the editor shows the avatar (the viewport is not blank)', T, async () => {
  const blank = await open('/index.html');
  const blankFrame = blank.page.locator('#editor').contentFrame();
  await blankFrame.locator('canvas').first().waitFor({ timeout: 60000 });
  await blank.page.waitForTimeout(1500);
  const before = (await blankFrame.locator('canvas').first().screenshot()).length;
  await blank.page.close();

  const { page } = await open('/index.html');
  await page.getByTestId('vrm-url').fill(SAMPLE);
  await page.getByTestId('load').click();
  await expect(page, '#resultInfo', /VRoid_V110_Male_v1\.1\.3\.vrm .*VRM 0\.x\) loaded/);
  const canvas = page.locator('#editor').contentFrame().locator('canvas').first();
  let after = 0;
  for (let i = 0; i < 60 && after < before * 1.5; i++) { await page.waitForTimeout(500); after = (await canvas.screenshot()).length; }
  console.log(`# viewport PNG bytes: empty editor ${before}, avatar ${after}`);
  assert.ok(after > before * 1.5, 'the editor viewport still looks empty');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.close();
});

test('(f) an edit made in the editor (the VRM title in the Meta tab) is baked into the downloaded VRM', T, async () => {
  const { page } = await open(`/index.html?vrm=${SAMPLE}`);
  await page.waitForSelector('body[data-webcli-status=idle]', { timeout: 120000 });
  const ed = page.locator('#editor').contentFrame();
  await ed.getByText('Meta', { exact: true }).first().click();
  const title = ed.locator('input[type=text]:visible').first();
  await title.waitFor({ timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('#editor').contentDocument.querySelector('input[type=text]')?.value === 'PS_Male', null, { timeout: 120000 });
  await title.fill('look-webCLI edit test');
  await title.press('Tab');
  await ed.getByText('Update', { exact: true }).last().click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 200000 }), page.getByTestId('download').click()]);
  const buf = fs.readFileSync(await download.path());
  const json = parseGlb(buf);
  assert.equal((json.extensions.VRM || json.extensions.VRMC_vrm).meta.title, 'look-webCLI edit test');
  assert.notEqual(crypto.createHash('sha256').update(buf).digest('hex'), SAMPLE_SHA, 'the edit changed the bytes');
  await page.close();
});

test('(g) ?vrm=female&run=export bakes the female base: <name>.look.vrm, valid glTF, byte-identical on a second run', T, async () => {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const { page, requests } = await open('/index.html?vrm=female&run=export', { watch: true });
    await page.waitForSelector(DONE, { timeout: 200000 });
    const r = await readResult(page);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.artifact.name, 'VRoid_V110_Female_v1.1.3.look.vrm');
    const buf = Buffer.from(r.artifact.b64, 'base64');
    assert.ok(parseGlb(buf).extensions?.VRM);
    assert.equal(r.meta.bytesIn, fs.statSync(FEMALE_FILE).size);
    assert.equal(r.meta.vrmVersion, '0.x');
    assert.ok(requests.some(q => q.url.endsWith(FEMALE) && q.method === 'GET'), 'the female base was fetched from this origin');
    assert.ok(!requests.some(q => q.url.endsWith(SAMPLE)), 'only the requested base is fetched');
    runs.push(sha(r.artifact.b64));
    await page.close();
  }
  assert.equal(runs[0], runs[1]);
  assert.equal(runs[0], crypto.createHash('sha256').update(fs.readFileSync(FEMALE_FILE)).digest('hex'), 'with no edits the editor hands the base back unchanged');
});

test('(h) no vrm= means idle and nothing auto-loaded; the base selector is visible, male by default, and ?vrm=male just loads it', T, async () => {
  const { page, requests } = await open('/index.html', { watch: true });
  await page.waitForTimeout(2500);
  assert.equal(await page.getAttribute('body', 'data-webcli-status'), 'idle');
  assert.ok(!requests.some(r => r.url.endsWith('.vrm')), 'a VRM was fetched without being asked');
  assert.equal(await page.getByTestId('base').isVisible(), true);
  assert.equal(await page.getByTestId('base').inputValue(), 'male');
  assert.deepEqual(await page.getByTestId('base').locator('option').allTextContents(), ['Male (VRoid base, bundled)', 'Female (VRoid base, bundled)']);
  assert.equal(await page.evaluate(() => window.__webcli_result ?? null), null);
  await page.close();

  const m = await open('/index.html?vrm=male');
  await m.page.waitForSelector('body[data-webcli-status=idle]');
  await expect(m.page, '#resultInfo', /VRoid_V110_Male_v1\.1\.3\.vrm .*loaded/);
  assert.equal(await m.page.evaluate(() => window.__webcli_result ?? null), null, 'no run= means no result handle');
  await m.page.close();
});

test('(i) the selector loads the female base into the editor and the viewport is not blank', T, async () => {
  const blank = await open('/index.html');
  const bf = blank.page.locator('#editor').contentFrame();
  await bf.locator('canvas').first().waitFor({ timeout: 60000 });
  await blank.page.waitForTimeout(1500);
  const before = (await bf.locator('canvas').first().screenshot()).length;
  await blank.page.close();

  const { page } = await open('/index.html');
  await page.getByTestId('base').selectOption('female');
  await page.getByTestId('load-base').click();
  await expect(page, '#resultInfo', /VRoid_V110_Female_v1\.1\.3\.vrm .*VRM 0\.x\) loaded/);
  const canvas = page.locator('#editor').contentFrame().locator('canvas').first();
  let after = 0;
  for (let i = 0; i < 60 && after < before * 1.5; i++) { await page.waitForTimeout(500); after = (await canvas.screenshot()).length; }
  console.log(`# viewport PNG bytes: empty editor ${before}, female base ${after}`);
  assert.ok(after > before * 1.5, 'the editor viewport still looks empty');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.close();
});

const nums = prog => prog.filter(p => !p.hidden && p.now != null).map(p => Number(p.now));
const labels = prog => new Set(prog.filter(p => !p.hidden).map(p => (p.text || '').replace(/, \d+%$/, '')));

async function assertIdleBar(page) {
  assert.equal(await page.getByTestId('progress').isHidden(), true, 'the progress bar is still visible');
  assert.equal(await page.getAttribute('body', 'data-loading'), 'false');
  assert.equal(await page.getAttribute('body', 'aria-busy'), 'false');
  assert.equal(await page.evaluate(() => window.__look_loading), false);
}

async function blankCanvasSize() {
  const blank = await open('/index.html');
  const f = blank.page.locator('#editor').contentFrame();
  await f.locator('canvas').first().waitFor({ timeout: 60000 });
  await blank.page.waitForTimeout(1500);
  const n = (await f.locator('canvas').first().screenshot()).length;
  await blank.page.close();
  return n;
}

test('(j) the progress bar shows byte progress, then the editor stages, until the editor reports the VRM loaded', T, async () => {
  const empty = await blankCanvasSize();
  const { page } = await open('/index.html', { observe: true });
  await page.locator('#editor').contentFrame().locator('canvas').first().waitFor({ timeout: 60000 });
  await assertIdleBar(page);
  assert.equal(await page.getAttribute('[data-testid=progress]', 'role'), 'progressbar');
  // 8 MB/s: the 22 MB base takes a few seconds, so the byte progress of the fetch stage is observable
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: 8 * 1024 * 1024, uploadThroughput: -1 });
  await page.evaluate(() => { window.__prog.length = 0; });
  await page.getByTestId('load-base').click();
  await page.waitForSelector('[data-testid=progress]:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.body.dataset.loading === 'false' && /loaded/.test(document.querySelector('#resultInfo').textContent), null, { timeout: 200000 });
  const prog = await page.evaluate(() => window.__prog);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  assert.ok(prog.some(p => !p.hidden), 'the bar was visible between the click and the end');
  assert.ok(prog.filter(p => !p.hidden).every(p => p.loading === 'true' && p.busy === 'true' && p.flag === true && p.role === 'progressbar'), 'visible means loading=true everywhere');
  const n = nums(prog);
  assert.ok(new Set(n).size >= 4, `expected several distinct percentages, got ${[...new Set(n)]}`);
  assert.deepEqual(n, [...n].sort((a, b) => a - b), 'aria-valuenow never decreases within one load');
  assert.ok(n.some(v => v > 2 && v < 30), 'byte progress of the fetch stage was seen');
  assert.ok(n.every(v => v >= 2 && v <= 98), 'between 2% and 98% while visible');
  const seen = labels(prog);
  for (const l of ['Fetching the VRM', 'Rendering the model']) assert.ok(seen.has(l), `stage "${l}" was shown: ${[...seen]}`);
  assert.ok(prog.filter(p => !p.hidden && p.text).every(p => /^[A-Z].*(, \d+%)?$/.test(p.text)), 'aria-valuetext carries the label');
  const last = prog.at(-1);
  assert.equal(last.hidden, true); assert.equal(last.loading, 'false');

  await assertIdleBar(page);
  assert.equal(await page.getAttribute('body', 'data-webcli-status'), 'idle', 'a manual load never leaves idle');
  assert.equal(await page.getByTestId('download').isDisabled(), false);
  const after = (await page.locator('#editor').contentFrame().locator('canvas').first().screenshot()).length;
  assert.ok(after > empty * 1.5, `the editor had rendered the avatar when the bar ended (${empty} -> ${after})`);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace(/(\.png)?$/, '-done.png') });
  await page.close();
});

test('(k) ?vrm=male&run=export keeps the bar up through the load, then shows an indeterminate bake; same bytes as before', T, async () => {
  const { page } = await open('/index.html?vrm=male&run=export', { observe: true });
  await page.waitForSelector(DONE, { timeout: 200000 });
  const r = await readResult(page);
  assert.equal(r.ok, true, r.error);
  assert.equal(sha(r.artifact.b64), SAMPLE_SHA, 'still the identity on the male base');
  const prog = await page.evaluate(() => window.__prog);
  const seen = labels(prog);
  assert.ok(seen.has('Rendering the model'), `${[...seen]}`);
  const n = nums(prog);
  assert.deepEqual(n, [...n].sort((a, b) => a - b));
  assert.ok(prog.some(p => !p.hidden && p.text === 'Baking the edits into the VRM' && p.now == null), 'the bake bar is indeterminate (no aria-valuenow)');
  await assertIdleBar(page);
  await page.close();
});

test('(l) a second VRM loaded while the first is still loading takes over: the bar ends hidden and the female bytes win', T, async () => {
  const { page } = await open('/index.html', { observe: true });
  await page.locator('#editor').contentFrame().locator('canvas').first().waitFor({ timeout: 60000 });
  await page.getByTestId('load-base').click();
  await page.waitForFunction(() => /Rendering the model/.test(document.querySelector('[data-testid=progress]').getAttribute('aria-valuetext') || ''), null, { timeout: 60000 });
  await page.getByTestId('base').selectOption('female');
  await page.getByTestId('load-base').click();
  await expect(page, '#resultInfo', /VRoid_V110_Female_v1\.1\.3\.vrm .*loaded/, 200000);
  await assertIdleBar(page);
  await page.waitForTimeout(2500);
  await assertIdleBar(page); // nothing from the abandoned load brings it back
  assert.equal(await page.getAttribute('body', 'data-webcli-status'), 'idle');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 200000 }), page.getByTestId('download').click()]);
  assert.equal(download.suggestedFilename(), 'VRoid_V110_Female_v1.1.3.look.vrm');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(await download.path())).digest('hex'), crypto.createHash('sha256').update(fs.readFileSync(FEMALE_FILE)).digest('hex'));
  await assertIdleBar(page);
  await page.close();
});

test('(m) unreadable input hides the bar and shows the error: not a VRM (file and URL), and a glTF the editor cannot load times out', T, async () => {
  const { page } = await open('/index.html', { observe: true });
  await page.getByTestId('vrm-input').setInputFiles({ name: 'notes.vrm', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not a glTF binary at all, just text') });
  await page.waitForSelector('body[data-webcli-status=error]', { timeout: 30000 });
  assert.match(await page.locator('#statusText').textContent(), /Not a VRM/);
  assert.match(await page.getByTestId('result').textContent(), /Not a VRM/);
  await assertIdleBar(page);
  await page.getByTestId('vrm-url').fill('/index.html');
  await page.getByTestId('load').click();
  await page.waitForFunction(() => /Not a VRM/.test(document.querySelector('#statusText').textContent) && document.body.dataset.loading === 'false');
  await page.close();

  // a binary glTF with no VRM in it passes the wrapper's check; the editor never reports it loaded (or reports a failure): either way the bar must end with an error
  const json = Buffer.from('{"asset":{"version":"2.0"}}  ');
  const g = Buffer.concat([Buffer.alloc(20), json]);
  g.writeUInt32LE(0x46546c67, 0); g.writeUInt32LE(2, 4); g.writeUInt32LE(g.length, 8); g.writeUInt32LE(json.length, 12); g.writeUInt32LE(0x4e4f534a, 16);
  const t = await open('/index.html?timeout=10', { observe: true });
  await t.page.getByTestId('vrm-input').setInputFiles({ name: 'plain.glb', mimeType: 'model/gltf-binary', buffer: g });
  await t.page.waitForSelector('body[data-webcli-status=error]', { timeout: 60000 });
  assert.match(await t.page.locator('#statusText').textContent(), /did not finish loading|could not load/);
  await assertIdleBar(t.page);
  assert.ok((await t.page.evaluate(() => window.__prog)).some(p => !p.hidden), 'the bar was shown while it tried');
  await t.page.close();
});

async function expect(page, selector, re, timeout = 120000) {
  await page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent || ''), [selector, re.source], { timeout });
}
