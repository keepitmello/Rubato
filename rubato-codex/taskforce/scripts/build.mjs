import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const packageDirectory = fileURLToPath(new URL("..", import.meta.url))
const outputPath = path.join(packageDirectory, "dist", "mcp-server.mjs")
const checkOnly = process.argv.includes("--check")

const result = await build({
  absWorkingDir: packageDirectory,
  entryPoints: ["src/mcp-server.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["node:*"],
  legalComments: "eof",
  treeShaking: true,
  minify: false,
  sourcemap: false,
  charset: "utf8",
  write: false,
  logLevel: "silent",
})

const bundled = result.outputFiles[0].contents
const digest = createHash("sha256").update(bundled).digest("hex")

if (checkOnly) {
  const checkedIn = await readFile(outputPath)
  if (!checkedIn.equals(bundled)) {
    throw new Error("dist/mcp-server.mjs is stale; run npm run build")
  }
  console.log(`dist/mcp-server.mjs is current (${bundled.byteLength} bytes, sha256 ${digest})`)
} else {
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, bundled)
  await chmod(outputPath, 0o755)
  console.log(`wrote dist/mcp-server.mjs (${bundled.byteLength} bytes, sha256 ${digest})`)
}
