import { build } from 'vite';

await build({
  worker: {
    format: 'es',
  },
});
