// Check "frames" (the passive part): every frame the spoke sent fits MAX_FRAME (the hub drops a connection on a larger
// one). The runner adds the active part: an oversize frame from the hub is ignored, and the spoke keeps serving.
import { MAX_FRAME } from "../../protocol/src/index.ts"

export interface FrameSize {
  readonly size: number
  /** The frame's `t`, when it parsed far enough to tell. */
  readonly t?: string
}

export function frameProblems(frames: readonly FrameSize[]): string[] {
  return frames
    .filter((f) => f.size > MAX_FRAME)
    .map((f) => `the spoke sent an oversize ${f.t ? `${f.t} ` : ""}frame of ${f.size} characters (limit ${MAX_FRAME})`)
}
