#!/usr/bin/env bun
// Headless smoke test of the built console against the mock hub (test/web-mock-hub.ts), at desktop (1440×900) and
// phone (390×844) sizes: home loads, a session opens with its timeline, Send → Steer/Stop → Send, image attachments
// (attach, remove, attach again, send), the right rail and diff viewer render, and a Voice-off session is inspectable. Screenshots go to $SMOKE_SHOTS (default: the OS temp
// dir). Run `npm run build:web && npm run test:e2e`. Chromium: $CHROMIUM_PATH, else Playwright's cache, else PATH.
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"

const ROOT = path.join(import.meta.dir, "..", "..")
const SHOTS = process.env.SMOKE_SHOTS ?? path.join(tmpdir(), "opencode-hub-smoke")
const PORT = Number(process.env.SMOKE_PORT ?? 4399)
const BASE = `http://127.0.0.1:${PORT}`

function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  try {
    const p = chromium.executablePath()
    if (p && existsSync(p)) return p
  } catch {}
  const cache = path.join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright")
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-linux64/chrome",
        "chrome-linux/chrome",
      ]) {
        const file = path.join(cache, dir, rel)
        if (existsSync(file)) return file
      }
    }
  }
  for (const file of ["/opt/homebrew/bin/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) if (existsSync(file)) return file
  return undefined
}

let failures = 0
const results: string[] = []
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
    results.push(`✓ ${name}`)
  } catch (e) {
    failures++
    results.push(`✗ ${name}: ${(e as Error).message.split("\n")[0]}`)
  }
}
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
const mock = (route: string, body: unknown = {}) => fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

async function desktop(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))

  await check("desktop: home table loads with sessions, sortable and filterable", async () => {
    await page.goto(`${BASE}/`)
    await page.getByRole("heading", { name: "All sessions" }).waitFor()
    await page.locator(".sessions-table tbody tr").nth(5).waitFor()
    const rows = await page.locator(".sessions-table tbody tr").count()
    assert(rows > 20, `expected many rows, got ${rows}`)
    await page.getByRole("button", { name: "Needs you" }).first().click()
    const needs = await page.locator(".sessions-table tbody tr").count()
    assert(needs > 0 && needs < rows, `Needs you filter: ${needs} of ${rows}`)
    await page.getByRole("button", { name: "Needs you" }).first().click()
    await page.getByRole("button", { name: /^Title/ }).click()
    assert((await page.locator('th[aria-sort="ascending"]').count()) === 1, "title sort applied")
    assert(await page.locator(".sidebar .side-section").first().isVisible(), "sidebar sections")
    await shot(page, "desktop-home")
  })

  await check("desktop: open a session; timeline, thoughts, tool group and rail render", async () => {
    await page.locator(".sidebar").getByRole("link", { name: /Mock session/ }).first().click()
    await page.waitForURL(/\/s\/ses_mock$/)
    await page.locator(".msg.user .pill").first().waitFor()
    await page.getByRole("button", { name: /Thought for 12s/ }).waitFor()
    await page.getByRole("button", { name: /Used 3 tools \(1 failed\)/ }).click()
    await page.locator(".tool-head").nth(1).click()
    await page.locator(".tool-detail pre").waitFor()
    assert((await page.locator(".tool-detail pre").textContent())?.includes("1 test failed"), "lazy tool detail")
    await page.locator(".rail").getByText("31%").waitFor()
    await page.locator(".rail").getByText("feature/remote-session-console").waitFor()
    assert(await page.locator(".rail .mcp-list li").count() === 3, "MCP list")
    assert(await page.locator(".rail .file-list li").count() === 3, "changed files listed")
    await page.locator(".rail").getByText("+2 more files").waitFor()
    await shot(page, "desktop-session")
  })

  await check("desktop: thoughts expand — stored text, encrypted-only reasoning, live streamed reasoning", async () => {
    await page.getByRole("button", { name: /Thought for 12s/ }).click()
    await page.locator(".fold-body.reasoning").getByText(/The failing test is in the picker/).waitFor()
    const hidden = page.getByRole("button", { name: /Thought for 2s/ })
    assert(await hidden.isEnabled(), "a thought without text is still clickable")
    await hidden.click()
    await page.locator(".fold-body.reasoning.hidden-reasoning").getByText(/didn't share its reasoning text/).waitFor()
    await mock("/mock/stream", { kind: "reasoning", messageID: "msg_live_r", text: "Streaming my live reasoning now.", every: 30, size: 8 })
    const live = page.getByRole("button", { name: /Thinking…/ })
    await live.waitFor()
    await live.click()
    await page.locator(".fold-body.reasoning").getByText("Streaming my live reasoning now.").waitFor()
    await mock("/mock/status", { sessions: [{ id: "ses_mock", title: "Mock session", state: "idle", blockers: [] }] })
    await page.getByRole("button", { name: /^Thought for \ds$/ }).last().waitFor()
    assert((await page.locator(".fold-body.reasoning").last().textContent())?.includes("Streaming my live reasoning now."), "finished live thought keeps its text")
    await shot(page, "desktop-thoughts")
  })

  await check("desktop: composer Send → Steer + Stop while running → Send", async () => {
    const send = page.locator("button.send")
    assert(await send.isDisabled(), "Send disabled while empty")
    await page.getByLabel("Message").fill("run the tests")
    assert(await send.isEnabled(), "Send enabled with text")
    assert((await send.textContent())?.includes("Send"), "primary is Send")
    await send.click()
    await page.locator("button.send.steer").waitFor({ timeout: 5000 })
    await page.getByRole("button", { name: "Stop the session and its subagents" }).waitFor()
    await page.getByLabel("Message").fill("also run the linter")
    await shot(page, "desktop-running-steer-stop")
    await page.locator("button.send.steer").click()
    await page.getByText("Steered the running session").waitFor()
    assert((await page.getByLabel("Message").inputValue()) === "", "draft cleared after steer")
    await page.getByRole("button", { name: "Stop the session and its subagents" }).click()
    await page.getByText(/Stopped 1 session/).waitFor()
    await page.locator("button.send.send").waitFor()
    assert((await page.locator("button.send").textContent())?.includes("Send"), "back to Send after stop")
  })

  await check("desktop: rejected submit keeps the draft", async () => {
    await page.getByLabel("Message").fill("this will fail")
    await page.locator("button.send").click()
    await page.locator(".composer-error").waitFor()
    assert((await page.getByLabel("Message").inputValue()) === "this will fail", "draft restored")
    await page.getByLabel("Message").fill("")
  })

  await check("desktop: attach an image, remove it, attach again and send it", async () => {
    // History: the first user message's image loads lazily from the hub.
    const history = page.locator(".msg.user .msg-image img").first()
    await history.waitFor()
    await page.waitForFunction(() => (document.querySelector(".msg.user .msg-image img") as HTMLImageElement | null)?.naturalWidth === 1)
    assert((await history.getAttribute("src"))?.includes("/timeline/messages/") && (await history.getAttribute("src"))?.endsWith("/files/0"), "history image URL")
    // A 1200×900 PNG drawn in the page (opaque, so it is re-encoded as JPEG).
    const dataURL = await page.evaluate(() => {
      const c = document.createElement("canvas")
      c.width = 1200
      c.height = 900
      const ctx = c.getContext("2d")!
      const g = ctx.createLinearGradient(0, 0, 1200, 900)
      g.addColorStop(0, "#fab283")
      g.addColorStop(1, "#3a6ea5")
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 1200, 900)
      ctx.fillStyle = "#fff"
      ctx.font = "120px sans-serif"
      ctx.fillText("smoke", 200, 500)
      return c.toDataURL("image/png")
    })
    const file = { name: "smoke.png", mimeType: "image/png", buffer: Buffer.from(dataURL.slice(dataURL.indexOf(",") + 1), "base64") }
    const input = page.getByTestId("attach-input")
    const send = page.locator("button.send")
    assert(await page.getByRole("button", { name: "Attach images" }).isEnabled(), "+ is enabled")
    await input.setInputFiles(file)
    await page.locator(".attachments .attachment img").waitFor()
    assert(await send.isEnabled(), "Send enabled with only an image")
    await shot(page, "desktop-attachment")
    await page.getByRole("button", { name: "Remove smoke.jpg" }).click()
    await page.locator(".attachments").waitFor({ state: "detached" })
    assert(await send.isDisabled(), "Send disabled again after removing the image")
    await input.setInputFiles(file)
    await page.locator(".attachments .attachment img").waitFor()
    await page.getByLabel("Message").fill("what is in this image?")
    await send.click()
    await page.locator(".attachments").waitFor({ state: "detached" })
    await page.locator(".msg.user .msg-image img[src^='blob:']").waitFor()
    const { log } = (await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ method: string; path: string; body?: any }> }
    const turn = log.filter((e) => e.method === "POST" && e.path.endsWith("/turn")).at(-1)
    assert(turn?.body?.text === "what is in this image?", `turn text: ${JSON.stringify(turn?.body?.text)}`)
    const images = turn?.body?.images as Array<{ mime: string; name: string; length: number }> | undefined
    assert(images?.length === 1, `one image sent, got ${images?.length}`)
    assert(images[0]!.mime === "image/jpeg" && images[0]!.name === "smoke.jpg", `re-encoded as JPEG: ${JSON.stringify(images[0])}`)
    assert(images[0]!.length > 0 && images[0]!.length <= 180_000, `within the per-image budget: ${images[0]!.length}`)
    await shot(page, "desktop-image-sent")
    await page.locator("button.send.send").waitFor({ timeout: 10_000 })
    await page.getByText("Done: what is in this image?").first().waitFor({ timeout: 10_000 })
  })

  await check("desktop: diff viewer opens over the transcript", async () => {
    await page.locator(".rail .file").first().click()
    await page.locator(".diff-panel table.diff tr.add").first().waitFor()
    await shot(page, "desktop-diff")
    await page.getByRole("button", { name: "Close diff" }).click()
  })

  await check("desktop: model menus handle a big catalog; pick a Voice model and a Worker model + variant", async () => {
    const lastPut = async () => {
      const { log } = (await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ method: string; path: string; body?: any }> }
      return log.filter((e) => e.method === "PUT" && e.path.endsWith("/model-prefs")).at(-1)?.body
    }
    const chips = page.locator(".composer-meta .model-chip")
    await chips.nth(0).getByText("Voice: claude-haiku-4-5").waitFor()
    // Voice: search the big list, a typed digit stays in the search box, Enter picks the highlighted model.
    await chips.nth(0).click()
    const dialog = page.locator("dialog.picker[open]")
    await dialog.locator(".picker-opt").first().waitFor()
    assert((await dialog.locator(".picker-opt kbd").first().textContent()) === "1", "number key hint")
    const status = (await dialog.getByRole("status").textContent()) ?? ""
    assert(/^2\d\d models · showing 100/.test(status), `big catalog bounded: ${status}`)
    await dialog.getByRole("searchbox").fill("")
    await dialog.getByRole("searchbox").press("5")
    assert((await dialog.getByRole("searchbox").inputValue()) === "5", "a digit typed in the search box is text")
    await dialog.getByRole("searchbox").fill("haiku 5")
    await dialog.locator(".picker-opt").first().waitFor()
    assert((await dialog.locator(".picker-opt").count()) === 1, "one match for 'haiku 5'")
    await dialog.getByRole("searchbox").press("Enter")
    await dialog.waitFor({ state: "hidden" })
    assert(JSON.stringify(await lastPut()) === JSON.stringify({ voice: { providerID: "omniroute", modelID: "claude-haiku-5-5" } }), `voice PUT body: ${JSON.stringify(await lastPut())}`)
    await chips.nth(0).getByText("Voice: claude-haiku-5-5").waitFor()
    // Worker: a model with variants → variant step (Back works) → pick "high".
    await chips.nth(1).click()
    await dialog.getByRole("searchbox").fill("gpt-6")
    await dialog.locator(".picker-opt").getByText("GPT-6 Sol").click()
    await dialog.getByText("Variant of GPT-6 Sol").waitFor()
    await shot(page, "desktop-model-variants")
    await dialog.getByRole("button", { name: "Back to models" }).click()
    await dialog.getByRole("searchbox").waitFor()
    await dialog.getByRole("searchbox").fill("gpt-6")
    await dialog.locator(".picker-opt").getByText("GPT-6 Sol").click()
    await dialog.getByRole("option", { name: /^high/ }).click()
    await dialog.waitFor({ state: "hidden" })
    assert(JSON.stringify(await lastPut()) === JSON.stringify({ worker: { providerID: "omniroute", modelID: "gpt-6-sol", variant: "high" } }), `worker PUT body: ${JSON.stringify(await lastPut())}`)
    await chips.nth(1).getByText("Worker: gpt-6-sol · high").waitFor()
    // The current model is marked when the menu opens again.
    await chips.nth(1).click()
    await dialog.getByRole("searchbox").fill("gpt-6")
    assert((await dialog.locator('.picker-opt[aria-selected="true"]').textContent())?.includes("GPT-6 Sol"), "current model marked")
    await dialog.getByRole("button", { name: "Close" }).click()
    await dialog.waitFor({ state: "hidden" })
    // A failed save is reported and the label stays.
    await mock("/mock/fail", { modelPrefs: true })
    await chips.nth(0).click()
    await dialog.getByRole("searchbox").fill("kimi")
    await dialog.locator(".picker-opt").first().click()
    await page.getByText(/Couldn't set the Voice model/).waitFor()
    await chips.nth(0).getByText("Voice: claude-haiku-5-5").waitFor()
    await mock("/mock/fail", { modelPrefs: false })
    await shot(page, "desktop-model-picker")
  })

  await check("desktop: a Voice-off session is inspectable and controllable", async () => {
    await page.goto(`${BASE}/s/ses_10`)
    await page.locator(".msg.assistant").first().waitFor()
    assert(await page.getByLabel("Message").isEnabled(), "composer enabled with Voice off")
    assert((await page.locator(".composer-meta").textContent())?.includes("Voice off"), "meta shows Voice off")
    await page.getByLabel("Message").fill("hello")
    await page.locator("button.send").click()
    await page.getByText("You said: hello").waitFor()
    await shot(page, "desktop-voice-off-session")
  })

  await check("desktop: Voice mode on a Voice-off session turns Voice on first, then shows the Voice bar", async () => {
    await page.goto(`${BASE}/s/ses_10`)
    await page.locator(".msg.assistant").first().waitFor()
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator(".voice-bar").waitFor({ timeout: 10_000 })
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor()
    await page.locator(".composer-meta").getByText(/Voice on/).waitFor()
    // Notifications are not allowed in this browser: the Voice bar offers them for the ongoing notification.
    await page.locator(".voice-bar .voice-hint").getByRole("button", { name: "Allow notifications" }).waitFor()
    await shot(page, "desktop-voice-bar")
    await page.getByRole("button", { name: "Mute" }).click()
    await page.locator(".voice-bar .voice-state").getByText("Muted").waitFor()
    await page.locator(".voice-bar").getByRole("button", { name: "End", exact: true }).click()
    await page.locator(".voice-bar").waitFor({ state: "detached" })
  })

  await check("desktop: Voice mode is a toggle, one session at a time, with an indicator while viewing another session", async () => {
    const go = (href: string) =>
      page.evaluate((h) => {
        const a = document.createElement("a")
        a.href = h
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, href)
    const convoPosts = async () =>
      ((await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ method: string; path: string; body?: any }> }).log
        .filter((e) => e.method === "POST" && e.path.endsWith("/conversation"))
        .map((e) => `${decodeURIComponent(e.path.split("/")[3]!)}:${e.body?.on}`)
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    const button = page.locator(".split-main")
    // Toggle on, then off, in A.
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator(".voice-bar").waitFor()
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor()
    assert((await button.getAttribute("aria-pressed")) === "true", "pressed while on")
    assert(await page.locator(".split.on").isVisible(), "active style while on")
    await page.getByRole("button", { name: "End Voice mode" }).click()
    await page.locator(".voice-bar").waitFor({ state: "detached" })
    assert((await button.getAttribute("aria-pressed")) === "false", "not pressed when off")
    await page.waitForFunction(async () => {
      const log = await (await fetch("/mock/log")).json()
      return log.log.filter((e: any) => e.path.endsWith("/conversation")).at(-1)?.body?.on === false
    })
    // On in A; going to B keeps it on, with an indicator (top bar pill, sidebar row).
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor()
    const before = (await convoPosts()).length
    await go("/s/ses_10")
    await page.waitForURL(/\/s\/ses_10$/)
    await page.locator(".topbar .voice-pill").getByText("Mock session").waitFor()
    assert((await page.locator(".voice-bar").count()) === 0, "no Voice bar in B")
    assert(await page.locator(".sidebar .side-row.voice-here").first().isVisible(), "sidebar marks A")
    assert((await convoPosts()).length === before, "navigating does not turn Voice mode off")
    await shot(page, "desktop-voice-elsewhere")
    // Turning it on in B turns A off first, then B on.
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor()
    const posts = (await convoPosts()).slice(before)
    assert(JSON.stringify(posts) === JSON.stringify(["ses_mock:false", "ses_10:true"]), `A off, then B on: ${posts.join(", ")}`)
    assert((await page.locator(".topbar .voice-pill").count()) === 0, "no pill in the session in Voice mode")
    // From A, the pill shows B; its End turns B off.
    await go("/s/ses_mock")
    await page.locator(".topbar .voice-pill").getByText("PWA icons").waitFor()
    await page.locator(".topbar .voice-pill").getByRole("button", { name: "End Voice mode" }).click()
    await page.locator(".topbar .voice-pill").waitFor({ state: "detached" })
    assert((await convoPosts()).at(-1) === "ses_10:false", "pill End turns B off")
    // On in A, then turning it on in a Voice-off session C fails: A is off and C shows the error.
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor()
    await mock("/mock/fail", { expose: true })
    await go("/s/ses_15")
    await page.waitForURL(/\/s\/ses_15$/)
    await page.locator(".topbar .voice-pill").waitFor()
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator(".voice-error").getByText(/Could not turn Voice on/).waitFor()
    assert((await page.locator(".voice-pill").count()) === 0, "A is off")
    assert((await convoPosts()).at(-1) === "ses_mock:false", "A was turned off")
    await mock("/mock/fail", { expose: false })
  })

  await check("desktop: /s/<id>?voice=1 (from /voice) starts Voice mode and drops the param", async () => {
    await page.goto(`${BASE}/s/ses_10?voice=1`)
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor({ timeout: 10_000 })
    assert(!page.url().includes("voice=1"), `param removed: ${page.url()}`)
    const { log } = (await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ method: string; path: string; body?: any }> }
    const last = log.filter((e) => e.method === "POST" && e.path.endsWith("/conversation")).at(-1)
    assert(last?.path.includes("ses_10") && last.body?.on === true, `conversation on for ses_10: ${JSON.stringify(last)}`)
    await page.locator(".voice-bar").getByRole("button", { name: "End", exact: true }).click()
    await page.locator(".voice-bar").waitFor({ state: "detached" })
  })

  await check("desktop: Dictate fills the draft of the session on screen; each session keeps its own draft; leaving mid-recording cancels", async () => {
    const go = (href: string) =>
      page.evaluate((h) => {
        const a = document.createElement("a")
        a.href = h
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, href)
    const transcribes = async () => ((await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ method: string; path: string }> }).log.filter((e) => e.path === "/api/transcribe").length
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    await page.getByLabel("Message").fill("")
    await mock("/mock/transcripts", { texts: ["dictated into A"] })
    await page.getByRole("button", { name: "Dictate" }).click()
    await page.getByRole("button", { name: "Stop dictation" }).waitFor()
    await page.waitForTimeout(800)
    await page.getByRole("button", { name: "Stop dictation" }).click()
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement | null)?.value === "dictated into A")
    const { log } = (await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ method: string; path: string }> }
    assert(!log.slice(-5).some((e) => e.path.endsWith("/turn") || e.path.endsWith("/utterance")), "dictation never sends")
    // Session B: its own (empty) draft.
    await go("/s/ses_10")
    await page.waitForURL(/\/s\/ses_10$/)
    await page.locator(".msg.assistant").first().waitFor()
    assert((await page.getByLabel("Message").inputValue()) === "", "B's draft is untouched")
    await page.getByLabel("Message").fill("draft of B")
    // Back to A: A's dictated draft is still there.
    await go("/s/ses_mock")
    await page.waitForURL(/\/s\/ses_mock$/)
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement | null)?.value === "dictated into A")
    // Start in A, leave for B mid-recording: cancelled, nothing transcribed, B's draft unchanged.
    const before = await transcribes()
    await mock("/mock/transcripts", { texts: ["must not land anywhere"] })
    await page.getByRole("button", { name: "Dictate" }).click()
    await page.getByRole("button", { name: "Stop dictation" }).waitFor()
    await go("/s/ses_10")
    await page.getByText(/Dictation cancelled/).waitFor()
    await page.waitForTimeout(600)
    assert((await page.getByLabel("Message").inputValue()) === "draft of B", "B's draft unchanged after the cancelled dictation")
    assert(await page.getByRole("button", { name: "Dictate" }).isVisible(), "B's mic button is idle")
    assert((await transcribes()) === before, "the cancelled recording was not transcribed")
    await go("/s/ses_mock")
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement | null)?.value === "dictated into A")
    await mock("/mock/reset-transcripts")
    await page.getByLabel("Message").fill("")
    await go("/s/ses_10")
    await page.getByLabel("Message").fill("")
  })

  await check("desktop: mic picker lists microphones with a level meter", async () => {
    await page.getByRole("button", { name: "Choose microphone" }).click()
    await page.locator(".mic-picker .level").waitFor()
    assert((await page.locator(".mic-picker .menu-item").count()) >= 1, "at least the default microphone")
    await shot(page, "desktop-mic-picker")
    await page.keyboard.press("Escape")
  })

  await check("desktop: settings and new session routes render", async () => {
    await page.goto(`${BASE}/settings`)
    await page.getByRole("heading", { name: "Speech" }).waitFor()
    await page.locator("#machines .list li").first().waitFor()
    await shot(page, "desktop-settings")
    await page.goto(`${BASE}/new`)
    await page.getByPlaceholder("Describe a task or ask a question").waitFor()
  })

  await check("desktop: /new picks an environment and a folder, creates there and sends the prompt as the first turn", async () => {
    await mock("/mock/workstation", { on: true })
    await page.evaluate(() => localStorage.removeItem("hub.newSession"))
    await page.goto(`${BASE}/new`)
    const envChip = page.getByRole("button", { name: "Choose environment" })
    await envChip.getByText("laptop").waitFor()
    await envChip.click()
    const menu = page.locator(".menu[role=menu]")
    await menu.getByText("Choose environment").waitFor()
    assert((await menu.getByRole("menuitemradio", { name: /laptop/ }).getAttribute("aria-checked")) === "true", "laptop checked")
    assert(await menu.getByRole("menuitemradio", { name: /desktop/ }).isDisabled(), "offline desktop disabled")
    assert((await menu.getByRole("menuitemradio", { name: /desktop/ }).textContent())?.includes("offline"), "offline label")
    assert((await menu.getByRole("menuitemradio", { name: /workstation/ }).textContent())?.includes("OpenCode 2.0.25"), "version shown")
    await shot(page, "desktop-new-environments")
    await menu.getByRole("menuitemradio", { name: /workstation/ }).click()
    await envChip.getByText("workstation").waitFor()
    // Folder: search and pick.
    await page.getByRole("button", { name: "Choose project folder" }).click()
    const folders = page.locator(".folder-menu")
    await folders.getByRole("searchbox").fill("ml")
    await folders.getByRole("option", { name: /ml-lab/ }).click()
    await page.getByRole("button", { name: "Choose project folder" }).getByText("ml-lab").waitFor()
    await page.getByPlaceholder("Describe a task or ask a question").fill("Plot the loss curves\nand explain the spike")
    await shot(page, "desktop-new-composer")
    await page.getByRole("button", { name: "Start session" }).click()
    await page.waitForURL(/\/s\/ses_new_\d+$/)
    const sessionID = decodeURIComponent(page.url().split("/s/")[1]!)
    await page.waitForFunction(async (id) => {
      const log = await (await fetch("/mock/log")).json()
      return log.log.some((e: any) => e.method === "POST" && e.path === `/api/sessions/${id}/turn`)
    }, sessionID)
    const { log } = (await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ method: string; path: string; body?: any }> }
    const create = log.filter((e) => e.method === "POST" && /\/api\/machines\/[^/]+\/sessions$/.test(e.path)).at(-1)
    assert(create?.path === "/api/machines/mac_5/sessions", `created on the workstation: ${create?.path}`)
    assert(create?.body?.directory === "/home/user/work/ml-lab", `in ml-lab: ${JSON.stringify(create?.body)}`)
    const turn = log.find((e) => e.method === "POST" && e.path === `/api/sessions/${sessionID}/turn`)
    assert(turn?.body?.text === "Plot the loss curves\nand explain the spike", `first turn text: ${JSON.stringify(turn?.body)}`)
    await page.locator(".msg.user").getByText("Plot the loss curves").waitFor()
    // Remembered for next time.
    await page.goto(`${BASE}/new`)
    await page.getByRole("button", { name: "Choose environment" }).getByText("workstation").waitFor()
    await page.getByRole("button", { name: "Choose project folder" }).getByText("ml-lab").waitFor()
    await mock("/mock/workstation", { on: false })
  })

  await check("desktop: the rail's Environment card shows machine, project and branch, and collapses (remembered)", async () => {
    await page.goto(`${BASE}/s/ses_mock`)
    const card = page.locator('.rail [data-card="environment"]')
    await card.getByText("laptop").waitFor()
    await card.getByText("feature/remote-session-console").waitFor()
    assert((await card.locator("dd[title]").first().getAttribute("title"))?.endsWith("/opencode-voice"), "full path in tooltip")
    await page.locator('.rail [data-card="mcp"]').getByText(/Connectors · 1 connected/).waitFor()
    const toggle = card.getByRole("button", { name: "Environment" })
    assert((await toggle.getAttribute("aria-expanded")) === "true", "open by default")
    await toggle.click()
    assert((await toggle.getAttribute("aria-expanded")) === "false", "collapsed")
    assert((await card.locator("dl").count()) === 0, "content hidden")
    await page.reload()
    await page.locator('.rail [data-card="environment"] button[aria-expanded="false"]').waitFor()
    await page.locator('.rail [data-card="environment"]').getByRole("button", { name: "Environment" }).click()
    await page.locator('.rail [data-card="environment"]').getByText("laptop").waitFor()
  })

  await check("desktop: speech model pickers filter a big gateway list by provider and name; the pick is saved", async () => {
    await page.goto(`${BASE}/settings`)
    await page.locator("#sp-stt-model").first().waitFor()
    await page.locator("#sp-stt-model").first().locator("..").getByRole("button", { name: "Browse…" }).click()
    const dialog = page.locator("dialog.picker[open]")
    await dialog.locator(".picker-opt").nth(3).waitFor()
    const all = await dialog.locator(".picker-opt").count()
    assert(all > 3 && all < 20, `speech-to-text models only, got ${all}`)
    await dialog.getByRole("searchbox").fill("WHISPER")
    await dialog.locator(".picker-group").getByText("openrouter/openai", { exact: true }).waitFor()
    const names = await dialog.locator(".picker-opt .po-name").allTextContents()
    assert(names.filter((n) => n.startsWith("openrouter/openai/whisper")).length === 3, `three gateway whisper models: ${names.join(", ")}`)
    assert(names.every((n) => /whisper/i.test(n)), `only whisper matches: ${names.join(", ")}`)
    await dialog.getByRole("searchbox").fill("mai")
    await dialog.locator(".picker-opt .po-name").getByText("openrouter/microsoft/mai-transcribe-1.5", { exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert((await page.locator("#sp-stt-model").first().inputValue()) === "openrouter/microsoft/mai-transcribe-1.5", "picked model in the field")
    // Text-to-speech: nothing in the gateway list is labeled TTS, so all models show with a note.
    await page.locator("#sp-tts-model").first().locator("..").getByRole("button", { name: "Browse…" }).click()
    await dialog.locator(".picker-note").getByText(/doesn't label speech models/).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Save", exact: true }).first().click()
    await page.waitForFunction(async () => {
      const log = await (await fetch("/mock/log")).json()
      return JSON.stringify([log.speech, log.userSpeech]).includes("openrouter/microsoft/mai-transcribe-1.5")
    })
    await shot(page, "desktop-speech-picker")
  })

  await check("desktop: ⌘B collapses the sidebar", async () => {
    await page.goto(`${BASE}/`)
    await page.locator(".sidebar").waitFor()
    await page.keyboard.press("Meta+b")
    await page.locator(".sidebar").waitFor({ state: "detached" })
    await page.keyboard.press("Meta+b")
    await page.locator(".sidebar").waitFor()
  })

  await check("desktop: no page errors", async () => assert(!errors.length, errors.join("; ")))
  await context.close()
}

/** Fakes Notification permission and PushManager (headless Chromium has no push service); state survives reloads. */
const FAKE_PUSH = `(() => {
  const read = (k) => localStorage.getItem("fake-push:" + k)
  const write = (k, v) => (v === null ? localStorage.removeItem("fake-push:" + k) : localStorage.setItem("fake-push:" + k, v))
  Object.defineProperty(Notification, "permission", { get: () => read("permission") || "default", configurable: true })
  Notification.requestPermission = async () => (write("permission", "granted"), "granted")
  const make = (endpoint) => ({
    endpoint,
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint, keys: { p256dh: "BFakeP256dhKey", auth: "FakeAuth" } }),
    unsubscribe: async () => (write("endpoint", null), true),
  })
  const manager = {
    getSubscription: async () => (read("endpoint") ? make(read("endpoint")) : null),
    subscribe: async () => (write("endpoint", "https://push.example/fake-" + Date.now()), make(read("endpoint"))),
  }
  Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", { get: () => manager, configurable: true })
})()`

async function notifications(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(FAKE_PUSH)
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  const hubLog = async () => (await (await fetch(`${BASE}/mock/log`)).json()) as { pushEndpoints: string[]; pushTests: number; mutedSessions: string[]; quietHours: unknown; pushPrefs: Record<string, boolean> }
  const state = page.locator("#notifications .notify-status")

  await check("notifications: not subscribed → enable → subscribed; test button calls the route", async () => {
    await page.goto(`${BASE}/settings#notifications`)
    await state.waitFor()
    assert((await state.getAttribute("data-state")) === "off", `starts off: ${await state.getAttribute("data-state")}`)
    assert((await page.locator("#notifications").getByText("These apply once this device is subscribed.").count()) === 1, "warns before subscribing")
    await page.getByRole("button", { name: "Enable notifications on this device" }).click()
    await page.locator('#notifications .notify-status[data-state="on"]').waitFor()
    const log = await hubLog()
    assert(log.pushEndpoints.length === 1 && log.pushEndpoints[0]!.startsWith("https://push.example/fake-"), `hub got the subscription: ${JSON.stringify(log.pushEndpoints)}`)
    await page.getByRole("button", { name: "Send test notification" }).click()
    await page.locator("[data-test-result]").getByText("Test notification sent to this device").waitFor()
    assert((await hubLog()).pushTests === 1, "POST /api/push/test called once")
    await shot(page, "notifications-on")
  })

  await check("notifications: toggles and quiet hours save; failed is its own toggle", async () => {
    await page.locator('#notifications input[data-pref="failed"]').check()
    await page.waitForFunction(async () => (await (await fetch("/mock/log")).json()).pushPrefs.failed === true)
    await page.locator("#notifications .switch").filter({ hasText: "Quiet hours" }).locator("input").check()
    await page.locator("#notifications .quiet-hours").waitFor()
    const quiet = (await hubLog()).quietHours as { start: string; end: string; timeZone: string } | null
    assert(quiet?.start === "22:00" && quiet.end === "07:00" && !!quiet.timeZone, `quiet hours saved with a time zone: ${JSON.stringify(quiet)}`)
  })

  await check("notifications: the hub lost the subscription (new origin) → re-subscribed on load", async () => {
    await mock("/mock/push", { endpoints: [] })
    await page.reload()
    await page.waitForFunction(async () => (await (await fetch("/mock/log")).json()).pushEndpoints.length === 1)
    await page.locator('#notifications .notify-status[data-state="on"]').waitFor()
  })

  await check("notifications: a session's ⋯ menu mutes and unmutes it", async () => {
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    await page.getByRole("button", { name: "Session actions" }).click()
    await page.getByRole("menuitem", { name: "Mute notifications" }).click()
    await page.waitForFunction(async () => (await (await fetch("/mock/log")).json()).mutedSessions.includes("ses_mock"))
    await page.getByRole("button", { name: "Session actions" }).click()
    await page.getByRole("menuitem", { name: "Unmute notifications" }).click()
    await page.waitForFunction(async () => (await (await fetch("/mock/log")).json()).mutedSessions.length === 0)
  })

  await check("notifications: no page errors", async () => assert(!errors.length, errors.join("; ")))
  await context.close()
}

/**
 * Audio blocked until a tap, as Chrome's autoplay policy does for a link opened from the terminal (headless
 * Chromium does not apply the policy itself): the AudioContext stays suspended and the page has no activation.
 */
const GESTURE_POLICY = `(() => {
  let tapped = false
  addEventListener("pointerdown", () => (tapped = true), true)
  const state = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "state").get
  Object.defineProperty(BaseAudioContext.prototype, "state", { get() { return tapped ? state.call(this) : "suspended" }, configurable: true })
  const resume = AudioContext.prototype.resume
  AudioContext.prototype.resume = function () { return tapped ? resume.call(this) : new Promise(() => {}) }
  Object.defineProperty(navigator, "userActivation", { get: () => ({ hasBeenActive: tapped, isActive: tapped }), configurable: true })
})()`

async function tapToStart(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] })
  await context.addInitScript(GESTURE_POLICY)
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await check("voice link: when the browser needs a tap, a Tap to start button starts Voice mode", async () => {
    await page.goto(`${BASE}/s/ses_mock?voice=1`)
    const tap = page.getByRole("button", { name: "Tap to start Voice mode" })
    await tap.waitFor({ timeout: 10_000 })
    assert((await page.locator(".voice-error").count()) === 0, "no error shown, only the button")
    assert(!page.url().includes("voice=1"), "param removed")
    await shot(page, "voice-tap-to-start")
    await tap.click()
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor({ timeout: 10_000 })
    assert((await tap.count()) === 0, "the button is gone once Voice mode is on")
  })
  await check("voice link: no page errors", async () => assert(!errors.length, errors.join("; ")))
  await context.close()
}

async function phone(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))

  await check("phone: home is a list, sidebar is a drawer", async () => {
    await page.goto(`${BASE}/`)
    await page.locator(".home-list .home-item").nth(3).waitFor()
    assert((await page.locator(".sessions-table").count()) === 0, "no table on phone")
    assert((await page.locator(".sidebar").count()) === 0, "sidebar closed")
    await shot(page, "phone-home")
    await page.getByRole("button", { name: "Open sidebar" }).click()
    await page.locator(".sidebar").waitFor()
    await shot(page, "phone-drawer")
    await page.locator(".sidebar").getByRole("link", { name: /Mock session/ }).first().click()
    await page.waitForURL(/\/s\/ses_mock$/)
    await page.locator(".sidebar").waitFor({ state: "detached" })
  })

  await check("phone: session with composer; rail as bottom sheet", async () => {
    await page.locator(".msg.assistant").first().waitFor()
    assert(await page.getByLabel("Message").isVisible(), "composer visible")
    await shot(page, "phone-session")
    const rail = page.locator(".rail")
    if (!(await rail.count())) await page.getByRole("button", { name: "Show details" }).click()
    await rail.getByText("31%").waitFor()
    const box = await rail.boundingBox()
    assert(box && box.y > 100 && box.width >= 380, `rail is a bottom sheet (${JSON.stringify(box)})`)
    await shot(page, "phone-rail-sheet")
    await page.getByRole("button", { name: "Close details" }).click()
  })

  await check("phone: no page errors", async () => assert(!errors.length, errors.join("; ")))
  await context.close()
}

mkdirSync(SHOTS, { recursive: true })
if (!existsSync(path.join(ROOT, "web", "dist", "index.html"))) {
  console.error("web/dist is missing: run `npm run build:web` first")
  process.exit(1)
}
const hub = Bun.spawn(["bun", path.join(ROOT, "test", "web-mock-hub.ts"), String(PORT)], { stdout: "ignore", stderr: "inherit" })
let browser: Browser | undefined
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/api/auth`).then((r) => r.ok, () => false)) break
    await Bun.sleep(100)
  }
  const executablePath = chromiumPath()
  if (!executablePath) throw new Error("No Chromium found: set CHROMIUM_PATH")
  // Fake microphone so Voice mode and the mic picker run headless.
  browser = await chromium.launch({ executablePath, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] })
  await mock("/mock/reset")
  await desktop(browser)
  await mock("/mock/reset")
  await phone(browser)
  await mock("/mock/reset")
  await notifications(browser)
  await mock("/mock/reset")
  await tapToStart(browser)
} catch (e) {
  failures++
  results.push(`✗ setup: ${(e as Error).message}`)
} finally {
  await browser?.close()
  hub.kill()
}
console.log(results.join("\n"))
console.log(`\n${results.length - failures}/${results.length} checks passed · screenshots in ${SHOTS}`)
process.exit(failures ? 1 : 0)
