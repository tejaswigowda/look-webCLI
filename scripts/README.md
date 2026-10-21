# Regenerating the editor build

`docs/editor/` is a static build of [cecil-tools/VRMEditorTools](https://github.com/cecil-tools/VRMEditorTools) (MIT) at the pinned commit
`e9975cf85e1653090a332ef507067ea06f0fb8d1`, plus `look-embed.patch`. It is committed, so running and testing the app needs no build and no network.

```bash
npm run build:editor     # = sh scripts/build-editor.sh
```

`build-editor.sh` clones the pinned commit into `.editor-build/` (git-ignored), applies `look-embed.patch`, adds `regenerator-shim.js`, runs `npm ci` and the Vue CLI build there,
replaces `docs/editor/` with `dist/`, drops the upstream Firebase `404.html`, and copies upstream's `LICENSE` to `docs/editor/LICENSE-VRMEditorTools.txt`.
It needs git, node and npm, and it is the only step that touches the network. After a rebuild, run `npm test`: `tests/static.test.mjs` re-checks the CSP, the bundle scan and the message types.
The bundle's file names carry content hashes, so a rebuild changes `docs/editor/index.html` and the file name used in `tests/static.test.mjs` (`index.<hash>.js`).
The three `look-vrm-*` messages were first added to the committed bundle by a minimal in-place edit of `drawVrm` (keeping the file name `index.a31e76d6.js`) and to the patch. A real build from the patched pinned source yields the same `lookNotify` / `drawVrm` code; it differs from the committed file only in the file hash, webpack's id of the scoped-style module and `data-v-` scope id of `Main.vue` (they are derived from that file's content), so the bundles are behaviourally identical but not byte-identical.

## What `look-embed.patch` changes

- Removes Google Analytics, the Twitter widget, Firebase, Stripe and the Donate page, the bundled sample VRMs and the external links.
- Adds a strict `<meta>` CSP (`default-src 'none'`, scripts from this origin plus `wasm-unsafe-eval`, connections to this origin and `blob:` / `data:` only, `form-action 'none'`).
- `?embed=1`: the editor loads no VRM by itself. The parent sends it with `postMessage` and the editor answers on the same channel. Origin and source are checked on both ends and the target origin is never `*`.

| message | direction | payload |
| --- | --- | --- |
| `look-editor-ready` | editor to wrapper | none; sent once the embed has mounted |
| `look-load-vrm` | wrapper to editor | `{ name, bytes: ArrayBuffer }` (transferred) |
| `look-apply` | wrapper to editor | none; bake everything into a VRM |
| `look-edited-vrm` | editor to wrapper | `{ name, bytes: ArrayBuffer }` (transferred) |
| `look-apply-failed` | editor to wrapper | none; nothing loaded yet, or the export failed |
| `look-vrm-progress` | editor to wrapper | `{ stage: 'viewer' }`; the viewer has drawn the model, the parser is now reading textures and materials |
| `look-vrm-loaded` | editor to wrapper | none; the model is drawn **and** parsed, so `look-apply` will succeed from now on |
| `look-vrm-failed` | editor to wrapper | `{ message }`; loading the VRM threw (the original `console.log` is kept) |

The three `look-vrm-*` messages are sent only in `?embed=1` mode, to `window.parent`, with `location.origin` as the target (never `*`). They come from `Main.vue`'s `drawVrm` (via a small `lookNotify`
method): `progress` after the viewer's `drawVrm` resolves, `loaded` after the parser's `parse` resolves and the camera and version are set, `failed` on its `catch`. A parent that does not know them can ignore them.

- Free accessories (11, built from three.js primitives in code), the Outfit tab (garments: recolor, 18 generated patterns, 12 built-in outfits, hide, delete) and extra outfit pieces. No third-party asset is downloaded.
- A dark card layout that matches the webCLI family; one column under 820 px.
- `regenerator-shim.js` declares `regeneratorRuntime` first, so the polyfill never falls back to `Function(...)` and the CSP needs no `unsafe-eval`.

The patch was cut from the Strata editor's facebind (`docs/facebind/editor` in [strata-editor](https://github.com/tejaswigowda/strata-editor)); the only difference is the message prefix (`facebind-*` became `look-*`) and the wording.
To move to a newer upstream commit, change `PIN`, re-apply the edits on it and regenerate the patch.
