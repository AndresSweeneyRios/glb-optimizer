import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const gameAssets = '/projects/8ball/src/assets/3d';
const aliases: Record<string,string> = {
  '/': resolve(root, 'preview/index.html'),
  '/original.glb': resolve(process.env.GLB_PREVIEW_SOURCE ?? resolve(gameAssets, 'table.glb')),
  '/report.json': resolve(process.env.GLB_PREVIEW_REPORT ?? resolve(root, 'output/table.atlas.report.json')),
  '/optimized.glb': resolve(process.env.GLB_PREVIEW_OUTPUT ?? resolve(root, 'output/table.atlas.glb')),
  '/environment.hdr': resolve(gameAssets, 'pine_attic_1k.hdr'),
};
const mime: Record<string,string> = {'.html':'text/html', '.js':'text/javascript', '.wasm':'application/wasm', '.glb':'model/gltf-binary', '.json':'application/json'};
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    let file = aliases[path];
    for (const [prefix, directory] of [['/three/', 'node_modules/three'], ['/preview/', 'preview'], ['/runtime/', 'runtime']]) {
      if (!path.startsWith(prefix)) continue;
      const base = resolve(root, directory);
      const candidate = resolve(base, path.slice(prefix.length));
      if (candidate.startsWith(base + '/')) file = candidate;
    }
    if (!file) { response.writeHead(404).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, {'Content-Type':mime[extname(file)] ?? 'application/octet-stream', 'Content-Length':info.size,'Cache-Control':'no-store'});
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy()); stream.pipe(response);
  } catch { response.writeHead(404).end(); }
});
server.listen(8991, '127.0.0.1', () => console.log('GLB preview: http://localhost:8991'));
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => server.close());
