// Web Worker running Silero VAD v5 for Voice mode (lazy: created when Voice mode first starts). onnxruntime-web's
// wasm-only build, single-threaded (no SharedArrayBuffer, so no COOP/COEP headers needed). Vite emits the .wasm
// and the model as hashed static assets (cached by the browser); the worker is its own chunk, outside the main JS.
//   page → worker: { type: "chunk", id, samples: Float32Array(512) } | { type: "reset" }
//   worker → page: { type: "ready", ms } | { type: "error", message } | { type: "prob", id, p } | { type: "fail", id, message }
import * as ort from "onnxruntime-web/wasm"
import modelURL from "./vad/silero_vad.onnx?url"
import { SileroModel, type Ort } from "./silero-model"

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
ort.env.logLevel = "error"

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null }

const started = performance.now()
const ready: Promise<SileroModel> = (async () => {
  const response = await fetch(modelURL)
  if (!response.ok) throw new Error(`model download failed (${response.status})`)
  return SileroModel.load(ort as unknown as Ort, new Uint8Array(await response.arrayBuffer()))
})()

ready.then(
  () => scope.postMessage({ type: "ready", ms: Math.round(performance.now() - started) }),
  (error) => scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }),
)

/** Chunks run one at a time, in order (the model's state carries from one to the next). */
let chain: Promise<unknown> = Promise.resolve()

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as { type: string; id?: number; samples?: Float32Array }
  chain = chain.then(async () => {
    let model: SileroModel
    try {
      model = await ready
    } catch (error) {
      if (message.type === "chunk") scope.postMessage({ type: "fail", id: message.id, message: String((error as Error)?.message ?? error) })
      return
    }
    if (message.type === "reset") return model.reset()
    if (message.type !== "chunk") return
    try {
      scope.postMessage({ type: "prob", id: message.id, p: await model.probability(message.samples!) })
    } catch (error) {
      scope.postMessage({ type: "fail", id: message.id, message: String((error as Error)?.message ?? error) })
    }
  })
}
