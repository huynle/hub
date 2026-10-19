// Vite build of the console (Solid + TypeScript). Output: web/dist, served by the hub (src/central/http.ts)
// and embedded in the compiled binaries (scripts/gen-web-entry.ts). public/ (service worker, manifest, icons,
// VAD worklet) is copied as is, at the site root.
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  root: import.meta.dirname,
  plugins: [solid()],
  // The Silero VAD worker (web/src/voice/silero-worker.ts) is an ES module worker: its own chunk, with
  // onnxruntime-web's .wasm and the .onnx model emitted as hashed assets next to it.
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsDir: "assets",
    sourcemap: false,
  },
  server: {
    // `bun test/web-mock-hub.ts 4311` (or a real hub) behind the dev server.
    proxy: { "/api": process.env.HUB_URL ?? "http://127.0.0.1:4311", "/auth": process.env.HUB_URL ?? "http://127.0.0.1:4311" },
  },
})
