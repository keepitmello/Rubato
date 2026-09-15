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

// 이 파일이 지키는 선. 앱 설정에는 성질이 다른 두 가지가 섞여 있다.
//
//   배선  — 앱이 Rubato 에 닿기 위해 반드시 맞아야 하는 것. 드라이버, 브리지
//          모듈 경로, descriptor 경로. 레포를 옮기면 절대경로가 달라지므로
//          이건 우리 것이고, 매번 다시 쓴다.
//   취향  — 기본 모델, 모델 순서, 어떤 프로바이더를 켜둘지, 글꼴. 처음 깔 때
//          쓸 만한 값을 넣어 주는 것까지가 우리 몫이고, 그 뒤로는 사용자 것이다.
//
// 예전에는 이 둘을 가르지 않고 매번 전부 덮어썼다. 그래서 `rubato restart` 나
// `rubato update` 를 할 때마다 사용자가 고른 기본 모델이 xai/grok-4.6 으로
// 되돌아갔고, 고른 reasoningEffort 도 같이 사라졌다. 업데이트가 설정을 되돌리면
// 사람은 그 설정 화면을 믿지 않게 된다.
//
// 그래서 취향 값은 **없을 때만** 채운다. 있으면 그대로 둔다. "없음" 에 의미를
// 싣는 자리(키가 빠지면 스키마 기본값이 켜지는 것들)는 아래에 따로 적어 둔다.
const seedIfMissing = (object, key, value) => {
  if (object[key] === undefined || object[key] === null) object[key] = value;
};

const settingsPath = path.join(userdata, 'settings.json');
let settings = {};
try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* first install */ }
if (!settings || typeof settings !== 'object') settings = {};
const instances = settings.providerInstances && typeof settings.providerInstances === 'object'
  ? settings.providerInstances : {};
// 우리가 예전에 만들어 둔 인스턴스는 끈다 — 같은 드라이버가 둘 뜨면 목록이
// 겹친다. 사용자가 손수 만든 다른 프로바이더는 건드리지 않는다: 그 목록에
// 무엇을 둘지는 사용자가 정할 일이지 설치기가 정할 일이 아니다.
for (const [id, instance] of Object.entries(instances)) {
  if (id === 'rubato') continue;
  if (instance && typeof instance === 'object' && instance.driver === 'rubato-pi') instance.enabled = false;
}
// 배선. 매번 쓴다.
instances.rubato = {
  ...(instances.rubato && typeof instances.rubato === 'object' ? instances.rubato : {}),
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
// 목록 순서는 취향이다. 처음에는 우리가 큐레이트한 순서를 넣고, 그 뒤로는
// 사용자가 바꾼 순서를 지킨다. 새로 생긴 모델만 뒤에 붙인다 — 안 그러면 카탈로그에
// 추가된 모델이 이 사람 화면에는 영영 안 나온다.
const curated = catalogSlugs();
const keptOrder = Array.isArray(rubatoPrefs.modelOrder) ? rubatoPrefs.modelOrder : null;
prefs.rubato = {
  hiddenModels: Array.isArray(rubatoPrefs.hiddenModels) ? rubatoPrefs.hiddenModels : [],
  modelOrder: keptOrder
    ? [...keptOrder, ...curated.filter((slug) => !keptOrder.includes(slug))]
    : curated,
};
settings.providerModelPreferences = prefs;

// providers 는 구형 드라이버 맵이고, 키가 없으면 스키마 기본값으로 디코드된다.
// 그 기본값이 codex 와 claudeAgent 를 켜진 상태로 만들어서, 아무것도 안 쓰면
// 화면에 Codex 와 Claude 가 같이 뜬다. 그래서 여섯 개의 키가 **있기는** 해야 한다.
// 다만 이미 적혀 있는 값은 사용자가 정한 것이다 — Codex 를 일부러 켠 사람에게
// 업데이트가 그것을 도로 끄지 않는다. 없는 키만 꺼진 상태로 채운다.
const builtInDrivers = ['codex', 'claudeAgent', 'cursor', 'grok', 'opencode', 'antigravity'];
const providers = settings.providers && typeof settings.providers === 'object' ? settings.providers : {};
for (const kind of builtInDrivers) {
  if (providers[kind] && typeof providers[kind] === 'object') {
    seedIfMissing(providers[kind], 'enabled', false);
  } else {
    providers[kind] = { enabled: false };
  }
}
settings.providers = providers;

// 셋 다 따로 디코드되고, textGenerationModelSelection 은 기본값이 codex 라서
// 비워두면 껐던 드라이버가 그 자리로 되돌아온다. 그래서 키는 있어야 하지만,
// **값은 사용자 것이다.** 적혀 있으면 그대로 두고, 없을 때만 채운다.
//
// 뒤의 둘은 제목 짓기와 커밋 메시지 쓰기다. 기본 모델을 따라가게 하고 싶어지지만
// 그러면 Opus 를 골라둔 사람이 제목 한 줄마다 Opus 값을 낸다. 잔일에는 싼 모델을
// 둔다 — 사람이 그 자리를 직접 바꾼 적이 있으면 물론 그것을 지킨다.
const modest = { instanceId: 'rubato', model: 'xai/grok-4.6' };
seedIfMissing(settings, 'defaultModelSelection', modest);
seedIfMissing(settings, 'textGenerationModelSelection', modest);
seedIfMissing(settings, 'sourceControlWriterModelSelection', modest);
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
  await writeFile(clientPath, `${JSON.stringify(client)}\n`);
}
// 바꿀 것이 없으면 쓰지 않는다. 글꼴·테마처럼 우리가 손대지 않는 값까지 이 파일
// 안에 있는데, 안 바뀐 파일을 다시 쓰는 것은 얻는 것 없이 잃을 것만 있는 일이다.
