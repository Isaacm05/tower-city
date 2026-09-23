import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'
import { scanThreads } from './server/scan.mjs'
import { startHiveSync } from './server/lib/hive-git.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'tower-city-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
    startHiveSync(scanThreads)
  },
})

export default defineConfig({
  plugins: [api()],
  // 5275, not Bot Crossing's own 5274 — the two repos are unrelated now, but still commonly
  // checked out side by side on the same machine, and strictPort:false silently falling back
  // to a random free port when 5274 is taken (which it often is, if Bot Crossing's own
  // always-on server happens to be running) is exactly what made "just go to 5274" wrong
  // advice once already. PORT still overrides this for anyone who wants a specific port.
  server: { port: Number(process.env.PORT) || 5275, strictPort: false },
  build: {
    target: 'esnext',
  },
})
