// Activity compaction (tool inputs cut to short summaries, no outputs) is part of the wire format and lives in the
// protocol package; the spoke SDK re-exports it so a spoke needs one import.
export { compactActivity, compactStatus, jobFromInfo, summarizeToolInput } from "../../protocol/src/index.ts"
