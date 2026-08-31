import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const workflowRoot = join(import.meta.dirname, "..", "..", ".github", "workflows")
const workflowPath = join(workflowRoot, "zmx-release.yml")

test("Stage 9 CI and signed release verify the Hub npm lock independently of Bun", async () => {
  for (const name of ["remote-stage9-ci.yml", "remote-release.yml"]) {
    const workflow = await readFile(join(workflowRoot, name), "utf8")
    assert.match(workflow, /npm --prefix packages\/rubato-remote-hub ci --dry-run --ignore-scripts/)
    assert.match(workflow, /bun install --frozen-lockfile/)
  }
})

test("zmx workflow builds and smokes each target on its explicit native runner", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  assert.match(workflow, /runner: macos-15-arm64\n\s+machine: arm64\n\s+platform: darwin-arm64\n\s+target: aarch64-macos/)
  assert.match(workflow, /runner: macos-15-intel\n\s+machine: x86_64\n\s+platform: darwin-x64\n\s+target: x86_64-macos/)
  const native = workflow.slice(workflow.indexOf("  build-smoke-native:"), workflow.indexOf("  combine-sign-release:"))
  assert.match(native, /runs-on: \$\{\{ matrix\.runner \}\}/)
  assert.match(native, /test "\$\(uname -m\)" = "\$EXPECTED_MACHINE"/)
  assert.match(native, /build-zmx-release\.mjs[\s\S]*--platform '\$\{\{ matrix\.platform \}\}'/)
  assert.match(native, /smoke-zmx-release\.mjs/)
  assert.doesNotMatch(native, /RUBATO_RELEASE_SIGNING_KEY|attest-build-provenance/)
})

test("zmx signing combines only exact downloaded native artifacts without rebuilding", async () => {
  const workflow = await readFile(workflowPath, "utf8")
  const combine = workflow.slice(workflow.indexOf("  combine-sign-release:"), workflow.indexOf("  release-upload:"))
  const upload = workflow.slice(workflow.indexOf("  release-upload:"))
  assert.match(combine, /needs: build-smoke-native/)
  assert.match(combine, /permissions:\n\s+contents: read\n\s+id-token: write\n\s+attestations: write/)
  assert.match(combine, /name: zmx-native-darwin-arm64[\s\S]*path: \$\{\{ runner\.temp \}\}\/native\/darwin-arm64/)
  assert.match(combine, /name: zmx-native-darwin-x64[\s\S]*path: \$\{\{ runner\.temp \}\}\/native\/darwin-x64/)
  assert.match(combine, /combine-zmx-release\.mjs[\s\S]*--partial "\$RUNNER_TEMP\/native\/darwin-arm64"[\s\S]*--partial "\$RUNNER_TEMP\/native\/darwin-x64"/)
  assert.doesNotMatch(combine, /build-zmx-release\.mjs|smoke-zmx-release\.mjs/)
  assert.match(combine, /attest-build-provenance/)
  assert.doesNotMatch(combine, /contents: write|gh release upload/)
  assert.match(upload, /needs: combine-sign-release[\s\S]*permissions:\n\s+contents: write/)
  assert.match(upload, /name: zmx-qualified-darwin[\s\S]*gh release upload/)
  assert.doesNotMatch(upload, /id-token: write|attestations: write|combine-zmx-release/)
})
