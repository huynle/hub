#!/usr/bin/env bun
// The reference driver: the fake harness (reference-spoke.ts) behind the harness driver protocol (testkit), as a
// harness package's driver would be. `--fault=<check>` starts a spoke that breaks exactly that check; `--minimal` one
// that serves neither permission nor deliver; `--fail-start` refuses to start.
//
//   bun packages/conformance/fixtures/driver.ts [--fault=<check>] [--minimal] [--fail-start]
//   hub-conformance spoke --driver "bun packages/conformance/fixtures/driver.ts"
//
// Besides the protocol's methods it serves `permissionToolCall`: the tool call (as the stub model returns it) that
// makes the harness ask permission, so the suite can check permission replies.
import { DRIVER_PROTOCOL_VERSION, DriverError, serveDriver, type DriverStart } from "../../testkit/src/index.ts"
import { FAULTS, FakeHarness, PERMISSION_TOOL_CALL, REFERENCE_HARNESS, REFERENCE_VERSION, referenceFeatures, type Fault } from "./reference-spoke.ts"

const argv = process.argv.slice(2)
const minimal = argv.includes("--minimal")
const failStart = argv.includes("--fail-start")
const arg = argv.find((a) => a.startsWith("--fault="))
const fault = arg?.slice("--fault=".length) as Fault | undefined
if (fault !== undefined && !FAULTS.includes(fault)) {
  process.stderr.write(`unknown fault ${JSON.stringify(fault)} (one of ${FAULTS.join(", ")})\n`)
  process.exit(2)
}

const log = (line: string) => process.stderr.write(`${line}\n`)
let harness: FakeHarness | undefined
const running = () => {
  if (!harness) throw new DriverError("not_started", "call start first")
  return harness
}

process.stdout.write("conformance fake harness driver ready\n")
serveDriver({
  describe: () => ({
    protocol: DRIVER_PROTOCOL_VERSION,
    harness: REFERENCE_HARNESS,
    harnessVersion: REFERENCE_VERSION,
    evidence: "hooks",
    features: [...referenceFeatures(minimal)],
    models: ["chat"],
  }),
  start(params: DriverStart) {
    if (failStart) throw new DriverError("failed", "refusing to start (--fail-start)")
    if (harness) throw new DriverError("started", "already started")
    if (params.model.format !== "chat") throw new DriverError("unsupported", `model format ${params.model.format}`)
    harness = new FakeHarness({ hubURL: params.hubURL, token: params.token, directory: params.directory, modelBaseURL: params.model.baseURL, minimal, ...(fault ? { fault } : {}), log })
    harness.start()
    return {}
  },
  createSession: (params) => ({ sessionID: running().createSession(params?.directory) }),
  prompt: (params) => (running().prompt(params.sessionID, params.text), {}),
  local: (params) => (running().local(params.sessionID, params.action), {}),
  permissionToolCall: () => PERMISSION_TOOL_CALL,
  stop: () => (harness?.stop(), {}),
  shutdown: () => harness?.stop(),
})
