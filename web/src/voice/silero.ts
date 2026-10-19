// The page side of the Silero worker (silero-worker.ts): loads it once, when Voice mode first starts, and keeps
// it for later starts (the model and wasm stay compiled). A load that fails or times out is retried next time.
const LOAD_TIMEOUT_MS = 30_000

export interface Silero {
  /** 512 samples at 16 kHz → speech probability. */
  classify(chunk: Float32Array): Promise<number>
  /** Forgets the audio heard so far (a new conversation). */
  reset(): void
}

let loading: Promise<Silero> | undefined

export function loadSilero(): Promise<Silero> {
  loading ??= start().catch((error) => {
    loading = undefined
    throw error
  })
  return loading
}

function start(): Promise<Silero> {
  return new Promise<Silero>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL("./silero-worker.ts", import.meta.url), { type: "module", name: "silero-vad" })
    } catch (error) {
      return reject(error)
    }
    const pending = new Map<number, { resolve: (p: number) => void; reject: (e: Error) => void }>()
    let nextID = 1
    let ready = false
    const fail = (error: Error) => {
      for (const p of pending.values()) p.reject(error)
      pending.clear()
      worker.terminate()
      loading = undefined
      if (!ready) reject(error)
    }
    const timer = setTimeout(() => fail(new Error("the speech model took too long to load")), LOAD_TIMEOUT_MS)
    worker.onerror = (event) => {
      event.preventDefault()
      clearTimeout(timer)
      fail(new Error(event.message || "the speech detection worker failed"))
    }
    worker.onmessage = (event: MessageEvent) => {
      const m = event.data as { type: string; id?: number; p?: number; message?: string }
      if (m.type === "ready") {
        clearTimeout(timer)
        ready = true
        resolve({
          classify(chunk) {
            return new Promise<number>((resolve, reject) => {
              const id = nextID++
              pending.set(id, { resolve, reject })
              worker.postMessage({ type: "chunk", id, samples: chunk })
            })
          },
          reset() {
            worker.postMessage({ type: "reset" })
          },
        })
      } else if (m.type === "error") {
        clearTimeout(timer)
        fail(new Error(m.message || "the speech model could not load"))
      } else if (m.type === "prob" || m.type === "fail") {
        const p = pending.get(m.id!)
        pending.delete(m.id!)
        if (m.type === "prob") p?.resolve(m.p!)
        else p?.reject(new Error(m.message || "speech detection failed"))
      }
    }
  })
}
