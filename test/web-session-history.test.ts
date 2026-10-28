import { expect, test } from "bun:test"
import { sessionHistory } from "../web/src/core/session-history"

function browser(path: string) {
  const stack = [{ path, state: {} as any }]
  let index = 0
  return {
    get state() { return stack[index]!.state },
    get path() { return stack[index]!.path },
    replaceState(state: any, _title: string, path: any) { stack[index] = { state, path } },
    pushState(state: any, _title: string, path: any) { stack.splice(++index); stack.push({ state, path }) },
    back() { if (index) index-- },
    get length() { return stack.length },
  }
}

test("native Back from successive main sessions returns All Sessions, not the previous main", () => {
  const h = browser("/s/a")
  sessionHistory(h, "/s/a")
  h.pushState({}, "", "/s/b")
  sessionHistory(h, "/s/b")
  h.back()
  expect(h.path).toBe("/")
})

test("deep-linked nested session backs to root then All Sessions without reinserting history", () => {
  const h = browser("/s/grandchild")
  sessionHistory(h, "/s/grandchild", "root")
  const length = h.length
  sessionHistory(h, "/s/grandchild", "root")
  expect(h.length).toBe(length)
  h.back()
  expect(h.path).toBe("/s/root")
  sessionHistory(h, "/s/root", "root")
  h.back()
  expect(h.path).toBe("/")
})
