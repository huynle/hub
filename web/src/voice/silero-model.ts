// Silero VAD v5 (MIT, https://github.com/snakers4/silero-vad, bundled as vad/silero_vad.onnx) through
// onnxruntime-web: one 512-sample 16 kHz chunk → speech probability. As in Silero's own wrapper, each chunk is
// fed with the last 64 samples of the previous one in front (576 samples), and the recurrent state is carried
// from chunk to chunk. The ort module is passed in (the worker imports the wasm-only build; tests the Node one).
import { SILERO_FRAME, SILERO_RATE } from "../core/speech-vad"

const CONTEXT = 64

/** What SileroModel needs of onnxruntime-web. */
export interface Ort {
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: readonly number[]) => unknown
  InferenceSession: {
    create(model: Uint8Array | string, options?: Record<string, unknown>): Promise<OrtSession>
  }
}

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>
}

export class SileroModel {
  private state: Float32Array = new Float32Array(2 * 128)
  private context = new Float32Array(CONTEXT)
  private readonly sr: unknown

  private constructor(
    private readonly ort: Ort,
    private readonly session: OrtSession,
  ) {
    this.sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(SILERO_RATE)]), [])
  }

  /** `model`: the .onnx bytes or URL. */
  static async load(ort: Ort, model: Uint8Array | string): Promise<SileroModel> {
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" })
    return new SileroModel(ort, session)
  }

  /** Forgets the audio heard so far (recurrent state and context). */
  reset(): void {
    this.state = new Float32Array(2 * 128)
    this.context = new Float32Array(CONTEXT)
  }

  async probability(chunk: Float32Array): Promise<number> {
    if (chunk.length !== SILERO_FRAME) throw new Error(`Silero VAD needs ${SILERO_FRAME}-sample chunks, got ${chunk.length}`)
    const input = new Float32Array(CONTEXT + SILERO_FRAME)
    input.set(this.context)
    input.set(chunk, CONTEXT)
    this.context = chunk.slice(SILERO_FRAME - CONTEXT)
    const out = await this.session.run({
      input: new this.ort.Tensor("float32", input, [1, input.length]),
      state: new this.ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: this.sr,
    })
    this.state = Float32Array.from(out.stateN!.data as Float32Array)
    return (out.output!.data as Float32Array)[0]!
  }
}
