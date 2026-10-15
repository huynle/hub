import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(".github/workflows/ci.yml").text();

function releaseImageJob(): string {
  const start = workflow.indexOf("  release-image:\n");
  if (start < 0) throw new Error("release-image job is missing");
  const remainder = workflow.slice(start + "  release-image:\n".length);
  const nextJob = remainder.search(/^  \S[^\n]*:\s*$/m);
  return workflow.slice(start, nextJob < 0 ? undefined : start + "  release-image:\n".length + nextJob);
}

describe("public repository release workflow", () => {
  test("uses a GitHub-hosted runner override", () => {
    const job = releaseImageJob();

    expect(job).toContain("runner: ubuntu-latest");
    expect(job).not.toMatch(/runner:\s*self-hosted/);
  });

  test("publishes the renamed OpenCode Hub image", () => {
    expect(releaseImageJob()).toContain("image: ghcr.io/huynle/opencode-hub\n");
  });

  test("retains the supported multi-architecture platforms", () => {
    expect(releaseImageJob()).toContain("platforms: linux/amd64,linux/arm64");
  });
});
