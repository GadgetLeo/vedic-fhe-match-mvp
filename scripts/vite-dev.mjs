import { createServer } from 'vite';

const server = await createServer({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  worker: {
    format: 'es',
  },
});

await server.listen();
server.printUrls();
