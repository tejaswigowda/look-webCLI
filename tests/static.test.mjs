import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MESSAGES } from '../docs/js/webcli.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const read = p => fs.readFileSync(path.join(docs, p), 'utf8');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const cspOf = html => (html.match(/Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
const directive = (csp, name) => ((csp.match(new RegExp(`(?:^|; )${name} ([^;]*)`)) || [])[1] || '').split(/\s+/).filter(Boolean);

test('the wrapper CSP is a <meta> policy: same-origin scripts and styles, https: only for connect-src, no eval, no inline', () => {
  const html = read('index.html');
  const csp = cspOf(html);
  assert.match(csp, /^default-src 'none'/);
  assert.deepEqual(directive(csp, 'script-src'), ["'self'"]);
  assert.deepEqual(directive(csp, 'style-src'), ["'self'"]);
  assert.deepEqual(directive(csp, 'img-src'), ["'self'", 'blob:', 'data:']);
  assert.deepEqual(directive(csp, 'connect-src'), ["'self'", 'blob:', 'data:', 'https:']);
  assert.deepEqual(directive(csp, 'frame-src'), ["'self'"]);
  assert.deepEqual(directive(csp, 'form-action'), ["'none'"]);
  assert.deepEqual(directive(csp, 'base-uri'), ["'none'"]);
  assert.ok(!/unsafe-eval|unsafe-inline|\*/.test(csp), 'the wrapper CSP must not allow eval, inline code or a wildcard');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<iframe[^>]+referrerpolicy="no-referrer"/);
  assert.match(read('js/app.js'), /EDITOR_URL = 'editor\/index\.html\?embed=1'/);
});

test('the wrapper has no inline <script>, no inline <style>, no style attributes, no remote src/href', () => {
  const html = read('index.html');
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/<script[^>]*>[^<]+<\/script>/i.test(html), 'script with a body');
  assert.ok(!/<style[\s>]/i.test(html), 'inline <style>');
  assert.ok(!/\sstyle=/i.test(html), 'style attribute');
  assert.ok(!/\son[a-z]+=/i.test(html), 'inline event handler');
  for (const m of html.matchAll(/<(?:script|link|img|iframe)[^>]+(?:src|href)="([^"]+)"/gi)) assert.ok(!/^(?:https?:)?\/\//.test(m[1]), `remote resource ${m[1]}`);
  assert.ok(!/\sstyle=|style\s*=\s*"/.test(fs.readFileSync(path.join(docs, 'editor', 'index.html'), 'utf8')), 'editor page style attribute');
});

test('the editor keeps its strict meta CSP: no remote hosts, no unsafe-eval, no inline script', () => {
  const html = read('editor/index.html');
  const c = cspOf(html);
  assert.match(c, /default-src 'none'/);
  assert.ok(directive(c, 'connect-src').every(v => ["'self'", 'blob:', 'data:'].includes(v)), `editor connect-src: ${directive(c, 'connect-src')}`);
  for (const d of ['script-src', 'style-src', 'img-src', 'font-src', 'worker-src', 'media-src']) assert.ok(!/https?:|\*/.test(directive(c, d).join(' ')), `${d} allows a remote host`);
  assert.ok(!/(?<!wasm-)unsafe-eval|script-src[^;]*unsafe-inline/.test(c), 'editor script-src allows eval or inline scripts');
  assert.match(c, /form-action 'none'/); assert.match(c, /base-uri 'none'/);
  assert.ok(!/googletagmanager|gtag|platform\.twitter|<script>[^<]/.test(html), 'analytics, a share widget or an inline script');
  assert.ok(!/<(script|link|img)[^>]+(?:src|href)="https?:/.test(html), 'remote resource in the editor page');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
});

test('the editor bundle has no analytics, Stripe or Firebase hosts, no sample VRMs, and ships the MIT license', () => {
  const dir = path.join(docs, 'editor');
  const files = walk(dir);
  const js = files.filter(f => f.endsWith('.js')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(js.length > 1e6, 'the editor bundle is missing');
  assert.ok(!/googletagmanager|G-Y2SF4RRHYB|js\.stripe\.com|firebaseio|firebaseapp|sendBeacon/.test(js), 'the editor bundle talks to analytics, Stripe or Firebase');
  assert.ok(!fs.existsSync(path.join(dir, 'res')), 'the editor ships sample VRMs it does not need');
  assert.ok(!fs.existsSync(path.join(dir, '404.html')), 'the Firebase 404 page (inline <style>) must not ship');
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE-VRMEditorTools.txt'), 'utf8'), /MIT License/i);
  assert.ok(/Free accessories/.test(js) && /bow-tie|Bow tie/.test(js), 'the free accessories are missing from the editor bundle');
});

test('every .js parses: the editor bundle as a classic script, the wrapper as ES modules or classic scripts', () => {
  for (const f of walk(path.join(docs, 'editor')).filter(f => f.endsWith('.js'))) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }), f);
  for (const f of walk(path.join(docs, 'js')).filter(f => f.endsWith('.js'))) execFileSync(process.execPath, ['--check', f]);
  execFileSync(process.execPath, ['--check', path.join(root, 'server.js')]);
});

test('the postMessage types are look-* and match js/webcli.js; nothing is called facebind any more', () => {
  const bundle = read('editor/js/index.a31e76d6.js');
  for (const t of Object.values(MESSAGES)) assert.ok(bundle.includes(`"${t}"`), `${t} is missing from the editor bundle`);
  const used = new Set([...bundle.matchAll(/"(look-[a-z-]+)"/g)].map(m => m[1]));
  assert.deepEqual([...used].sort(), Object.values(MESSAGES).sort());
  for (const f of [...walk(docs), path.join(root, 'scripts', 'look-embed.patch'), path.join(root, 'scripts', 'build-editor.sh')]) {
    if (/\.(vrm|ico|svg)$/.test(f)) continue;
    assert.ok(!/facebind/i.test(fs.readFileSync(f, 'utf8')), `${path.relative(root, f)} still mentions facebind`);
  }
});

test('the wrapper checks origin and source on every message and never posts to "*"', () => {
  const code = read('js/app.js');
  assert.match(code, /e\.origin !== location\.origin \|\| e\.source !== frame\.contentWindow/);
  assert.match(code, /frame\.contentWindow\.postMessage\(msg, location\.origin, transfer\)/);
  assert.ok(!/postMessage\([^)]*['"]\*['"]/.test(code), 'postMessage with a wildcard target');
  const bundle = read('editor/js/index.a31e76d6.js');
  assert.ok(!/postMessage\([^)]*['"]\*['"]/.test(bundle), 'the editor posts to "*"');
  assert.match(bundle, /t\.origin===window\.location\.origin&&t\.source===window\.parent/);
});

test('the egress guard refuses non-GET, bodies, other origins and the usual side channels', () => {
  const code = read('js/guard.js');
  for (const s of ["method !== 'GET'", 'hasBody', 'sendBeacon', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'WebTransport', 'Worker', 'window.open', 'serviceWorker']) assert.ok(code.includes(s), `guard does not cover ${s}`);
  assert.ok(code.split('\n').length < 60, 'the guard grew past its budget');
  assert.match(read('index.html'), /<script src="js\/guard\.js"><\/script>[\s\S]*<script type="module" src="js\/app\.js">/);
});

test('there is no service worker, and the manifest and icon are present', () => {
  assert.ok(!fs.existsSync(path.join(docs, 'service-worker.js')));
  assert.ok(!/serviceWorker\.register\(/.test(read('js/app.js')));
  assert.equal(JSON.parse(read('manifest.json')).short_name, 'look-webCLI');
  assert.match(read('icon.svg'), /viewBox="0 0 192 192"/);
  assert.ok(fs.statSync(path.join(docs, 'sample', 'VRoid_V110_Male_v1.1.3.vrm')).size > 1e6);
  assert.match(read('sample/README.md'), /hinzka\/52blendshapes-for-VRoid-face/);
});
