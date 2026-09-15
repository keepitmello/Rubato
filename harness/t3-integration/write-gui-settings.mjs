#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { catalogSlugs } from './src/model-catalog-order.mjs';

const home = process.env.RUBATO_GUI_T3_HOME;
const bridge = process.env.RUBATO_GUI_BRIDGE;
const descriptor = process.env.RUBATO_GUI_DESCRIPTOR;
const catalogue = process.env.RUBATO_GUI_CATALOGUE;
if (!home || !bridge || !descriptor || !catalogue) {
  throw new Error('RUBATO_GUI_T3_HOME, BRIDGE, DESCRIPTOR, CATALOGUE are required');
}
if (![bridge, descriptor, catalogue, home].every((value) => path.isAbsolute(value))) {
  throw new Error('GUI settings paths must be absolute');
}

const userdata = path.join(home, 'userdata');
await mkdir(userdata, { recursive: true, mode: 0o700 });

const settingsPath = path.join(userdata, 'settings.json');
let settings = {};
try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* first install */ }
if (!settings || typeof settings !== 'object') settings = {};
const instances = settings.providerInstances && typeof settings.providerInstances === 'object'
  ? settings.providerInstances : {};
// 목록에 Rubato 만 남긴다. 우리가 만든 예전 인스턴스(rubato-pi)도, 사용자가
// 만졌을 수 있는 다른 인스턴스도 전부 끈다.
for (const [id, instance] of Object.entries(instances)) {
  if (id === 'rubato') continue;
  if (instance && typeof instance === 'object') instance.enabled = false;
}
instances.rubato = {
  driver: 'rubato-pi',
  displayName: 'Rubato',
  environment: [],
  enabled: true,
  config: { bridgeModule: bridge, descriptorPath: descriptor, catalogueCwd: catalogue },
};
settings.providerInstances = instances;
const prefs = settings.providerModelPreferences && typeof settings.providerModelPreferences === 'object'
  ? settings.providerModelPreferences : {};
const rubatoPrefs = prefs.rubato && typeof prefs.rubato === 'object' ? prefs.rubato : {};
prefs.rubato = {
  hiddenModels: Array.isArray(rubatoPrefs.hiddenModels) ? rubatoPrefs.hiddenModels : [],
  modelOrder: catalogSlugs(),
};
settings.providerModelPreferences = prefs;

// providers 는 구형 드라이버 맵이고, 키가 없으면 스키마 기본값으로 디코드된다.
// 그 기본값이 codex 와 claudeAgent 를 켜진 상태로 만들어서, 아무것도 안 쓰면
// 화면에 Codex 와 Claude 가 같이 뜬다. 여섯 개를 전부 명시해서 꺼야 한다.
const builtInDrivers = ['codex', 'claudeAgent', 'cursor', 'grok', 'opencode', 'antigravity'];
const providers = settings.providers && typeof settings.providers === 'object' ? settings.providers : {};
for (const kind of builtInDrivers) {
  const previous = providers[kind] && typeof providers[kind] === 'object' ? providers[kind] : {};
  providers[kind] = { ...previous, enabled: false };
}
settings.providers = providers;

// 셋 다 따로 디코드된다. textGenerationModelSelection 은 기본값이 codex 라서
// 비워두면 껐던 드라이버가 그 자리로 되돌아온다.
const selection = { instanceId: 'rubato', model: 'xai/grok-4.6' };
settings.defaultModelSelection = selection;
settings.textGenerationModelSelection = selection;
settings.sourceControlWriterModelSelection = selection;
await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

const clientPath = path.join(userdata, 'client-settings.json');
let client = {};
try { client = JSON.parse(await readFile(clientPath, 'utf8')); } catch { /* first install */ }
if (!client || typeof client !== 'object') client = {};

// T3 는 이 셋을 "legacy" 로 분류해 기본으로 끄거나, 기본값이 언제든 바뀔 수
// 있는 자리에 둔다. Rubato 쪽 기능이 거기 걸려 있어서 우리가 켠다.
//
// 매번 덮어쓰지는 않는다. 사용자가 끈 것을 업데이트마다 도로 켜는 건
// 설정이 아니라 강요고, 그러면 사용자는 이 파일을 신뢰하지 않게 된다.
// 그래서 묶음마다 판을 매기고, 그 판을 적용한 적이 있으면 건너뛴다.
// 값을 새로 밀고 싶으면 판 번호를 올린다.
const RECOMMENDED_REVISION = 1;
const RECOMMENDED = {
  // 원래 사이드바. 프로젝트별 트리가 Rubato 세션 목록과 맞는다.
  legacySidebarEnabled: true,
  // 컨텍스트 사용량 미터. 브릿지가 thread.token-usage.updated 를 보내는데
  // 이 값이 꺼져 있으면 컴포저가 미터를 아예 안 그린다.
  contextWindowMeterEnabled: true,
  // 슬래시 메뉴의 스킬. 드라이버가 채우는 스킬 목록이 여기로 나온다.
  // 기본값이 true 지만 업스트림이 뒤집으면 우리 기능이 조용히 사라진다.
  showSkillsInSlashMenu: true,
};
const stampPath = path.join(userdata, '.rubato-gui-settings');
let applied = 0;
try { applied = Number(JSON.parse(await readFile(stampPath, 'utf8')).revision) || 0; } catch { /* 처음 */ }
if (applied < RECOMMENDED_REVISION) {
  Object.assign(client, RECOMMENDED);
  await writeFile(stampPath, `${JSON.stringify({ revision: RECOMMENDED_REVISION })}\n`);
}
await writeFile(clientPath, `${JSON.stringify(client)}\n`);
