import { describe, expect, test } from "bun:test"

import {
  CURSOR_GROK_DEFAULT_FAST_ID,
  CURSOR_GROK_PRESENTED_ID,
  cursorGrokLaunchModel,
  expandCursorGrokVisibility,
} from "./cursor-grok-ids"

describe("cursor Grok catalog identity", () => {
  test("#given a raw catalog that only lists Fast #when expanded #then the presented picker id is visible", () => {
    const visible = expandCursorGrokVisibility(new Set([CURSOR_GROK_DEFAULT_FAST_ID]))
    expect(visible.has(CURSOR_GROK_PRESENTED_ID)).toBe(true)
    expect(visible.has(CURSOR_GROK_DEFAULT_FAST_ID)).toBe(true)
  })

  test("#given a filtered catalog that only lists the presented id #when expanded #then Fast ids are visible", () => {
    const visible = expandCursorGrokVisibility(new Set([CURSOR_GROK_PRESENTED_ID]))
    expect(visible.has(CURSOR_GROK_DEFAULT_FAST_ID)).toBe(true)
  })

  test("#given unrelated models #when expanded #then the set is unchanged", () => {
    const source = new Set(["xai/grok-4.6"])
    expect(expandCursorGrokVisibility(source)).toEqual(source)
  })

  test("#given the presented picker id #when launching a child #then --model is the live Fast row", () => {
    expect(cursorGrokLaunchModel(CURSOR_GROK_PRESENTED_ID)).toBe(CURSOR_GROK_DEFAULT_FAST_ID)
    expect(cursorGrokLaunchModel("xai/grok-4.6")).toBe("xai/grok-4.6")
  })
})
