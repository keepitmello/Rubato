// Aside models.json 잠금. Cursor 면을 카탈로그 리프레시가 지워도 다시 박는다.
// xAI grok-4.6 은 catalog 기본 차로다. 예전 priority 프록시로 묶인 baseUrl 만
// 공식 upstream 으로 되돌린다.

import { ASIDE_CURSOR_API_KEY, ASIDE_CURSOR_DEFAULT_HOST, ASIDE_CURSOR_DEFAULT_PORT } from "./aside-cursor.mjs";

export const ASIDE_XAI_OAUTH_PROVIDER = "xai-grok-oauth";
export const ASIDE_XAI_PRIORITY_MODEL = "grok-4.6";
export const ASIDE_XAI_UPSTREAM = "https://api.x.ai";
/**
 * Aside 의 xAI 모델 `max_output_tokens` 상한. Aside 카탈로그는 maxTokens 를
 * contextWindow(500k) 와 같게 두고, 그러면 클라이언트가 매 호출
 * `contextWindow − 현재 컨텍스트` 를 보낸다. xAI 는 그 값을 프롬프트 캐시 키에
 * 넣어서 턴마다 값이 바뀌면 전부 miss 다 (2026-09-02 실측). Rubato 직결과 같은
 * 상수로 고정한다 (`provider-direct.mjs XAI_MAX_OUTPUT_TOKENS`).
 */
export const ASIDE_XAI_MAX_OUTPUT_TOKENS = 65_536;
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
    const face = asideXaiFaceUrl(host, port);
    for (const model of xai.models) {
      if (model?.id === ASIDE_XAI_PRIORITY_MODEL && model.baseUrl === face) {
        model.baseUrl = `${ASIDE_XAI_UPSTREAM}/v1`;
      }
      if (model && typeof model === "object" && model.reasoning === true
        && (typeof model.maxTokens !== "number" || model.maxTokens > ASIDE_XAI_MAX_OUTPUT_TOKENS)) {
        model.maxTokens = ASIDE_XAI_MAX_OUTPUT_TOKENS;
      }
    }
  }
  return next;
}

export function asideModelsUnlocked(data, options = {}) {
  return JSON.stringify(data ?? {}) !== JSON.stringify(lockAsideModels(data, options));
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
