// DEV ONLY: build the workbench harness (bench.html) into one self-contained file, outside the project's dist/.
// Usage: node src/ui/bench/dev/build-harness.mjs [outDir]   (default: /tmp/kss-bench-harness)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const outDir = process.argv[2] ?? '/tmp/kss-bench-harness';
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  plugins: [react(), viteSingleFile()],
  build: {
    target: 'es2022', cssCodeSplit: false, assetsInlineLimit: 100000000, chunkSizeWarningLimit: 5000,
    outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'bench.html') },
  },
});
console.log(`harness built: ${path.join(outDir, 'bench.html')}`);
