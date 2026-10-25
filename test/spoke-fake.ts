// Test helpers: a fake central server (HTTP enrollment + /spoke/ws) and an async event queue. They live in the
// testkit (packages/testkit, @huynle/hub-testkit) as fakeHub; this file keeps the names the hub's tests use.
export {
  EventQueue,
  fakeHub as fakeCentral,
  freePort,
  stopServer,
  until,
  type FakeHub as FakeCentral,
  type FakeHubOptions as FakeCentralOptions,
} from "../packages/testkit/src/index.ts"
