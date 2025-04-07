import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: false, // Don't empty the output directory since we'll add server files there
  },
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:10000',
        ws: true,
      }
    }
  }
});
