import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const promptSourceRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../prompts");
export const promptFragments = [
  "base.pi.md", "brief-exchange.pi.md", "core-lead.pi.md",
  "core-teammate.pi.md", "core-agent.pi.md", "voice.md",
];

// Tests exercise this checkout, never a developer's ~/.agents installation.
export function createPromptFixture() {
  const dir = mkdtempSync(join(tmpdir(), "rubato-role-contract-"));
  try {
    for (const file of ["build.sh", ...promptFragments]) {
      copyFileSync(join(promptSourceRoot, file), join(dir, file));
    }
    const result = spawnSync("bash", [join(dir, "build.sh")], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw new Error(`Role prompt build failed: ${result.error ?? result.stderr ?? result.stdout}`);
    }
    return {
      dir,
      env: { RUBATO_PROMPTS_DIR: dir },
      read(name) { return readFileSync(join(dir, ".build", name), "utf8"); },
      dispose() { rmSync(dir, { recursive: true, force: true }); },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
