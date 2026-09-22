import { createHash } from "node:crypto";
import type { ServerProvider } from "@t3tools/contracts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// These are glyphs in the shipped mobile ProviderIcon, not new driver registrations.
const marks = {
  claude: { driver: "claudeAgent", label: "Claude", emoji: "" },
  grok: { driver: "grok", label: "Grok", emoji: "" },
  // The default glyph already is OpenAI. Pretending to be Codex also makes
  // the stock composer consume /feedback instead of sending it to Rubato.
  openai: { driver: "rubato-pi", label: "OpenAI", emoji: "" },
  cursor: { driver: "cursor", label: "Cursor", emoji: "" },
  // Antigravity's driver name also enables client-side setup/send gates.
  // Keep Rubato semantics rather than trading working sends for that glyph.
  antigravity: { driver: "rubato-pi", label: "Antigravity", emoji: "🪐" },
  opencode: { driver: "opencode", label: "OpenCode", emoji: "" },
  deepseek: { driver: "rubato-pi", label: "DeepSeek", emoji: "🐋" },
  gemini: { driver: "rubato-pi", label: "Gemini", emoji: "✨" },
  kimi: { driver: "rubato-pi", label: "Kimi", emoji: "🌙" },
  qwen: { driver: "rubato-pi", label: "Qwen", emoji: "🐼" },
  glm: { driver: "rubato-pi", label: "GLM", emoji: "💎" },
  other: { driver: "rubato-pi", label: "Models", emoji: "🤖" },
} as const;
type Mark = keyof typeof marks;
const prefix = "rubatom_";

export function rubatoModelMark(slug: string): Mark {
  const slash = slug.indexOf("/");
  const route = slug.slice(0, slash).toLowerCase();
  const model = slug.slice(slash + 1).toLowerCase();
  if (/(^|[/_-])claude([/_.-]|$)/u.test(model)) return "claude";
  if (/(^|[/_-])grok([/_.-]|$)/u.test(model)) return "grok";
  if (/^(gpt[-_.]|chatgpt|codex|o[1-9]([-_.]|$))/u.test(model)) return "openai";
  if (model.includes("deepseek")) return "deepseek";
  if (model.includes("kimi")) return "kimi";
  if (model.includes("qwen")) return "qwen";
  if (/^glm[-_.]/u.test(model)) return "glm";
  if (route === "google-antigravity" || route === "antigravity") return "antigravity";
  if (model.includes("gemini") || model.includes("gemma")) return "gemini";
  if (route === "cursor") return "cursor";
  if (route === "opencode") return "opencode";
  return "other";
}

const aliasFor = (id: string, mark: Mark) =>
  `${prefix}${createHash("sha256").update(id).digest("hex").slice(0, 20)}_${mark}`;

/**
 * Mobile-only view. Never give these snapshots to ProviderRegistry or persist
 * their aliases. The protocol restores all incoming references before decoding
 * and dispatch; the canonical instance, model slug and options stay untouched.
 */
export function makeRubatoMobilePresentation(providers: ReadonlyArray<ServerProvider>) {
  const realIds = new Set(providers.map(provider => String(provider.instanceId)));
  const rubatoIds = new Set(providers.filter(provider => provider.driver === "rubato-pi")
    .map(provider => String(provider.instanceId)));
  const routes = new Map<string, { instanceId: string; mark: Mark }>();
  for (const id of rubatoIds) {
    for (const mark of Object.keys(marks) as Mark[]) {
      const alias = aliasFor(id, mark);
      if (realIds.has(alias) || routes.has(alias)) throw new Error("Rubato mobile provider alias collision");
      routes.set(alias, { instanceId: id, mark });
    }
  }

  function restoreId(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const route = routes.get(value);
    if (route) return route.instanceId;
    if (value.startsWith(prefix) && !realIds.has(value)) {
      throw new Error("Rubato mobile provider is no longer available; refresh the model list");
    }
    return value;
  }

  function selection(value: unknown, incoming = false): unknown {
    if (!object(value) || typeof value.instanceId !== "string") return value;
    if (incoming) {
      const route = routes.get(value.instanceId);
      if (route && typeof value.model === "string" && rubatoModelMark(value.model) !== route.mark) {
        throw new Error("Model does not belong to the selected Rubato mobile provider");
      }
      return { ...value, instanceId: restoreId(value.instanceId) };
    }
    if (!rubatoIds.has(value.instanceId) || typeof value.model !== "string") return value;
    return { ...value, instanceId: aliasFor(value.instanceId, rubatoModelMark(value.model)) };
  }

  function project(value: unknown): unknown {
    return object(value) && "defaultModelSelection" in value
      ? { ...value, defaultModelSelection: selection(value.defaultModelSelection) } : value;
  }

  function session(value: unknown, modelSelection: unknown): unknown {
    if (!object(value) || !object(modelSelection) ||
        value.providerInstanceId !== modelSelection.instanceId) return value;
    const presented = selection(modelSelection);
    return object(presented) ? { ...value, providerInstanceId: presented.instanceId } : value;
  }

  function thread(value: unknown): unknown {
    if (!object(value)) return value;
    return { ...value, modelSelection: selection(value.modelSelection),
      session: session(value.session, value.modelSelection) };
  }

  function shell(value: unknown): unknown {
    if (!object(value)) return value;
    return { ...value,
      ...(Array.isArray(value.projects) ? { projects: value.projects.map(project) } : {}),
      ...(Array.isArray(value.threads) ? { threads: value.threads.map(thread) } : {}) };
  }

  function settings(value: unknown, incoming = false): unknown {
    if (!object(value)) return value;
    // Virtual rows are not installable/configurable providers. Never save them
    // as real providerInstances via the settings RPC.
    if (incoming && object(value.providerInstances)) {
      for (const id of Object.keys(value.providerInstances)) {
        if (routes.has(id) || (id.startsWith(prefix) && !realIds.has(id))) {
          throw new Error("Configure the original Rubato provider, not its mobile display group");
        }
      }
    }
    const result = { ...value };
    for (const key of ["defaultModelSelection", "textGenerationModelSelection", "sourceControlWriterModelSelection"]) {
      if (key in value) result[key] = selection(value[key], incoming);
    }
    // Project overrides carry the same selection fields. Visit only this
    // schema-owned map, never arbitrary provider config or user payloads.
    if (object(value.projectSettingsOverrides)) {
      result.projectSettingsOverrides = Object.fromEntries(Object.entries(value.projectSettingsOverrides)
        .map(([id, override]) => [id, settings(override, incoming)]));
    }
    return result;
  }

  function catalogue(values: ReadonlyArray<ServerProvider>): ReadonlyArray<unknown> {
    return values.flatMap<unknown>(provider => {
      if (provider.driver !== "rubato-pi") return [provider];
      const groups = new Map<Mark, typeof provider.models[number][]>();
      for (const model of provider.models) {
        const mark = rubatoModelMark(model.slug);
        if (!groups.has(mark)) groups.set(mark, []);
        groups.get(mark)!.push(model);
      }
      // Keep unavailable/empty providers observable without letting a stale
      // local draft select the old canonical id as a second duplicate row.
      if (groups.size === 0) groups.set("other", []);
      return [...groups].map(([key, models]) => {
        const mark = marks[key];
        const label = mark.emoji ? `${mark.emoji} ${mark.label}` : mark.label;
        const { usageLimits: _usage, updateState: _update, versionAdvisory: _version, ...base } = provider;
        return { ...base,
          instanceId: aliasFor(provider.instanceId, key), driver: mark.driver,
          displayName: `${label} · ${provider.displayName ?? "Rubato"}`,
          setup: { canAuthenticate: false, canInstall: false },
          models: models.map(model => mark.emoji ? {
            ...model, name: `${mark.emoji} ${model.name}`,
            ...(model.shortName ? { shortName: `${mark.emoji} ${model.shortName}` } : {}),
          } : model),
        };
      });
    });
  }

  function config(value: unknown): unknown {
    if (!object(value)) return value;
    return { ...value,
      ...(Array.isArray(value.providers) ? { providers: catalogue(value.providers as ServerProvider[]) } : {}),
      ...(object(value.settings) ? { settings: settings(value.settings) } : {}) };
  }

  function command(value: unknown): unknown {
    if (!object(value)) return value;
    const bootstrap = value.bootstrap;
    return { ...value,
      ...("modelSelection" in value ? { modelSelection: selection(value.modelSelection, true) } : {}),
      ...("defaultModelSelection" in value ? { defaultModelSelection: selection(value.defaultModelSelection, true) } : {}),
      ...(object(bootstrap) && object(bootstrap.createThread) ? {
        bootstrap: { ...bootstrap, createThread: { ...bootstrap.createThread,
          modelSelection: selection(bootstrap.createThread.modelSelection, true) } },
      } : {}),
    };
  }

  function event(value: unknown, currentThread?: unknown): unknown {
    if (!object(value) || !object(value.payload)) return value;
    const payload = value.payload;
    return { ...value, payload: { ...payload,
      ...("modelSelection" in payload ? { modelSelection: selection(payload.modelSelection) } : {}),
      ...("defaultModelSelection" in payload ? { defaultModelSelection: selection(payload.defaultModelSelection) } : {}),
      ...(payload.session && object(currentThread)
        ? { session: session(payload.session, currentThread.modelSelection) } : {}),
    } };
  }

  return {
    restoreId, selection, settings, config, command, catalogue, thread, shell,
    shellItem(value: unknown): unknown {
      if (!object(value)) return value;
      if (value.kind === "snapshot") return { ...value, snapshot: shell(value.snapshot) };
      if (value.kind === "thread-upserted") return { ...value, thread: thread(value.thread) };
      if (value.kind === "project-upserted") return { ...value, project: project(value.project) };
      return value;
    },
    detailItem(value: unknown, currentThread?: unknown): unknown {
      if (!object(value)) return value;
      if (value.kind === "snapshot" && object(value.snapshot)) {
        return { ...value, snapshot: { ...value.snapshot, thread: thread(value.snapshot.thread) } };
      }
      if (value.kind === "event") return { ...value, event: event(value.event, currentThread) };
      return value;
    },
    configItem(value: unknown): unknown {
      if (!object(value)) return value;
      if (value.type === "snapshot") return { ...value, config: config(value.config) };
      if (value.type === "providerStatuses" && object(value.payload)) {
        return { ...value, payload: config(value.payload) };
      }
      if (value.type === "settingsUpdated" && object(value.payload)) {
        return { ...value, payload: { ...value.payload, settings: settings(value.payload.settings) } };
      }
      return value;
    },
  };
}
