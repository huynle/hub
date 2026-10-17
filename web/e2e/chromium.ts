// Finds a Chromium for headless runs (web/e2e/smoke.ts, scripts/gen-icons.ts): $CHROMIUM_PATH, else
// Playwright's own, else its cache, else a system Chromium.
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { chromium } from "playwright-core"

export function chromiumPath(): string | undefined {
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
