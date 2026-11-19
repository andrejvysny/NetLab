import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained index.html (JS + CSS inlined) so the app can be published as a single page and opened offline.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { target: 'es2022', cssCodeSplit: false, assetsInlineLimit: 100000000, chunkSizeWarningLimit: 5000 },
});
