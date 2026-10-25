// Pod RPC (decision vkxkqiuf §5): a pod serves pod.<podID>.rpc and forwards spoke/node ops to the connections it
// holds; the calling pod gets the result, or the error mapped back to SpokeError / NodeError / RequestTimeoutError /
// RequestTooLargeError. A pod with no responder is gone (offline); a Bus timeout is a RequestTimeoutError. Close
// notices (revocation, launch end) go to every pod. Memory bus by default; real Valkey with HUB_IT_CLUSTER=1.
import { afterAll, describe, expect, test } from "bun:test"
import { MemoryBus } from "../src/central/backend/memory-bus"
import type { Bus } from "../src/central/backend/types"
import { ValkeyBus } from "../src/central/backend/valkey-bus"
import { LOCAL_ONLY_OPS, PodRpc, RPC_SLACK_MS, rpcTopic, type CloseNotice, type RpcCall } from "../src/central/cluster/rpc"
import { NodeError, RequestTimeoutError, RequestTooLargeError, SpokeError } from "../src/central/spoke-ws"
import { dockerAvailable, ItCluster, itClusterEnabled } from "./cluster-it"

interface Variant {
  readonly name: string
  make(): Promise<{ a: Bus; b: Bus; settle(): Promise<void>; dispose(): void }>
}

const variants: Variant[] = [
  {
    name: "memory",
    async make() {
      const bus = new MemoryBus()
      return { a: bus, b: bus, settle: async () => {}, dispose: () => {} }
    },
  },
]

let cluster: ItCluster | undefined
if (itClusterEnabled() && (await dockerAvailable())) {
  const it = new ItCluster({ log: (line) => console.log(`[cluster-it] ${line}`) })
  cluster = it
  await it.valkey()
  variants.push({
    name: "valkey",
    async make() {
      const url = await it.freshValkey()
      const a = new ValkeyBus(url, { instanceID: "rpc-a" })
      const b = new ValkeyBus(url, { instanceID: "rpc-b" })
      return {
        a,
        b,
        settle: async () => {
          await a.sync()
          await b.sync()
        },
        dispose: () => {
          a.close()
          b.close()
        },
      }
    },
  })
}
afterAll(async () => {
  await cluster?.stop()
})

const spokeCall = (extra: Partial<RpcCall> = {}): RpcCall => ({ kind: "spoke", connID: "conn_1", tenant: "u1", req: { op: "interrupt", sessionID: "ses_1" }, ...extra }) as RpcCall
const nodeCall = (extra: Partial<RpcCall> = {}): RpcCall => ({ kind: "node", connID: "conn_n", tenant: "u1", req: { op: "cancel", launchID: "lch_1" }, ...extra }) as RpcCall

test("the pod's RPC topic, the slack and the ops that never cross the Bus", () => {
  expect(rpcTopic("pod-a")).toBe("pod.pod-a.rpc")
  expect(RPC_SLACK_MS).toBeGreaterThan(0)
  expect([...LOCAL_ONLY_OPS].sort()).toEqual(["actTokens", "sessionTokens"])
})

for (const variant of variants) {
  describe(`PodRpc (${variant.name})`, () => {
    test("a call reaches the owning pod's handler and resolves with its result", async () => {
      const { a, b, dispose } = await variant.make()
      const podA = new PodRpc({ bus: a, podID: "pod-a" })
      const podB = new PodRpc({ bus: b, podID: "pod-b" })
      try {
        const seen: RpcCall[] = []
        await podA.serve(async (call) => {
          seen.push(call)
          return { interrupted: true }
        })
        expect(await podB.call("pod-a", spokeCall(), 1000)).toEqual({ interrupted: true })
        expect(seen).toEqual([spokeCall()])
      } finally {
        await podA.stop()
        await podB.stop()
        dispose()
      }
    })

    test("errors come back as the same classes and messages", async () => {
      const { a, b, dispose } = await variant.make()
      const podA = new PodRpc({ bus: a, podID: "pod-a" })
      const podB = new PodRpc({ bus: b, podID: "pod-b" })
      try {
        const errors: Error[] = [
          new SpokeError("Unknown session"),
          new NodeError("The node sent an invalid prepare result: x"),
          new RequestTimeoutError("turn"),
          new RequestTimeoutError("prepare", "The node"),
          new RequestTooLargeError("prompt"),
        ]
        let next = 0
        await podA.serve(async () => {
          throw errors[next++]
        })
        for (const expected of errors) {
          const call = expected instanceof NodeError || expected.message.includes("node") ? nodeCall() : spokeCall()
          const error = await podB.call("pod-a", call, 1000).then(
            () => undefined,
            (e: Error) => e,
          )
          expect(error).toBeInstanceOf(expected.constructor as new (...args: never[]) => Error)
          expect(error!.name).toBe(expected.name)
          expect(error!.message).toBe(expected.message)
        }
      } finally {
        await podA.stop()
        await podB.stop()
        dispose()
      }
    })

    test("any other error is a SpokeError for spoke ops and a NodeError for node ops", async () => {
      const { a, b, dispose } = await variant.make()
      const podA = new PodRpc({ bus: a, podID: "pod-a" })
      const podB = new PodRpc({ bus: b, podID: "pod-b" })
      try {
        await podA.serve(async () => {
          throw new TypeError("boom")
        })
        const spoke = await podB.call("pod-a", spokeCall(), 1000).catch((e: Error) => e)
        expect(spoke).toBeInstanceOf(SpokeError)
        expect((spoke as Error).message).toBe("boom")
        const node = await podB.call("pod-a", nodeCall(), 1000).catch((e: Error) => e)
        expect(node).toBeInstanceOf(NodeError)
      } finally {
        await podA.stop()
        await podB.stop()
        dispose()
      }
    })

    test("no responder: the pod is gone, the connection offline (onGone is told)", async () => {
      const { b, dispose } = await variant.make()
      const podB = new PodRpc({ bus: b, podID: "pod-b" })
      try {
        let gone = 0
        const spoke = await podB.call("pod-x", spokeCall(), 1000, { onGone: () => void gone++ }).catch((e: Error) => e)
        expect(spoke).toBeInstanceOf(SpokeError)
        expect((spoke as Error).message).toBe("OpenCode process disconnected")
        const node = await podB.call("pod-x", nodeCall(), 1000, { onGone: () => void gone++ }).catch((e: Error) => e)
        expect(node).toBeInstanceOf(NodeError)
        expect((node as Error).message).toBe("The node disconnected")
        expect(gone).toBe(2)
      } finally {
        await podB.stop()
        dispose()
      }
    })

    test("no reply in time: RequestTimeoutError for the op", async () => {
      const { a, b, dispose } = await variant.make()
      const podA = new PodRpc({ bus: a, podID: "pod-a" })
      const podB = new PodRpc({ bus: b, podID: "pod-b" })
      try {
        await podA.serve(() => new Promise(() => {}))
        const spoke = await podB.call("pod-a", spokeCall(), 50).catch((e: Error) => e)
        expect(spoke).toBeInstanceOf(RequestTimeoutError)
        expect((spoke as Error).message).toBe(new RequestTimeoutError("interrupt").message)
        const node = await podB.call("pod-a", nodeCall(), 50).catch((e: Error) => e)
        expect((node as Error).message).toBe(new RequestTimeoutError("cancel", "The node").message)
      } finally {
        await podA.stop()
        await podB.stop()
        dispose()
      }
    })

    test("session-token and act-token ops are refused on both ends", async () => {
      const { a, b, dispose } = await variant.make()
      const podA = new PodRpc({ bus: a, podID: "pod-a" })
      const podB = new PodRpc({ bus: b, podID: "pod-b" })
      try {
        let handled = 0
        await podA.serve(async () => void handled++)
        for (const op of LOCAL_ONLY_OPS) {
          const call = spokeCall({ req: { op, tokens: [] } as never })
          expect(await podB.call("pod-a", call, 1000).catch((e: Error) => e)).toBeInstanceOf(SpokeError)
          // A forged call straight onto the topic is refused by the serving pod too.
          const reply = await b.request(rpcTopic("pod-a"), call, { timeoutMs: 1000 })
          expect(reply).toMatchObject({ ok: false })
        }
        expect(handled).toBe(0)
      } finally {
        await podA.stop()
        await podB.stop()
        dispose()
      }
    })

    test("close notices reach every pod, the sender included", async () => {
      const { a, b, settle, dispose } = await variant.make()
      const podA = new PodRpc({ bus: a, podID: "pod-a" })
      const podB = new PodRpc({ bus: b, podID: "pod-b" })
      try {
        const atA: CloseNotice[] = []
        const atB: CloseNotice[] = []
        await podA.onClose((notice) => void atA.push(notice))
        await podB.onClose((notice) => void atB.push(notice))
        await podB.publishClose({ kind: "machine", id: "mch_1", reason: "revoked" })
        await settle()
        expect(atA).toEqual([{ kind: "machine", id: "mch_1", reason: "revoked", from: "pod-b" }])
        expect(atB).toEqual(atA)
      } finally {
        await podA.stop()
        await podB.stop()
        dispose()
      }
    })
  })
}
