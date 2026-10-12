#!/usr/bin/env bun
// Central voice server entry point: `bun bin/hub.ts [--help | --version]`, configured by VOICE_* env vars
// over ~/.config/opencode-voice/hub.json ($VOICE_HUB_CONFIG); see src/central/config.ts. Serves web/ from
// disk. The standalone binaries embed web/ instead (scripts/build-binaries.sh).
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

runHub({ web: diskAssets(path.join(root, "web")), version })
