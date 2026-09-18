#!/usr/bin/env node
import { readFile, writeFile, lstat, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const overlays = ['apps/server/src/provider/Drivers/RubatoPiDriver.ts', 'apps/server/src/provider/RubatoPiInventory.ts', 'apps/web/src/components/RubatoIcon.tsx'];
// 값이 [anchor, addition] 이면 anchor 앞에 붙이고, [from, to, 'replace'] 면 갈아끼운다.
// 앱 이름·번들 id·상태 경로는 T3 가 const 로 박아둬서 앞에 덧붙이는 것으로는 못 바꾼다.
//
// 값은 환경변수가 아니라 소스에 직접 박는다. 환경변수로 주면 start-gui.sh 를 지나는
// 실행만 Rubato 가 되고, 사용자가 Dock 에 고정하는 것은 앱이 실행 중에 만드는
// .electron-runtime 번들이라 그 경로로 켜면 맨 T3 가 떴다. 아이콘도 같은 이유로
// 여기서 경로를 바꾸는 대신, 설치기가 T3 가 읽는 자리에 Rubato 것을 깔아둔다.
const edits = {
  'apps/server/src/provider/builtInDrivers.ts': [
    ['import type { AnyProviderDriver } from "./ProviderDriver.ts";', 'import { RubatoPiDriver } from "./Drivers/RubatoPiDriver.ts";\n'],
    ['  AntigravityDriver,\n];', '  RubatoPiDriver,\n'],
  ],
  'apps/server/src/serverRuntimeStartup.ts': [
    ['import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";', 'import { makeRubatoPiInventory } from "./provider/RubatoPiInventory.ts";\n'],
    ['      yield* runStartupPhase("provider-sessions.reconcile", reconcileProviderSessions);', '      const rubatoInventory = yield* makeRubatoPiInventory.pipe(Scope.provide(reactorScope));\n'],
    ['      yield* Effect.logDebug("startup phase: complete");', '      yield* rubatoInventory.start.pipe(Scope.provide(reactorScope));\n'],
  ],
  // Rubato 카탈로그는 성공한 discovery 다. Codex/OpenCode 와 같이 취급해야
  // 예전 캐시 extras 가 큐레이트 뒤에 붙어서 /model 순서와 갈라지지 않는다.
  'apps/server/src/provider/Layers/ProviderRegistry.ts': [
    [
      '  if (!isAntigravity && !isCodex && provider.driver !== ProviderDriverKind.make("opencode")) {\n    return true;\n  }',
      '  if (\n    !isAntigravity &&\n    !isCodex &&\n    provider.driver !== ProviderDriverKind.make("opencode") &&\n    provider.driver !== ProviderDriverKind.make("rubato-pi")\n  ) {\n    return true;\n  }',
      'replace',
    ],
  ],
  // 부팅 hydrate 가 예전 캐시 extras 를 산 목록 뒤에 이어 붙인다. 산 카탈로그가
  // 있으면 Rubato 는 그걸 정본으로 쓴다.
  'apps/server/src/provider/providerStatusCache.ts': [
    [
      '    models: mergeProviderModels(input.fallbackProvider.models, input.cachedProvider.models),',
      '    models:\n      String(input.fallbackProvider.driver) === "rubato-pi" && input.fallbackProvider.models.length > 0\n        ? input.fallbackProvider.models\n        : mergeProviderModels(input.fallbackProvider.models, input.cachedProvider.models),',
      'replace',
    ],
  ],
  // CLI /model 은 별을 그려도 순서는 안 바꾼다. T3 기본값은 즐겨찾기를 맨 위로 올린다.
  // 위저드의 "최근 에이전트 세션 가져오기" 는 ~/.codex 와 ~/.claude 의 기록을
  // 스레드로 만든다. Rubato 는 Rubato 세션만 보여준다. 화면에서 감추는 대신
  // 서버에서 끊는다 — 모바일이든 웹이든 같은 RPC 하나로 들어오기 때문이다.
  // 원본 대화는 두 홈 디렉터리에 그대로 남는다.
  'apps/server/src/project/AgentSessionImporter.ts': [
    [
      '  const scanner = yield* AgentSessionScanner.AgentSessionScanner;',
      '  if (!process.env.RUBATO_IMPORT_AGENT_HISTORY) {\n    return { importedCount: 0, skippedCount: 0 } satisfies AgentSessionImportResult;\n  }\n',
    ],
  ],
  'apps/web/src/components/chat/ModelPickerContent.tsx': [
    [
      '    return sortProviderModelItems(result, {\n      favoriteModelKeys: favoritesSet,\n      groupFavorites: selectedInstanceId !== "favorites",\n      instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],\n    });',
      '    return sortProviderModelItems(result, {\n      favoriteModelKeys: favoritesSet,\n      groupFavorites: false,\n      instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],\n    });',
      'replace',
    ],
  ],
  // 런타임 번들의 이름·번들 id. 아이콘은 이 파일이 assets 에서 읽어 만든다.
  'apps/desktop/scripts/electron-launcher.mjs': [
    [
      'const APP_DISPLAY_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";',
      'const APP_DISPLAY_NAME = isDevelopment ? "Rubato (Dev)" : "Rubato";',
      'replace',
    ],
    [
      ['const APP_BUNDLE_ID = isDevelopment', '  ? `com.t3tools.t3code.dev.${devBundleIdSuffix || "local"}`', '  : "com.t3tools.t3code";'].join('\n'),
      ['const APP_BUNDLE_ID = isDevelopment', '  ? `app.rubato.t3.dev.${devBundleIdSuffix || "local"}`', '  : "app.rubato.t3";'].join('\n'),
      'replace',
    ],
    [
      ['    NSScreenCaptureUsageDescription:', '      "T3 Code captures the active window when you use the snapshot shortcut.",', '    NSDocumentsFolderUsageDescription: "T3 Code reads project files you open in the desktop app.",'].join('\n'),
      ['    NSScreenCaptureUsageDescription: `${APP_DISPLAY_NAME} captures the active window when you use the snapshot shortcut.`,', '    NSDocumentsFolderUsageDescription: `${APP_DISPLAY_NAME} reads project files you open in the desktop app.`,'].join('\n'),
      'replace',
    ],
  ],
  // T3CODE_HOME 이 없을 때 쓰는 기본 상태 경로. 여기가 모든 경로의 뿌리라서,
  // 이 한 줄이 설정·세션·로그를 통째로 Rubato 쪽으로 옮긴다. 뒤에 userdata 를
  // 붙이는 것은 T3 쪽 코드이고, 설치기가 쓰는 settings.json 위치와 맞는다.
  'apps/desktop/src/app/DesktopStatePaths.ts': [
    [
      '    input.joinPath(input.homeDirectory, ".t3"),',
      '    input.joinPath(input.homeDirectory, ".rubato", "t3-home"),',
      'replace',
    ],
  ],
  // 메뉴 막대와 정보 창에 쓰는 이름. 번들 이름과 따로 논다.
  'apps/desktop/src/app/DesktopEnvironment.ts': [
    [
      'const APP_BASE_NAME = "T3 Code";',
      'const APP_BASE_NAME = "Rubato";',
      'replace',
    ],
    [
      '    displayName: `${APP_BASE_NAME} (${stageLabel})`,',
      '    displayName: APP_BASE_NAME,',
      'replace',
    ],
    // 서버 프로세스의 cwd 다. 서버는 이 값을 워크스페이스 루트로 삼아서 그 밖의
    // 경로는 리뷰 diff 를 거부한다 (ReviewService.assertWorkspaceBoundCwd).
    // upstream 은 packaged 일 때만 홈을 쓰는데, 우리는 소스 트리에서 실행하므로
    // appRoot(=~/.rubato/t3-source) 가 잡혀서 사용자의 모든 프로젝트가 루트 밖이
    // 됐다. 실행 형태와 무관하게 홈으로 둔다.
    [
      '    backendCwd: input.isPackaged ? homeDirectory : appRoot,',
      '    backendCwd: homeDirectory,',
      'replace',
    ],
  ],
  // 모델 선택기와 목록 행의 제공자 글리프. 매핑에 없는 드라이버는 이름 앞
  // 두 글자로 떨어져서 Rubato 가 "RU" 로 보였다.
  'apps/web/src/components/chat/providerIconUtils.ts': [
    ['import {\n  AntigravityIcon,', 'import { RubatoIcon } from "../RubatoIcon";\n'],
    [
      '  CursorIcon,\n  GrokIcon,\n  Icon,\n  OpenAI,\n  OpenCodeIcon,\n} from "../Icons";',
      '  CursorIcon,\n  GrokIcon,\n  Icon,\n  KiroIcon,\n  OpenAI,\n  OpenCodeIcon,\n} from "../Icons";',
      'replace',
    ],
    ['  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,', '  [ProviderDriverKind.make("rubato-pi")]: RubatoIcon,\n'],
    [
      '  isUnavailable?: boolean | undefined;\n};\n\nfunction escapeRegExp(value: string): string {',
      [
        '  isUnavailable?: boolean | undefined;',
        '};',
        '',
        'const VENDOR_ICONS: Record<string, Icon> = {',
        '  "openai-codex": OpenAI,',
        '  anthropic: ClaudeAI,',
        '  xai: GrokIcon,',
        '  "google-antigravity": AntigravityIcon,',
        '  kiro: KiroIcon,',
        '  cursor: CursorIcon,',
        '  opencode: OpenCodeIcon,',
        '};',
        'const VENDOR_LABELS: Record<string, string> = {',
        '  "openai-codex": "OpenAI",',
        '  anthropic: "Claude",',
        '  xai: "xAI",',
        '  "google-antigravity": "Antigravity",',
        '  kiro: "Kiro",',
        '  cursor: "Cursor",',
        '  opencode: "OpenCode",',
        '};',
        '',
        'export function vendorForModel(model: Pick<ModelEsque, "slug" | "subProvider">): string | undefined {',
        '  const sub = (model.subProvider ?? "").toLowerCase();',
        '  if (sub && VENDOR_ICONS[sub]) return sub;',
        '  const slug = model.slug.toLowerCase();',
        '  const provider = slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : "";',
        '  return provider && VENDOR_ICONS[provider] ? provider : undefined;',
        '}',
        '',
        'export function iconForProviderModel(',
        '  driverKind: ProviderDriverKind,',
        '  model: Pick<ModelEsque, "slug" | "subProvider">,',
        '): Icon | null {',
        '  const vendor = vendorForModel(model);',
        '  return (vendor ? VENDOR_ICONS[vendor] : undefined) ?? PROVIDER_ICON_BY_PROVIDER[driverKind] ?? null;',
        '}',
        '',
        'export function subProviderLabel(',
        '  subProvider: string,',
        '  model?: Pick<ModelEsque, "slug" | "subProvider">,',
        '): string {',
        '  const vendor = vendorForModel(model ?? { slug: "", subProvider });',
        '  return (vendor && VENDOR_LABELS[vendor]) || subProvider;',
        '}',
        '',
        'function escapeRegExp(value: string): string {',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/components/chat/ModelListRow.tsx': [
    [
      '  PROVIDER_ICON_BY_PROVIDER,\n} from "./providerIconUtils";',
      '  iconForProviderModel,\n  subProviderLabel,\n} from "./providerIconUtils";',
      'replace',
    ],
    [
      '  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;\n  const providerLabel = props.model.subProvider\n    ? `${props.providerDisplayName} · ${props.model.subProvider}`\n    : props.providerDisplayName;',
      '  const ProviderIcon = iconForProviderModel(props.driverKind, props.model);\n  const providerLabel = props.model.subProvider\n    ? subProviderLabel(props.model.subProvider, props.model)\n    : props.providerDisplayName;',
      'replace',
    ],
  ],
  // 닫힌 트리거는 인스턴스(Rubato) 아이콘을 쓴다. 고른 모델의 레인 로고로 바꾼다.
  'apps/web/src/components/chat/ProviderModelPicker.tsx': [
    [
      '  getTriggerDisplayModelLabel,\n  getTriggerDisplayModelName,\n} from "./providerIconUtils";',
      '  getTriggerDisplayModelLabel,\n  getTriggerDisplayModelName,\n  iconForProviderModel,\n} from "./providerIconUtils";',
      'replace',
    ],
    [
      '  const showInstanceBadge =\n    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);',
      '  const showInstanceBadge =\n    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);\n  const TriggerIcon =\n    selectedModel && activeEntry\n      ? iconForProviderModel(activeEntry.driverKind, selectedModel)\n      : null;',
      'replace',
    ],
    [
      '          {activeEntry && props.triggerLabel === undefined ? (\n            <ProviderInstanceIcon',
      '          {activeEntry && props.triggerLabel === undefined ? (\n            TriggerIcon ? (\n              <TriggerIcon\n                className={cn("size-4 shrink-0", props.activeProviderIconClassName)}\n                aria-hidden\n              />\n            ) : (\n            <ProviderInstanceIcon',
      'replace',
    ],
    [
      '            />\n          ) : null}',
      '            />\n            )\n          ) : null}',
      'replace',
    ],
  ],
  // 사이드바 왼쪽 위 워드마크. 원래 "T3" 글리프 + "Code" 글자다.
  'apps/web/src/components/T3Wordmark.tsx': [
    [
      '      <path\n        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"\n        fill="currentColor"\n      />',
      '      <text\n        dominantBaseline="middle"\n        fill="currentColor"\n        fontSize="52"\n        fontWeight="600"\n        letterSpacing="-1"\n        x="15.5"\n        y="66"\n      >\n        Rubato\n      </text>',
      'replace',
    ],
    [
      '    <svg {...props} viewBox="15.5309 37 94.3941 56.96" xmlns="http://www.w3.org/2000/svg">',
      '    <svg {...props} viewBox="15.5309 37 176 56.96" xmlns="http://www.w3.org/2000/svg">',
      'replace',
    ],
  ],
  // 워드마크 옆의 "Code" 글자. 워드마크가 이미 제품 이름을 다 쓴다.
  // 지우는 대신 빈 글자로 둔다 — 치환을 되돌릴 때 빈 문자열은 파일 맨 앞에
  // 원문을 다시 붙여 넣어서, overlay 제거가 원본을 복원하지 못한다.
  'apps/web/src/components/sidebar/SidebarChrome.tsx': [
    [
      '        <T3Wordmark aria-label="T3" className="h-2.5 w-auto shrink-0" />',
      '        <T3Wordmark aria-label="Rubato" className="h-2.5 w-auto shrink-0" />',
      'replace',
    ],
    [
      '        >\n          Code\n        </span>',
      '        >\n          {null}\n        </span>',
      'replace',
    ],
  ],

  // Worked for 는 도구만 접는다. 어시스턴트 본문을 마지막 조각만 남기면
  // 끝난 턴이 잘린 것처럼 보인다.
  'apps/web/src/components/chat/MessagesTimeline.logic.ts': [
    [
      ' * Settled turns fold activity before their terminal assistant message behind\n * a "Worked for ..." row. A single ordinary activity after that message joins\n * the fold, while larger groups and failures stay visible as a trailing summary.',
      ' * Settled turns fold tool activity behind a "Worked for ..." row. Assistant\n * prose stays visible in full — first line, last line, and everything\n * between. Picking leftover fragments is what made the final answer look\n * truncated. A single ordinary activity after the last message joins the\n * fold; larger groups and failures stay as a trailing summary.',
      'replace',
    ],
    [
      '    for (const [index, entry] of group.entries.entries()) {\n      if (entry.id === group.terminalEntry?.id) {\n        continue;\n      }',
      '    for (const [index, entry] of group.entries.entries()) {\n      if (entry.kind === "message") {\n        continue;\n      }\n      if (entry.id === group.terminalEntry?.id) {\n        continue;\n      }',
      'replace',
    ],
  ],
  'apps/mobile/src/lib/threadActivity.ts': [
    [
      '  const firstAssistantMessageIdByTurn = new Map<TurnId, string>();\n  const terminalAssistantMessageIdByTurn = new Map<TurnId, string>();\n  for (const entry of feed) {\n    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {\n      if (!firstAssistantMessageIdByTurn.has(entry.message.turnId)) {\n        firstAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);\n      }\n      terminalAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);\n    }\n  }',
      '  const terminalAssistantMessageIdByTurn = new Map<TurnId, string>();\n  for (const entry of feed) {\n    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {\n      terminalAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);\n    }\n  }',
      'replace',
    ],
    [
      '    const firstAssistantMessageId = firstAssistantMessageIdByTurn.get(turnId);\n    const terminalAssistantMessageId = terminalAssistantMessageIdByTurn.get(turnId);\n    const hiddenEntryIds = new Set(\n      entries\n        .filter(\n          (entry) =>\n            entry.id !== firstAssistantMessageId &&\n            entry.id !== terminalAssistantMessageId &&\n            !(entry.type === "activity-group" && isUserInputActivityGroup(entry)),\n        )\n        .map((entry) => entry.id),\n    );',
      '    const terminalAssistantMessageId = terminalAssistantMessageIdByTurn.get(turnId);\n    const hiddenEntryIds = new Set(\n      entries\n        .filter(\n          (entry) =>\n            entry.type !== "message" &&\n            !(entry.type === "activity-group" && isUserInputActivityGroup(entry)),\n        )\n        .map((entry) => entry.id),\n    );',
      'replace',
    ],
  ],
};
function transform(text, changes) {
  for (const [anchor, addition, mode] of changes) {
    if (text.split(anchor).length !== 2) throw new Error(`T3 integration anchor is missing or ambiguous: ${anchor}`);
    text = mode === 'replace' ? text.replace(anchor, addition) : text.replace(anchor, addition + anchor);
  }
  return text;
}
function untransform(text, changes) {
  for (const [anchor, addition, mode] of changes)
    text = mode === 'replace' ? text.replace(addition, anchor) : text.replace(addition + anchor, anchor);
  return text;
}
async function existing(file) {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`Refusing symlink target: ${file}`);
    return await readFile(file,'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomic(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary,content,{flag:'wx',mode:0o644}); await rename(temporary,file); }
  finally { await unlink(temporary).catch((error) => { if (error.code!=='ENOENT') throw error; }); }
}
export async function applyIntegration({t3,check=false,remove=false}) {
  const target = await realpath(t3);
  const upstream = JSON.parse(await readFile(path.join(root,'upstream.json'),'utf8'));
  const manifestPath = path.join(target,'.rubato-pi-overlay.json');
  const oldText = await existing(manifestPath);
  const old = oldText ? JSON.parse(oldText) : {version:1,files:{}};
  if (old.version!==1) throw new Error('Unsupported previous overlay manifest');
  const planned = [];
  const manifest = {version:1,upstreamCommit:upstream.upstreamCommit,files:{}};
  for (const relative of [...Object.keys(upstream.targets),...overlays]) {
    const destination = path.join(target,relative);
    const parent = await realpath(path.dirname(destination));
    if (!parent.startsWith(target + path.sep)) throw new Error(`Target escapes T3 root: ${relative}`);
    const current = await existing(destination);
    let original;
    let next;
    if (relative in edits) {
      if (current===null) throw new Error(`T3 source file is missing: ${relative}`);
      original = untransform(current,edits[relative]);
      if (hash(original)!==upstream.targets[relative]) throw new Error(`T3 source changed outside this overlay: ${relative}`);
      next = transform(original,edits[relative]);
      if (current!==original && current!==next) throw new Error(`Partial external edit in T3 target: ${relative}`);
    } else {
      original = old.files[relative]?.original ?? null;
      next = await readFile(path.join(root,'overlay',relative),'utf8');
      if (current!==null && current!==next && hash(current)!==old.files[relative]?.installedHash)
        throw new Error(`Refusing to overwrite a different provider file: ${relative}`);
    }
    if (remove) {
      if (!old.files[relative]) throw new Error(`No installation record for ${relative}`);
      if (current===null || hash(current)!==old.files[relative].installedHash) throw new Error(`Installed file has local changes: ${relative}`);
      next = old.files[relative].original;
    }
    manifest.files[relative] = {original,installedHash:next===null?null:hash(next)};
    planned.push({relative,destination,current,next});
  }
  if (!check) {
    for (const item of planned) if (item.current!==item.next) {
      if (item.next===null) await unlink(item.destination);
      else await atomic(item.destination,item.next);
    }
    if (remove) await unlink(manifestPath);
    else await atomic(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  }
  return {compatible:true,check,remove,changes:planned.filter((item)=>item.current!==item.next).map((item)=>item.relative),
    upstreamCommit:upstream.upstreamCommit};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options:{t3:{type:'string'},check:{type:'boolean'},remove:{type:'boolean'}}});
    if (!values.t3) throw new Error('Usage: node harness/t3-integration/apply.mjs --t3 /absolute/t3code [--check | --remove]');
    console.log(JSON.stringify(await applyIntegration(values),null,2));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
