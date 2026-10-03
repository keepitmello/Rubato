import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { assertStockPiPins } from "./doctor.mjs"

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
const root = readJson("../../package.json")
const engine = readJson("../../harness/pi-runtime/package.json")

test("the checked-in root pins the engine's stock pi", () => {
  assert.deepEqual(assertStockPiPins({ root, engine }), { version: engine.dependencies["@earendil-works/pi-coding-agent"] })
})

test("a pi package left on another version fails", () => {
  const drifted = { ...root, devDependencies: { ...root.devDependencies, "@earendil-works/pi-tui": "0.0.1" } }
  assert.throws(() => assertStockPiPins({ root: drifted, engine }), /pi-tui is not exactly pinned/)
})

test("an npm alias to a fork fails even when the version string matches", () => {
  const aliased = { ...root, overrides: { ...root.overrides, "left-pad": "npm:@fork/left-pad@1.0.0" } }
  assert.throws(() => assertStockPiPins({ root: aliased, engine }), /left-pad is aliased/)
})

test("an override that disagrees with the pin fails", () => {
  const overridden = { ...root, overrides: { ...root.overrides, "@earendil-works/pi-ai": "0.0.1" } }
  assert.throws(() => assertStockPiPins({ root: overridden, engine }), /pi-ai override 0.0.1 differs/)
})
