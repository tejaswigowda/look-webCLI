# look-webCLI

A browser-based **VRM look editor**: load a VRM (a local file or a URL), recolor and replace its textures, edit materials, meta and spring bones, dress it with outfits and free accessories, and export the edited **VRM** (0.x or 1.0). VRM in, edited VRM out.
<b><ins>No uploads, no servers: everything happens in your browser.</ins></b> No build step for the app: `docs/` is plain static files (the editor is a committed build, `docs/editor/`), same-origin, with no CDN, so the whole app works offline after the first load.

Intended origin: <https://look.webcli.app/> (the intended home of this tool, not a verified live deployment). It runs anywhere a static server does: `npm start`.

It was cut from the Strata editor's facebind (`docs/facebind/editor` in [strata-editor](https://github.com/tejaswigowda/strata-editor)). [portrait-webCLI](https://github.com/tejaswigowda/portrait-webCLI) produces the bound VRMs (a face bound onto a VRoid base); this tool then edits their look.

## Paper

This tool is a reference implementation of the **Web-CLI** architecture, applied to a new domain (editing the look of a VRM avatar):

> **The Web-CLI: Verifiable Privacy for Tools, Models, and Inference Engines in the Browser**
> Tejaswi Gowda, Arizona State University.
> arXiv: https://arxiv.org/abs/2608.28950

Part of the Web-CLI family, alongside [ffmpeg-webCLI](https://github.com/tejaswigowda/ffmpeg-webCLI), [whisper-webCLI](https://github.com/tejaswigowda/whisper-webCLI), [3mf-webCLI](https://github.com/tejaswigowda/3mf-webCLI), [bodyrig-webCLI](https://github.com/tejaswigowda/bodyrig-webCLI), [portrait-webCLI](https://github.com/tejaswigowda/portrait-webCLI) and [Strata](https://github.com/tejaswigowda/strata-editor).

## Run it

```bash
npm install     # dev tooling only (tests); the app itself needs nothing
npm start       # http://127.0.0.1:8010 (any static host works; no COOP/COEP needed)
```

Pick **Male** or **Female** in the **Base VRM** selector and press **Load base** (the two VRoid bases are bundled; nothing loads until you ask), choose or drop a `.vrm`, or paste a URL. Edit in the editor below the input card, then press **Download VRM**: the editor bakes every edit (accessories included) into the file and the page saves it as `<name>.look.vrm`.

## What you can edit

The editor is [cecil-tools/VRMEditorTools](https://github.com/cecil-tools/VRMEditorTools) (MIT), patched for zero egress and for embedding (see [Honest limitations](#honest-limitations) and `scripts/README.md`):

- **Textures**: replace or recolor any texture. Also **Color Adjustment**, **Materials**, **Perspective, Scale**, **Meta** (title, author, license), **Spring Bone**, **BlendShape**, **Armature**, **Polygon Reduction**, **Motion**, and screenshots.
- **Add Accessory**: 11 free accessories built in code from three.js primitives (round, square and sun glasses, cap, top hat, cat and bunny ears, headband, crown, halo, bow tie) plus outfit pieces (scarf, necktie, backpack, belt, cape). Attach to the head or neck bone, move with a gizmo, set a color. Nothing is downloaded and there is no third-party asset.
- **Outfit**: list the garments (materials named `*_CLOTH`: tops, bottoms, shoes, one-pieces), recolor them, give one a generated pattern (18 patterns painted on a canvas in code) or your own image, hide and restore, delete for good, or apply one of 12 built-in outfits.
- **Export** as VRM 0.x or 1.0.

## Pure transform, agent-drivable

look-webCLI is a **pure transform**: input (a URL or a dropped file) in, artifact (a VRM download plus a grabbable handle) out. It has no git, no token, no repo write, no versioning and no file management. Versioning, pinning and persistence belong to the orchestrator driving it and to [Strata](https://github.com/tejaswigowda/strata-editor), never to this tool.

**Input** is any fetchable URL (a CDN, jsDelivr or raw GitHub, S3, a `data:` URL, or a previous stage's output, e.g. a portrait-webCLI result), or a file chosen or dropped on the page. Parameters go in the query string or the `#fragment` (the fragment never reaches the server, so use it for long `data:` URLs):

```
index.html?vrm=male|female|<url>[&run=export]
```

`vrm=male` and `vrm=female` are the bundled VRoid bases (`sample/VRoid_V110_Male_v1.1.3.vrm`, `sample/VRoid_V110_Female_v1.1.3.vrm`), a same-origin `GET`. Any other value is a URL. `?vrm=male` alone just loads that base into the editor; with `run=export` it also bakes. Opened with no `vrm=` and no file, the page stays idle and loads nothing (the selector is there, one click loads the default, male).

`owner/repo@ref:path` is optional sugar that expands to a jsDelivr URL, and a `raw.githubusercontent.com` URL that fails is retried once through jsDelivr. Neither is required. To pin an input, pass an immutable URL (jsDelivr `@<sha>`, content-addressed); the tool does not pin.

**Output.** A **Download VRM** button for people. For agents, `run=export` loads the VRM, bakes it through the editor without a click and, when finished, the page exposes:

```js
document.body.dataset.webcliStatus   // 'idle' | 'running' | 'done' | 'error'
window.__webcli_result = { ok, op: 'export', artifact: { mime: 'model/gltf-binary', name, size, dataUrl }, error, meta: { source, bytesIn, bytesOut, vrmVersion } }
```

`dataUrl` is the VRM as a `data:` URL (built on first read); `error` is a message when `ok` is false (then `artifact` is `null`). This is not a network write, only a way to retrieve the output. The same handle is set after a **Download VRM** pressed by hand. An unknown `run=` value, `run=export` without `vrm=`, an HTTP error and a file that is not a binary glTF all end in `data-webcli-status="error"` with a message. Stable hooks: `data-testid` `vrm-input`, `vrm-url`, `load`, `base`, `load-base`, `download`, `result`.

```js
// Playwright
await page.goto(`${origin}/index.html?vrm=${encodeURIComponent(vrmUrl)}&run=export`);
await page.waitForSelector('body[data-webcli-status=done], body[data-webcli-status=error]');
const { ok, artifact, error } = await page.evaluate(() => window.__webcli_result);
const vrm = Buffer.from(artifact.dataUrl.split(',')[1], 'base64'); // starts with 'glTF'
```

With no edits, `run=export` returned the input byte for byte on both bundled bases, and two runs were byte-identical (the tests assert both). Persisting the VRM and feeding its URL to the next stage is the orchestrator's job.

The wrapper talks to the editor iframe (`editor/index.html?embed=1`) with five `postMessage` types: `look-editor-ready`, `look-load-vrm`, `look-apply`, `look-edited-vrm` and `look-apply-failed`. Every message, in both directions, is checked for `origin === location.origin` and for the right window, and the target origin is always `location.origin`, never `*`. A fresh editor is opened for each VRM, so an earlier model is never baked into a later one.

## Embedding in portrait-webCLI

[portrait-webCLI](https://github.com/tejaswigowda/portrait-webCLI) embeds this tool's `docs/editor/` build: the raw editor in `?embed=1` mode, same origin, in an iframe, over the `look-*` postMessage protocol. The parent waits for `look-editor-ready`, sends `look-load-vrm` (`{ name, bytes }`, transferred), later sends `look-apply`, and the editor replies `look-edited-vrm` (`{ bytes }`) or `look-apply-failed` (also sent until a VRM has been parsed, so retry). Both sides check `origin === location.origin` and the other window, and post to `location.origin`, never `*`. The embedding repository refreshes its copy by copying `docs/editor/` from here; the standalone page in this repository is the same editor with its own wrapper (`docs/js/app.js` is a working reference for the parent side). `scripts/README.md` has the message table.

## Verify zero egress

Open DevTools, Network tab, check **Preserve log**, load a base and press **Download VRM**. Only static files from this site appear, all `GET`, none carrying a body, cookie or credential. There is no write path to audit: no `POST` or `PUT`, no account, no token. The one exception is a URL you name yourself (the URL field or `?vrm=`), which is fetched with a read-only `GET` and `credentials: 'omit'`; nothing is sent with it.

The protections, from the outside in:

- **Wrapper CSP** (a `<meta>` tag, because GitHub Pages cannot set headers): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob: data: https:; frame-src 'self'; manifest-src 'self'; form-action 'none'; base-uri 'none'`, plus `<meta name="referrer" content="no-referrer">`. No inline script, style or style attribute. `https:` in `connect-src` exists only so a user-named VRM URL can be fetched; no code path of this app sends anything there.
- **Egress guard** (`docs/js/guard.js`, under 60 lines, loaded before the app): inside the wrapper, `fetch` and `XMLHttpRequest` must be `GET` with no body to this origin, a `blob:` or `data:` URL, or the exact URL registered for the VRM just named; it also refuses `sendBeacon`, `WebSocket`, `EventSource`, WebRTC, WebTransport, workers, service workers and `window.open`. Every request is logged in `window.__look_net`. It is a second line behind the CSP; it cannot stop a browser extension or a host that replaces the file.
- **Editor CSP** (the untouched `<meta>` in `docs/editor/index.html`): `default-src 'none'`, scripts from this origin plus `wasm-unsafe-eval` (no `unsafe-eval`), connections to this origin, `blob:` and `data:` only, no remote styles, fonts or images, `form-action 'none'`. The bundle has no analytics, Twitter, Firebase or Stripe code.

`npm test` asserts it: every request while loading the page and a base is same-origin, `GET` and bodyless; the guard refuses a `POST`, a foreign-origin fetch, `sendBeacon` and `WebSocket`; both CSPs are as above; the bundle scan finds no analytics, Stripe or Firebase host.

## Testing

```bash
npm test             # unit, static, then the Playwright end-to-end suite
npm run test:unit    # tests/unit.test.mjs   (node --test, no browser)
npm run test:static  # tests/static.test.mjs (CSP, no inline code, bundle scan, every .js parses, look-* messages)
npm run test:e2e     # tests/e2e.test.mjs    (headless Chromium via Playwright)
```

`unit.test.mjs` covers `docs/js/webcli.js`: `vrm=` / `run=` parsing from the query and the `#fragment`, the `male` / `female` aliases (and that other names stay URLs), run validation, the jsDelivr sugar and raw-GitHub fallback, content-based name sniffing, `fetchInput` (GET only, `credentials: 'omit'`, no body), VRM 0.x / 1.0 detection, the output name and the result handle.

`e2e.test.mjs` starts `server.js` on a free port and drives the real page: (a) zero egress, (b) `?vrm=<male base>&run=export` reaches `done` with a valid binary glTF carrying the VRM extension, and a second run is byte-identical (and, with no edits, identical to the input), (c) a bad `run=`, `run=export` without `vrm=`, a 404 and a non-VRM all give status `error`, (d) the file input plus the **Download** button saves `<name>.look.vrm`, (e) the URL field loads the sample and the editor viewport is not blank, (f) an edit made in the editor (the VRM title in the Meta tab) is baked into the downloaded file, (g) `?vrm=female&run=export` gives `VRoid_V110_Female_v1.1.3.look.vrm`, valid and byte-identical on a second run, (h) with no `vrm=` nothing is fetched and the selector shows male, and (i) the selector loads the female base and the viewport is not blank. The editor draws with WebGL, so the tests launch Chromium with SwiftShader (`--use-angle=swiftshader`), which also works on machines without a GPU. Playwright is the dev loop, not the product: it never runs at runtime.

## Honest limitations

- **The editor re-exports through its own writer.** The file you download is the editor's output, not a byte-audited edit of the input. With no edits it came back identical on both bundled bases, but that is a measurement on that file, not a guarantee for every VRM, and anything you do change is rewritten by the editor's code.
- **Third-party, patched build.** The editor is [cecil-tools/VRMEditorTools](https://github.com/cecil-tools/VRMEditorTools) at a pinned commit (`e9975cf`) with a patch (`scripts/look-embed.patch`) that removes its network features and adds the embed protocol, the free accessories and the Outfit tab. It is a committed build you can regenerate (`scripts/README.md`), not code written for this repository, and its bugs are its own.
- **Determinism is measured, not promised.** The bundled bases export byte-identically across runs. Other VRMs, and edits that involve generated textures, are not covered by a test.
- **No service worker.** The editor iframe's CSP restricts `worker-src`, so there is no service worker. The app works offline after the first load only because everything is a same-origin static file the browser has already fetched; clear the cache and it needs the network once more. It is not an installable offline PWA.
- **`https:` in the wrapper's `connect-src`** is there only so a user-named VRM URL can be read. The CSP alone cannot tell that URL from any other `https:` host; the egress guard narrows it to the one URL registered for the fetch.
- **The wrapper CSP is a `<meta>`, not a header.** `frame-ancestors` cannot be set that way, so a static host that can send headers should add `frame-ancestors 'self'`.
- **Large VRMs are memory-bound.** The page keeps the input, the editor holds its own copy and the baked output is another. A 22 MB model is fine; a few hundred MB may not be on a phone.
- The editor needs WebGL.

## Layout

```
docs/                    the static app (GitHub Pages root)
  index.html style.css   the wrapper page (header, statusbar, cards: same look as the family)
  js/webcli.js           pure, DOM-free: ?vrm= / run= parsing, GET-only fetchInput, sniffing, result handle
  js/app.js              the wrapper: loads the VRM, speaks the look-* protocol with the iframe
  js/guard.js            egress guard for the wrapper window
  editor/                the committed editor build (MIT, LICENSE-VRMEditorTools.txt)
  sample/                the bundled male and female VRoid bases (hinzka/52blendshapes-for-VRoid-face) and their README
  icon.svg manifest.json
server.js                static dev server for docs/
scripts/                 build-editor.sh, look-embed.patch, README.md (how the editor build is regenerated)
tests/                   unit, static and Playwright end-to-end tests
```

## Attribution

- The editor is [cecil-tools/VRMEditorTools](https://github.com/cecil-tools/VRMEditorTools), MIT licensed; its license is kept at `docs/editor/LICENSE-VRMEditorTools.txt`. It bundles three.js, Vue and other open-source libraries under their own licenses.
- The bases are `VRoid_V110_Male_v1.1.3.vrm` and `VRoid_V110_Female_v1.1.3.vrm` from [hinzka/52blendshapes-for-VRoid-face](https://github.com/hinzka/52blendshapes-for-VRoid-face): free VRoid base models with the 52 ARKit blendshapes, which that repository states may be used and redistributed freely. Both are included unmodified (`docs/sample/README.md`).
- The accessories, outfits and patterns are generated in code by the editor build, so they carry no third-party asset.

## License

The wrapper, tests and scripts in this repository are GPL-3.0-only. See [LICENSE](LICENSE). The vendored editor in `docs/editor/` keeps its own MIT notice (`docs/editor/LICENSE-VRMEditorTools.txt`), and the bases keep their upstream terms.
