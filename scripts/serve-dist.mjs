import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = join(process.cwd(), 'dist');
const port = Number(process.env.PORT || 5173);
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer((request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  const requested = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = join(root, requested);
  const safePath = existsSync(filePath) && filePath.startsWith(root) ? filePath : join(root, 'index.html');
  response.setHeader('Content-Type', mime[extname(safePath)] || 'application/octet-stream');
  createReadStream(safePath).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`Serving dist at http://127.0.0.1:${port}`);
});
