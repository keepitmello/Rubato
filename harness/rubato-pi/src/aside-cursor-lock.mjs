// Aside models.json 잠금. Cursor 면과 xAI grok-4.6 priority 프록시 경로를
// 카탈로그 리프레시가 지워도 다시 박는다.
//
// supportsFastMode 는 hydrateProviderModel 이 버리고 FAST_MODE_SUPPORTED 에도
// xAI 가 없다. 그래서 Fast 토글이 아니라 baseUrl 을 이 프로세스의 /xai 로
// 돌려 POST 에 service_tier: priority 를 넣는다.

import { ASIDE_CURSOR_API_KEY, ASIDE_CURSOR_DEFAULT_HOST, ASIDE_CURSOR_DEFAULT_PORT } from "./aside-cursor.mjs";

export const ASIDE_XAI_OAUTH_PROVIDER = "xai-grok-oauth";
export const ASIDE_XAI_PRIORITY_MODEL = "grok-4.6";
export const ASIDE_XAI_UPSTREAM = "https://api.x.ai";
export const ASIDE_CURSOR_LAUNCHD_LABEL = "com.keepitmello.rubato.aside-cursor";

const ASIDE_CURSOR_GROK_ROW = {
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: null,
  },
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 500000,
  maxTokens: 64000,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsLongCacheRetention: false,
  },
};

export function asideCursorGrokAllowlist() {
  return [
    structuredClone({ id: "cursor/grok-4.6", name: "Grok 4.6 Fast [Cursor]", ...ASIDE_CURSOR_GROK_ROW }),
    structuredClone({ id: "cursor/grok-4.6-fast", name: "Grok 4.6 Fast [Cursor]", ...ASIDE_CURSOR_GROK_ROW }),
  ];
}

export function asideCursorFaceUrl(host = ASIDE_CURSOR_DEFAULT_HOST, port = ASIDE_CURSOR_DEFAULT_PORT) {
  return `http://${host}:${port}/v1`;
}

export function asideXaiFaceUrl(host = ASIDE_CURSOR_DEFAULT_HOST, port = ASIDE_CURSOR_DEFAULT_PORT) {
  return `http://${host}:${port}/xai/v1`;
}

export function defaultAsideModelsPath(home = process.env.HOME ?? "") {
  return `${home}/.aside/u/0/models.json`;
}

export function lockAsideModels(data, options = {}) {
  const host = options.host ?? ASIDE_CURSOR_DEFAULT_HOST;
  const port = Number(options.port ?? ASIDE_CURSOR_DEFAULT_PORT);
  const apiKey = options.apiKey ?? ASIDE_CURSOR_API_KEY;
  const next = structuredClone(data ?? {});
  const providers = next.providers ??= {};
  const cursor = providers.cursor ??= {};
  cursor.name ??= "Cursor Subscription";
  cursor.api = "openai-completions";
  cursor.authHeader = true;
  cursor.baseUrl = asideCursorFaceUrl(host, port);
  cursor.apiKey = apiKey;
  const models = Array.isArray(cursor.models) ? cursor.models : [];
  cursor.models = models;
  for (const row of asideCursorGrokAllowlist()) {
    if (!models.some((model) => model?.id === row.id)) models.push(structuredClone(row));
  }
  const xai = providers[ASIDE_XAI_OAUTH_PROVIDER];
  if (Array.isArray(xai?.models)) {
    for (const model of xai.models) {
      if (model?.id === ASIDE_XAI_PRIORITY_MODEL) {
        model.baseUrl = asideXaiFaceUrl(host, port);
      }
    }
  }
  return next;
}

export function asideModelsUnlocked(data, options = {}) {
  return JSON.stringify(data ?? {}) !== JSON.stringify(lockAsideModels(data, options));
}

export function injectXaiPriority(raw) {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    parsed.service_tier = "priority";
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

export function xaiUpstreamUrl(pathname, search = "") {
  const suffix = pathname.startsWith("/xai") ? pathname.slice("/xai".length) : pathname;
  return `${ASIDE_XAI_UPSTREAM}${suffix || "/"}${search}`;
}

export function renderAsideCursorLaunchAgent({
  scriptPath,
  stdoutPath,
  stderrPath,
  home = process.env.HOME ?? "",
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(ASIDE_CURSOR_LAUNCHD_LABEL)}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>${escapeXml(scriptPath)}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict>
<key>HOME</key><string>${escapeXml(home)}</string>
</dict>
<key>StandardOutPath</key><string>${escapeXml(stdoutPath)}</string>
<key>StandardErrorPath</key><string>${escapeXml(stderrPath)}</string>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
