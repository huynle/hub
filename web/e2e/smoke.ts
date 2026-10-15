#!/usr/bin/env bun
// Headless smoke test of the built console against the mock hub (test/web-mock-hub.ts), at desktop (1440×900) and
// phone (390×844) sizes: home loads, a session opens with its timeline, Send → Steer/Stop → Send, the right rail and
// diff viewer render, and a Voice-off session is inspectable. Screenshots go to $SMOKE_SHOTS (default: the OS temp
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

  await check("desktop: diff viewer opens over the transcript", async () => {
    await page.locator(".rail .file").first().click()
    await page.locator(".diff-panel table.diff tr.add").first().waitFor()
    await shot(page, "desktop-diff")
    await page.getByRole("button", { name: "Close diff" }).click()
  })

  await check("desktop: model menu lists models with number keys", async () => {
    await page.locator(".composer-meta .model-chip").nth(1).click()
    await page.locator(".dialog .picker-opt").first().waitFor()
    assert((await page.locator(".dialog .picker-opt kbd").first().textContent()) === "1", "number key hint")
    await shot(page, "desktop-model-picker")
    await page.keyboard.press("Escape")
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
    await shot(page, "desktop-voice-bar")
    await page.getByRole("button", { name: "Mute" }).click()
    await page.locator(".voice-bar .voice-state").getByText("Muted").waitFor()
    await page.locator(".voice-bar").getByRole("button", { name: "End", exact: true }).click()
    await page.locator(".voice-bar").waitFor({ state: "detached" })
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
    await page.getByRole("button", { name: "Create session" }).waitFor()
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
