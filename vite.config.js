import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'
import { scanThreads } from './server/scan.mjs'
import { startHiveSync } from './server/lib/hive-git.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
    startHiveSync(scanThreads)
  },
})

export default defineConfig({
  plugins: [api()],
  // PORT lets a second copy run alongside the first without a flag on the command line.
  server: { port: Number(process.env.PORT) || 5274, strictPort: false },
  build: {
    target: 'esnext',
    // Tower City is a second, separate page (see src/towers/main.js) — listed explicitly so
    // `npm run build` bundles it too, not just the original index.html.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        towerCity: fileURLToPath(new URL('./tower-city.html', import.meta.url)),
      },
    },
  },
})
