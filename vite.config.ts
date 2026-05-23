import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
  root: './src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
