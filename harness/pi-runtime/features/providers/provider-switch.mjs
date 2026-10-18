import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

// 프로바이더 끄기. 인증은 그대로 두고, 그 프로바이더의 모델을 "지금 쓸 수 있는 모델"
// 에서만 뺀다. CLI 피커, 앱 피커, 메인 세션의 Agent·팀 모델 목록이 모두 그 목록을
// 읽으므로(model-runtime 패치, patches.mjs) 한 곳에서 같이 빠진다. id 로 찾는 길
// (getModel)과 인증은 건드리지 않아서, 이미 그 모델로 도는 세션은 계속 돈다.
// 값은 사용자 설정 ~/.rubato/rubato.jsonc 의 providers.disabled 이고, 쓰는 길은
// `rubato auth disable|enable` 이다 (scripts/rubato-auth.mjs, 앱의 Providers 화면).

export const DISABLED_PROVIDERS_PATH = Object.freeze(["providers", "disabled"]);
export const LOAD_BALANCING_PATH = Object.freeze(["providers", "loadBalancing"]);

/** Opt-in: absent settings preserve explicit base/sub account selection. */
export function readAccountLoadBalancing({ home = process.env.HOME || homedir() } = {}) {
  try {
    const config = parseJsonc(readFileSync(providerConfigPath(home), "utf8"), [], { allowTrailingComma: true });
    return new Set(Array.isArray(config?.providers?.loadBalancing) ? config.providers.loadBalancing : []);
  } catch {
    return new Set();
  }
}

export function setAccountLoadBalancing(providerId, enabled, options = {}) {
  if (providerId !== "anthropic") throw new Error("Account load balancing is supported for Anthropic.");
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  editProviderSetting(LOAD_BALANCING_PATH, (config) => {
    const providers = new Set(config?.providers?.loadBalancing ?? []);
    if (enabled) providers.add(providerId);
    else providers.delete(providerId);
    return [...providers].sort();
  }, options);
  return enabled;
}

/** 설정 파일 자리: rubato.jsonc, 그게 없고 rubato.json 만 있으면 그쪽 (titleConfigPath 와 같은 규칙). */
export function providerConfigPath(home = process.env.HOME || homedir()) {
  const jsonc = join(home, ".rubato", "rubato.jsonc");
  const json = join(home, ".rubato", "rubato.json");
  return !existsSync(jsonc) && existsSync(json) ? json : jsonc;
}

/** providers.disabled 값 → 정렬·중복 없는 프로바이더 id 목록. 잘못된 칸은 버린다. */
export function disabledProviderList(config) {
  const raw = config?.providers?.disabled;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id) => typeof id === "string" && id.trim() !== "").map((id) => id.trim()))].sort();
}

export function readDisabledProviders({ home = process.env.HOME || homedir(), readFile = readFileSync } = {}) {
  try {
    return new Set(disabledProviderList(parseJsonc(readFile(providerConfigPath(home), "utf8"), [], { allowTrailingComma: true })));
  } catch {
    // 파일이 없거나 깨졌으면 다 켜진 것으로 본다. 설정 하나 때문에 모델을 다 숨기지 않는다.
    return new Set();
  }
}

let cached;

/** 지금 꺼진 프로바이더. 파일이 바뀔 때만 다시 읽어서, 목록을 자주 읽어도 싸다. */
export function currentDisabledProviders(home = process.env.HOME || homedir()) {
  const file = providerConfigPath(home);
  let stamp = "missing";
  try {
    const stat = statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // 없는 파일은 다 켜진 상태다.
  }
  if (cached?.file === file && cached.stamp === stamp) return cached.value;
  const value = stamp === "missing" ? new Set() : readDisabledProviders({ home });
  cached = { file, stamp, value, source: undefined, result: undefined };
  return value;
}

/**
 * 꺼진 프로바이더의 모델을 뺀 목록. 같은 목록과 같은 설정이면 같은 배열을 돌려준다:
 * 스냅숏을 참조로 비교하는 쪽이 매번 바뀐 것으로 보지 않게.
 */
export function withoutDisabledProviders(models, disabled = currentDisabledProviders()) {
  if (disabled.size === 0 || !Array.isArray(models)) return models;
  if (cached?.value === disabled && cached.source === models) return cached.result;
  const result = models.filter((model) => !disabled.has(model?.provider));
  if (cached?.value === disabled) {
    cached.source = models;
    cached.result = result;
  }
  return result;
}

/** providers.disabled 를 고친다. 주석·다른 키·순서는 사용자가 쓴 그대로 둔다. 새 목록을 돌려준다. */
export function setProviderDisabled(providerId, disabled, { home = process.env.HOME || homedir() } = {}) {
  if (typeof providerId !== "string" || providerId.trim() === "") throw new Error("provider id is missing");
  return editProviderSetting(DISABLED_PROVIDERS_PATH, (config) => {
    const next = new Set(disabledProviderList(config));
    if (disabled) next.add(providerId.trim());
    else next.delete(providerId.trim());
    return [...next].sort();
  }, { home });
}

function editProviderSetting(settingPath, nextValue, { home = process.env.HOME || homedir() } = {}) {
  const file = providerConfigPath(home);
  let symlink = false;
  try { symlink = lstatSync(file).isSymbolicLink(); } catch { /* 없으면 새로 만든다 */ }
  if (symlink) throw new Error(`${file} is a symlink; edit ${settingPath.join(".")} there directly.`);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const errors = [];
  const config = text.trim() === "" ? {} : parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`${file} does not parse. Fix it before changing providers.`);
  const list = nextValue(config);
  const base = text.trim() === "" ? "{\n}\n" : text;
  // 빈 목록이면 키를 지운다. providers 가 비면 그것도 지운다.
  let edited = applyEdits(base, modify(base, [...settingPath], list.length > 0 ? list : undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }));
  const providers = parseJsonc(edited, [], { allowTrailingComma: true })?.providers;
  if (providers && typeof providers === "object" && Object.keys(providers).length === 0) {
    edited = applyEdits(edited, modify(edited, ["providers"], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
  }
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, edited, { mode: 0o600 });
  renameSync(temp, file);
  return list;
}
