import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset base so the same build works on GitHub Pages
  // (https://<user>.github.io/<repo>/) or any subpath — no /admin prefix.
  base: './',
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000'
    }
  }
})
