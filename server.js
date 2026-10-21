// Static dev server for docs/. No COOP/COEP needed. GitHub Pages serves the same files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.vrm': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.md': 'text/markdown', '.txt': 'text/plain',
};

export function createServer(dir = root) {
  return http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 8010;
  createServer().listen(port, '127.0.0.1', () => console.log(`look-webCLI at http://127.0.0.1:${port}`));
}
