#!/usr/bin/env bun
// Hub server entry point (`hub-server`, aliases `opencode-hub` and `opencode-voice-hub`): `bun bin/hub.ts [--help | --version]`,
// configured by HUB_* env vars over ~/.config/hub/hub.json ($HUB_CONFIG); see src/central/config.ts. Serves the
// built web app (web/dist, `npm run build:web`) from disk. The standalone binaries embed it instead
// (scripts/build-binaries.sh).
import { readFileSync } from "node:fs"
import path from "node:path"
import { diskAssets } from "../src/central/assets"
import { runHub } from "../src/central/main"

const root = path.join(import.meta.dir, "..")
const version = (() => {
  try {
    return String(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version ?? "0.0.0")
  } catch {
    return "0.0.0"
  }
})()

runHub({ web: diskAssets(path.join(root, "web", "dist")), version })
