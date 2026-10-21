#!/bin/sh
# Rebuilds docs/editor from cecil-tools/VRMEditorTools (MIT) at a pinned commit plus look-embed.patch.
# Needs git, node and npm. The result is static files only; nothing is fetched at run time.
set -e
PIN=e9975cf85e1653090a332ef507067ea06f0fb8d1
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../docs/editor"
WORK="$HERE/../.editor-build"
rm -rf "$WORK" && mkdir -p "$WORK"
git clone -q https://github.com/cecil-tools/VRMEditorTools "$WORK/src"
cd "$WORK/src" && git checkout -q "$PIN"
git apply "$HERE/look-embed.patch"
rm -rf app/public/res
# regenerator-runtime falls back to Function("...") (eval) when the global is not declared; declaring it first keeps the CSP free of unsafe-eval
printf '%s\n' '// declares the global that regenerator-runtime assigns, so it never needs eval' 'window.regeneratorRuntime = window.regeneratorRuntime || {};' > app/public/regenerator-shim.js
sed -i.bak 's#<div id="app"></div>#<script src="regenerator-shim.js"></script><div id="app"></div>#' app/public/index.html && rm -f app/public/index.html.bak
cd app && npm ci --no-audit --no-fund --ignore-scripts && npm run build
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R dist/. "$OUT/"
# the upstream Firebase 404 page carries an inline <style>; a static host does not need it
rm -f "$OUT/404.html"
cp ../LICENSE "$OUT/LICENSE-VRMEditorTools.txt"
echo "built into $OUT"
rm -rf "$WORK"
