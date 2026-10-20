#!/usr/bin/env bun
// Headless smoke test of the built console against the mock hub (test/web-mock-hub.ts), at desktop (1440×900) and
// phone (390×844) sizes: home loads, a session opens with its timeline, Send → Steer/Stop → Send, image attachments
// (attach, remove, attach again, send), Dictate → Send (input cleared, also when the turn's connection drops), a slow turn (202, reply later), the right rail and diff viewer render, a Voice-off session is inspectable, rename (table,
// sidebar, top bar), archive (menu, Undo, Archived chip, Needs-you exception, bulk, inactive), resizable sidebar/rail, and
// Voice mode speaking a streamed reply before its text ends (each sentence playing while its MP3 still downloads), with the turn timed (a browser with a silent fake mic), Voice mode with the screen off (the phone muting/ending the mic or suspending audio: paused in the Voice bar and the notification, listening again on unlock),
// progressive history (newest page first, older pages while scrolling up, anchored, Retry), rich Markdown (tables, task lists, highlighted code, copy) and the text size (Settings, pinch, ctrl+wheel, kept after reload, phone at 1.8),
// and speech detection (fake mics looping background noise: nothing sent, unless the on-device model is blocked; and a spoken request: one utterance, a hallucinated “Thank you.” shown as ignored). Screenshots go to $SMOKE_SHOTS (default: the OS temp
// dir). Run `npm run build:web && npm run test:e2e`. Chromium: $CHROMIUM_PATH, else Playwright's cache, else PATH.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { chromiumPath } from "./chromium"
import { encodeWav } from "../src/core/conversation-core"
import { readWav } from "../../test/wav-fixture"

const ROOT = path.join(import.meta.dir, "..", "..")
const SHOTS = process.env.SMOKE_SHOTS ?? path.join(tmpdir(), "hub-smoke")
const PORT = Number(process.env.SMOKE_PORT ?? 4399)
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
const results: string[] = []
/** Measurements printed after the results (not checks). */
const measured: string[] = []
/** The page under test; a failed check leaves a screenshot of it (failed-<n>.png). */
let current: Page | undefined
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
    results.push(`✓ ${name}`)
  } catch (e) {
    failures++
    results.push(`✗ ${name}: ${(e as Error).message.split("\n")[0]}`)
    await current?.screenshot({ path: path.join(SHOTS, `failed-${failures}.png`) }).catch(() => undefined)
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
  current = page
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

  const apiLog = async () => ((await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ method: string; path: string; body?: any }> }).log
  const renames = async () => (await apiLog()).filter((e) => e.method === "POST" && e.path.endsWith("/rename"))

  await check("desktop: rename from the table ⋯ menu (inline, Enter saves, Esc cancels, failure reverts)", async () => {
    const row = (title: string) => page.locator(".sessions-table tbody tr", { has: page.getByRole("link", { name: title, exact: true }) })
    await row("Image resizing").getByRole("button", { name: "More actions for Image resizing" }).click()
    await page.getByRole("menuitem", { name: "Rename…" }).click()
    const field = page.locator(".sessions-table").getByRole("textbox", { name: "Session title" })
    await field.waitFor()
    assert((await field.inputValue()) === "Image resizing", "prefilled with the current title")
    assert(await field.evaluate((el: HTMLInputElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length), "text selected on open")
    // The title is selected: typing replaces it.
    await field.pressSequentially("Resize images faster")
    await field.press("Enter")
    await row("Resize images faster").waitFor()
    assert(!(await field.count()), "field closes after saving")
    const sent = (await renames()).at(-1)
    assert(sent?.body?.title === "Resize images faster", `rename sent: ${JSON.stringify(sent)}`)
    // Escape cancels without a request.
    const before = (await renames()).length
    await row("Orders API").getByRole("button", { name: "More actions for Orders API" }).click()
    await page.getByRole("menuitem", { name: "Rename…" }).click()
    await field.fill("Not this")
    await field.press("Escape")
    await row("Orders API").waitFor()
    assert((await renames()).length === before, "Escape sends nothing")
    // A refused rename reverts, with a message.
    await mock("/mock/fail", { rename: true })
    await row("CLI polish").getByRole("button", { name: "More actions for CLI polish" }).click()
    await page.getByRole("menuitem", { name: "Rename…" }).click()
    await field.fill("Polished CLI")
    await field.press("Enter")
    await page.getByText(/Could not rename: OpenCode did not answer/).waitFor()
    await row("CLI polish").waitFor()
    await mock("/mock/fail", { rename: false })
    await shot(page, "desktop-rename-table")
  })

  await check("desktop: rename from a sidebar row ⋯ menu", async () => {
    const link = page.locator(".sidebar .side-row").first()
    const title = (await link.locator(".side-title").textContent())!.trim()
    await link.getByRole("button", { name: `More actions for ${title}` }).click({ force: true })
    await page.getByRole("menuitem", { name: "Rename…" }).click()
    const field = page.locator(".sidebar").getByRole("textbox", { name: "Session title" })
    await field.waitFor()
    assert((await field.inputValue()) === title, "sidebar field prefilled")
    await field.fill(`${title} (renamed)`)
    await field.press("Enter")
    await page.locator(".sidebar .side-title", { hasText: `${title} (renamed)` }).first().waitFor()
    assert((await renames()).at(-1)?.body?.title === `${title} (renamed)`, "sidebar rename sent")
    // Back to the original title for the checks below.
    const back = page.locator(".sidebar .side-row", { has: page.locator(".side-title", { hasText: `${title} (renamed)` }) }).first()
    await back.getByRole("button", { name: `More actions for ${title} (renamed)` }).click({ force: true })
    await page.getByRole("menuitem", { name: "Rename…" }).click()
    await field.fill(title)
    await field.press("Enter")
    await page.locator(".sidebar .side-title", { hasText: title }).first().waitFor()
  })

  await check("desktop: rename from the session top bar (title click and the title menu)", async () => {
    await page.goto(`${BASE}/s/ses_10`)
    const title = page.locator(".topbar .title")
    const current = "PWA icons"
    await title.getByRole("button", { name: current }).waitFor()
    await title.getByRole("button").click()
    const field = page.locator(".topbar").getByRole("textbox", { name: "Session title" })
    await field.waitFor()
    assert((await field.inputValue()) === current, "top bar field prefilled")
    await field.fill("Top bar title")
    await field.press("Enter")
    await page.locator(".topbar .title").getByText("Top bar title").waitFor()
    await page.getByRole("button", { name: "Session actions" }).click()
    await page.getByRole("menuitem", { name: "Rename…" }).click()
    await field.fill("Top bar title, again")
    await field.press("Enter")
    await page.locator(".topbar .title").getByText("Top bar title, again").waitFor()
    assert((await renames()).at(-1)?.body?.title === "Top bar title, again", "top bar rename sent")
    await shot(page, "desktop-rename-topbar")
    await title.getByRole("button").click()
    await field.fill(current)
    await field.press("Enter")
    await page
      .locator(".topbar .title")
      .getByText(current, { exact: true })
      .waitFor({ timeout: 5000 })
      .catch(async () => {
        throw new Error(`title not restored; renames sent: ${JSON.stringify((await renames()).map((e) => e.body?.title))}`)
      })
    // Each rename reached the hub, in order, and the hub ends with the restored title (later checks use it). A
    // catalog sent before the hub applied a rename must not flip the title back meanwhile.
    const sent = () => renames().then((list) => list.filter((e) => e.path.includes("/ses_10/")).map((e) => e.body?.title))
    let stored = ""
    for (let i = 0; i < 50 && stored !== current; i++) {
      stored = ((await (await fetch(`${BASE}/api/sessions/ses_10`)).json()) as { title: string }).title
      if (stored !== current) await Bun.sleep(100)
    }
    assert(JSON.stringify(await sent()) === JSON.stringify(["Top bar title", "Top bar title, again", current]), `renames sent: ${JSON.stringify(await sent())}`)
    assert(stored === current, `hub title restored: ${stored}`)
    await page.locator(".topbar .title").getByText(current, { exact: true }).waitFor()
  })

  const prefPuts = async () => (await apiLog()).filter((e) => e.method === "PUT" && e.path === "/api/prefs/view")
  const tableRow = (title: string) => page.locator(".sessions-table tbody tr", { has: page.getByRole("link", { name: title, exact: true }) })
  const chip = (name: string) => page.locator(".chips").getByRole("button", { name, exact: true })

  await check("desktop: archive from the ⋯ menu; Undo; the Archived chip; Unarchive", async () => {
    await page.goto(`${BASE}/`)
    await tableRow("Orders API").waitFor()
    await tableRow("Orders API").getByRole("button", { name: "More actions for Orders API" }).click()
    await page.getByRole("menuitem", { name: /^Archive\b/ }).click()
    await tableRow("Orders API").waitFor({ state: "detached" })
    const toast = page.locator(".toast").filter({ hasText: "Archived “Orders API”" })
    await toast.waitFor()
    await toast.getByRole("button", { name: "Undo" }).click()
    await tableRow("Orders API").waitFor()
    await tableRow("Orders API").getByRole("button", { name: "More actions for Orders API" }).click()
    await page.getByRole("menuitem", { name: /^Archive\b/ }).click()
    await tableRow("Orders API").waitFor({ state: "detached" })
    assert(!(await page.locator(".sidebar").getByRole("link", { name: "Orders API" }).count()), "gone from the sidebar")
    // The save is in flight: wait for it to reach the hub.
    let saved: unknown
    for (let i = 0; i < 50 && !saved; i++) {
      saved = (await prefPuts()).at(-1)?.body?.hiddenSessions?.at(-1)
      if (!saved) await Bun.sleep(100)
    }
    assert(typeof saved === "string" && saved.startsWith("ses_"), `archived set saved: ${JSON.stringify((await prefPuts()).at(-1))}`)
    await chip("Archived").click()
    await tableRow("Orders API").waitFor()
    await shot(page, "desktop-archived-chip")
    await tableRow("Orders API").getByRole("button", { name: "More actions for Orders API" }).click()
    await page.getByRole("menuitem", { name: /^Unarchive\b/ }).click()
    await tableRow("Orders API").waitFor({ state: "detached" })
    await chip("Archived").click()
    await tableRow("Orders API").waitFor()
  })

  await check("desktop: an archived session that needs you stays under Needs you", async () => {
    await tableRow("Cart bug").getByRole("button", { name: "More actions for Cart bug" }).click()
    await page.getByRole("menuitem", { name: /^Archive\b/ }).click()
    await tableRow("Cart bug").waitFor({ state: "detached" })
    await page.locator(".sidebar .side-section.needs").getByRole("link", { name: /Cart bug/ }).waitFor()
    await chip("Needs you").click()
    await tableRow("Cart bug").waitFor()
    await tableRow("Cart bug").getByRole("button", { name: "More actions for Cart bug" }).click()
    await page.getByRole("menuitem", { name: /^Unarchive\b/ }).click()
    await chip("Needs you").click()
    await tableRow("Cart bug").waitFor()
  })

  await check("desktop: select rows and archive them together, with Undo", async () => {
    const before = await page.locator(".sessions-table tbody tr").count()
    await tableRow("editor config").getByRole("checkbox", { name: "Select editor config" }).check()
    await tableRow("shell setup").getByRole("checkbox", { name: "Select shell setup" }).check()
    const bar = page.getByRole("region", { name: "Selected sessions" })
    await bar.getByText("2 selected").waitFor()
    await bar.getByRole("button", { name: "Archive" }).click()
    await tableRow("editor config").waitFor({ state: "detached" })
    await tableRow("shell setup").waitFor({ state: "detached" })
    assert((await page.locator(".sessions-table tbody tr").count()) === before - 2, "two rows left the table")
    assert(!(await bar.count()), "selection cleared")
    const toast = page.locator(".toast").filter({ hasText: "Archived 2 sessions" })
    await toast.getByRole("button", { name: "Undo" }).click()
    await tableRow("editor config").waitFor()
    await tableRow("shell setup").waitFor()
    // Select all (the shown rows) and clear.
    await page.getByRole("checkbox", { name: "Select all shown sessions" }).check()
    await bar.getByText(`${before} selected`).waitFor()
    await bar.getByRole("button", { name: "Clear selection" }).click()
    await bar.waitFor({ state: "detached" })
  })

  await check("desktop: archive sessions inactive for more than N days (confirm with the count)", async () => {
    const before = await page.locator(".sessions-table tbody tr").count()
    await page.getByRole("button", { name: "Archive inactive…" }).click()
    const dialog = page.getByRole("dialog", { name: "Archive inactive sessions" })
    await dialog.waitFor()
    const days = dialog.getByRole("spinbutton", { name: "Inactive for more than (days)" })
    assert((await days.inputValue()) === "30", "30 days by default")
    await days.fill("1")
    const confirm = dialog.getByRole("button", { name: /^Archive \d+ sessions?$/ })
    await confirm.waitFor()
    const n = Number((await confirm.textContent())!.match(/\d+/)![0])
    assert(n > 0 && n < before, `some sessions are older than a day: ${n} of ${before}`)
    await shot(page, "desktop-archive-inactive")
    await confirm.click()
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction((count) => document.querySelectorAll(".sessions-table tbody tr").length === count, before - n)
    const toast = page.locator(".toast").filter({ hasText: `Archived ${n} session` })
    await toast.getByRole("button", { name: "Undo" }).click()
    await page.waitForFunction((count) => document.querySelectorAll(".sessions-table tbody tr").length === count, before)
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
    // The turn stays working until Stop: steering and stopping never race the mock turn's timer.
    await mock("/mock/hold-turns", { on: true })
    try {
      await composerSteerStop()
    } finally {
      await mock("/mock/hold-turns", { on: false })
    }
  })

  async function composerSteerStop(): Promise<void> {
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
  }

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

  await check("desktop: a question from the agent is answered in the console (options, own answer, multi-select)", async () => {
    await page.goto(`${BASE}/`)
    await page.locator(".sidebar").getByRole("link", { name: /Reverse proxy route for dashboard/ }).first().click()
    const card = page.getByRole("group", { name: /^Question/ })
    await card.waitFor()
    await card.getByText("Which subdomain should the dashboard use?").waitFor()
    assert(!(await card.getByText(/answer (it|this one) in the terminal/i).count()), "no terminal hint for an answerable question")
    await card.getByRole("radio", { name: "ops" }).check()
    await card.getByLabel("Subdomain: your own answer").fill("status")
    await card.getByRole("checkbox", { name: "TLS" }).check()
    await shot(page, "desktop-question-card")
    await card.getByRole("button", { name: "Submit" }).click()
    await card.waitFor({ state: "detached" })
    const { log } = (await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ method: string; path: string; body?: any }> }
    const sent = log.filter((e) => e.path.endsWith("/form")).at(-1)
    assert(JSON.stringify(sent?.body) === JSON.stringify({ formID: "q_1", answer: { q0: "status", q1: ["tls"] } }), `form answer sent: ${JSON.stringify(sent?.body)}`)
  })

  await check("desktop: a subagent row opens the subagent's own session; its card, live output and a way back", async () => {
    const child = "ses_mock_child"
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.user .pill").first().waitFor()
    await mock("/mock/status", {
      sessions: [
        { id: "ses_mock", title: "Mock session", state: "working", blockers: [] },
        { id: child, parentID: "ses_mock", title: "Integrate P6.5 sessions", state: "blocked", blockers: [{ kind: "permission", id: "per_kid", summary: "shell: git push" }] },
        { id: "ses_mock_sibling", parentID: "ses_mock", title: "Sibling work", state: "working", blockers: [] },
      ],
    })
    await page.getByRole("link", { name: /Subagent · Integrate P6.5 sessions/ }).click()
    await page.waitForURL(new RegExp(`/s/${child}$`))
    await page.locator(".topbar .title").getByText("Integrate P6.5 sessions").waitFor()
    await page.locator(".msg.user .pill").first().waitFor()
    assert(!(await page.getByRole("link", { name: /Subagent · Mock session/ }).count()), "the root is not listed as a subagent of its child")
    assert(!(await page.getByRole("link", { name: /Subagent · Sibling work/ }).count()), "siblings are not subagents of the child")
    assert(!(await page.locator(".banner.warn").count()), "not shown as disconnected")
    await page.getByRole("group", { name: /Permission request: shell: git push/ }).waitFor()
    assert(await page.getByLabel("Message").isEnabled(), "composer steers the subagent")
    await mock("/mock/stream", { sessionID: child, kind: "text", messageID: "msg_kid_live", text: "Child is pushing now.", every: 20, size: 8 })
    await mock("/mock/stream", { sessionID: "ses_mock_sibling", kind: "text", messageID: "msg_sib_live", text: "Sibling output here.", every: 20, size: 8 })
    await page.getByText("Child is pushing now.").waitFor()
    await Bun.sleep(400)
    assert(!(await page.getByText("Sibling output here.").count()), "a sibling's output stays off the child's page")
    await shot(page, "desktop-subagent-session")
    await page.getByRole("link", { name: /Back to Mock session/ }).click()
    await page.waitForURL(/\/s\/ses_mock$/)
    await mock("/mock/status", { sessions: [{ id: "ses_mock", title: "Mock session", state: "idle", blockers: [] }] })
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

  await check("desktop: home table has no Voice column/filters; a green dot marks only the live Voice session; ⋯ has Allow Voice", async () => {
    const go = (href: string) =>
      page.evaluate((h) => {
        const a = document.createElement("a")
        a.href = h
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, href)
    const dotted = () =>
      page.locator(".sessions-table tbody tr").evaluateAll((trs) =>
        trs.filter((tr) => tr.querySelector(".col-title .voice-dot")).map((tr) => tr.querySelector(".col-title a")?.textContent ?? ""),
      )
    await page.goto(`${BASE}/`)
    await page.locator(".sessions-table tbody tr").nth(5).waitFor()
    const headers = (await page.locator(".sessions-table thead th").allTextContents()).map((t) => t.trim())
    assert(!headers.some((h) => /^Voice/.test(h)), `no Voice column: ${headers.join(" | ")}`)
    assert((await page.locator(".sessions-table .voice-pill, .col-voice").count()) === 0, "no Voice cells")
    assert((await page.locator('.chips [data-chip^="voice"]').count()) === 0, "no Voice filter chips")
    assert((await page.getByRole("button", { name: /^Voice (on|off)$/ }).count()) === 0, "no Voice on/off buttons")
    const before = await dotted()
    // Only sessions the catalog reports in a conversation are live; merely exposed ones get nothing.
    assert(!before.includes("Mock session"), `Mock session not live yet: ${before.join(", ")}`)
    assert(before.length <= 1, `at most the one fixture in conversation: ${before.join(", ")}`)
    // Voice mode on in Mock session, then back home in-app (Voice mode keeps running).
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor()
    await go("/")
    await page.getByRole("heading", { name: "All sessions" }).waitFor()
    await page.locator(".sessions-table tbody tr").nth(5).waitFor()
    const row = page.locator(".sessions-table tbody tr", { has: page.getByRole("link", { name: "Mock session", exact: true }) })
    const dot = row.locator(".col-title .voice-dot")
    await dot.waitFor()
    assert((await dot.getAttribute("aria-label")) === "Voice mode on", "dot aria-label")
    assert((await dot.getAttribute("title")) === "Voice mode on", "dot tooltip")
    assert(await row.locator(".col-title").evaluate((td) => td.firstElementChild?.classList.contains("voice-dot")), "dot is left of the title")
    const box = await dot.boundingBox()
    assert(box && Math.round(box.width) === 8 && Math.round(box.height) === 8, `8px dot: ${JSON.stringify(box)}`)
    const after = await dotted()
    assert(JSON.stringify([...after].sort()) === JSON.stringify([...before, "Mock session"].sort()), `only the live session gains a dot: ${after.join(", ")}`)
    assert(await page.locator(".sidebar .side-row.voice-here .voice-dot").first().isVisible(), "sidebar dot for the live session")
    await row.scrollIntoViewIfNeeded()
    await shot(page, "desktop-home-voice-dot")
    // The ⋯ menu keeps the capability: a Voice-off session offers Allow Voice, an exposed one Disallow Voice.
    await page.getByRole("button", { name: "More actions for PWA icons" }).first().click()
    await page.getByRole("menuitem", { name: "Allow Voice" }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("menuitem", { name: "Allow Voice" }).waitFor({ state: "detached" })
    await row.getByRole("button", { name: "More actions for Mock session" }).click()
    await page.getByRole("menuitem", { name: "Disallow Voice" }).waitFor()
    await page.keyboard.press("Escape")
    // Ending Voice mode removes the dot.
    await go("/s/ses_mock")
    await page.locator(".voice-bar").getByRole("button", { name: "End", exact: true }).click()
    await page.locator(".voice-bar").waitFor({ state: "detached" })
    await go("/")
    await page.locator(".sessions-table tbody tr").nth(5).waitFor()
    await row.locator(".voice-dot").waitFor({ state: "detached" })
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

  await check("desktop: Dictate → Send clears the input and it stays empty, also when the turn's connection drops", async () => {
    const box = () => page.getByLabel("Message").inputValue()
    const dictateText = async (text: string) => {
      await mock("/mock/transcripts", { texts: [text] })
      await page.getByRole("button", { name: "Dictate" }).click()
      await page.getByRole("button", { name: "Stop dictation" }).waitFor()
      await page.waitForTimeout(600)
      await page.getByRole("button", { name: "Stop dictation" }).click()
      await page.waitForFunction((t) => (document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement | null)?.value === t, text)
    }
    const idle = () => page.locator("button.send.send").waitFor({ timeout: 15_000 })
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    await page.getByLabel("Message").fill("")
    await dictateText("dictated then sent")
    await page.locator("button.send").click()
    await page.waitForTimeout(400)
    assert((await box()) === "", `input cleared after send: ${JSON.stringify(await box())}`)
    await page.locator(".msg.assistant", { hasText: "Done: dictated then sent" }).waitFor({ timeout: 15_000 })
    assert((await box()) === "", "input still empty after the reply")
    assert(!(await page.locator(".composer-error").count()), "no error after a normal send")
    await idle()
    // A proxy cuts the long request after the hub took the turn: not a failure, nothing comes back.
    await page.route("**/api/sessions/*/turn", async (route) => {
      // The request reaches the hub (which starts the turn); the browser's side is then cut.
      void route.fetch().catch(() => undefined)
      await Bun.sleep(300)
      await route.abort("failed")
    })
    try {
      await dictateText("dictated, connection dropped")
      await page.locator("button.send").click()
      await page.getByText(/Lost the connection to the hub after sending/).waitFor()
      assert((await box()) === "", `input stays empty after a dropped connection: ${JSON.stringify(await box())}`)
      assert(!(await page.locator(".composer-error").count()), "no error under the input")
      assert(!(await page.getByText(/Failed to fetch/).count()), "never the raw 'Failed to fetch'")
      await page.locator(".msg.assistant", { hasText: "Done: dictated, connection dropped" }).waitFor({ timeout: 15_000 })
      assert((await box()) === "", "input still empty after the reply")
      await idle()
    } finally {
      await page.unroute("**/api/sessions/*/turn")
      await mock("/mock/reset-transcripts")
    }
  })

  await check("desktop: a slow turn is accepted at once (202, no error) and its reply appears when it arrives", async () => {
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    await mock("/mock/slow-turns", { ms: 6000 })
    try {
      const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/turn"))
      await page.getByLabel("Message").fill("a slow one")
      const sentAt = Date.now()
      await page.locator("button.send").click()
      const res = await answered
      assert(res.status() === 202 && (await res.json()).mode === "turn", `accepted async: ${res.status()}`)
      assert((await res.request().headerValue("prefer")) === "respond-async", "asks for respond-async")
      assert(Date.now() - sentAt < 4000, "answered before the turn ended")
      await page.waitForTimeout(500)
      assert((await page.getByLabel("Message").inputValue()) === "", "input empty")
      assert(!(await page.locator(".composer-error").count()), "no error under the input")
      assert(!(await page.getByText(/Steered the running session/).count()), "an accepted turn is not a steer")
      await page.locator(".msg.assistant", { hasText: "Done: a slow one" }).waitFor({ timeout: 20_000 })
      assert(!(await page.locator(".composer-error").count()), "still no error after the reply")
      assert(!(await page.locator(".note.err").count()), "no failure note")
      await page.locator("button.send.send").waitFor({ timeout: 15_000 })
    } finally {
      await mock("/mock/slow-turns", {})
    }
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

  await check("desktop: Settings → Voice → Mic sensitivity: Normal by default, a choice is kept on this device", async () => {
    await page.evaluate(() => localStorage.removeItem("voice.sensitivity"))
    await page.goto(`${BASE}/settings#voice`)
    const group = page.getByRole("radiogroup", { name: "Mic sensitivity" })
    await group.waitFor()
    assert((await group.getByRole("radio", { name: "Normal" }).getAttribute("aria-checked")) === "true", "Normal by default")
    await group.getByRole("radio", { name: "High" }).click()
    assert((await page.evaluate(() => localStorage.getItem("voice.sensitivity"))) === "high", "stored per device")
    await page.reload()
    await group.waitFor()
    assert((await group.getByRole("radio", { name: "High" }).getAttribute("aria-checked")) === "true", "kept after a reload")
    await shot(page, "desktop-settings-sensitivity")
    await group.getByRole("radio", { name: "Normal" }).click()
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

  await check("desktop: sidebar and rail resize (drag, keys, double-click, persisted, collapse, window resize)", async () => {
    const width = (sel: string) => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().width)
    const drag = async (sel: string, dx: number) => {
      const box = (await page.locator(sel).boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + dx / 2, y, { steps: 4 })
      await page.mouse.move(x + dx, y, { steps: 4 })
      await page.mouse.up()
    }
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    if (!(await page.locator(".rail").count())) await page.getByRole("button", { name: "Show details" }).click()
    const side = page.getByRole("separator", { name: "Resize sidebar" })
    const rail = page.getByRole("separator", { name: "Resize details" })
    await rail.waitFor()
    assert((await side.getAttribute("aria-orientation")) === "vertical", "vertical separator")
    assert((await width(".sidebar")) === 235 && (await width(".rail")) === 260, `defaults: ${await width(".sidebar")} / ${await width(".rail")}`)
    // Drag: the sidebar's handle right, the rail's left.
    await drag('.panel-handle[data-panel="side"]', 100)
    assert((await width(".sidebar")) === 335, `sidebar dragged wider: ${await width(".sidebar")}`)
    await drag('.panel-handle[data-panel="rail"]', -120)
    assert((await width(".rail")) === 380, `rail dragged wider: ${await width(".rail")}`)
    assert((await side.getAttribute("aria-valuenow")) === "335", "aria-valuenow follows")
    assert(!(await page.evaluate(() => document.documentElement.classList.contains("resizing"))), "selection re-enabled after the drag")
    // Keyboard: 16px, Shift 64px, Home/End.
    await side.focus()
    await page.keyboard.press("ArrowRight")
    assert((await width(".sidebar")) === 351, `ArrowRight +16: ${await width(".sidebar")}`)
    await page.keyboard.press("Shift+ArrowLeft")
    assert((await width(".sidebar")) === 287, `Shift+ArrowLeft −64: ${await width(".sidebar")}`)
    await page.keyboard.press("Home")
    assert((await width(".sidebar")) === 180, `Home → min: ${await width(".sidebar")}`)
    await page.keyboard.press("End")
    assert((await width(".sidebar")) === 480 && (await side.getAttribute("aria-valuemax")) === "480", `End → max: ${await width(".sidebar")}`)
    await rail.focus()
    await page.keyboard.press("ArrowLeft")
    assert((await width(".rail")) === 396, `rail ArrowLeft +16: ${await width(".rail")}`)
    // Double-click resets to the default.
    await side.dblclick()
    assert((await width(".sidebar")) === 235, `double-click reset: ${await width(".sidebar")}`)
    await drag('.panel-handle[data-panel="side"]', 65)
    await shot(page, "desktop-resized")
    // Persisted on this device.
    await page.reload()
    await page.locator(".msg.assistant").first().waitFor()
    await rail.waitFor()
    assert((await width(".sidebar")) === 300 && (await width(".rail")) === 396, `after reload: ${await width(".sidebar")} / ${await width(".rail")}`)
    // Long titles still end in an ellipsis, with the full title as a tooltip.
    const title = page.locator(".sidebar .side-row-link").first()
    assert((await title.getAttribute("title"))?.startsWith((await title.locator(".side-title").textContent())!.trim()), "row tooltip has the title")
    assert((await title.locator(".side-title").evaluate((el) => getComputedStyle(el).textOverflow)) === "ellipsis", "titles truncate with an ellipsis")
    // A narrow window keeps the center column ≥ 420px; widening it restores the remembered widths.
    await page.setViewportSize({ width: 1000, height: 900 })
    await page.waitForFunction(() => document.querySelector(".rail")!.getBoundingClientRect().width === 280)
    assert((await width(".session-main")) >= 420, `center column: ${await width(".session-main")}`)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForFunction(() => document.querySelector(".rail")!.getBoundingClientRect().width === 396)
    // Dragging the sidebar well past its minimum collapses it; expanding restores the last width.
    await drag('.panel-handle[data-panel="side"]', -200)
    await page.locator(".sidebar").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Show sidebar (⌘B)" }).click()
    await page.locator(".sidebar").waitFor()
    assert((await width(".sidebar")) === 300, `restored width: ${await width(".sidebar")}`)
    await side.dblclick()
    await rail.dblclick()
    assert((await width(".sidebar")) === 235 && (await width(".rail")) === 260, "back to defaults")
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

  await check("notifications: Activity updates are off by default with a hint; on, the interval saves", async () => {
    await page.locator("#notifications [data-activity-hint]").waitFor()
    await page.locator('#notifications input[data-pref="activity"]').check()
    await page.waitForFunction(async () => (await (await fetch("/mock/log")).json()).pushPrefs.activity === true)
    await page.locator("#notifications [data-activity-hint]").waitFor({ state: "detached" })
    await page.locator("#notifications select[data-activity-minutes]").selectOption("10")
    await page.waitForFunction(async () => (await (await fetch("/mock/log")).json()).activityMinutes === 10)
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

/**
 * Test hooks for Voice mode with the screen off: notification permission granted (fake), every notification the
 * page shows recorded (window.__shown), every microphone stream and AudioContext kept (window.__streams /
 * __contexts) so a check can mute or end the track or suspend the audio like Android Chrome does, and a settable
 * page visibility (window.__setVisible).
 */
const SCREEN_OFF_HOOKS = `(() => {
  localStorage.setItem("fake-push:permission", "granted")
  window.__shown = []
  ServiceWorkerRegistration.prototype.showNotification = async function (title, options) {
    window.__shown.push({ title, body: options?.body, actions: (options?.actions ?? []).map((a) => a.title) })
  }
  window.__streams = []
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (c) => {
    const stream = await gum(c)
    window.__streams.push(stream)
    return stream
  }
  window.__contexts = []
  const Ctx = window.AudioContext
  window.AudioContext = class extends Ctx {
    constructor(...args) {
      super(...args)
      window.__contexts.push(this)
    }
  }
  let visible = "visible"
  Object.defineProperty(document, "visibilityState", { get: () => visible, configurable: true })
  Object.defineProperty(document, "hidden", { get: () => visible === "hidden", configurable: true })
  window.__setVisible = (on) => {
    visible = on ? "visible" : "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
  }
})()`

/** Android Chrome stops the mic with the screen off: Voice mode says paused (bar + notification), and resumes on unlock. */
async function voiceScreenOff(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] })
  await context.addInitScript(FAKE_PUSH)
  await context.addInitScript(SCREEN_OFF_HOOKS)
  const page = await context.newPage()
  current = page
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  const PAUSED = "Paused — mic stopped by the phone (screen off). Unlock to resume."
  const state = page.locator(".voice-bar .voice-state")
  const lastShown = () => page.evaluate(() => (window as any).__shown.at(-1) as { title: string; body: string; actions: string[] } | undefined)
  const waitShown = (title: string) => page.waitForFunction((t) => (window as any).__shown.at(-1)?.title === t, title, { timeout: 5000 })
  await check("voice screen off: the phone muting the mic → Voice bar and notification say paused; unlock → listening", async () => {
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await state.getByText(/Listening|Thinking/).waitFor({ timeout: 10_000 })
    await waitShown("Voice mode on")
    // Screen off: hidden, then the browser mutes the microphone track.
    await page.evaluate(() => {
      const w = window as any
      w.__setVisible(false)
      w.__streams.at(-1).getAudioTracks()[0].dispatchEvent(new Event("mute"))
    })
    await state.getByText(PAUSED).waitFor({ timeout: 5000 })
    await waitShown("Voice mode paused · unlock to talk")
    const paused = await lastShown()
    assert(JSON.stringify(paused?.actions) === JSON.stringify(["End", "Open"]), `End/Open kept: ${JSON.stringify(paused)}`)
    assert(paused?.body === "Mock session · paused", `body: ${paused?.body}`)
    await shot(page, "voice-screen-off-paused")
    // Unlock: visible again, the track unmutes, frames flow → listening.
    await page.evaluate(() => {
      const w = window as any
      w.__setVisible(true)
      w.__streams.at(-1).getAudioTracks()[0].dispatchEvent(new Event("unmute"))
    })
    await state.getByText(/Listening|Thinking/).waitFor({ timeout: 5000 })
    await waitShown("Voice mode on")
  })

  await check("voice screen off: audio suspended while hidden → paused; visible → resumed and listening", async () => {
    await page.evaluate(async () => {
      const w = window as any
      w.__setVisible(false)
      await w.__contexts.at(-1).suspend()
    })
    await state.getByText(PAUSED).waitFor({ timeout: 2500 })
    await waitShown("Voice mode paused · unlock to talk")
    await page.evaluate(() => (window as any).__setVisible(true))
    await state.getByText(/Listening|Thinking/).waitFor({ timeout: 5000 })
    await waitShown("Voice mode on")
  })

  await check("voice screen off: the mic track ended → on screen the mic is requested again and listening resumes", async () => {
    const before = await page.evaluate(() => (window as any).__streams.length as number)
    await page.evaluate(() => {
      const track = (window as any).__streams.at(-1).getAudioTracks()[0] as MediaStreamTrack
      track.stop()
      track.dispatchEvent(new Event("ended"))
    })
    await page.waitForFunction((n) => (window as any).__streams.length > n, before, { timeout: 5000 })
    await state.getByText(/Listening|Thinking/).waitFor({ timeout: 5000 })
    assert(await page.evaluate(() => (window as any).__streams.at(-1).getAudioTracks()[0].readyState === "live"), "a live new track")
    await page.locator(".voice-bar").getByRole("button", { name: "End", exact: true }).click()
    await page.locator(".voice-bar").waitFor({ state: "detached" })
  })
  await check("voice screen off: no page errors", async () => assert(!errors.length, errors.join("; ")))
  await context.close()
}

/**
 * Speak while it writes, timed: a browser whose fake microphone is silent (the default fake device beeps, which the
 * VAD can take for speech and barge in on the reply).
 */
async function voiceSpeed(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(`${e.message} @ ${(e.stack ?? "").split("\n").slice(0, 4).join(" / ")}`))
  await check("voice speed: Voice mode speaks a streamed reply sentence by sentence, starting before the text ends; the Voice bar times the turn", async () => {
    type Entry = { at: number; method: string; path: string; body?: any; done?: number }
    const state = async () => (await (await fetch(`${BASE}/mock/log`)).json()) as { log: Entry[]; textEnded: Array<{ messageID: string; at: number }> }
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor({ timeout: 10_000 })
    const from = Date.now()
    // A typed turn in Voice mode (an utterance): the reply then streams in.
    const accepted = page.waitForResponse((r) => r.url().endsWith("/utterance") && r.status() === 202)
    await page.getByLabel("Message").fill("how is the build?")
    await page.locator("button.send").click()
    await accepted
    const sentences = ["The first sentence is ready.", "Then a much longer second sentence follows, written slowly.", "And a third one ends it."]
    await mock("/mock/stream", { kind: "text", messageID: "msg_fast", text: sentences.join(" "), every: 120, size: 5 })
    await page.locator(".msg.assistant", { hasText: "And a third one ends it." }).waitFor({ timeout: 15_000 })
    let s = await state()
    for (let i = 0; i < 30 && s.log.filter((e) => e.path === "/api/speak" && e.at >= from && sentences.includes(e.body?.text)).length < 3; i++) {
      await page.waitForTimeout(200)
      s = await state()
    }
    const speaks = s.log.filter((e) => e.path === "/api/speak" && e.at >= from && sentences.includes(e.body?.text))
    const ended = s.textEnded.find((e) => e.messageID === "msg_fast")
    assert(ended, "the streamed text ended")
    const calls = s.log.filter((e) => e.at >= from && !e.path.endsWith("/presence")).map((e) => `${e.at - from} ${e.method} ${e.path} ${e.body?.text ?? ""}`)
    assert(JSON.stringify(speaks.map((e) => e.body.text)) === JSON.stringify(sentences), `each sentence spoken once, in order: ${JSON.stringify(speaks.map((e) => e.body?.text))}; calls: ${calls.join(" | ")}`)
    assert(speaks[0]!.at < ended!.at - 1000, `first sentence synthesized ${ended!.at - speaks[0]!.at} ms before the text ended`)
    // The reply's first audio played before its text ended (performance marks), and the Voice bar says how long.
    const firstAudio = await page.evaluate(() => {
      const mark = performance.getEntriesByName("hub-voice:first-audio").at(-1)
      return mark ? performance.timeOrigin + mark.startTime : undefined
    })
    assert(firstAudio !== undefined && firstAudio < ended!.at, `first audio ${firstAudio === undefined ? "missing" : `${Math.round(ended!.at - firstAudio)} ms before the text ended`}`)
    // Streamed playback: the first sentence started playing before its audio finished downloading (the mock sends
    // the MP3 in chunks over ~1.2 s), right after its first byte.
    const marks = await page.evaluate(() => {
      const at = (name: string) => {
        const mark = performance.getEntriesByName(name).at(-1)
        return mark ? performance.timeOrigin + mark.startTime : undefined
      }
      return { firstByte: at("hub-voice:first-byte"), firstAudio: at("hub-voice:first-audio") }
    })
    for (let i = 0; i < 20 && !(await state()).log.find((e) => e.path === "/api/speak" && e.at === speaks[0]!.at)?.done; i++) await page.waitForTimeout(100)
    const firstDone = (await state()).log.find((e) => e.path === "/api/speak" && e.at === speaks[0]!.at)?.done
    assert(marks.firstByte !== undefined && marks.firstByte <= firstAudio!, `first byte ${JSON.stringify(marks)}`)
    assert(firstDone !== undefined && firstAudio! < firstDone - 300, `first sentence played ${firstDone === undefined ? "(download never ended)" : `${Math.round(firstDone - firstAudio!)} ms`} before its audio finished downloading`)
    const title = await page.locator(".voice-bar .voice-state").getAttribute("title")
    assert(/^last turn: \d+\.\d s to first audio\nfirst reply \d+\.\d s · first byte \d+\.\d s · audio \d+\.\d s\nspeech detection: .+$/.test(title ?? ""), `Voice bar timing tooltip: ${JSON.stringify(title)}`)
    await page.locator(".voice-bar").getByRole("button", { name: "End", exact: true }).click()
    await page.locator(".voice-bar").waitFor({ state: "detached" })
  })

  await check("voice workers: two parallel workers show as working; their announcements are spoken in completion order, after the sentence playing", async () => {
    type Entry = { at: number; method: string; path: string; body?: any }
    const log = async () => ((await (await fetch(`${BASE}/mock/log`)).json()) as { log: Entry[] }).log
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor({ timeout: 10_000 })
    const from = Date.now()
    const tree = (deploy: string, docs: string) => ({
      sessions: [
        { id: "ses_mock", title: "Mock session", state: "working", blockers: [] },
        { id: "ses_w_deploy", parentID: "ses_mock", title: "Deploy check", state: deploy, blockers: [] },
        { id: "ses_w_docs", parentID: "ses_mock", title: "Changelog", state: docs, blockers: [] },
      ],
    })
    await mock("/mock/status", tree("working", "working"))
    await page.getByText(/2 subagents working/).first().waitFor({ timeout: 10_000 })
    // The voice agent is mid-reply when the first worker finishes: its announcement waits for that sentence.
    await mock("/mock/emit", { type: "say", sessionID: "ses_mock", messageID: "msg_ack", ordinal: 0, seq: 0, text: "Both are running now." })
    await page.waitForTimeout(150)
    await mock("/mock/status", tree("idle", "working"))
    await mock("/mock/emit", { type: "say", sessionID: "ses_mock", messageID: "msg_deploy", ordinal: 0, text: "Deploy check finished: The deploy is green." })
    await page.waitForTimeout(150)
    await mock("/mock/status", tree("idle", "idle"))
    await mock("/mock/emit", { type: "say", sessionID: "ses_mock", messageID: "msg_docs", ordinal: 0, text: "Changelog finished: The changelog is updated." })
    const wanted = ["Both are running now.", "Deploy check finished: The deploy is green.", "Changelog finished: The changelog is updated."]
    let speaks: Entry[] = []
    for (let i = 0; i < 50; i++) {
      speaks = (await log()).filter((e) => e.path === "/api/speak" && e.at >= from && wanted.includes(e.body?.text))
      if (speaks.length >= 3) break
      await page.waitForTimeout(200)
    }
    assert(JSON.stringify(speaks.map((e) => e.body.text)) === JSON.stringify(wanted), `spoken in order: ${JSON.stringify(speaks.map((e) => e.body?.text))}`)
    await page.getByText("Changelog finished: The changelog is updated.").waitFor()
    // Nothing was interrupted along the way.
    assert(!(await log()).some((e) => e.at >= from && e.path.endsWith("/interrupt")), "no interrupt")
    await mock("/mock/status", { sessions: [{ id: "ses_mock", title: "Mock session", state: "idle", blockers: [] }] })
    await page.locator(".voice-bar").getByRole("button", { name: "End", exact: true }).click()
    await page.locator(".voice-bar").waitFor({ state: "detached" })
  })

  await check("voice speed: no page errors", async () => assert(!errors.length, errors.join("; ")))
  await context.close()
}

type LogEntry = { at: number; method: string; path: string; body?: any }
const mockLog = async () => ((await (await fetch(`${BASE}/mock/log`)).json()) as { log: LogEntry[] }).log

/**
 * Speech detection on a noisy desk: Chromium's fake microphone loops an 8 s recording of background noise (a fan
 * burst, typing, clatter, a beep, mains hum). With the on-device model nothing is sent; with the model blocked
 * (the energy fallback, as before the model) the same noise is taken for speech.
 */
async function noiseRejection(browser: Browser): Promise<void> {
  for (const blocked of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] })
    if (blocked) await context.route(/\.onnx$/, (route) => route.abort())
    const page = await context.newPage()
    current = page
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    const name = blocked ? "voice noise: without the model (energy fallback) the same noise is taken for speech" : "voice noise: background noise (fan, typing, clatter, beep, hum) sends nothing with the on-device model"
    await check(name, async () => {
      await mock("/mock/reset-transcripts")
      await mock("/mock/transcripts", { texts: ["Thank you.", "Thank you.", "Thank you.", "Thank you.", "Thank you.", "Thank you."] })
      await page.goto(`${BASE}/s/ses_mock`)
      await page.locator(".msg.assistant").first().waitFor()
      await page.getByRole("button", { name: "Start Voice mode" }).click()
      await page.locator(".voice-bar .voice-state").getByText(/Listening|Thinking/).waitFor({ timeout: 10_000 })
      if (!blocked) await page.locator('.voice-bar[data-vad="silero"]').waitFor({ timeout: 15_000 })
      const from = Date.now()
      await page.waitForTimeout(9000) // the whole noise loop, plus a second
      const log = (await mockLog()).filter((e) => e.at >= from)
      const transcribed = log.filter((e) => e.path === "/api/transcribe").length
      const utterances = log.filter((e) => e.path.endsWith("/utterance"))
      assert(!utterances.length, `no utterance: ${JSON.stringify(utterances.map((e) => e.body))}`)
      if (blocked) {
        assert((await page.locator(".voice-bar").getAttribute("data-vad")) === "energy", "the energy detector runs")
        assert(transcribed > 0, "the energy detector sends noise to transcription (so the noise is a real test)")
        // ...and the junk filter still keeps Whisper's "Thank you." from reaching the agent.
        await page.locator(".voice-bar .voice-ignored").getByText("Thank you.").waitFor({ timeout: 5000 })
      } else {
        assert(transcribed === 0, `nothing sent to transcription, got ${transcribed}`)
        await shot(page, "voice-noise-ignored")
      }
      await page.locator(".voice-bar").getByRole("button", { name: "End", exact: true }).click()
      await page.locator(".voice-bar").waitFor({ state: "detached" })
      assert(!errors.length, errors.join("; "))
    })
    await context.close()
  }
}

/**
 * Speech detection hears speech: the fake microphone loops a spoken request (1 s in, 3 s long, then silence).
 * The first transcript is a Whisper hallucination ("Thank you."): shown as ignored, not sent; the next is sent.
 */
async function speechDetection(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] })
  const page = await context.newPage()
  current = page
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await check("voice speech: a spoken request becomes one utterance; a hallucinated “Thank you.” is shown as ignored; model time per chunk", async () => {
    await mock("/mock/reset-transcripts")
    await page.goto(`${BASE}/s/ses_mock`)
    await page.locator(".msg.assistant").first().waitFor()
    await page.getByRole("button", { name: "Start Voice mode" }).click()
    await page.locator('.voice-bar[data-vad="silero"]').waitFor({ timeout: 15_000 })
    await mock("/mock/transcripts", { texts: ["Thank you.", "Can you check whether the build passed on main, please?"] })
    const from = Date.now()
    await page.locator(".voice-bar .voice-ignored").getByText("Thank you.").waitFor({ timeout: 12_000 })
    await shot(page, "voice-ignored")
    const sent = page.waitForResponse((r) => r.url().endsWith("/utterance"), { timeout: 12_000 })
    await sent
    const utterances = (await mockLog()).filter((e) => e.at >= from && e.path.endsWith("/utterance"))
    assert(utterances.length === 1, `one utterance, got ${JSON.stringify(utterances.map((e) => e.body))}`)
    assert(utterances[0]!.body?.text === "Can you check whether the build passed on main, please?", `the request: ${JSON.stringify(utterances[0]!.body)}`)
    const title = (await page.locator(".voice-bar .voice-state").getAttribute("title")) ?? ""
    const measured = /on-device model \(([\d.]+) ms per 32 ms of audio\)/.exec(title)?.[1]
    assert(Number(measured) >= 0 && Number(measured) < 16, `model round trip per 32 ms chunk: ${title}`)
    console.log(`voice speech: Silero round trip ${measured} ms per 32 ms chunk (worker message + inference)`)
    await page.locator(".voice-bar").getByRole("button", { name: "End", exact: true }).click()
    await page.locator(".voice-bar").waitFor({ state: "detached" })
    assert(!errors.length, errors.join("; "))
  })
  await context.close()
}

/** 8 s of background noise for the fake microphone: hum and room tone, a fan burst, typing, clatter, a beep. */
function noiseWav(file: string): string {
  const rate = 16_000
  let seed = 11
  const rnd = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const out = new Float32Array(rate * 8)
  for (let i = 0; i < out.length; i++) {
    const t = i / rate
    let x = 0.004 * Math.sin(2 * Math.PI * 60 * t) + (rnd() * 2 - 1) * 0.002
    if (t >= 0.6 && t < 1.6) x += (rnd() * 2 - 1) * 0.15 // a fan switching on
    if (t >= 2.2 && t < 4.2 && i % Math.round(rate / 7) < 50) x += (rnd() * 2 - 1) * 0.5 * Math.exp(-(i % Math.round(rate / 7)) / 12) // typing
    if (t >= 4.8 && t < 5.6 && i % 397 < 30) x += (rnd() * 2 - 1) * 0.4 * Math.exp(-(i % 397) / 6) // clatter
    if (t >= 6.2 && t < 7) x += 0.2 * Math.sin(2 * Math.PI * 1000 * t) // a beep
    out[i] = x
  }
  writeFileSync(file, encodeWav(out, rate))
  return file
}

/** The spoken request fixture with 1 s of silence before and 4 s after (8 s, looped by the fake microphone). */
function speechWav(file: string): string {
  const speech = readWav(path.join(ROOT, "test", "fixtures", "speech-16k.wav"))
  const out = new Float32Array(speech.rate * 8)
  out.set(speech.samples, speech.rate)
  writeFileSync(file, encodeWav(out, speech.rate))
  return file
}

/** A silent 16 kHz mono WAV for Chromium's fake microphone. */
function silentWav(file: string): string {
  const samples = 16_000 * 2
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)))
  ascii(0, "RIFF")
  view.setUint32(4, bytes.length - 8, true)
  ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, samples * 2, true)
  writeFileSync(file, bytes)
  return file
}

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
  // Widths remembered from a desktop session must not leak into the phone layout.
  await context.addInitScript(() => localStorage.setItem("hub.panels", JSON.stringify({ side: 480, rail: 640 })))
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))

  await check("phone: home is a list, sidebar is a drawer", async () => {
    await page.goto(`${BASE}/`)
    await page.locator(".home-list .home-item").nth(3).waitFor()
    assert((await page.locator(".sessions-table").count()) === 0, "no table on phone")
    assert((await page.locator(".sidebar").count()) === 0, "sidebar closed")
    // No exposed-only Voice badges; a dot only on sessions live in Voice (the fixture in a conversation).
    assert((await page.locator(".home-list .voice-badge").count()) === 0, "no Voice badges")
    const live = await page.locator(".home-list .home-item").evaluateAll((lis) => lis.filter((li) => li.querySelector(".voice-dot")).length)
    assert(live <= 1, `at most one live dot: ${live}`)
    await shot(page, "phone-home")
    await page.getByRole("button", { name: "Open sidebar" }).click()
    await page.locator(".sidebar").waitFor()
    // Stored desktop widths do not apply: the drawer keeps its size and has no resize handle.
    assert((await page.locator(".panel-handle").count()) === 0, "no resize handles on phone")
    const drawer = await page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width)
    assert(drawer === Math.min(390 * 0.86, 320), `drawer width unaffected: ${drawer}`)
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
    assert((await page.locator(".panel-handle").count()) === 0, "no rail resize handle on phone")
    await shot(page, "phone-rail-sheet")
    await page.getByRole("button", { name: "Close details" }).click()
  })

  await check("phone: no page errors", async () => assert(!errors.length, errors.join("; ")))
  await context.close()
}

/** Rich Markdown (session "Benchmark harness": RICH_MARKDOWN in the mock hub) and the text size: Settings, pinch, persistence. */
/** Progressive history (POST /mock/big): newest page first, older pages while scrolling up, anchored. */
async function progressiveHistory(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  current = page
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  const timelineCalls = async () => ((await (await fetch(`${BASE}/mock/log`)).json()) as { log: Array<{ path: string; query?: string }> }).log.filter((e) => e.path === "/api/sessions/ses_big/timeline")
  let bytes = 0
  page.on("response", (r) => {
    if (r.url().includes("/ses_big/timeline")) void r.body().then((b) => (bytes += b.length), () => undefined)
  })
  const scroller = page.locator(".scroller")
  const atBottom = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4)
  /** The first conversation row in view and its offset from the scroller's top. */
  const firstVisible = () =>
    scroller.evaluate((el) => {
      const top = el.getBoundingClientRect().top
      const rows = Array.from(el.querySelectorAll<HTMLElement>(".transcript > [data-key]"))
      const row = rows.find((r) => r.getBoundingClientRect().bottom > top + 1)!
      return { key: row.dataset.key!, offset: row.getBoundingClientRect().top - top }
    })
  const offsetOf = (key: string) => scroller.evaluate((el, k) => el.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`)!.getBoundingClientRect().top - el.getBoundingClientRect().top, key)
  await mock("/mock/big", { on: true, delayMs: 300 })

  await check("history: a long session opens on its newest rows with one request, stuck to the bottom", async () => {
    const started = Date.now()
    await page.goto(`${BASE}/s/ses_big`)
    await page.getByText("Answer 899.").waitFor()
    const ms = Date.now() - started
    await page.waitForTimeout(300)
    const calls = await timelineCalls()
    assert(calls.length === 1, `one timeline request, got ${calls.map((c) => c.query).join(" ")}`)
    assert(calls[0]!.query?.includes("order=desc"), `newest-first request: ${calls[0]!.query}`)
    assert(await atBottom(), "at the bottom")
    assert(!(await page.getByText("Question 0:").count()), "older rows not loaded yet")
    measured.push(`history: newest rows shown after ${ms} ms, ${bytes} bytes of timeline`)
    await shot(page, "history-open")
  })

  await check("history: scrolling up loads older pages in place, then shows the beginning", async () => {
    const anchor = await firstVisible()
    await scroller.evaluate((el) => (el.scrollTop = 0))
    await page.locator(".history-edge", { hasText: "Loading earlier" }).waitFor()
    const loadingAnchor = await firstVisible()
    await page.waitForFunction(() => !document.querySelector(".history-edge.loading"))
    const calls = await timelineCalls()
    assert(calls.length === 2 && calls[1]!.query?.includes("before="), `older page asked: ${calls.map((c) => c.query).join(" ")}`)
    // What was on screen stays where it was (the rows above it are new).
    const moved = Math.abs((await offsetOf(loadingAnchor.key)) - loadingAnchor.offset)
    assert(moved <= 2, `anchored row moved ${moved}px (${loadingAnchor.key}; first anchor ${anchor.key})`)
    assert(!(await atBottom()), "not thrown to the bottom")
    await shot(page, "history-older")
    for (let i = 0; i < 40 && !(await page.getByText("Beginning of conversation").count()); i++) {
      await scroller.evaluate((el) => (el.scrollTop = 0))
      await page.waitForTimeout(150)
      await page.waitForFunction(() => !document.querySelector(".history-edge.loading"))
    }
    await page.getByText("Beginning of conversation").waitFor()
    await page.getByText("Question 0: what about step 0?").waitFor()
    const all = await timelineCalls()
    const keys = await page.locator(".transcript > [data-key]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key))
    assert(new Set(keys).size === keys.length, "no duplicate rows")
    const users = await page.locator(".msg.user").count()
    assert(users === 450, `every question shown once, got ${users}`)
    measured.push(`history: whole history in ${all.length} requests, ${bytes} bytes`)
  })

  await check("history: a live reply appends at the bottom (and does not pull the reader down)", async () => {
    await scroller.evaluate((el) => (el.scrollTop = 0))
    await mock("/mock/emit", { type: "delta", sessionID: "ses_big", rootID: "ses_big", messageID: "msg_live_1", text: "Live while reading old history." })
    await page.getByText("Live while reading old history.").waitFor()
    assert((await scroller.evaluate((el) => el.scrollTop)) < 50, "reader stays at the top")
    const last = await page.locator(".transcript > [data-key]").last().textContent()
    assert(last?.includes("Live while reading old history."), `live row last: ${last}`)
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight))
    await page.waitForTimeout(100)
    await mock("/mock/emit", { type: "delta", sessionID: "ses_big", rootID: "ses_big", messageID: "msg_live_2", text: "Second live reply." })
    await page.getByText("Second live reply.").waitFor()
    await page.waitForTimeout(100)
    assert(await atBottom(), "at the bottom: follows the new reply")
  })

  await check("history: a failed older page shows Retry, which loads it", async () => {
    await mock("/mock/big", { failOlder: true, delayMs: 0 })
    await page.reload()
    await page.getByText("Answer 899.").waitFor()
    await scroller.evaluate((el) => (el.scrollTop = 0))
    const retry = page.locator(".history-edge.error").getByRole("button", { name: "Retry" })
    await retry.waitFor()
    await mock("/mock/big", { failOlder: false })
    await retry.click()
    await page.waitForFunction(() => !document.querySelector(".history-edge.error, .history-edge.loading"))
    assert((await page.locator(".msg.user").count()) > 40, "older page shown after Retry")
    await shot(page, "history-retry")
  })

  await check("history: more than 2000 rows still opens on the newest ones", async () => {
    await mock("/mock/reset")
    await mock("/mock/big", { on: true, messages: 2400 })
    await page.goto(`${BASE}/s/ses_big`)
    await page.getByText("Answer 2399.").waitFor()
    assert(await atBottom(), "at the bottom")
    assert(!errors.length, `page errors: ${errors.join("; ")}`)
  })
  await context.close()
}

async function markdownAndTextSize(browser: Browser): Promise<void> {
  const RICH = "/s/ses_52"
  const transcriptPx = (page: Page) => page.locator(".msg.assistant").last().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const scaleOf = (page: Page) => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--font-scale") || 1))
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] })
  const page = await context.newPage()
  current = page
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))

  await check("markdown: table, task list, highlight, strike, autolink, highlighted code with copy", async () => {
    await page.goto(`${BASE}${RICH}`)
    const md = page.locator(".msg.assistant").last()
    await md.locator("table").waitFor()
    assert((await md.locator("th").count()) === 4, "4 header cells")
    assert((await md.locator("tbody tr").count()) === 3, "3 rows")
    assert((await md.locator("th").nth(1).evaluate((el) => getComputedStyle(el).textAlign)) === "right", "right-aligned column")
    assert((await md.locator("li.task input[type=checkbox][disabled]").count()) === 2, "two task checkboxes, disabled")
    assert((await md.locator("li.task input:checked").count()) === 1, "one done")
    assert((await md.locator("mark").textContent()) === "pgvector is fastest", "==highlight==")
    assert((await md.locator("del").textContent()) === "FAISS on CPU", "~~strike~~")
    assert((await md.locator('a[href="https://example.com/bench/run-42"]').count()) === 1, "bare URL autolinked")
    assert((await md.locator("ol > li > ul").count()) === 1, "nested list")
    assert((await md.locator("blockquote ul").count()) === 1, "list inside a quote")
    await md.locator(".tok-keyword").first().waitFor()
    assert((await md.locator(".code-block .tok-del").textContent()) === "-const LISTS = 50", "diff colored")
    await md.getByRole("button", { name: "Copy ts code" }).click()
    await md.getByRole("button", { name: "Copied" }).waitFor()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    assert(copied.startsWith("// Run one query and time it\nexport async function timeQuery"), `clipboard: ${copied.slice(0, 40)}`)
    const overflow = await page.locator(".scroller").evaluate((el) => el.scrollWidth - el.clientWidth)
    assert(overflow <= 0, `no horizontal overflow in the transcript (${overflow}px)`)
    await md.locator("table").scrollIntoViewIfNeeded()
    await shot(page, "markdown-desktop")
  })

  await check("text size: Settings → Appearance slider scales the transcript; Reset", async () => {
    const base = await transcriptPx(page)
    assert(Math.abs(base - 14) < 0.5, `default transcript size 14px: ${base}`)
    await page.goto(`${BASE}/settings#appearance`)
    const slider = page.getByRole("slider", { name: "Text size" })
    await slider.fill("1.4")
    await page.locator("output[for=text-size]").getByText("140%").waitFor()
    await page.goto(`${BASE}${RICH}`)
    await page.locator(".msg.assistant").last().waitFor()
    const big = await transcriptPx(page)
    assert(Math.abs(big - 14 * 1.4) < 0.5, `scaled transcript: ${big}`)
    await page.goto(`${BASE}/settings#appearance`)
    await page.getByRole("button", { name: "Reset text size" }).click()
    await page.locator("output[for=text-size]").getByText("100%").waitFor()
    assert((await page.evaluate(() => localStorage.getItem("hub.fontScale"))) === null, "default not stored")
  })

  await check("text size: ctrl+wheel (trackpad pinch) on the transcript, not elsewhere", async () => {
    await page.goto(`${BASE}${RICH}`)
    await page.locator(".msg.assistant").last().waitFor()
    const prevented = await page.locator(".scroller").evaluate((el) => {
      const e = new WheelEvent("wheel", { ctrlKey: true, deltaY: -30, bubbles: true, cancelable: true })
      el.dispatchEvent(e)
      return e.defaultPrevented
    })
    assert(prevented, "page zoom prevented in the transcript")
    assert((await scaleOf(page)) > 1.2, `grew: ${await scaleOf(page)}`)
    const outside = await page.locator(".topbar").evaluate((el) => {
      const e = new WheelEvent("wheel", { ctrlKey: true, deltaY: -30, bubbles: true, cancelable: true })
      el.dispatchEvent(e)
      return e.defaultPrevented
    })
    assert(!outside, "browser zoom left alone outside the transcript")
    await page.waitForFunction(() => localStorage.getItem("hub.fontScale") !== null)
    await page.evaluate(() => localStorage.removeItem("hub.fontScale"))
  })
  await check("markdown + text size: no page errors (desktop)", async () => assert(!errors.length, errors.join("; ")))
  await context.close()

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const p = await phone.newPage()
  current = p
  p.on("pageerror", (e) => errors.push(e.message))
  await check("phone: a two-finger pinch on the transcript scales the text and persists after reload", async () => {
    await p.goto(`${BASE}${RICH}`)
    await p.locator(".msg.assistant").last().waitFor()
    const before = await transcriptPx(p)
    await p.locator(".scroller").evaluate(async (el) => {
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const fire = (type: string, id: number, x: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: cy, bubbles: true, cancelable: true }))
      fire("pointerdown", 1, cx - 50)
      fire("pointerdown", 2, cx + 50)
      for (let d = 50; d <= 70; d += 5) {
        fire("pointermove", 1, cx - d)
        fire("pointermove", 2, cx + d)
        await new Promise((r) => requestAnimationFrame(r))
      }
      fire("pointerup", 1, cx - 70)
      fire("pointerup", 2, cx + 70)
    })
    const after = await transcriptPx(p)
    assert(Math.abs(after - before * 1.4) < 0.6, `pinch 100→140 px apart: ${before} → ${after}`)
    assert((await p.evaluate(() => localStorage.getItem("hub.fontScale"))) === "1.4", "stored")
    await p.reload()
    await p.locator(".msg.assistant").last().waitFor()
    assert(Math.abs((await transcriptPx(p)) - before * 1.4) < 0.6, "kept after reload")
    await p.locator(".md table").scrollIntoViewIfNeeded()
    await shot(p, "markdown-phone-1.4")
  })
  await check("phone: layout holds at the largest text size (1.8); inputs are ≥ 16px", async () => {
    await p.evaluate(() => localStorage.setItem("hub.fontScale", "1.8"))
    await p.reload()
    await p.locator(".msg.assistant").last().waitFor()
    assert(Math.abs((await transcriptPx(p)) - 14 * 1.8) < 0.6, "1.8 applied before the app")
    const wide = await p.evaluate(() => document.documentElement.scrollWidth)
    assert(wide <= 390, `no page-wide horizontal scroll: ${wide}`)
    const composer = await p.getByLabel("Message").boundingBox()
    assert(composer && composer.x >= 0 && composer.x + composer.width <= 390 && composer.y + composer.height <= 844, `composer on screen: ${JSON.stringify(composer)}`)
    const topbar = await p.locator(".topbar").boundingBox()
    assert(topbar && topbar.width <= 390, "top bar fits")
    const table = await p.locator(".md .table-wrap").evaluate((el) => ({ scroll: el.scrollWidth > el.clientWidth, right: el.getBoundingClientRect().right }))
    assert(table.right <= 390, `table scrolls inside its box: ${JSON.stringify(table)}`)
    const inputPx = await p.getByLabel("Message").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    assert(inputPx >= 16, `composer ≥ 16px: ${inputPx}`)
    await shot(p, "markdown-phone-1.8")
    await p.evaluate(() => localStorage.setItem("hub.fontScale", "0.8"))
    await p.reload()
    await p.locator(".msg.assistant").last().waitFor()
    assert((await p.getByLabel("Message").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) >= 16, "still ≥ 16px at 0.8")
  })
  await check("phone: markdown + text size: no page errors", async () => assert(!errors.length, errors.join("; ")))
  await phone.close()
}

mkdirSync(SHOTS, { recursive: true })
if (!existsSync(path.join(ROOT, "web", "dist", "index.html"))) {
  console.error("web/dist is missing: run `npm run build:web` first")
  process.exit(1)
}
const hub = Bun.spawn(["bun", path.join(ROOT, "test", "web-mock-hub.ts"), String(PORT)], { stdout: "ignore", stderr: "inherit" })
let browser: Browser | undefined
let quiet: Browser | undefined
let noisy: Browser | undefined
let speaking: Browser | undefined
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
  await markdownAndTextSize(browser)
  await mock("/mock/reset")
  await progressiveHistory(browser)
  await mock("/mock/reset")
  await notifications(browser)
  await mock("/mock/reset")
  await tapToStart(browser)
  await mock("/mock/reset")
  quiet = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${silentWav(path.join(SHOTS, "silence.wav"))}`],
  })
  await voiceSpeed(quiet)
  await mock("/mock/reset")
  await voiceScreenOff(quiet)
  await mock("/mock/reset")
  const fakeMic = (file: string) => ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${file}`]
  noisy = await chromium.launch({ executablePath, headless: true, args: fakeMic(noiseWav(path.join(SHOTS, "noise.wav"))) })
  await noiseRejection(noisy)
  await mock("/mock/reset")
  speaking = await chromium.launch({ executablePath, headless: true, args: fakeMic(speechWav(path.join(SHOTS, "speech.wav"))) })
  await speechDetection(speaking)
} catch (e) {
  failures++
  results.push(`✗ setup: ${(e as Error).message}`)
} finally {
  await browser?.close()
  await quiet?.close()
  await noisy?.close()
  await speaking?.close()
  hub.kill()
}
console.log(results.join("\n"))
if (measured.length) console.log(`\nMeasured:\n${measured.map((m) => `  ${m}`).join("\n")}`)
console.log(`\n${results.length - failures}/${results.length} checks passed · screenshots in ${SHOTS}`)
process.exit(failures ? 1 : 0)
