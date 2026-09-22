#!/usr/bin/env node
import { readFile, writeFile, lstat, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const overlays = ['apps/server/src/provider/Drivers/RubatoPiDriver.ts', 'apps/server/src/provider/RubatoPiInventory.ts', 'apps/server/src/provider/RubatoMobilePresentation.ts', 'apps/server/src/provider/RubatoMobileProtocol.ts', 'apps/web/src/components/RubatoIcon.tsx', 'apps/web/src/components/DeepSeekIcon.tsx', 'apps/web/src/components/AgentResultDetails.tsx', 'apps/server/src/workspace/createWorkspaceFile.ts', 'apps/web/src/components/files/NewMarkdownNoteDialog.tsx', 'apps/desktop/src/updates/RubatoUpdates.ts', 'apps/web/src/components/desktop/RubatoUpdateDialog.tsx'];
// 값이 [anchor, addition] 이면 anchor 앞에 붙이고, [from, to, 'replace'] 면 갈아끼운다.
// 앱 이름·번들 id·상태 경로는 T3 가 const 로 박아둬서 앞에 덧붙이는 것으로는 못 바꾼다.
//
// 값은 환경변수가 아니라 소스에 직접 박는다. 환경변수로 주면 start-gui.sh 를 지나는
// 실행만 Rubato 가 되고, 사용자가 Dock 에 고정하는 것은 앱이 실행 중에 만드는
// .electron-runtime 번들이라 그 경로로 켜면 맨 T3 가 떴다. 아이콘도 같은 이유로
// 여기서 경로를 바꾸는 대신, 설치기가 T3 가 읽는 자리에 Rubato 것을 깔아둔다.
const edits = {
  'apps/desktop/src/window/DesktopWindow.ts': [
    ['import * as Electron from "electron";', 'import { attachRubatoUpdates } from "../updates/RubatoUpdates.ts";\n'],
    ['    window.webContents.on("did-finish-load", () => {',
      '    attachRubatoUpdates(window, Electron, environment.desktopSettingsPath, applicationUrl);\n\n'],
  ],
  'apps/desktop/src/preload.ts': [
    ['  getPathForFile: (file: File) => webUtils.getPathForFile(file),',
      [
        '  rubatoUpdate: {',
        '    getState: () => ipcRenderer.invoke("rubato:update:get"),',
        '    respond: (id, action) => ipcRenderer.invoke("rubato:update:action", { id, action }),',
        '    onState: (listener) => {',
        '      const handler = (_event: Electron.IpcRendererEvent, state: unknown) => {',
        '        if (!state || typeof state !== "object" || !("phase" in state)) return;',
        '        if (!["idle", "available", "running", "failed"].includes(String(state.phase))) return;',
        '        listener(state as Parameters<typeof listener>[0]);',
        '      };',
        '      ipcRenderer.on("rubato:update:state", handler);',
        '      return () => ipcRenderer.removeListener("rubato:update:state", handler);',
        '    },',
        '  },',
        '',
      ].join('\n')],
  ],
  'packages/contracts/src/ipc.ts': [
    ['export interface DesktopBridge {',
      [
        'export type RubatoUpdateAction = "update" | "later" | "dismiss" | "log";',
        'export interface RubatoUpdateState {',
        '  phase: "idle" | "available" | "running" | "failed";',
        '  id?: string;',
        '  message?: string;',
        '  detail?: string;',
        '  log?: string;',
        '}',
        '',
      ].join('\n')],
    ['  getAppBranding: () => DesktopAppBranding | null;',
      [
        '  rubatoUpdate?: {',
        '    getState: () => Promise<RubatoUpdateState>;',
        '    respond: (id: string, action: RubatoUpdateAction) => Promise<void>;',
        '    onState: (listener: (state: RubatoUpdateState) => void) => () => void;',
        '  };',
        '',
      ].join('\n')],
  ],
  'apps/web/src/routes/__root.tsx': [
    ['import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";',
      'import { RubatoUpdateDialog } from "../components/desktop/RubatoUpdateDialog";\n'],
    ['          <SshPasswordPromptDialog />', '          <RubatoUpdateDialog />\n'],
  ],
  // Creation is a separate RPC so an older server cannot silently ignore a
  // create-only flag and route the request to its overwriting writeFile method.
  'packages/contracts/src/rpc.ts': [
    ['  projectsWriteFile: "projects.writeFile",', '  projectsCreateFile: "projects.createFile",\n'],
    ['const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {', 'const WsProjectsCreateFileRpc = Rpc.make(WS_METHODS.projectsCreateFile, {\n  payload: ProjectWriteFileInput,\n  success: ProjectWriteFileResult,\n  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),\n});\n\n'],
    ['  WsProjectsWriteFileRpc,\n', '  WsProjectsCreateFileRpc,\n'],
  ],
  'packages/contracts/src/project.ts': [
    ['  readonly operationPath?: string;\n  readonly cause?: unknown;\n};', '  readonly operationPath?: string;\n  readonly cause?: unknown;\n  readonly message?: string;\n};', 'replace'],
  ],
  'packages/client-runtime/src/state/projectCommands.ts': [
    ['    writeFile: createEnvironmentRpcCommand(runtime, {',
      '    createFile: createEnvironmentRpcCommand(runtime, {\n      label: "environment-data:projects:create-file",\n      tag: WS_METHODS.projectsCreateFile,\n      scheduler: fileScheduler,\n      concurrency: {\n        mode: "serial",\n        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd, input.relativePath]),\n      },\n    }),\n'],
  ],
  'apps/server/src/auth/RpcAuthorization.ts': [
    ['  [WS_METHODS.projectsWriteFile]: AuthOrchestrationOperateScope,', '  [WS_METHODS.projectsCreateFile]: AuthOrchestrationOperateScope,\n'],
  ],
  'apps/server/src/workspace/WorkspaceFileSystem.ts': [
    ['import * as WorkspaceEntries from "./WorkspaceEntries.ts";', 'import { createWorkspaceFile } from "./createWorkspaceFile.ts";\n'],
    ['    readonly writeFile: (\n      input: ProjectWriteFileInput,', '    readonly writeFile: (\n      input: ProjectWriteFileInput & { readonly createOnly?: boolean },', 'replace'],
    ['    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(',
      [
        '    if (input.createOnly) {',
        '      yield* Effect.tryPromise({',
        '        try: () => createWorkspaceFile(input.cwd, target.relativePath, input.contents),',
        '        catch: (cause) => new WorkspaceFileSystemOperationError({',
        '          workspaceRoot: input.cwd, relativePath: input.relativePath,',
        '          resolvedPath: target.absolutePath, operationPath: target.absolutePath,',
        '          operation: "write-file", cause,',
        '        }),',
        '      });',
        '      yield* workspaceEntries.refresh(input.cwd);',
        '      return { relativePath: target.relativePath };',
        '    }',
        '',
      ].join('\n')],
  ],
  'apps/server/src/ws.ts': [
    [
      'import { withTerminalOutputWindow } from "./terminal/OutputProtocol.ts";',
      'import { withRubatoMobilePresentation } from "./provider/RubatoMobileProtocol.ts";\n',
    ],
    [
      '          yield* RpcServer.make(WsRpcGroup, { disableTracing: true }).pipe(\n            Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),',
      [
        '          let clientProtocol = protocol;',
        '          if (clientOrigin.surface === "mobile") {',
        '            const providers = yield* ProviderRegistry.ProviderRegistry;',
        '            const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;',
        '            clientProtocol = withRubatoMobilePresentation(protocol, {',
        '              surface: clientOrigin.surface,',
        '              providers: providers.getProviders,',
        '              thread: (id) => query.getThreadDetailById(ThreadId.make(id)).pipe(',
        '                Effect.map(Option.getOrUndefined), Effect.orDie,',
        '              ),',
        '            });',
        '          }',
        '          yield* RpcServer.make(WsRpcGroup, { disableTracing: true }).pipe(',
        '            Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(clientProtocol)),',
      ].join('\n'),
      'replace',
    ],
    ['        [WS_METHODS.projectsWriteFile]: (input) =>',
      [
        '        [WS_METHODS.projectsCreateFile]: (input) =>',
        '          observeRpcEffect(',
        '            WS_METHODS.projectsCreateFile,',
        '            workspaceFileSystem.writeFile({ ...input, createOnly: true }).pipe(',
        '              Effect.mapError((cause) => new ProjectWriteFileError({',
        '                cwd: input.cwd, relativePath: input.relativePath,',
        '                ...projectFileFailureContext(cause),',
        '                message: cause._tag === "WorkspaceFileSystemOperationError" && cause.cause instanceof Error',
        '                  ? cause.cause.message : cause.message,',
        '                cause,',
        '              })),',
        '            ),',
        '            { "rpc.aggregate": "workspace" },',
        '          ),',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/RightPanelTabs.tsx': [
    ['import type { RightPanelSurface } from "~/rightPanelStore";', 'import { NewMarkdownNoteDialog, type MarkdownNoteTarget } from "./files/NewMarkdownNoteDialog";\n'],
    ['  FileDiff,\n  Files,', '  FileDiff,\n  FilePenLine,\n  Files,', 'replace'],
    ['interface RightPanelTabsProps {', 'interface RightPanelTabsProps {\n  noteTarget?: MarkdownNoteTarget | undefined;', 'replace'],
    ['function RightPanelEmptyState(props: {', 'function RightPanelEmptyState(props: {\n  onAddNote?: (() => void) | undefined;', 'replace'],
    ['  const [renamingDevice, setRenamingDevice] = useState<string | null>(null);', '  const [newNoteTarget, setNewNoteTarget] = useState<MarkdownNoteTarget | null>(null);\n'],
    ['    {\n      label: "Diff",\n      icon: FileDiff,\n      shortcut: "D",\n      available: props.diffAvailable,\n      disabledReason: SURFACE_UNAVAILABLE_HINTS.diff,',
      '    {\n      label: "Markdown note",\n      icon: FilePenLine,\n      shortcut: "N",\n      available: props.onAddNote !== undefined,\n      disabledReason: SURFACE_UNAVAILABLE_HINTS.files,\n      onClick: () => props.onAddNote?.(),\n      badgeCount: 0,\n    },\n'],
    ['    {\n      label: "Diff",\n      icon: FileDiff,\n      shortcut: "D",\n      available: props.diffAvailable,\n      disabledReason: SURFACE_DISABLED_REASONS.diff,',
      '    {\n      label: "Markdown note",\n      icon: FilePenLine,\n      shortcut: "N",\n      available: props.noteTarget !== undefined,\n      disabledReason: SURFACE_DISABLED_REASONS.files,\n      onClick: () => setNewNoteTarget(props.noteTarget ?? null),\n    },\n'],
    ['            onAddFiles={props.onAddFiles}', '            onAddNote={props.noteTarget ? () => setNewNoteTarget(props.noteTarget!) : undefined}\n'],
    ['    </PreviewPanelShell>', '      {newNoteTarget ? <NewMarkdownNoteDialog target={newNoteTarget} onClose={() => setNewNoteTarget(null)} /> : null}\n'],
  ],
  'apps/web/src/components/files/FilePreviewPanel.tsx': [
    ['const RENDER_MARKDOWN_STORAGE_KEY = "t3code.renderMarkdown";\n', '// Markdown reading mode is local to the opened file.\n', 'replace'],
    [
      '  // Reading markdown rendered is a preference, not a property of one file. Keeping\n  // it on the panel meant a thread switch dropped it and forced source back.\n  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useLocalStorage(\n    RENDER_MARKDOWN_STORAGE_KEY,\n    false,\n    Schema.Boolean,\n  );',
      '  // Files open for reading; an explicit line reveal still opens source.\n  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useState(true);\n  useEffect(() => setRenderMarkdownPreferred(true), [relativePath, revealRequestId]);',
      'replace',
    ],
  ],
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
    ['import {\n  AntigravityIcon,', 'import { RubatoIcon } from "../RubatoIcon";\nimport { DeepSeekIcon } from "../DeepSeekIcon";\n'],
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
        '  "b-ai": DeepSeekIcon,',
        '};',
        'const VENDOR_LABELS: Record<string, string> = {',
        '  "openai-codex": "OpenAI",',
        '  anthropic: "Claude",',
        '  xai: "xAI",',
        '  "google-antigravity": "Antigravity",',
        '  kiro: "Kiro",',
        '  cursor: "Cursor",',
        '  opencode: "OpenCode",',
        '  "b-ai": "DeepSeek(b.ai)",',
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
        '  return VENDOR_LABELS[vendor ?? ""] || VENDOR_LABELS[subProvider.toLowerCase()] || subProvider;',
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
      '          ) : activeEntry && props.triggerLabel === undefined ? (\n            <ProviderInstanceIcon',
      '          ) : activeEntry && props.triggerLabel === undefined ? (\n            TriggerIcon ? (\n              <TriggerIcon\n                className={cn("size-4 shrink-0", props.activeProviderIconClassName)}\n                aria-hidden\n              />\n            ) : (\n            <ProviderInstanceIcon',
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
      '        <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />',
      '        <T3Wordmark aria-label="Rubato" className="h-[1cap] w-auto shrink-0" />',
      'replace',
    ],
    [
      '        >\n          Code\n        </span>',
      '        >\n          {null}\n        </span>',
      'replace',
    ],
  ],

  // 이미 저장된 잘못된 사고 행은 본문에서만 제외한다. Pi 원본과 T3 DB는
  // 건드리지 않고, 우리 브리지가 발급한 reasoning ID만 식별한다.
  'apps/web/src/session-logic.ts': [
    [
      '  const showMessage = (message: ChatMessage) =>\n    message.role !== "user" || !foldedAnswerMessageIds.has(message.id);',
      '  const showMessage = (message: ChatMessage) =>\n    !/^assistant:pi:[^:]+:[a-f0-9]{24}:reasoning$/.test(message.id) &&\n    (message.role !== "user" || !foldedAnswerMessageIds.has(message.id));',
      'replace',
    ],
    [
      '    if (activity.kind === "context-window.updated") continue;\n    if (activity.kind === "turn.plan.updated") continue;',
      '    if (activity.kind === "context-window.updated") continue;\n    if (activity.kind === "session.speed.updated") continue;\n    if (activity.kind === "turn.plan.updated") continue;',
      'replace',
    ],
  ],
  // 중간 발화는 완료 후 접되, 마지막 답변의 연속된 조각은 전부 남긴다.
  // 사고/답변 분리는 브리지의 이벤트 타입이 맡는다.
  'apps/web/src/components/chat/MessagesTimeline.logic.ts': [
    [
      ' * Settled turns fold activity before their terminal assistant message behind\n * a "Worked for ..." row. A single ordinary activity after that message joins\n * the fold, while larger groups and failures stay visible as a trailing summary.',
      ' * Settled turns fold intermediate commentary and activity behind a "Worked for"\n * row. Keep the terminal run of assistant messages intact, not just its last\n * fragment. A single ordinary activity after the answer joins the fold;\n * larger groups and failures stay visible as a trailing summary.',
      'replace',
    ],
    [
      '    for (const [index, entry] of group.entries.entries()) {\n      if (entry.id === group.terminalEntry?.id) {\n        continue;\n      }',
      '    // 답변은 마지막 조각만 남기지 않는다. 터미널 답변 앞으로 이어진 assistant\n    // 메시지를 한 덩어리로 본다. 사고 행은 이 덩어리에 넣지 않는다 — 업스트림이\n    // 답변 뒤 thinking 을 그 턴의 접힘에 넣기 때문이다.\n    let answerStartIndex = terminalEntryIndex;\n    while (answerStartIndex > 0) {\n      const previous = group.entries[answerStartIndex - 1];\n      if (previous?.kind !== "message" || previous.message.role !== "assistant") break;\n      answerStartIndex -= 1;\n    }\n    for (const [index, entry] of group.entries.entries()) {\n      if (\n        entry.kind === "message" &&\n        entry.message.role === "assistant" &&\n        index >= answerStartIndex\n      ) {\n        continue;\n      }',
      'replace',
    ],
  ],
  'apps/web/src/components/chat/MessagesTimeline.logic.test.ts': [
    [
      '  it("folds all assistant messages before the terminal message", () => {',
      '  it("keeps all adjacent final answer fragments when there is no intervening work", () => {',
      'replace',
    ],
    [
      '    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);\n  });\n\n  const reasoningEntry = (id: string, at: string, turnId: string | null) => ({',
      '    expect(rows.map((row) => row.id)).toEqual([\n      "assistant-first-entry", "assistant-middle-entry", "assistant-final-entry",\n    ]);\n  });\n\n  const reasoningEntry = (id: string, at: string, turnId: string | null) => ({',
      'replace',
    ],
  ],
  // 큐에 든 말과 끼어드는 말은 다른 물건이다. T3 는 대기 메시지를 첫 툴 경계에서
  // 내보내므로 ↑(Send now) 와 자동 방출이 같은 결과가 되고, Rubato 에서는 그 말이
  // Pi 자신의 follow_up 큐로 들어가 T3 가 보여주지도 취소하지도 못했다. 루바토에서는
  // 대기 메시지를 턴이 끝날 때까지 붙들어 둔다 — 그게 팔로업이고, ↑ 는 승격이다.
  'apps/web/src/components/ChatView.tsx': [
    ...[10, 12].map((indent) => {
      const spaces = ' '.repeat(indent);
      return [
        `\n${spaces}onAddFiles={addFilesSurface}`,
        `\n${spaces}noteTarget={activeWorkspaceRoot ? { threadRef: activeThreadRef, cwd: activeWorkspaceRoot } : undefined}\n${spaces}onAddFiles={addFilesSurface}`,
        'replace',
      ];
    }),
    [
      '    if (!isQueuedMessageDue({ message: nextQueuedMessage, phase, latestToolActivityId })) return;\n    sendQueuedMessage(nextQueuedMessage);\n  }, [\n    isSendBusy,\n    latestToolActivityId,\n    nextQueuedMessage,\n    phase,\n    queueBlockedByPendingRequest,\n    queueSendGate,\n  ]);',
      '    if (!isQueuedMessageDue({ message: nextQueuedMessage, phase, latestToolActivityId })) return;\n    // A queued message is a follow-up: it runs as its own turn once this one\n    // ends. Releasing it at a tool boundary would make the row\'s Send now\n    // arrow mean nothing — that arrow is the promotion to a steer.\n    if (phase === "running" && selectedProvider === ProviderDriverKind.make("rubato-pi")) return;\n    sendQueuedMessage(nextQueuedMessage);\n  }, [\n    isSendBusy,\n    latestToolActivityId,\n    nextQueuedMessage,\n    phase,\n    queueBlockedByPendingRequest,\n    queueSendGate,\n    selectedProvider,\n  ]);',
      'replace',
    ],
    [
      'import {\n  deriveAgentPanelModel,\n  foldSubagentActivities,\n} from "@t3tools/client-runtime/state/subagentRuntime";',
      'import {\n  deriveAgentPanelModel,\n  foldSubagentActivities,\n  formatSpeedLabel,\n  latestSessionSpeed,\n} from "@t3tools/client-runtime/state/subagentRuntime";',
      'replace',
    ],
    [
      '  const activeContextWindow = useMemo(\n    () => deriveLatestContextWindowSnapshot(threadActivities),\n    [threadActivities],\n  );',
      '  const activeContextWindow = useMemo(\n    () => deriveLatestContextWindowSnapshot(threadActivities),\n    [threadActivities],\n  );\n  const sessionSpeedLabel = useMemo(() => {\n    const score = activeContextWindow?.speedIndex ?? latestSessionSpeed(threadActivities);\n    return score === null ? null : formatSpeedLabel(score);\n  }, [activeContextWindow, threadActivities]);',
      'replace',
    ],
    [
      '                            activeContextWindow={activeContextWindow}',
      '                            activeContextWindow={activeContextWindow}\n                            sessionSpeedLabel={sessionSpeedLabel}',
      'replace',
    ],
  ],
  'apps/mobile/src/lib/threadActivity.ts': [
    [
      '        .filter((message) => message.role !== "user" || !foldedAnswerMessageIds.has(message.id))',
      '        .filter((message) =>\n          !/^assistant:pi:[^:]+:[a-f0-9]{24}:reasoning$/.test(message.id) &&\n          (message.role !== "user" || !foldedAnswerMessageIds.has(message.id)))',
      'replace',
    ],
    [
      '  const firstAssistantMessageIdByTurn = new Map<TurnId, string>();\n  const terminalAssistantMessageIdByTurn = new Map<TurnId, string>();\n  for (const entry of feed) {\n    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {\n      if (!firstAssistantMessageIdByTurn.has(entry.message.turnId)) {\n        firstAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);\n      }\n      terminalAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);\n    }\n  }',
      '  const terminalAssistantMessageIdByTurn = new Map<TurnId, string>();\n  for (const entry of feed) {\n    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {\n      terminalAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);\n    }\n  }',
      'replace',
    ],
    [
      '    const firstAssistantMessageId = firstAssistantMessageIdByTurn.get(turnId);\n    const terminalAssistantMessageId = terminalAssistantMessageIdByTurn.get(turnId);\n    const hiddenEntryIds = new Set(\n      entries\n        .filter(\n          (entry) =>\n            entry.id !== firstAssistantMessageId &&\n            entry.id !== terminalAssistantMessageId &&\n            !(entry.type === "activity-group" && isUserInputActivityGroup(entry)),\n        )\n        .map((entry) => entry.id),\n    );',
      '    const terminalAssistantMessageId = terminalAssistantMessageIdByTurn.get(turnId);\n    const terminalIndex = entries.findIndex((entry) => entry.id === terminalAssistantMessageId);\n    // 웹과 같은 규칙이다. 답변은 마지막 조각만 남기지 않고, 사고 행은 덩어리에\n    // 넣지 않는다.\n    let answerStartIndex = terminalIndex;\n    while (answerStartIndex > 0) {\n      const previous = entries[answerStartIndex - 1];\n      if (previous?.type !== "message" || previous.message.role !== "assistant") break;\n      answerStartIndex -= 1;\n    }\n    const hiddenEntryIds = new Set(\n      entries\n        .filter(\n          (entry, index) =>\n            !(\n              entry.type === "message" &&\n              entry.message.role === "assistant" &&\n              index >= answerStartIndex\n            ) &&\n            !(entry.type === "activity-group" && isUserInputActivityGroup(entry)),\n        )\n        .map((entry) => entry.id),\n    );',
      'replace',
    ],
    [
      '    if (activity.kind === "context-window.updated") continue;\n    if (activity.summary === "Checkpoint captured") continue;',
      '    if (activity.kind === "context-window.updated") continue;\n    if (activity.kind === "session.speed.updated") continue;\n    if (activity.summary === "Checkpoint captured") continue;',
      'replace',
    ],
  ],
  'apps/mobile/src/lib/threadActivity.test.ts': [
    [
      '  it("keeps the first and terminal assistant messages visible around settled work", () => {',
      '  it("folds intermediate commentary and keeps the terminal answer visible", () => {',
      'replace',
    ],
    [
      '    expect(collapsed.map((entry) => entry.id)).toEqual([\n      "assistant-first",\n      "turn-fold:turn-1",\n      "assistant-final",\n    ]);\n    expect(collapsed[1]).toMatchObject({',
      '    expect(collapsed.map((entry) => entry.id)).toEqual([\n      "turn-fold:turn-1",\n      "assistant-final",\n    ]);\n    expect(collapsed[0]).toMatchObject({',
      'replace',
    ],
    [
      '    expect(expanded.map((entry) => entry.id)).toEqual([\n      "assistant-first",\n      "turn-fold:turn-1",\n      "work-toggle:work-group:tool-completed",',
      '    expect(expanded.map((entry) => entry.id)).toEqual([\n      "turn-fold:turn-1",\n      "assistant-first",\n      "work-toggle:work-group:tool-completed",',
      'replace',
    ],
    [
      '    expect(interrupted[1]).toMatchObject({\n      type: "turn-fold",\n      label: "You stopped after 19s",',
      '    expect(interrupted[0]).toMatchObject({\n      type: "turn-fold",\n      label: "You stopped after 19s",',
      'replace',
    ],
    [
      '    expect(retimed[1]).toMatchObject({ type: "turn-fold", label: "Worked for 23s" });\n    expect(collapsed[1]).toMatchObject({ type: "turn-fold", label: "Worked for 17s" });',
      '    expect(retimed[0]).toMatchObject({ type: "turn-fold", label: "Worked for 23s" });\n    expect(collapsed[0]).toMatchObject({ type: "turn-fold", label: "Worked for 17s" });',
      'replace',
    ],
    [
      '  it("folds assistant messages between the first and terminal messages", () => {',
      '  it("keeps adjacent final answer fragments without intervening work", () => {',
      'replace',
    ],
    [
      '      "assistant-first",\n      "turn-fold:turn-1",\n      "assistant-final",\n    ]);\n  });\n\n  it("measures a steer-superseded turn from its user boundary through trailing work", () => {',
      '      "assistant-first",\n      "assistant-middle",\n      "assistant-final",\n    ]);\n  });\n\n  it("measures a steer-superseded turn from its user boundary through trailing work", () => {',
      'replace',
    ],
  ],
  // 슬래시 메뉴가 줄 맨 앞에서만 열렸다. 고른 스킬은 `$name` 칩이 되므로
  // 그 다음에 `/` 를 쳐도 목록이 안 떴다. 메뉴 쪽은 이미 중간에서도 스킬을
  // 남긴다. `/usr/bin` 과 `//` 는 경로로 보고 건너뛴다.
  //
  // 앵커의 `$` 는 업스트림이 통화 기호 전체(`\p{Sc}`)로 넓혔다. 우리가 더하는
  // `/` 분기는 그대로 두고, 표지판만 새 모양을 따라간다.
  'apps/web/src/composer-logic.ts': [
    [
      '  const skillPrefix = /^\\p{Sc}/u.exec(token);\n  if (skillPrefix) {\n    return {\n      kind: "skill",\n      query: token.slice(skillPrefix[0].length),\n      rangeStart: tokenStart,\n      rangeEnd: cursor,\n    };\n  }\n  if (!token.startsWith("@")) {\n    return null;\n  }',
      '  const skillPrefix = /^\\p{Sc}/u.exec(token);\n  if (skillPrefix) {\n    return {\n      kind: "skill",\n      query: token.slice(skillPrefix[0].length),\n      rangeStart: tokenStart,\n      rangeEnd: cursor,\n    };\n  }\n  if (token.startsWith("/") && !token.includes("/", 1)) {\n    return {\n      kind: "slash-command",\n      query: token.slice(1),\n      rangeStart: tokenStart,\n      rangeEnd: cursor,\n    };\n  }\n  if (!token.startsWith("@")) {\n    return null;\n  }',
      'replace',
    ],
  ],
  'packages/shared/src/composerTrigger.ts': [
    [
      '  const skillPrefix = /^\\p{Sc}/u.exec(token);\n  if (skillPrefix) {\n    return {\n      kind: "skill",\n      query: token.slice(skillPrefix[0].length),\n      rangeStart: tokenStart,\n      rangeEnd: cursor,\n    };\n  }\n  if (!token.startsWith("@")) {\n    return null;\n  }',
      '  const skillPrefix = /^\\p{Sc}/u.exec(token);\n  if (skillPrefix) {\n    return {\n      kind: "skill",\n      query: token.slice(skillPrefix[0].length),\n      rangeStart: tokenStart,\n      rangeEnd: cursor,\n    };\n  }\n  if (token.startsWith("/") && !token.includes("/", 1)) {\n    return {\n      kind: "slash-command",\n      query: token.slice(1),\n      rangeStart: tokenStart,\n      rangeEnd: cursor,\n    };\n  }\n  if (!token.startsWith("@")) {\n    return null;\n  }',
      'replace',
    ],
  ],
  'apps/web/src/composer-logic.test.ts': [
    [
      '  it("keeps slash command detection active for provider commands", () => {\n    const text = "/rev";\n    const trigger = detectComposerTrigger(text, text.length);\n\n    expect(trigger).toEqual({\n      kind: "slash-command",\n      query: "rev",\n      rangeStart: 0,\n      rangeEnd: text.length,\n    });\n  });',
      '  it("keeps slash command detection active for provider commands", () => {\n    const text = "/rev";\n    const trigger = detectComposerTrigger(text, text.length);\n\n    expect(trigger).toEqual({\n      kind: "slash-command",\n      query: "rev",\n      rangeStart: 0,\n      rangeEnd: text.length,\n    });\n  });\n\n  it("opens the slash menu from a bare slash after other text", () => {\n    const text = "then /";\n    expect(detectComposerTrigger(text, text.length)).toEqual({\n      kind: "slash-command",\n      query: "",\n      rangeStart: "then ".length,\n      rangeEnd: text.length,\n    });\n  });\n\n  it("detects a slash command after leading prose", () => {\n    const text = "please /rev";\n    expect(detectComposerTrigger(text, text.length)).toEqual({\n      kind: "slash-command",\n      query: "rev",\n      rangeStart: "please ".length,\n      rangeEnd: text.length,\n    });\n  });\n\n  it("detects a second slash after a skill mention", () => {\n    const text = "$review /sk";\n    expect(detectComposerTrigger(text, text.length)).toEqual({\n      kind: "slash-command",\n      query: "sk",\n      rangeStart: "$review ".length,\n      rangeEnd: text.length,\n    });\n  });\n\n  it("does not treat path-like tokens as slash commands", () => {\n    expect(detectComposerTrigger("see /usr/bin", "see /usr/bin".length)).toBeNull();\n    expect(detectComposerTrigger("note //", "note //".length)).toBeNull();\n  });',
      'replace',
    ],
  ],
  // Speed Index replaces the agent-row token counter, and the lead score sits
  // in the composer footer. The packed CLI status line stays off the wire.
  'packages/contracts/src/providerRuntime.ts': [
    [
      '  toolUses: Schema.optional(NonNegativeInt),\n  durationMs: Schema.optional(NonNegativeInt),\n});\nexport type RuntimeTaskUsage = typeof RuntimeTaskUsage.Type;',
      '  toolUses: Schema.optional(NonNegativeInt),\n  durationMs: Schema.optional(NonNegativeInt),\n  speedIndex: Schema.optional(NonNegativeInt),\n});\nexport type RuntimeTaskUsage = typeof RuntimeTaskUsage.Type;',
      'replace',
    ],
    [
      '  durationMs: Schema.optional(NonNegativeInt),\n  compactsAutomatically: Schema.optional(Schema.Boolean),',
      '  durationMs: Schema.optional(NonNegativeInt),\n  speedIndex: Schema.optional(NonNegativeInt),\n  compactsAutomatically: Schema.optional(Schema.Boolean),',
      'replace',
    ],
  ],
  'packages/client-runtime/src/state/subagentRuntime.ts': [
    // Completion detail retains the report; summaries and live activity stay bounded.
    [
      '        const summary = asString(payload.summary) ?? asString(payload.detail);',
      '        const summary = asString(payload.detail) ?? asString(payload.summary);',
      'replace',
    ],
    ...[
      '\n              agent.error = agent.error ?? bounded(summary);',
      '\n              agent.result = agent.result ?? bounded(summary);',
      '\n            agent.error = agent.error ?? bounded(summary);',
      '\n            agent.result = bounded(summary);',
    ].map((line) => [line, line.replace('bounded(summary)', 'summary'), 'replace']),
    [
      '  readonly toolUses?: number;\n  readonly durationMs?: number;\n}',
      '  readonly toolUses?: number;\n  readonly durationMs?: number;\n  readonly speedIndex?: number;\n}',
      'replace',
    ],
    [
      '    toolUses?: number;\n    durationMs?: number;\n  } = { totalTokens };',
      '    toolUses?: number;\n    durationMs?: number;\n    speedIndex?: number;\n  } = { totalTokens };',
      'replace',
    ],
    [
      '  const durationMs = asCount(record.durationMs);\n  if (durationMs !== undefined) usage.durationMs = durationMs;\n  return usage;',
      '  const durationMs = asCount(record.durationMs);\n  if (durationMs !== undefined) usage.durationMs = durationMs;\n  const speedIndex = asCount(record.speedIndex);\n  if (speedIndex !== undefined) usage.speedIndex = speedIndex;\n  return usage;',
      'replace',
    ],
    [
      '    toolUses?: number;\n    durationMs?: number;\n  } = { totalTokens: Math.max(current.totalTokens, incoming.totalTokens) };',
      '    toolUses?: number;\n    durationMs?: number;\n    speedIndex?: number;\n  } = { totalTokens: Math.max(current.totalTokens, incoming.totalTokens) };',
      'replace',
    ],
    [
      '  const durationMs = pick(current.durationMs, incoming.durationMs);\n  if (durationMs !== undefined) merged.durationMs = durationMs;\n  return merged;',
      '  const durationMs = pick(current.durationMs, incoming.durationMs);\n  if (durationMs !== undefined) merged.durationMs = durationMs;\n  const speedIndex = incoming.speedIndex !== undefined ? incoming.speedIndex : current.speedIndex;\n  if (speedIndex !== undefined) merged.speedIndex = speedIndex;\n  return merged;',
      'replace',
    ],
    [
      'export function formatSubagentTokenCount(totalTokens: number): string {',
      'export function formatSpeedLabel(score: number | null | undefined): string {\n  return typeof score === "number" && Number.isFinite(score) ? `Speed ${Math.round(score)}` : "Speed —";\n}\n\nexport function latestSessionSpeed(\n  activities: readonly { kind: string; payload: unknown }[],\n): number | null {\n  for (let index = activities.length - 1; index >= 0; index -= 1) {\n    const activity = activities[index];\n    if (!activity || activity.kind !== "session.speed.updated") continue;\n    const payload = activity.payload;\n    if (!payload || typeof payload !== "object") return null;\n    const score = (payload as { speedIndex?: unknown }).speedIndex;\n    return typeof score === "number" && Number.isFinite(score) ? Math.round(score) : null;\n  }\n  return null;\n}\n\nexport function formatSubagentTokenCount(totalTokens: number): string {',
      'replace',
    ],
  ],
  'apps/web/src/components/AgentsPanel.tsx': [
    [
      'import { useEffect, useRef, useState } from "react";',
      'import { useEffect, useId, useRef, useState } from "react";\nimport { AgentResultDetails } from "./AgentResultDetails";',
      'replace',
    ],
    [
      '/** Flat, non-interactive agent status line. No unfold. */\nfunction AgentRow({ agent }: { agent: RuntimeSubagent }) {',
      '/** Stable collapsed row with an inline report; opening never starts child work. */\nfunction AgentRow({ agent }: { agent: RuntimeSubagent }) {\n  const [open, setOpen] = useState(false);\n  const detailsId = useId();',
      'replace',
    ],
    [
      '    <div className="grid h-[3.875rem] grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1">',
      [
        '    <div className="min-w-0">',
        '    <button',
        '      type="button"',
        '      aria-expanded={open}',
        '      aria-controls={detailsId}',
        '      aria-label={`${agent.title}: ${open ? "Hide" : "Show"} report. ${statusLabel}`}',
        '      onClick={() => setOpen((value) => !value)}',
        '      className="grid h-[3.875rem] w-full cursor-pointer grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"',
        '    >',
      ].join('\n'),
      'replace',
    ],
    [
      '        {activity ?? statusLabel}',
      '        {activity ? (activity.length > 180 ? `${activity.slice(0, 177)}...` : activity) : statusLabel}',
      'replace',
    ],
    [
      '          <AgentElapsed agent={agent} />',
      '          <AgentElapsed agent={agent} />\n          {open ? <ChevronDown aria-hidden className="size-3" /> : <ChevronRight aria-hidden className="size-3" />}',
      'replace',
    ],
    [
      '      <span className="sr-only">{statusLabel}</span>\n    </div>',
      [
        '      <span className="sr-only">{statusLabel}</span>',
        '    </button>',
        '    {open ? (',
        '      <div',
        '        id={detailsId}',
        '        role="region"',
        '        aria-label={`${agent.title} report`}',
        '        tabIndex={0}',
        '        className="mx-1.5 mb-2 max-h-96 min-w-0 overflow-y-auto overscroll-contain rounded-md border border-border/60 bg-card/30 p-3 focus-visible:outline-2 focus-visible:outline-ring"',
        '      >',
        '        <AgentResultDetails agent={agent} />',
        '      </div>',
        '    ) : null}',
        '    </div>',
      ].join('\n'),
      'replace',
    ],
    [
      '  formatSubagentModelLabel,\n  formatSubagentTokenCount,\n} from "@t3tools/client-runtime/state/subagentRuntime";',
      '  formatSubagentModelLabel,\n  formatSpeedLabel,\n} from "@t3tools/client-runtime/state/subagentRuntime";',
      'replace',
    ],
    [
      '    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",',
      '    formatSpeedLabel(agent.usage?.speedIndex),',
      'replace',
    ],
    [
      '  const members = workflowMembers(group);\n  const failed = members.filter((member) => member.status === "failed").length;\n  // Coordinator usage may already aggregate members (panel-footer rule):\n  // count it only when there are no member rows to sum.\n  const totalTokens = members.reduce(\n    (sum, member) => sum + (member.usage?.totalTokens ?? 0),\n    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,\n  );\n  const elapsed =',
      '  const members = workflowMembers(group);\n  const failed = members.filter((member) => member.status === "failed").length;\n  const elapsed =',
      'replace',
    ],
    [
      '          <span>{members.length} agents</span>\n          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>\n          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}',
      '          <span>{members.length} agents</span>\n          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}',
      'replace',
    ],
    [
      '          {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}\n        </span>\n        <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>\n      </footer>',
      '          {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}\n        </span>\n      </footer>',
      'replace',
    ],
  ],
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    [
      '  formatSubagentModelLabel,\n  formatSubagentTokenCount,\n  isActiveSubagentStatus,',
      '  formatSubagentModelLabel,\n  formatSpeedLabel,\n  isActiveSubagentStatus,',
      'replace',
    ],
    [
      '    agent.usage && agent.usage.totalTokens > 0\n      ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok`\n      : null,',
      '    formatSpeedLabel(agent.usage?.speedIndex),',
      'replace',
    ],
  ],
  'apps/web/src/components/chat/ChatComposer.tsx': [
    [
      '  // Context window\n  activeContextWindow: ContextWindowSnapshot | null;',
      '  // Context window\n  activeContextWindow: ContextWindowSnapshot | null;\n  sessionSpeedLabel?: string | null;',
      'replace',
    ],
    [
      '    activeThreadModelSelection,\n    activeContextWindow,\n    compactThreadUnavailable,',
      '    activeThreadModelSelection,\n    activeContextWindow,\n    sessionSpeedLabel,\n    compactThreadUnavailable,',
      'replace',
    ],
    [
      '                  isComposerResting &&\n                    ((settings.contextWindowMeterEnabled && activeContextWindow) ||\n                    reserveContextWindowMeter\n                      ? "pr-28"\n                      : showComposerAttachAction\n                        ? "pr-20"\n                        : "pr-12"),',
      '                  isComposerResting &&\n                    (sessionSpeedLabel\n                      ? "pr-44"\n                      : (settings.contextWindowMeterEnabled && activeContextWindow) ||\n                          reserveContextWindowMeter\n                        ? "pr-28"\n                        : showComposerAttachAction\n                          ? "pr-20"\n                          : "pr-12"),',
      'replace',
    ],
    [
      '                  {showComposerAttachAction ? (',
      '                  {sessionSpeedLabel ? (\n                    <span className="shrink-0 px-1 font-mono text-sm tabular-nums text-secondary-label">\n                      {sessionSpeedLabel}\n                    </span>\n                  ) : null}\n                  {showComposerAttachAction ? (',
      'replace',
    ],
  ],
  'apps/web/src/lib/contextWindow.ts': [
    [
      '      toolUses: asFiniteNumber(payload?.toolUses),\n      durationMs: asFiniteNumber(payload?.durationMs),\n      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,',
      '      toolUses: asFiniteNumber(payload?.toolUses),\n      durationMs: asFiniteNumber(payload?.durationMs),\n      speedIndex: asFiniteNumber(payload?.speedIndex),\n      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,',
      'replace',
    ],
  ],
  'apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts': [
    [
      '        if (thread.titleState?.source !== "manual" && canReplaceThreadTitle(thread.title)) {',
      [
        '        // Rubato 의 스레드 제목은 Pi 세션이 짓는다. 그 엔진은 T3 의 배경',
        '        // 텍스트 생성을 대신 해 주지 않으므로(드라이버가 unsupported) 여기서',
        '        // 첫 메시지를 제목으로 굳히면 앱에는 영영 지어진 제목이 안 뜬다.',
        '        // 사용자가 직접 고친 제목은 위 조건이 계속 지킨다.',
        '        if (',
        '          thread.titleState?.source !== "manual" &&',
        '          (canReplaceThreadTitle(thread.title) || String(event.provider) === "rubato-pi")',
        '        ) {',
      ].join('\n'),
      'replace',
    ],
    [
      '                  summary: truncateDetail(event.payload.summary),\n                  detail: truncateDetail(event.payload.summary),',
      '                  summary: truncateDetail(event.payload.summary),\n                  detail: event.payload.summary,',
      'replace',
    ],
    [
      '      const summary =\n        beforeTokens !== undefined && afterTokens !== undefined\n          ? `Compacted context ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens`\n          : "Context compacted";',
      [
        '      const detail = event.payload.detail;',
        '      const notesWindow = detail !== null && typeof detail === "object" &&',
        '        "contextMode" in detail && detail.contextMode === "history-notes";',
        '      const summary = notesWindow',
        '        ? "Context Optimized"',
        '        : beforeTokens !== undefined && afterTokens !== undefined',
        '          ? `Compacted context ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens`',
        '          : "Context compacted";',
      ].join('\n'),
      'replace',
    ],
    [
      '    case "thread.token-usage.updated": {\n      const payload = buildContextWindowActivityPayload(event);',
      '    case "thread.metadata.updated": {\n      const metadata = event.payload.metadata;\n      if (metadata === undefined || !("speedIndex" in metadata)) return [];\n      const raw = metadata.speedIndex;\n      const speedIndex =\n        typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;\n      return [\n        {\n          id: EventId.make(`session-speed:${event.threadId}`),\n          createdAt: event.createdAt,\n          tone: "info",\n          kind: "session.speed.updated",\n          summary: speedIndex === null ? "Speed —" : `Speed ${speedIndex}`,\n          payload: { speedIndex },\n          turnId: toTurnId(event.turnId) ?? null,\n          ...maybeSequence,\n        },\n      ];\n    }\n\n    case "thread.token-usage.updated": {\n      const payload = buildContextWindowActivityPayload(event);',
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
      // A previous overlay can have different replacements. Only trust its
      // recorded original when the installed file still matches its hash;
      // user edits must continue to fail before any writes.
      const prior = old.files[relative];
      const recorded = prior?.original !== null && typeof prior?.original === 'string'
        && hash(current) === prior.installedHash;
      original = recorded ? prior.original : untransform(current,edits[relative]);
      if (hash(original)!==upstream.targets[relative]) throw new Error(`T3 source changed outside this overlay: ${relative}`);
      next = transform(original,edits[relative]);
      if (!recorded && current!==original && current!==next) throw new Error(`Partial external edit in T3 target: ${relative}`);
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
