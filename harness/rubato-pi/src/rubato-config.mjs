import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DISABLED_AGENT_NAMES, DISABLED_CATEGORY_NAMES, MEMORY_JOB_MODELS, MODEL_CATEGORY_CHAINS } from "./defaults.mjs";

function readTaskSettings(cwd) {
  if (!cwd) return undefined;
  for (const name of ["rubato.jsonc", "rubato.json"]) {
    const path = join(cwd, ".rubato", name);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const task = raw?.["[senpi]"]?.task ?? raw?.task;
      if (task && typeof task === "object") return task;
    } catch {
      /* ignore malformed fixture / comment-bearing jsonc */
    }
  }
  return undefined;
}

const TASK_SCHEMA_DEFAULTS = {
  default_execution_mode: "in-process",
  default_concurrency: 5,
  global_concurrency: 8,
  max_depth: 1,
  residency_max_children: 8,
  ttl_ms: 86400000,
  resume_children: true,
  warnings: { unavailable_categories: true },
  wait: { min_ms: 5000, default_ms: 60000, max_ms: 600000 },
  team: { max_members: 8, max_parallel_members: 4, max_wall_clock_minutes: 120 },
};

function withTaskDefaults(task) {
  return {
    ...TASK_SCHEMA_DEFAULTS,
    ...task,
    warnings: { ...TASK_SCHEMA_DEFAULTS.warnings, ...(task.warnings && typeof task.warnings === "object" ? task.warnings : {}) },
    wait: { ...TASK_SCHEMA_DEFAULTS.wait, ...(task.wait && typeof task.wait === "object" ? task.wait : {}) },
    team: { ...TASK_SCHEMA_DEFAULTS.team, ...(task.team && typeof task.team === "object" ? task.team : {}) },
  };
}

export function loadRubatoPiRubatoConfig(options = {}) {
  const task = readTaskSettings(options.cwd);
  return {
    config: {
      agents: Object.fromEntries(DISABLED_AGENT_NAMES.map((name) => [name, { disable: true }])),
      categories: {
        ...Object.fromEntries(DISABLED_CATEGORY_NAMES.map((name) => [name, { disable: true }])),
        ...Object.fromEntries(
          Object.entries(MODEL_CATEGORY_CHAINS).map(([name, models]) => [name, { models }]),
        ),
      },
      ...(task ? { task: withTaskDefaults(task) } : {}),
    },
    diagnostics: [],
  };
}

/**
 * Memory children still call loadConfig themselves. Task overlay disables `quick`,
 * but facts and `/people --ask` are hardcoded to that name, so memory reopens it
 * as xAI grok and pins reflection/dream to the grok category name.
 * The models here are MEMORY_JOB_MODELS, not the task-planner grok chain.
 *
 * 이 함수는 **오직 category 만** 고정한다. 나머지 필드는 손대지 않는다.
 *
 * 예전에는 `config.memory ?? {}` 로 시작해 항상 새 객체를 만들어 돌려줬다.
 * 그런데 memory 설정의 기본값은 스키마가 쥐고 있고, 엔진 쪽
 * `resolveMemorySettings` 는 `settings ?? Schema.parse({})` 로 **settings 가
 * 통째로 undefined 일 때만** 그 기본값을 꺼낸다.
 *
 * 그래서 사용자 설정이 없는 배치(갓 만든 HOME, 통합 테스트의 임시 HOME)에서는
 * `config.memory` 가 undefined 인데, 여기서 `{reflection:{category:"grok"}}` 라는
 * 부분 객체를 만들어 끼워 넣는 순간 그 `??` 가 영영 안 걸린다. `enabled` 가
 * undefined 로 남고 isEnabled 가 false 가 되어 memory 컴포넌트가 **조용히**
 * 등록을 건너뛴다 — stderr 한 줄 없이 memory/dream/palace 명령이 통째로 사라졌다.
 *
 * 고칠 곳은 기본값을 다시 구현하는 쪽이 아니라 여기다. 원본에 memory 블록이
 * 없으면 없는 채로 넘겨서, 기본값을 정하는 한 정본(스키마)이 그대로 일하게 둔다.
 */
export function pinMemoryJobsToGrok(loaded) {
  const config = loaded?.config ?? {};
  const memory = config.memory;
  const reflection = memory?.reflection ?? {};
  return {
    ...loaded,
    config: {
      ...config,
      categories: {
        ...config.categories,
        grok: { models: MEMORY_JOB_MODELS },
        quick: { models: MEMORY_JOB_MODELS },
      },
      ...(memory === undefined ? {} : {
        memory: {
          ...memory,
          reflection: {
            ...reflection,
            category: "grok",
          },
        },
      }),
    },
  };
}
