// @huynle/hub-conformance: the spoke conformance suite (design §13.3, §16). Imports only the protocol and testkit
// packages and node builtins, never the hub (src/central), a spoke or the spoke SDK (fixtures may use the SDK).
//
//   hub-conformance spoke --driver "<command>" [--json] [--out <file>] [--retry-after-ms <n>]
//   runConformance({ driver: ["bun", "driver.ts"], timeouts?, retryAfterMs?, reconnectGraceMs?, log? }) → report
//
// The runner spawns the driver (testkit driver protocol v1, stdio JSON lines), starts a recording hub, a stub model
// and a deny-all proxy, and calls: describe → start({hubURL, token, directory, env, model}) → createSession →
// prompt … → stop → shutdown. A driver must:
//   - describe: harness, harnessVersion, evidence and features exactly as the spoke's hello announces them, and the
//     stub model formats the harness speaks (the first is used);
//   - start: start the harness and its spoke against hubURL with the machine token, the stub model (format and base
//     URL) and env (HTTP(S)_PROXY to the deny-all proxy, an isolated HOME); return once it is starting;
//   - createSession: open a session as the local user would and return its hub session ID (the spoke reports it);
//   - prompt: type a prompt as the local user; return at once (the turn runs on);
//   - permissionToolCall (optional, needed for the permission check): the tool call {name, input} that makes the
//     harness ask permission; the runner queues it on the stub model before prompting.
// Then the checks (CHECK_IDS): hello, features, events, deliver.idempotent, deliver.modes, permission, tokens,
// reconnect, frames. A check the spoke's features do not reach is skipped with a reason; report.ok (and exit 0)
// when none failed. fixtures/driver.ts is the reference driver (passes everything); --fault=<check> breaks one.
export * from "./runner.ts"
export * from "./report.ts"
export * from "./args.ts"
