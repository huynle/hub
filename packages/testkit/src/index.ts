// @huynle/hub-testkit: test doubles for hub spokes, harness packages and conformance suites (design §13.3, §16).
// Imports only the protocol, SDK and spoke SDK packages and node builtins, never the hub (src/central) or a spoke.
//   fakeHub          a fake hub: enrollment, /spoke/ws (welcome, recorded frames, next), request() → res
//   connectSpoke /   the client side of a spoke against a real or fake hub: recording WebSocket, next frame,
//   fakeSpoke        respond/fail to server requests; fakeSpoke does hello → welcome → sessions
//   stubModel        one loopback server speaking OpenAI chat completions, Anthropic Messages and OpenAI Responses
//                    (streaming or JSON, text and tool calls), recording requests, scripted by queue()/respond
//   denyProxy        a deny-all HTTP/HTTPS (CONNECT) proxy recording attempted hosts; env() for live harness tests
//   serveDriver /    the harness driver protocol (newline-delimited JSON on stdio) conformance suites use to
//   spawnDriver      control a harness: describe, start, createSession, prompt, local, stop, shutdown
export * from "./fake-hub.ts"
export * from "./fake-spoke.ts"
export * from "./sse.ts"
export * from "./stub-model.ts"
export * from "./deny-proxy.ts"
export * from "./driver.ts"
