// Rebuild from the immutable upstream source plus our local patch. Never touches npm's binary.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Build on darwin-arm64");
const root = dirname(fileURLToPath(import.meta.url));
const checkout = join(mkdtempSync(join(tmpdir(), "rubato-pty-build-")), "source");
const run = (cmd, args, cwd = checkout) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
run("git", ["clone", "--depth", "1", "--branch", "v2026.9.4-3", "--filter=blob:none", "--sparse",
	"https://github.com/code-yeongyu/senpi.git", checkout], tmpdir());
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
if (commit !== "b0a446488dafc813ec2ff56e515668c0fa990027") throw new Error("Upstream tag moved");
run("git", ["sparse-checkout", "set", "crates/senpi-pty"]);
run("git", ["apply", join(root, "nonblocking-input.patch")]);
run(process.env.CARGO ?? join(process.env.HOME, ".cargo/bin/cargo"), ["build", "--locked", "--release", "-p", "senpi-pty"]);
copyFileSync(join(checkout, "target/release/libsenpi_pty.dylib"), join(root, "prebuilds/darwin-arm64/senpi_pty.darwin-arm64.node"));
console.log(`Source retained at ${checkout}`);
