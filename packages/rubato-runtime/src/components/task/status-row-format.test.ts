import { describe, expect, it } from "bun:test"

import { rendererVisibleWidth, type TaskRecord, type TaskStatus } from "@rubato/senpi-task"

import { backgroundWidgetRows, buildWidgetRows, formatTaskRow } from "./status-row-format"

function record(overrides: Partial<TaskRecord> & { task_id: string; status: TaskStatus }): TaskRecord {
  return {
    parent_session_id: "session-a",
    root_session_id: "session-a",
    depth: 0,
    execution_mode: "in-process",
    model: "anthropic/claude-sonnet-4-6",
    residency_state: "resident",
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:01.000Z",
    notification: { run_epoch: 0, notified_epoch: -1 },
    notify_on_terminal: false,
    ...overrides,
  }
}

function longActiveRecord(): TaskRecord {
  return record({
    task_id: "st_01active0123456789",
    name: "active-child",
    status: "running",
    category: "ultrabrain",
    resolved_model: {
      provider: "rubato-mock",
      model_id: "mock-1",
      display: "rubato-mock/mock-1",
      reasoning_effort: "xhigh",
      variant: "xhigh",
      source: "category",
    },
  })
}

describe("buildWidgetRows", () => {
  it("#given active and completed records #when selecting rows #then only resident team members follow active rows before the cap", () => {
    const alpha = record({ task_id: "st_alpha", name: "team:12345678-1234-1234-1234-123456789abc:alpha", task_summary: "settled alpha", status: "completed" })
    const beta = record({ task_id: "st_beta", name: "team:12345678-1234-1234-1234-123456789abc:beta", task_summary: "settled beta", status: "completed" })
    const ordinary = record({ task_id: "st_ordinary", task_summary: "ordinary task", status: "completed" })
    const stale = record({ task_id: "st_stale", name: "team:12345678-1234-1234-1234-123456789abc:stale", task_summary: "stale member", status: "completed" })
    const active = Array.from({ length: 4 }, (_value, index) => record({ task_id: `st_${index}`, status: "running" }))
    const rows = buildWidgetRows([alpha, ordinary, stale, ...active, beta], new Set([alpha.task_id, beta.task_id, ordinary.task_id]))
    expect(rows.slice(0, 4).every((row) => row.includes("running"))).toBe(true)
    expect(rows[4]).toContain("settled alpha")
    expect(rows[4]).toContain("completed")
    expect(rows[5]).toBe("+1 more")
    expect(rows.join("\n")).not.toMatch(/ordinary task|stale member/u)
  })

  it("#given an active task #when building a row #then useful identity and execution context remain", () => {
    const row = buildWidgetRows([
      record({ task_id: "st_row", name: "finder", status: "running", agent_type: "explore", pid: 4242 }),
    ])[0] ?? ""
    expect(row).toContain("finder")
    expect(row).toContain("agent:explore")
    expect(row).toContain("anthropic/")
    expect(row).toContain("in-process")
    expect(row).toContain("running")
    expect(rendererVisibleWidth(row)).toBeLessThanOrEqual(72)
  })

  it("#given a 137-column active task #when building its widget row #then it remains one physical line", () => {
    const row = buildWidgetRows([longActiveRecord()])[0] ?? ""
    expect(row).not.toContain("\n")
    for (const columns of [70, 72, 120]) expect(rendererVisibleWidth(row)).toBeLessThanOrEqual(columns)
    expect(row).toContain("category:ultrabrain")
    expect(row).toContain("rubato-mock/mock-1")
    expect(row).toContain("xhigh")
    expect(row).toContain("in-process")
    expect(row).toContain("running")
  })
})

describe("task_summary identity", () => {
  it("#given a record with a task_summary #when building the widget row #then the summary leads over name and description", () => {
    const row = buildWidgetRows([
      record({ task_id: "st_sum", name: "finder", description: "quick label", task_summary: "Audit auth session flow", status: "running", category: "quick" }),
    ])[0] ?? ""
    expect(row.startsWith("Audi")).toBe(true)
    expect(row).not.toContain("finder")
    expect(row).not.toContain("quick label")
  })

  it("#given a record with a task_summary #when formatting the full row #then the summary is the identity", () => {
    const row = formatTaskRow(record({ task_id: "st_sum", name: "finder", task_summary: "Audit auth session flow", status: "running" }))
    expect(row.startsWith("Audit auth session flow")).toBe(true)
  })
})

describe("backgroundWidgetRows", () => {
  const now = Date.parse("2026-07-07T00:01:00.000Z")
  const stats = {
    turns: 2,
    tool_calls: 4,
    runtime_ms: 60_000,
    cost_usd: 0.1303,
    cache_hit_rate_last: 0.89,
    tokens_per_second: 97,
  }

  it("#given a wide terminal #when a live task row renders #then title, short model, elapsed, and tps remain", () => {
    const row = backgroundWidgetRows([
      record({
        task_id: "st_wide",
        description: "Plan the Spider-Man library",
        task_summary: "Plan the complete Spider-Man media library migration",
        status: "running",
        category: "unspecified-high",
        resolved_model: {
          provider: "xai",
          model_id: "grok-4.6",
          display: "xai/grok-4.6",
          reasoning_effort: "high",
          source: "category",
        },
      }),
    ], new Map([["st_wide", "running read src/library.ts"]]), now, () => stats, 220)[0] ?? ""

    expect(row).toBe("⠋ Plan the Spider-Man library · Grok 4.6 high · 1m 0s · 97 tok/s")
    expect(row).not.toContain("category:")
    expect(row).not.toContain("turn ")
    expect(row).not.toContain("$0.1303")
    expect(row).not.toContain("CH:")
    expect(row).not.toContain("running read")
    expect(rendererVisibleWidth(row)).toBeLessThanOrEqual(220)
  })

  it("#given a long description and a task_summary #when a live row renders #then the short description leads and stays 32 visible chars", () => {
    const row = backgroundWidgetRows([
      record({
        task_id: "st_title",
        description: "Plan the complete Spider-Man media library migration",
        task_summary: "Final review",
        status: "running",
        resolved_model: {
          provider: "xai",
          model_id: "grok-4.6",
          display: "xai/grok-4.6",
          reasoning_effort: "high",
          source: "category",
        },
      }),
    ], new Map(), now, () => stats, 220)[0] ?? ""
    const title = row.split(" · ")[0]?.replace(/^⠋ /u, "") ?? ""
    expect(title).toStartWith("Plan the complete")
    expect(title).not.toContain("Final review")
    expect(rendererVisibleWidth(title)).toBeLessThanOrEqual(32)
    expect(row).toEndWith("97 tok/s")
  })

  it("#given only a routing variant #when a live row renders #then it is not repeated as reasoning effort", () => {
    const row = backgroundWidgetRows([
      record({
        task_id: "st_variant",
        description: "Review tests",
        status: "running",
        resolved_model: {
          provider: "openai",
          model_id: "gpt-5.6-luna",
          display: "openai/gpt-5.6-luna",
          variant: "luna",
          source: "category",
        },
      }),
    ], new Map(), now, () => stats, 220)[0] ?? ""
    expect(row).toContain("Luna 5.6 · 1m 0s")
    expect(row).not.toContain("Luna luna")
  })

  // Two machines resolve the identical provider/model id but their local catalogs differ in whether
  // they carry a friendly `model.name`, so the planner persists `display` as either the id spelling
  // or the friendly one. The rendered identity must not depend on that incidental metadata.
  it("#given the same model resolved with and without a friendly catalog name #when live rows render #then both machines show one identity", () => {
    const rowFor = (display: string): string =>
      backgroundWidgetRows([
        record({
          task_id: "st_display",
          description: "Review tests",
          status: "running",
          resolved_model: {
            provider: "openai",
            model_id: "gpt-5.6-sol",
            display,
            source: "category",
          },
        }),
      ], new Map(), now, () => stats, 220)[0] ?? ""

    // Machine A: no `model.name` in the catalog, so the planner falls back to the id spelling.
    // Machine B: the catalog carries `GPT-5.6 Sol`, which the planner preserves verbatim.
    expect(rowFor("openai/gpt-5.6-sol")).toContain("Sol 5.6")
    expect(rowFor("GPT-5.6 Sol")).toContain("Sol 5.6")
    expect(rowFor("GPT-5.6 Sol")).not.toContain("GPT 5.6")
  })

  it("#given GPT-6 Astra #when a live row renders #then the label is Astra 6", () => {
    const row = backgroundWidgetRows([
      record({
        task_id: "st_astra",
        description: "Review tests",
        status: "running",
        resolved_model: {
          provider: "openai-codex",
          model_id: "gpt-6-astra",
          display: "GPT-6 Astra",
          source: "category",
        },
      }),
    ], new Map(), now, () => stats, 220)[0] ?? ""
    expect(row).toContain("Astra 6")
    expect(row).not.toContain("GPT 6")
  })

  it("#given Muse Spark 1.3 Free #when a live row renders #then the label is Muse Spark 1.3", () => {
    const rowFor = (modelId: string, display?: string) =>
      backgroundWidgetRows([
        record({
          task_id: "st_muse",
          description: "Review tests",
          status: "running",
          resolved_model: {
            provider: "opencode",
            model_id: modelId,
            display,
            source: "category",
          },
        }),
      ], new Map(), now, () => stats, 220)[0] ?? ""

    expect(rowFor("muse-spark-1.3-contributor-free")).toContain("Muse Spark 1.3")
    expect(rowFor("muse-spark-1.3-contributor-free", "Muse Spark 1.3 Free")).toContain("Muse Spark 1.3")
    expect(rowFor("muse-spark-1.3-contributor-free")).not.toContain("contributor-free")
  })

  it("#given a Cursor Grok task whose catalog name is not Fast #when a live row renders #then it still shows Fast", () => {
    const row = backgroundWidgetRows([
      record({
        task_id: "st_grok",
        description: "Review tests",
        status: "running",
        resolved_model: {
          provider: "cursor",
          model_id: "cursor-grok-4.6",
          display: "Cursor Grok 4.6",
          reasoning: "high",
          source: "category",
        },
      }),
    ], new Map(), now, () => stats, 220)[0] ?? ""
    expect(row).toContain("Grok 4.6 high [fast]")
    expect(row).not.toContain("Cursor Grok")
  })

  it("#given xAI Grok #when a live row renders #then Fast is not implied", () => {
    const row = backgroundWidgetRows([
      record({
        task_id: "st_xai",
        description: "Review tests",
        status: "running",
        resolved_model: {
          provider: "xai",
          model_id: "grok-4.6",
          display: "xai/grok-4.6",
          reasoning: "high",
          source: "category",
        },
      }),
    ], new Map(), now, () => stats, 220)[0] ?? ""
    expect(row).toContain("Grok 4.6 high")
    expect(row).not.toContain("[fast]")
  })

  it("#given a model whose name merely starts with a variant token #when a live row renders #then it is not read as that variant", () => {
    const row = backgroundWidgetRows([
      record({
        task_id: "st_solar",
        description: "Review tests",
        status: "running",
        resolved_model: {
          provider: "vendor",
          model_id: "gpt-5.6-solar",
          display: "vendor/gpt-5.6-solar",
          source: "category",
        },
      }),
    ], new Map(), now, () => stats, 220)[0] ?? ""
    expect(row).toContain("GPT 5.6")
    expect(row).not.toContain("Sol")
  })

  it("#given a narrow terminal #when a live task row renders #then it stays on one bounded physical line", () => {
    const row = backgroundWidgetRows([
      record({
        task_id: "st_narrow",
        task_summary: "Plan the complete Spider-Man media library migration",
        status: "running",
        category: "unspecified-high",
      }),
    ], new Map([["st_narrow", "running"]]), now, () => stats, 90)[0] ?? ""

    expect(row).not.toContain("\n")
    expect(rendererVisibleWidth(row)).toBeLessThanOrEqual(90)
    expect(row).toContain("Plan")
    expect(row).not.toContain("category:")
    expect(row).not.toContain("running")
    expect(row).toEndWith("97 tok/s")
  })
})

describe("suspended residency labeling", () => {
  it("#given a persisted_only record #when formatting a full row #then the status shows suspended", () => {
    const row = formatTaskRow(record({ task_id: "st_susp", status: "running", residency_state: "persisted_only" }))
    expect(row).toContain("suspended")
    expect(row).not.toContain("status:running")
  })

  it("#given an rpc_detached record #when formatting a full row #then the status shows suspended", () => {
    const row = formatTaskRow(record({ task_id: "st_susp", status: "running", residency_state: "rpc_detached" }))
    expect(row).toContain("suspended")
    expect(row).not.toContain("status:running")
  })

  it("#given a resident record #when formatting a full row #then the status label is unchanged (regression pin)", () => {
    const row = formatTaskRow(record({ task_id: "st_live", status: "running", residency_state: "resident" }))
    expect(row).toContain("status:running")
    expect(row).not.toContain("suspended")
  })

  it("#given a persisted_only record #when building a widget row #then it contains suspended", () => {
    const row = buildWidgetRows([record({ task_id: "st_susp", status: "running", residency_state: "persisted_only" })])
    expect(row.length).toBeGreaterThan(0)
    expect(row[0]).toContain("suspended")
  })

  it("#given an rpc_detached record #when building a widget row #then it contains suspended", () => {
    const row = buildWidgetRows([record({ task_id: "st_susp", status: "running", residency_state: "rpc_detached" })])
    expect(row.length).toBeGreaterThan(0)
    expect(row[0]).toContain("suspended")
  })

  it("#given a persisted_only record #when building a background widget row #then it contains suspended", () => {
    const now = Date.parse("2026-07-07T00:01:00.000Z")
    const row = backgroundWidgetRows([record({ task_id: "st_susp", status: "running", residency_state: "persisted_only" })], new Map([]), now, () => undefined, 220)[0] ?? ""
    expect(row).toContain("suspended")
  })
})

describe("formatTaskRow", () => {
  it("#given resolved category metadata #when formatting #then the unified target carries the model and effort", () => {
    const task = record({
      task_id: "st_resolved",
      name: "planner",
      status: "running",
      category: "ultrabrain",
      execution_mode: "rpc",
      model: "category/raw-fallback",
      resolved_model: {
        provider: "openai",
        model_id: "gpt-5.6-sol",
        display: "openai/gpt-5.6-sol",
        reasoning_effort: "xhigh",
        variant: "sol",
        source: "category",
      },
    })
    expect(formatTaskRow(task)).toBe(
      "planner (st_resolved) category:ultrabrain(openai/gpt-5.6-sol:xhigh) mode:rpc status:running",
    )
  })

  it("#given a description #when formatting #then the human label leads", () => {
    const row = formatTaskRow(record({
      task_id: "st_described",
      name: "task-2",
      description: "Audit the waiting line",
      status: "running",
      category: "quick",
    }))
    expect(row).toStartWith("Audit the waiting line (st_described) category:quick")
  })

  it("#given no resolved model #when formatting #then raw model remains", () => {
    const row = formatTaskRow(record({
      task_id: "st_legacy",
      status: "running",
      agent_type: "explore",
      model: "anthropic/claude-sonnet-4-6",
    }))
    expect(row).toBe("st_legacy agent:explore(anthropic/claude-sonnet-4-6) mode:in-process status:running")
  })

  it("#given empty resolved detail labels #when formatting #then they are omitted", () => {
    const row = formatTaskRow(record({
      task_id: "st_empty",
      status: "running",
      category: "ultrabrain",
      model: "category/raw-fallback",
      resolved_model: {
        provider: "google",
        model_id: "gemini-3.1-pro",
        display: "google/gemini-3.1-pro",
        reasoning_effort: "",
        variant: "",
        source: "category",
      },
    }))
    expect(row).toBe("st_empty category:ultrabrain(google/gemini-3.1-pro) mode:in-process status:running")
  })

  it("#given matching reasoning and variant #when formatting #then the effort renders once inside the target", () => {
    const row = formatTaskRow(longActiveRecord())
    expect(row).toContain("category:ultrabrain(rubato-mock/mock-1:xhigh)")
    expect(row).not.toContain("variant:")
    expect(row).not.toContain("reasoning:")
  })

  it("#given malformed running progress #when formatting #then the excerpt is width-safe", () => {
    const row = formatTaskRow(record({
      task_id: "st_cjk",
      status: "running",
      agent_type: "explore",
      final_response: `${"界".repeat(40)}tail`,
    }))
    const progressPrefix = " progress:"
    const progressIndex = row.indexOf(progressPrefix)
    const progress = progressIndex >= 0 ? row.slice(progressIndex + progressPrefix.length) : ""
    expect(progress).toContain("...")
    expect(progress).not.toContain("tail")
    expect(rendererVisibleWidth(progress)).toBeLessThanOrEqual(60)
  })
})
