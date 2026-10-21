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

async function open(url, { watch = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
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

async function expect(page, selector, re, timeout = 120000) {
  await page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent || ''), [selector, re.source], { timeout });
}
