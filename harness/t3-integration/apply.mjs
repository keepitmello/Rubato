#!/usr/bin/env node
import { readFile, writeFile, lstat, realpath, rename, unlink, mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { memoryEdits, memoryOverlays } from './memory-edits.mjs';
import { cacheEdits, cacheOverlays } from './cache-edits.mjs';
import { voiceEdits, voiceOverlays } from './voice-edits.mjs';
import { permissionEdits, permissionOverlays } from './permission-edits.mjs';
import { providerEdits, providerOverlays } from './provider-edits.mjs';
import { aboutEdits, aboutOverlays } from './about-edits.mjs';
import { scheduleEdits, scheduleOverlays } from './schedule-edits.mjs';
import { sessionMessageEdits, sessionMessageOverlays } from './session-message-edits.mjs';
import { phoneEdits, phoneOverlays } from './phone-edits.mjs';
import { officeEdits, officeOverlays } from './office-edits.mjs';
import { assetRevisionEdits, assetRevisionOverlays } from './asset-revision-edits.mjs';
import { surfaceMenuEdits, surfaceMenuOverlays } from './surface-menu-edits.mjs';
import { agentSessionEdits, agentSessionOverlays } from './agent-session-edits.mjs';
import { fileExplorerEdits, fileExplorerOverlays } from './file-explorer-edits.mjs';
import { rightPanelEdits, rightPanelOverlays } from './right-panel-edits.mjs';
import { chatWidthEdits, chatWidthOverlays } from './chat-width-edits.mjs';
import { tsgoCheckersEdits, tsgoCheckersOverlays } from './tsgo-checkers-edits.mjs';
import { agentsSurfaceEdits, agentsSurfaceOverlays } from './agents-surface-edits.mjs';
import { threadForkEdits, threadForkOverlays } from './thread-fork-edits.mjs';
import { sidebarModelIconEdits, sidebarModelIconOverlays } from './sidebar-model-icon-edits.mjs';
import { workCardEdits, workCardOverlays } from './work-card-edits.mjs';
import { fileLinkEdits, fileLinkOverlays } from './file-link-edits.mjs';
import { stagedBuildEdits, stagedBuildOverlays } from './staged-build-edits.mjs';
import { soundEdits, soundOverlays } from './sound-edits.mjs';
import { sessionPromptEdits, sessionPromptOverlays } from './session-prompt-edits.mjs';
import { stepRewindEdits, stepRewindOverlays } from './step-rewind-edits.mjs';
import { stateRetentionEdits, stateRetentionOverlays } from './state-retention-edits.mjs';
import { threadAutoArchiveEdits, threadAutoArchiveOverlays } from './thread-auto-archive-edits.mjs';
import { sidebarLookEdits, sidebarLookOverlays } from './sidebar-look-edits.mjs';
import { threadArchiveEdits, threadArchiveOverlays } from './thread-archive-edits.mjs';
import { composerLayoutEdits, composerLayoutOverlays } from './composer-layout-edits.mjs';
import { settingsMenuEdits, settingsMenuOverlays } from './settings-menu-edits.mjs';
import { localThreadEdits, localThreadOverlays } from './local-thread-edits.mjs';
import { stateQueryEdits, stateQueryOverlays } from './state-query-edits.mjs';
import { stepRewindUiEdits, stepRewindUiOverlays } from './step-rewind-ui-edits.mjs';
import { turnActionsEdits, turnActionsOverlays } from './turn-actions-edits.mjs';
import { ROUTE_TREE_EDITS } from './route-tree-edits.mjs';
import { statsEdits, statsOverlays } from './stats-edits.mjs';
import { callEdits, callOverlays } from './call-edits.mjs';
import { piAdapterEdits, piAdapterOverlays } from './pi-adapter-edits.mjs';
import { legacyImportEdits, legacyImportOverlays } from './legacy-import-edits.mjs';
import { handoffRecoveryEdits } from './handoff-recovery-edits.mjs';
import { themeEdits, themeOverlays } from './theme-edits.mjs';
import { polishEdits, polishOverlays } from './polish-edits.mjs';
import { chatTableEdits, chatTableOverlays } from './chat-table-edits.mjs';
import { markdownTildeEdits, markdownTildeOverlays } from './markdown-tilde-edits.mjs';
import { windowMaterialEdits, windowMaterialOverlays } from './window-material-edits.mjs';
import { readOpenEdits, readOpenOverlays } from './read-open-edits.mjs';
import { projectRailEdits, projectRailOverlays } from './project-rail-edits.mjs';
import { projectOrderEdits, projectOrderOverlays } from './project-order-edits.mjs';
import { usageLimitsEdits, usageLimitsOverlays } from './usage-limits-edits.mjs';
import { sectionScaleEdits, sectionScaleOverlays } from './section-scale-edits.mjs';
import { sidebarBlocksEdits, sidebarBlocksOverlays } from './sidebar-blocks-edits.mjs';
import { floatingMenuEdits, floatingMenuOverlays } from './floating-menu-edits.mjs';
import { settingsLayoutEdits, settingsLayoutOverlays } from './settings-layout-edits.mjs';
import { i18nEdits, i18nOverlays } from './i18n-edits.mjs';
import { companionEdits, companionOverlays } from './companion-edits.mjs';
import { scrollToEndEdits } from './scroll-to-end-edits.mjs';
import { timelineRailEdits, timelineRailOverlays } from './timeline-rail-edits.mjs';
import { mobileEdits, mobileOverlays } from './mobile/index.mjs';
import { threadFoldersEdits, threadFoldersOverlays } from './thread-folders-edits.mjs';
import { tailscaleEdits, tailscaleOverlays } from './tailscale-edits.mjs';
import { localAgyEdits, localAgyOverlays } from './local-agy-edits.mjs';
import { acpPerfEdits, acpPerfOverlays } from './acp-perf-edits.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const overlays = ['apps/server/src/provider/Drivers/RubatoPiDriver.ts', 'apps/server/src/provider/Drivers/RubatoPiDriver.test.ts', 'apps/server/src/provider/RubatoPiSessions.ts', 'apps/server/src/provider/RubatoPiInventory.ts', 'apps/web/src/components/RubatoIcon.tsx', 'apps/web/src/components/DeepSeekIcon.tsx', 'apps/web/src/components/OpenGatewayIcon.tsx', 'apps/web/src/components/ZhipuIcon.tsx', 'apps/web/src/components/GeminiIcon.tsx', 'apps/web/src/components/chat/rubatoModelIcons.tsx', 'apps/server/src/workspace/createWorkspaceFile.ts', 'apps/web/src/components/files/NewMarkdownNoteDialog.tsx', 'apps/desktop/src/updates/RubatoUpdates.ts', 'apps/web/src/components/desktop/RubatoUpdateDialog.tsx'];
overlays.push('apps/web/src/environments/primary/auth.recovery.test.ts');
// 값이 [anchor, addition] 이면 anchor 앞에 붙이고, [from, to, 'replace'] 면 갈아끼운다.
// 앱 이름·번들 id·상태 경로는 T3 가 const 로 박아둬서 앞에 덧붙이는 것으로는 못 바꾼다.
//
// 값은 환경변수가 아니라 소스에 직접 박는다. 환경변수로 주면 start-gui.sh 를 지나는
// 실행만 Rubato 가 되고, 사용자가 Dock 에 고정하는 것은 앱이 실행 중에 만드는
// .electron-runtime 번들이라 그 경로로 켜면 맨 T3 가 떴다. 아이콘도 같은 이유로
// 여기서 경로를 바꾸는 대신, 설치기가 T3 가 읽는 자리에 Rubato 것을 깔아둔다.
const edits = {
  // The desktop supervisor allows 60s for a backend restart. A transport failure
  // is wrapped as HTTP 500 by auth.ts, but is not an actual server response.
  'apps/web/src/environments/primary/auth.ts': [
    // auth.recovery.test.ts drives the retry loop directly.
    ['\nasync function retryTransientBootstrap<T>(', '\nexport async function retryTransientBootstrap<T>(', 'replace'],
    ['  const startedAt = Date.now();\n  while (true) {', '  const startedAt = Date.now();\n  const timeoutMs = window.desktopBridge ? 60_000 : BOOTSTRAP_RETRY_TIMEOUT_MS;\n  while (true) {', 'replace'],
    ['Date.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS', 'Date.now() - startedAt >= timeoutMs', 'replace'],
  ],
  // SSH 원격 환경. 원본은 원격에 GitHub 의 T3 릴리스를 받아 띄우는데, 그 서버에는
  // Rubato 제공자가 없다. 원격에도 Rubato 를 깔아 두고(install-gui.sh 가
  // ~/.rubato/t3-remote-server.mjs 를 만든다) 그것을 node 로 부른다. 경로는 원격
  // 실행기의 cwd 인 원격 $HOME 기준이다 — 실행기가 경로를 작은따옴표로 넘겨서 ~ 가
  // 풀리지 않는다.
  // `rubato update` 는 데스크톱에 붙인 SSH 환경도 올린다(harness/scripts/
  // ssh-remote-hosts.mjs). 그런데 연결 카탈로그는 safeStorage 로 암호화돼 있어
  // 셸에서 읽을 수 없다. 암호화 직전의 평문을 카탈로그 스키마로 읽어 비밀이
  // 없는 SSH 프로필만 옆에 ssh-environments.json 으로 둔다. 실패는 무시한다 — 이것 때문에
  // 카탈로그 저장이 실패하면 안 된다.
  'apps/desktop/src/app/DesktopConnectionCatalogStore.ts': [
    ['      document: { version: 1, encryptedCatalog },\n      suffix,\n    });\n',
      [
        '      document: { version: 1, encryptedCatalog },',
        '      suffix,',
        '    });',
        '    yield* Schema.decodeEffect(RuntimeConnectionCatalogDocumentJson)(catalog).pipe(',
        '      Effect.flatMap((doc) =>',
        '        Schema.encodeEffect(',
        '          Schema.fromJsonString(',
        '            Schema.Struct({',
        '              version: Schema.Finite,',
        '              disabledEnvironmentIds: Schema.Array(Schema.String),',
        '              profiles: Schema.Array(SshConnectionProfile),',
        '            }),',
        '          ),',
        '        )({',
        '          version: 1,',
        '          disabledEnvironmentIds: doc.disabledEnvironmentIds,',
        '          profiles: doc.profiles.filter(Schema.is(SshConnectionProfile)),',
        '        }),',
        '      ),',
        '      Effect.flatMap((text) =>',
        '        fileSystem.writeFileString(path.join(environment.stateDir, "ssh-environments.json"), `${text}\\n`),',
        '      ),',
        '      Effect.ignore,',
        '    );',
        '',
      ].join('\n'),
      'replace'],
  ],
  // The desktop SSH runner resolution moved out of main.ts, so the script lands where it resolves.
  'apps/desktop/src/ssh/DesktopSshEnvironment.ts': [
    [
      '  const releaseBaseUrl = env[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined;\n  return {\n    archiveVersion: environment.appVersion,\n    ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),\n  };',
      '  const releaseBaseUrl = env[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined;\n  // Rubato: the desktop carries its own server script, so no release archive is fetched.\n  return {\n    nodeScriptPath: ".rubato/t3-remote-server.mjs",\n    nodeEngineRange: serverPackageJson.engines.node,\n    ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),\n  };',
      'replace',
    ],
  ],
  // macOS 에서도 단일 인스턴스 잠금을 잡는다. Clerk 는 macOS 에서 잠금을 건너뛴다 —
  // LaunchServices 가 번들당 앱 하나를 지켜 주기 때문이다. 그런데 start-gui.sh 는
  // Electron 바이너리를 직접 켜서 LaunchServices 를 지나지 않고, 그렇게 켠 앱과
  // Dock 으로 켠 앱이 같은 상태 DB 에 둘이 되면 나중 앱의 데스크톱 로그인이 먼저
  // 앱의 것을 갈아치워 먼저 앱이 페어링을 요구했다. 잠금을 못 잡은 두 번째 앱은
  // 원래 다른 OS 에서처럼 스스로 끝나고, 먼저 앱의 second-instance 가 창을 올린다.
  // 잠금 범위는 userData 라서 make 가 setPath 한 뒤인 여기서 잡는다.
  'apps/desktop/src/app/DesktopClerk.ts': [
    ['import * as Context from "effect/Context";', 'import * as ElectronMain from "electron";\n'],
  ],
  // A native Dock launch has no terminal to show progress. Reuse the existing connecting
  // window on every platform while the backend becomes ready, not only on WSL.
  'apps/desktop/src/app/DesktopApp.ts': [
    ['  if (settings.wslOnly === true && settings.wslBackendEnabled === true) {\n    yield* desktopWindow.showConnectingSplash;\n  }',
      '  // Rubato: native launches show progress even before the server is ready.\n  yield* desktopWindow.showConnectingSplash;', 'replace'],
  ],
  'apps/desktop/src/window/DesktopWindow.ts': [
    ['<div class="label">Connecting to WSL…</div>', '<div class="label">Rubato를 여는 중…</div>', 'replace'],
    // macOS 권한 설정 화면(permission-edits.mjs)의 IPC 도 여기서 건다.
    ['import * as Electron from "electron";', 'import { attachRubatoUpdates } from "../updates/RubatoUpdates.ts";\nimport { attachRubatoPermissions } from "../permissions/RubatoPermissions.ts";\n'],
    ['    window.webContents.on("did-finish-load", () => {',
      '    attachRubatoUpdates(window, Electron, environment.serverSettingsPath, applicationUrl);\n    attachRubatoPermissions(window, Electron, applicationUrl, environment.serverSettingsPath);\n\n'],
  ],
  // 앱 메뉴의 "Check for Updates..." 는 T3 자체 업데이터로 간다. 소스로 빌드한
  // Rubato 앱에서는 그 업데이터가 꺼져 있어서 "Updates unavailable" 만 떴다.
  // 알림을 닫은 뒤 다시 부를 길이 이 메뉴뿐이라 Rubato 업데이트 확인으로 돌린다.
  // Rubato 업데이터를 못 차린 경우(브리지 설정 없음)에만 원래 동작으로 간다.
  'apps/desktop/src/window/DesktopApplicationMenu.ts': [
    ['import * as DesktopWindow from "./DesktopWindow.ts";',
      'import { checkRubatoUpdatesNow, rubatoUpdatesAttached } from "../updates/RubatoUpdates.ts";\n'],
    ['const handleCheckForUpdatesMenuClick = Effect.gen(function* () {\n',
      'const handleCheckForUpdatesMenuClick = Effect.gen(function* () {\n' +
      '  if (rubatoUpdatesAttached()) {\n' +
      '    const rubatoWindow = yield* DesktopWindow.DesktopWindow;\n' +
      '    yield* rubatoWindow.revealOrCreateMain;\n' +
      '    if (yield* Effect.promise(() => checkRubatoUpdatesNow())) return;\n' +
      '  }\n',
      'replace'],
  ],
  'apps/desktop/src/preload.ts': [
    ['  getPathForFile: (file: File) => webUtils.getPathForFile(file),',
      [
        '  rubatoUpdate: {',
        '    getState: () => ipcRenderer.invoke("rubato:update:get"),',
        '    respond: (id, action) => ipcRenderer.invoke("rubato:update:action", { id, action }),',
        '    checkNow: () => ipcRenderer.invoke("rubato:update:check"),',
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
        '    /** Checks now; when an update is available the in-app prompt asks to run it. False: no updater. */',
        '    checkNow?: () => Promise<boolean>;',
        '    onState: (listener: (state: RubatoUpdateState) => void) => () => void;',
        '  };',
        '',
      ].join('\n')],
  ],
  'apps/web/src/routes/__root.tsx': [
    ['import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";',
      'import { RubatoUpdateDialog } from "../components/desktop/RubatoUpdateDialog";\n'],
    ['      <SshPasswordPromptDialog />', '      <RubatoUpdateDialog />\n'],
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
    ['  [WS_METHODS.projectsWriteFile]: AuthFilesystemWriteScope,', '  [WS_METHODS.projectsCreateFile]: AuthFilesystemWriteScope,\n'],
  ],
  // Every RPC names its trace aggregate; the table is exhaustive over WS_METHODS.
  'apps/server/src/observability/RpcInstrumentation.ts': [
    ['  [WS_METHODS.projectsWriteFile]: "workspace",', '  [WS_METHODS.projectsCreateFile]: "workspace",\n'],
  ],
  'apps/server/src/workspace/WorkspaceFileSystem.ts': [
    ['import * as WorkspaceEntries from "./WorkspaceEntries.ts";', 'import { createWorkspaceFile } from "./createWorkspaceFile.ts";\n'],
    ['    readonly writeFile: (\n      input: ProjectWriteFileInput,', '    readonly writeFile: (\n      input: ProjectWriteFileInput & { readonly createOnly?: boolean },', 'replace'],
    ['    yield* fileSystem.makeDirectory(path.dirname(realTargetPath), { recursive: true }).pipe(',
      [
        '    if (input.createOnly) {',
        '      yield* Effect.tryPromise({',
        '        try: () => createWorkspaceFile(input.cwd, target.relativePath, input.contents),',
        '        catch: (cause) => new WorkspaceFileSystemOperationError({',
        '          workspaceRoot: input.cwd, relativePath: input.relativePath,',
        '          resolvedPath: realTargetPath, operationPath: realTargetPath,',
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
    ['        [WS_METHODS.projectsWriteFile]: (input) =>',
      [
        '        [WS_METHODS.projectsCreateFile]: (input) =>',
        '          workspaceFileSystem.writeFile({ ...input, createOnly: true }).pipe(',
        '            Effect.mapError((cause) => new ProjectWriteFileError({',
        '              cwd: input.cwd, relativePath: input.relativePath,',
        '              ...projectFileFailureContext(cause),',
        '              message: cause._tag === "WorkspaceFileSystemOperationError" && cause.cause instanceof Error',
        '                ? cause.cause.message : cause.message,',
        '              cause,',
        '            })),',
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
    ['    {\n      label: msg("Diff"),\n      icon: FileDiff,\n      shortcut: "D",\n      available: props.diffAvailable,\n      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.diff),',
      '    {\n      label: msg("Markdown note"),\n      icon: FilePenLine,\n      shortcut: "N",\n      available: props.onAddNote !== undefined,\n      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.files),\n      onClick: () => props.onAddNote?.(),\n    },\n'],
    ['    {\n      label: msg("Diff"),\n      icon: FileDiff,\n      shortcut: "D",\n      available: props.diffAvailable,\n      disabledReason: messages(SURFACE_DISABLED_REASONS.diff),',
      '    {\n      label: msg("Markdown note"),\n      icon: FilePenLine,\n      shortcut: "N",\n      available: props.noteTarget !== undefined,\n      disabledReason: messages(SURFACE_DISABLED_REASONS.files),\n      onClick: () => setNewNoteTarget(props.noteTarget ?? null),\n    },\n'],
    ['            onAddFiles={props.onAddFiles}', '            onAddNote={props.noteTarget ? () => setNewNoteTarget(props.noteTarget!) : undefined}\n'],
    ['    </PreviewPanelShell>', '      {newNoteTarget ? <NewMarkdownNoteDialog target={newNoteTarget} onClose={() => setNewNoteTarget(null)} /> : null}\n'],
  ],
  'apps/web/src/components/files/FilePreviewPanel.tsx': [
    ['const RENDER_MARKDOWN_STORAGE_KEY = "t3code.renderMarkdown";\n', '// Markdown reading mode is local to the opened file.\n', 'replace'],
    [
      '  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useLocalStorage(\n    RENDER_MARKDOWN_STORAGE_KEY,\n    false,\n    Schema.Boolean,\n  );',
      '  // Files open for reading; an explicit line reveal still opens source.\n  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useState(true);\n  useEffect(() => setRenderMarkdownPreferred(true), [relativePath, revealRequestId]);',
      'replace',
    ],
  ],
  'apps/server/src/provider/builtInDrivers.ts': [
    ['import type {\n  AnyProviderDriver,\n  ProviderUsageReaderEnv,\n} from "@t3tools/provider-core/server/driver";', 'import { RubatoPiDriver } from "./Drivers/RubatoPiDriver.ts";\n'],
    ['  AcpRegistryDriver,\n];', '  RubatoPiDriver,\n'],
  ],
  // Segno's words come in a run of their own that must be seen running before it completes, or the
  // phone hears nothing (RubatoPiSessions.ts ownRunShown). The relay alone knows whether its publish
  // of that running state went through; this lets the run ask, and stay running while a failed
  // publish waits on its retry.
  'apps/server/src/relay/AgentAwarenessRelay.ts': [
    // The phone's push path publishes the same events the relay does (RubatoPush.ts).
    ['\nfunction shouldPublishAgentAwarenessEvent(\n', '\nexport function shouldPublishAgentAwarenessEvent(\n', 'replace'],
    ['    readonly drain: Effect.Effect<void>;\n',
      '    /** Rubato: whether the thread\'s last publish failed and waits on a retry. */\n    readonly publishPending: (threadId: ThreadId) => Effect.Effect<boolean>;\n'],
    ['    drain: worker.drain,\n',
      '    publishPending: Effect.fn("AgentAwarenessRelay.publishPending")((threadId) =>\n      Effect.sync(() => publishRetries.get(threadId)?.timer !== undefined)),\n'],
  ],
  // Upstream's idle relay stand-in has to carry the method the relay gains above.
  'apps/server/src/cloud/CloudLink.lifecycle.test.ts': [
    ['  drain: Effect.void,\n', '  publishPending: () => Effect.succeed(false),\n'],
  ],
  'apps/server/src/serverRuntimeStartup.ts': [
    ['import { forkParked, forkParkedFiber } from "./serverActivation.ts";\n', 'import { bindRubatoSessionLookup } from "./provider/RubatoPiSessions.ts";\nimport { makeRubatoPiInventory } from "./provider/RubatoPiInventory.ts";\nimport * as Schedule from "effect/Schedule";\n'],
    // Sessions started elsewhere show as threads once commands are accepted (RubatoPiInventory.ts).
    ['    yield* Effect.logDebug("startup phase: complete");\n',
      '    yield* runStartupPhase("rubato.inventory", Effect.flatMap(makeRubatoPiInventory, (inventory) => inventory.start));\n'],
    // Before recovery resumes anything, the Rubato bridges learn which session each thread
    // already runs in, so a conversation from before V2 continues there (RubatoPiSessions.ts).
    ['    const { recovery, bootstrap: bootstrapTargets } = yield* runOrderedV2StartupPhases({\n',
      '    yield* runStartupPhase("rubato.session-lookup", bindRubatoSessionLookup);\n'],
    // 데스크톱 백엔드는 자기를 띄운 앱과 수명을 같이한다. 앱은 정상 종료 때만
    // SIGTERM 을 보내서, 앱이 크래시로 죽으면 서버가 launchd 밑에 고아로 남았다.
    // 다시 켠 앱이 새 서버를 띄우면 둘이 같은 state.sqlite 와 같은 Pi 세션에 붙어
    // 모든 이벤트를 제 턴 ID 로 한 번씩 더 썼다(답·생각 중복, 도구 묶음 끊김).
    // 부모가 바뀌면 자기에게 SIGTERM 을 보내 정상 종료 경로로 내려간다.
    [
      '  const startup = Effect.gen(function* () {\n',
      [
        '    // Rubato: a desktop backend lives only as long as the app that spawned it.',
        '    // The app sends SIGTERM on a normal quit; after a crash this process was',
        '    // reparented to launchd and kept writing beside the next backend.',
        '    if (serverConfig.mode === "desktop") {',
        '      const parentPid = process.ppid;',
        '      yield* Effect.sync(() => process.ppid !== parentPid).pipe(',
        '        Effect.repeat({ until: (orphaned) => orphaned, schedule: Schedule.spaced("2 seconds") }),',
        '        Effect.andThen(',
        '          Effect.logWarning("desktop app exited without stopping its backend; shutting down", {',
        '            parentPid,',
        '          }),',
        '        ),',
        '        Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGTERM"))),',
        '        Effect.forkScoped,',
        '      );',
        '    }',
        '',
        '',
      ].join('\n'),
    ],
  ],
  // Rubato 카탈로그는 성공한 discovery 다. Codex/OpenCode 와 같이 취급해야
  // 예전 캐시 extras 가 큐레이트 뒤에 붙어서 /model 순서와 갈라지지 않는다.
  'apps/server/src/provider/ProviderRegistry.ts': [
    [
      '  if (!isAntigravity && !isCodex && !isOpenCode) {',
      '  if (!isAntigravity && !isCodex && !isOpenCode && provider.driver !== ProviderDriverKind.make("rubato-pi")) {',
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
    ['import * as Context from "effect/Context";\n', 'import * as Config from "effect/Config";\n'],
    [
      '    input: AgentSessionImportInput,\n  ) {\n',
      '    input: AgentSessionImportInput,\n  ) {\n    if (!(yield* Config.String("RUBATO_IMPORT_AGENT_HISTORY").pipe(Effect.orElseSucceed(() => "")))) {\n      return { importedCount: 0, skippedCount: 0 } satisfies AgentSessionImportResult;\n    }\n',
      'replace',
    ],
  ],
  // The importer's own test asks for the import the gate above leaves off.
  'apps/server/src/project/AgentSessionImporter.test.ts': [
    [
      'it.effect(\n  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",\n',
      '// Rubato leaves this import off unless asked (the AgentSessionImporter edit above); this test asks.\nprocess.env.RUBATO_IMPORT_AGENT_HISTORY = "1";\n\n',
    ],
  ],
  // Rubato's engine runs outside T3 with no harness version a policy could pin, like the ACP
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
      'const APP_DISPLAY_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Beta)";',
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
  // 아이폰 알림은 서버 → T3 릴레이 → APNs 로만 온다. 앱스토어 앱에는 로컬 알림이 없다.
  // 공식 빌드는 CI 가 릴레이 주소와 Clerk 공개값을 서버에 굽는데, 우리 소스 빌드는
  // 빈 값으로 구워져서 `t3 connect` 가 링크할 곳이 없었고 게시가 매번 조용히 빠졌다.
  // 서버에만 굽는다 — 웹(VITE_*)에 넣으면 데스크톱에 T3 로그인 화면이 열린다. 값은
  // npm 의 공식 `t3` 실행파일에 박힌 공개값이고, 런타임 T3CODE_* 환경변수가 여전히 이긴다.
  'apps/server/vite.config.ts': [
    [
      '        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),',
      '        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(\n          repoEnv.T3CODE_RELAY_URL?.trim() || "https://relay.t3.codes",\n        ),',
      'replace',
    ],
    [
      '          repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",',
      '          repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() || "pk_live_Y2xlcmsudDMuY29kZXMk",',
      'replace',
    ],
    [
      '          repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",',
      '          repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || "hzxSgY2cH10sDU2r",',
      'replace',
    ],
  ],
  // 웹 진입점의 이름. 데스크톱은 preload 가 위 DesktopEnvironment 의 이름을 넘겨서
  // 이 기본값을 안 쓰지만, 아이폰·브라우저로 붙는 웹은 브리지가 없어 여기로 떨어진다
  // — 페어링 화면·첫 화면·탭 제목이 "T3 Code (Alpha)" 였다. 데스크톱과 같게 단계
  // 표시 없이 이름만 쓴다. formatAppDisplayName 은 "Latest" 단계에서 이름만 돌려준다.
  'apps/web/src/branding.ts': [
    [
      'export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "T3 Code";',
      'export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "Rubato";',
      'replace',
    ],
    [
      '  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });',
      '  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: "Latest" });',
      'replace',
    ],
  ],
  // React 가 뜨기 전의 첫 화면. 그림은 /apple-touch-icon.png 를 그대로 쓰고, 그 파일은
  // 설치기가 assets/web 의 Rubato 것으로 깐다. 여기서는 그 앞뒤 글자만 바꾼다.
  'apps/web/index.html': [
    ['    <title>T3 Code</title>', '    <title>Rubato</title>', 'replace'],
    [
      '        <div id="boot-shell-card" aria-label="T3 Code splash screen">\n          <img id="boot-shell-logo" src="/apple-touch-icon.png" alt="T3 Code" />',
      '        <div id="boot-shell-card" aria-label="Rubato splash screen">\n          <img id="boot-shell-logo" src="/apple-touch-icon.png" alt="Rubato" />',
      'replace',
    ],
  ],
  // 홈 화면에 추가했을 때 아이콘 밑에 붙는 이름. 원본 매니페스트에는 이름이 없어서
  // 기기가 추가 순간의 문서 제목을 가져갔다.
  'apps/web/public/manifest.webmanifest': [
    ['  "id": "/",\n', '  "name": "Rubato",\n  "short_name": "Rubato",\n'],
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
  // 모델 선택기와 목록 행의 제공자 글리프. 매핑에 없는 드라이버는 이름 앞
  // 두 글자로 떨어져서 Rubato 가 "RU" 로 보였다. 모델마다 그 레인의 로고와 이름을
  // 쓰는 매핑은 overlay rubatoModelIcons.tsx 에 있다.
  'apps/web/src/components/chat/ProviderInstanceIcon.tsx': [
    ['import { cn } from "~/lib/utils";', 'import { DeepSeekIcon } from "../DeepSeekIcon";\nimport { GeminiIcon } from "../GeminiIcon";\nimport { RubatoIcon } from "../RubatoIcon";\n'],
    ['  [ProviderDriverKind.make("ollama")]: OllamaIcon,\n};', '  [ProviderDriverKind.make("ollama")]: OllamaIcon,\n  [ProviderDriverKind.make("rubato-pi")]: RubatoIcon,\n  [ProviderDriverKind.make("gemini")]: GeminiIcon,\n  [ProviderDriverKind.make("deepseek")]: DeepSeekIcon,\n};', 'replace'],
  ],
  // An untouched speed select with Ultrafast is sent as Normal, like the Fast toggle's implicit false.
  'packages/shared/src/model.ts': [
    [
      '/** Cursor ACP can default Fast to true; T3 requires a user selection. */\nexport function withImplicitFastModeDefault(\n  caps: ModelCapabilities,\n  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,\n): ReadonlyArray<ProviderOptionSelection> | undefined {\n',
      '/**\n * Rubato: a speed select that offers Ultrafast is the same switch as Fast, so an untouched one is\n * Normal and is sent as such. Otherwise a tier the engine remembered from `/ultrafast` kept\n * running while the picker read Normal (harness/t3-integration/src/model-catalog-order.mjs).\n */\nfunction withImplicitServiceTierDefault(\n  caps: ModelCapabilities,\n  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,\n): ReadonlyArray<ProviderOptionSelection> | null | undefined {\n  if (modelOptions?.some((selection) => selection.id === "serviceTier")) return modelOptions;\n  for (const descriptor of caps.optionDescriptors ?? []) {\n    if (descriptor.type !== "select" || descriptor.id !== "serviceTier") continue;\n    if (!descriptor.options.some((option) => option.id === "ultrafast")) continue;\n    const normal = descriptor.options.find((option) => option.isDefault)?.id ?? "default";\n    return [...(modelOptions ?? []), { id: "serviceTier", value: normal }];\n  }\n  return modelOptions;\n}\n\n/** Cursor ACP can default Fast to true; T3 requires a user selection. */\nexport function withImplicitFastModeDefault(\n  caps: ModelCapabilities,\n  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,\n): ReadonlyArray<ProviderOptionSelection> | undefined {\n',
      'replace',
    ],
    ['  const hasExplicitFastMode = modelOptions?.some((selection) => selection.id === "fastMode");',
      '  modelOptions = withImplicitServiceTierDefault(caps, modelOptions);\n  const hasExplicitFastMode = modelOptions?.some((selection) => selection.id === "fastMode");', 'replace'],
  ],
  // The composer's trait button reads a Codex speed select as "High Ultrafast", and as plain
  // "High" on Normal. Rubato's Ultrafast models send the same select (model-catalog-order.mjs),
  'apps/web/src/components/chat/ModelListRow.tsx': [
    ['import { ProviderInstanceIcon } from "./ProviderInstanceIcon";', 'import { iconForProviderModel } from "./rubatoModelIcons";\n'],
    [
      '  const model = {\n    slug: props.slug,\n    name: props.name,\n    subProvider: props.subProvider,\n  };',
      '  const model = {\n    slug: props.slug,\n    name: props.name,\n    subProvider: props.subProvider,\n  };\n  // Rubato: the model vendor logo, where upstream shows the provider icon.\n  const ModelVendorIcon = iconForProviderModel(props.driverKind, model);',
      'replace',
    ],
    [
      '      <ProviderInstanceIcon\n        driverKind={props.driverKind}\n        displayName={props.providerDisplayName}\n        accentColor={props.providerAccentColor}\n        acpRegistryAgentId={props.acpRegistryAgentId}\n        acpRegistryIconUrl={props.acpRegistryIconUrl}\n        showBadge={props.showInstanceBadge}\n        className="size-4"\n        iconClassName="size-4"\n        indicatorBackground="var(--popover)"\n        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"\n      />',
      '      {ModelVendorIcon ? (\n        <ModelVendorIcon className="size-4 shrink-0" aria-hidden />\n      ) : (\n      <ProviderInstanceIcon\n        driverKind={props.driverKind}\n        displayName={props.providerDisplayName}\n        accentColor={props.providerAccentColor}\n        acpRegistryAgentId={props.acpRegistryAgentId}\n        acpRegistryIconUrl={props.acpRegistryIconUrl}\n        showBadge={props.showInstanceBadge}\n        className="size-4"\n        iconClassName="size-4"\n        indicatorBackground="var(--popover)"\n        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"\n      />\n      )}',
      'replace',
    ],
  ],
  // 닫힌 트리거는 인스턴스(Rubato) 아이콘을 쓴다. 고른 모델의 레인 로고로 바꾼다.
  'apps/web/src/components/chat/ProviderModelPicker.tsx': [
    [
      'import { ModelEsque, getDisplayModelName, getTriggerDisplayModelName } from "./providerIconUtils";',
      'import { ModelEsque, getDisplayModelName, getTriggerDisplayModelName } from "./providerIconUtils";\nimport { iconForProviderModel } from "./rubatoModelIcons";',
      'replace',
    ],
    [
      '  const showInstanceBadge =\n    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);',
      '  const showInstanceBadge =\n    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);\n  const TriggerIcon =\n    selectedModel && activeEntry\n      ? iconForProviderModel(activeEntry.driverKind, selectedModel)\n      : null;',
      'replace',
    ],
    [
      '            <span data-chat-provider-model-picker-icon className="contents">\n              <ProviderInstanceIcon',
      '            <span data-chat-provider-model-picker-icon className="contents">\n              {TriggerIcon ? (\n                <TriggerIcon\n                  className={cn("size-4 shrink-0", props.activeProviderIconClassName)}\n                  aria-hidden\n                />\n              ) : (\n              <ProviderInstanceIcon',
      'replace',
    ],
    [
      '              />\n            </span>\n          ) : null}',
      '              />\n              )}\n            </span>\n          ) : null}',
      'replace',
    ],
  ],
  // 사이드바 왼쪽 위 워드마크. 원래 "T3" 글리프 + "Code" 글자다.
  //
  // 워드마크는 이미지가 아니라 CLI 가 쓰는 수학 볼드 이탤릭 문자열
  // "𝒓𝒖𝒃𝒂𝒕𝒐" 다 (harness/pi-runtime/features/statusline/brand.mjs).
  // 벡터 자산이 없으므로 같은 문자열을 같은 폰트 스택으로 그린다 — 이 글리프를
  // 가진 폰트가 STIX 두 Math 뿐이라 터미널도 같은 모양을 낸다.
  // (previews/rubato-resonance/index.html 과 같은 스택이다.)
  //
  // viewBox 는 그 폰트의 잉크 경계에 맞춘다. 원래 T3 글리프의 viewBox 는
  // 글자 위아래로 여백이 많아서, 같은 h-* 클래스라도 잉크가 상자의 68% 밖에
  // 안 됐다. 잉크에 맞추면 클래스가 곧 크기가 된다 — 잉크/상자 = 0.95.
  // 값은 STIXTwoMath.otf 의 1000upm 좌표다: 잉크 x 23..3193, y -15..705 에
  // 사방 20 을 더해 0 0 3210 760, 텍스트는 그만큼 밀어 넣는다.
  'apps/web/src/components/T3Wordmark.tsx': [
    [
      '      <path\n        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"\n        fill="currentColor"\n      />',
      [
        '      <text',
        '        fill="currentColor"',
        `        fontFamily={'"STIX Two Math", "Cambria Math", "Apple Symbols", serif'}`,
        '        fontSize="1000"',
        '        x="-3"',
        '        y="725"',
        '      >',
        '        𝒓𝒖𝒃𝒂𝒕𝒐',
        '      </text>',
      ].join('\n'),
      'replace',
    ],
    [
      '    <svg {...props} viewBox="15.5309 37 94.3941 56.96" xmlns="http://www.w3.org/2000/svg">',
      '    <svg {...props} viewBox="0 0 3210 760" xmlns="http://www.w3.org/2000/svg">',
      'replace',
    ],
  ],
  // T3 MCP 도구 행의 제품 로고도 같은 워드마크라 Rubato 로 보인다. upstream 테스트는 T3 글리프의
  // 워드마크 옆의 "Code" 글자. 워드마크가 이미 제품 이름을 다 쓴다.
  // 지우는 대신 빈 글자로 둔다 — 치환을 되돌릴 때 빈 문자열은 파일 맨 앞에
  // 원문을 다시 붙여 넣어서, overlay 제거가 원본을 복원하지 못한다.
  'apps/web/src/components/sidebar/SidebarChrome.tsx': [
    [
      '      <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />',
      // 1cap 은 지금 폰트의 캡 높이라 UI 글자 크기 설정을 따라간다. 워드마크는
      // 그 1.2배 — 잉크가 상자의 0.95 라서 실제 잉크는 1.14cap 이고, 인터페이스
      // 20px(글자 0.875rem = 17.5px, 캡 12.5px)에서 14.5px 다. 원래 8px 이었다.
      '      <T3Wordmark aria-label="Rubato" className="h-[1.2cap] w-auto shrink-0" />',
      'replace',
    ],
    [
      '      >\n        {/* oxlint-disable-next-line t3code/no-untranslated-copy -- product wordmark */}\n        {"Code"}\n      </span>',
      '      >\n        {null}\n      </span>',
      'replace',
    ],
  ],

  // 대기 메시지(팔로업)와 끼어들기(스티어)는 T3 서버 큐가 가른다. 기본 followUpBehavior 가
  // "queue" 라 실행 중 보낸 말은 queue_after_active 로 그 턴이 끝난 뒤 제 턴으로 돌고, 대기
  // 행의 ↑ 는 queued-message.promote-to-steer 로 스티어가 된다. 그래서 웹 쪽 패치가 없다.
  'apps/web/src/components/ChatView.tsx': [
    ...[10].map((indent) => {
      const spaces = ' '.repeat(indent);
      return [
        `\n${spaces}onAddFiles={addFilesSurfaceStable}`,
        `\n${spaces}noteTarget={activeWorkspaceRoot ? { threadRef: activeThreadRef, cwd: activeWorkspaceRoot } : undefined}\n${spaces}onAddFiles={addFilesSurfaceStable}`,
        'replace',
      ];
    }),
  ],
  // 슬래시 메뉴는 줄 중간의 `/` 에서도 열린다(upstream 이 이제 그렇게 한다). Rubato 는
  // `/usr/bin` 같은 경로와 `//` 를 명령으로 보지 않는다 — 두 번째 `/` 가 있으면 건너뛴다.
  'apps/web/src/composer-logic.ts': [
    ['  const token = text.slice(tokenStart, cursor);\n  if (token.startsWith("/")) {\n',
      '  const token = text.slice(tokenStart, cursor);\n  if (token.startsWith("/") && !token.includes("/", 1)) {\n',
      'replace'],
  ],
  'packages/shared/src/composerTrigger.ts': [
    ['  const token = text.slice(tokenStart, cursor);\n  if (token.startsWith("/")) {\n',
      '  const token = text.slice(tokenStart, cursor);\n  if (token.startsWith("/") && !token.includes("/", 1)) {\n',
      'replace'],
  ],
  // 턴이 도는 동안 입력창에 초안이 있어도 Stop 은 그 옆에 남는다(전과 같이). upstream 은
  // 초안이 생기면 Stop 을 숨기고 스티어 화살표만 보여 줬다. 화살표의 이름은 upstream 대로 Steer 다.
  'apps/web/src/components/chat/ComposerPrimaryActions.tsx': [
    [
      '  // Keep the clicked target at the right edge even if typing changes the primary action.\n  const withStopButton = (action: ReactNode) => (\n    <>\n      {action}\n      {stopPhase === "pending" || stopPhase === "timedOut"\n        ? renderStopGenerationButton(false)\n        : null}\n    </>\n  );',
      [
        '  // Rubato: while a turn runs, Stop stays beside the steer arrow once a draft is written.',
        '  const keepStop = canInterrupt && hasSendableContent && !isEditingQueuedMessage;',
        '  // Keep the clicked target at the right edge even if typing changes the primary action.',
        '  const withStopButton = (action: ReactNode) => (',
        '    <>',
        '      {action}',
        '      {keepStop || stopPhase === "pending" || stopPhase === "timedOut"',
        '        ? renderStopGenerationButton(false)',
        '        : null}',
        '    </>',
        '  );',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/composer-logic.test.ts': [
    [
      '  it("does not keep a subcommand trigger active after /model arguments", () => {',
      [
        '  it("opens the slash menu from a bare slash after other text", () => {',
        '    const text = "then /";',
        '    expect(detectComposerTrigger(text, text.length)).toEqual({',
        '      kind: "slash-command",',
        '      query: "",',
        '      rangeStart: "then ".length,',
        '      rangeEnd: text.length,',
        '    });',
        '  });',
        '',
        '  it("detects a slash command after leading prose", () => {',
        '    const text = "please /rev";',
        '    expect(detectComposerTrigger(text, text.length)).toEqual({',
        '      kind: "slash-command",',
        '      query: "rev",',
        '      rangeStart: "please ".length,',
        '      rangeEnd: text.length,',
        '    });',
        '  });',
        '',
        '  it("detects a second slash after a skill mention", () => {',
        '    const text = "$review /sk";',
        '    expect(detectComposerTrigger(text, text.length)).toEqual({',
        '      kind: "slash-command",',
        '      query: "sk",',
        '      rangeStart: "$review ".length,',
        '      rangeEnd: text.length,',
        '    });',
        '  });',
        '',
        '  it("does not treat path-like tokens as slash commands", () => {',
        '    expect(detectComposerTrigger("see /usr/bin", "see /usr/bin".length)).toBeNull();',
        '    expect(detectComposerTrigger("note //", "note //".length)).toBeNull();',
        '  });',
        '',
        '',
      ].join('\n'),
    ],
  ],
  // 새 스레드에 쓰다 만 글. 업스트림은 글이 든 초안을 두고 새 스레드를 누르면 빈 초안을
  // 새로 만들고, 쓰던 초안은 새 사이드바의 초안 줄로 돌아가게 한다. Rubato 는 레거시
  // 사이드바를 켜는데(write-gui-settings.mjs) 거기엔 초안 줄이 없어서, 다른 스레드에
  // 갔다 와서 새 스레드를 누르면 쓰던 글이 사라진 것처럼 보였다. 그래서 인자 없는 새
  // 스레드 요청은 그 프로젝트의 쓰던 초안으로 돌아간다. 브랜치·워크트리를 지정한
  // 요청은 그 조건의 새 초안이 필요하니 업스트림대로 새로 만든다.
  'apps/web/src/hooks/useHandleNewThread.ts': [
    ['    if (emptyStoredDraftThread) {\n      return (async () => {\n',
      [
        '    // Rubato: the legacy sidebar Rubato ships has no draft rows, so the',
        '    // invested draft that mint-fresh leaves behind would be unreachable and',
        '    // the half-written prompt would look lost. A plain new-thread request',
        '    // goes back to the project\'s invested draft exactly as the user left',
        '    // it. Explicit workspace options still mint a fresh draft below.',
        '    if (',
        '      reusableStoredDraftThread &&',
        '      !emptyStoredDraftThread &&',
        '      !hasBranchOption &&',
        '      !hasWorktreePathOption &&',
        '      !hasEnvModeOption &&',
        '      !hasStartFromOriginOption',
        '    ) {',
        '      const opened = {',
        '        draftId: reusableStoredDraftThread.draftId,',
        '        threadId: reusableStoredDraftThread.threadId,',
        '      };',
        '      if (currentRouteTarget?.kind === "draft" && currentRouteTarget.draftId === opened.draftId) {',
        '        return Promise.resolve(opened);',
        '      }',
        '      return router',
        '        .navigate({',
        '          to: "/draft/$draftId",',
        '          params: { draftId: opened.draftId },',
        '          replace: options?.replace ?? false,',
        '        })',
        '        .then(() => opened);',
        '    }',
        '',
      ].join('\n')],
  ],
  'apps/web/src/hooks/useHandleNewThread.test.ts': [
    ['describe.each([\n  ["new", null],\n',
      [
        '// Rubato: the legacy sidebar has no draft rows, so a plain new-thread request',
        '// must lead back to the project\'s half-written draft rather than strand it.',
        'describe("useNewThreadHandler with an invested draft", () => {',
        '  const investedDraft = {',
        '    draftId: "draft-existing",',
        '    environmentId: "environment-ssh",',
        '    promotedTo: null,',
        '    threadId: "thread-existing",',
        '  };',
        '  const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;',
        '',
        '  it("returns to the half-written draft as the user left it", async () => {',
        '    testState.reset(investedDraft);',
        '    testState.giveUserText("draft-existing");',
        '',
        '    const opened = await useNewThreadHandler()(projectRef);',
        '',
        '    expect(opened).toEqual({ draftId: "draft-existing", threadId: "thread-existing" });',
        '    expect(testState.router.navigate).toHaveBeenCalledWith(',
        '      expect.objectContaining({ params: { draftId: "draft-existing" } }),',
        '    );',
        '    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();',
        '    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();',
        '  });',
        '',
        '  it("still opens a fresh draft when the caller asks for a specific workspace", async () => {',
        '    testState.reset(investedDraft);',
        '    testState.giveUserText("draft-existing");',
        '',
        '    const opened = await useNewThreadHandler()(projectRef, { envMode: "worktree" });',
        '',
        '    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });',
        '  });',
        '});',
        '',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/chat/ChatComposer.tsx': [
    [
      '  compactDisabled: boolean;\n',
      '  compactDisabled: boolean;\n  sessionSpeedLabel?: string | null;\n',
      'replace',
    ],
    [
      '    activeProjectId,\n    projectName,\n',
      '    activeProjectId,\n    projectName,\n    sessionSpeedLabel,\n',
      'replace',
    ],
    // 쉬는 입력창의 오른쪽 여백은 upstream 이 액션 묶음 폭을 재서 잡는다(restingActionsWidth).
    // 그래서 Speed 라벨이 그 묶음 안에 있으면 따로 비울 것이 없다.
    [
      '                  <div\n                    ref={attachExpandedComposerControls}',
      '                  {sessionSpeedLabel ? (\n                    <span data-rubato-speed-label="" className="shrink-0 px-1 font-mono text-sm tabular-nums text-secondary-label">\n                      {sessionSpeedLabel}\n                    </span>\n                  ) : null}\n                  <div\n                    ref={attachExpandedComposerControls}',
      'replace',
    ],
  ],
};
// The phone's Tailscale Serve root route, held while the server runs (tailscale-edits.mjs).
overlays.push(...tailscaleOverlays);
for (const [relative, changes] of Object.entries(tailscaleEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
overlays.push(...voiceOverlays, ...permissionOverlays);
for (const [relative, changes] of [...Object.entries(voiceEdits), ...Object.entries(permissionEdits)]) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Settings > 기억 (memory-edits.mjs) registers after the rest, so its anchors see their edits.
overlays.push(...memoryOverlays);
for (const [relative, changes] of Object.entries(memoryEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Settings > Providers (provider-edits.mjs) shares server.ts and settings.tsx anchors with memory.
overlays.push(...providerOverlays);
for (const [relative, changes] of Object.entries(providerEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Settings > General > About (about-edits.mjs).
overlays.push(...aboutOverlays);
for (const [relative, changes] of Object.entries(aboutEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The context ring's cache (cache-edits.mjs) anchors on the Speed Index and memory edits above.
overlays.push(...cacheOverlays);
for (const [relative, changes] of Object.entries(cacheEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Settings > Scheduled Tasks (schedule-edits.mjs) anchors on the memory edits above.
overlays.push(...scheduleOverlays);
for (const [relative, changes] of Object.entries(scheduleEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Messages from another conversation (session-message-edits.mjs).
overlays.push(...sessionMessageOverlays);
for (const [relative, changes] of Object.entries(sessionMessageEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Settings > Phone (phone-edits.mjs) anchors on the schedule and permission edits above.
overlays.push(...phoneOverlays);
for (const [relative, changes] of Object.entries(phoneEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The Stats page (stats-edits.mjs) anchors on the phone edits above.
overlays.push(...statsOverlays);
for (const [relative, changes] of Object.entries(statsEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Voice calls with companions (call-edits.mjs): the server route and the root's call layer.
overlays.push(...callOverlays);
for (const [relative, changes] of Object.entries(callEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Rubato's routes (the rail's pages and the settings pages above) in the generated route tree (route-tree-edits.mjs).
edits['apps/web/src/routeTree.gen.ts'] = [
  ...(edits['apps/web/src/routeTree.gen.ts'] ?? []),
  ...ROUTE_TREE_EDITS,
];
// Word, Excel, PowerPoint and Hangul documents in the file viewer (office-edits.mjs).
overlays.push(...officeOverlays);
for (const [relative, changes] of Object.entries(officeEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// A host file a session rewrites and shows again shows as it is now (asset-revision-edits.mjs).
overlays.push(...assetRevisionOverlays);
for (const [relative, changes] of Object.entries(assetRevisionEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Grouped surface launcher and "+" menu (surface-menu-edits.mjs).
overlays.push(...surfaceMenuOverlays);
for (const [relative, changes] of Object.entries(surfaceMenuEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// One agent's conversation in the Agents panel (agent-session-edits.mjs).
overlays.push(...agentSessionOverlays);
for (const [relative, changes] of Object.entries(agentSessionEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Explorer on the left, back and forward in the file surface (file-explorer-edits.mjs).
overlays.push(...fileExplorerOverlays);
for (const [relative, changes] of Object.entries(fileExplorerEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Closing the right panel's last tab returns to its launcher (right-panel-edits.mjs).
overlays.push(...rightPanelOverlays);
for (const [relative, changes] of Object.entries(rightPanelEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Chat width as a percentage slider (chat-width-edits.mjs).
overlays.push(...chatWidthOverlays);
for (const [relative, changes] of Object.entries(chatWidthEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// tsgo checker count (tsgo-checkers-edits.mjs).
overlays.push(...tsgoCheckersOverlays);
for (const [relative, changes] of Object.entries(tsgoCheckersEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Fork thread in the sidebars (thread-fork-edits.mjs) anchors on the pin edits above.
overlays.push(...threadForkOverlays);
for (const [relative, changes] of Object.entries(threadForkEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Thread card icon shows the model's company, not the Rubato mark (sidebar-model-icon-edits.mjs).
overlays.push(...sidebarModelIconOverlays);
for (const [relative, changes] of Object.entries(sidebarModelIconEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The right panel's Agents surface, which v0.1.0 dropped (agents-surface-edits.mjs).
overlays.push(...agentsSurfaceOverlays);
for (const [relative, changes] of Object.entries(agentsSurfaceEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Chat links to files with non-ASCII names (file-link-edits.mjs).
overlays.push(...fileLinkOverlays);
for (const [relative, changes] of Object.entries(fileLinkEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The server build can write into a sibling directory while the app runs (staged-build-edits.mjs).
overlays.push(...stagedBuildOverlays);
for (const [relative, changes] of Object.entries(stagedBuildEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Which sound a thread notification plays (sound-edits.mjs).
overlays.push(...soundOverlays);
for (const [relative, changes] of Object.entries(soundEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Opening a new conversation on another system prompt (session-prompt-edits.mjs).
overlays.push(...sessionPromptOverlays);
for (const [relative, changes] of Object.entries(sessionPromptEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The state DB stays bounded (state-retention-edits.mjs).
overlays.push(...stateRetentionOverlays);
for (const [relative, changes] of Object.entries(stateRetentionEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The state DB's hot reads use indexes that answer them (state-query-edits.mjs).
overlays.push(...stateQueryOverlays);
for (const [relative, changes] of Object.entries(stateQueryEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Rewinding to a finished tool step (step-rewind-edits.mjs).
overlays.push(...stepRewindOverlays);
for (const [relative, changes] of Object.entries(stepRewindEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Its web half: the rewind button, card and fades (step-rewind-ui-edits.mjs).
overlays.push(...stepRewindUiOverlays);
for (const [relative, changes] of Object.entries(stepRewindUiEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Editing a sent message and forking at a reply; after step rewind, whose reply button it sits beside (turn-actions-edits.mjs).
overlays.push(...turnActionsOverlays);
for (const [relative, changes] of Object.entries(turnActionsEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The Rubato provider on T3's V2 orchestrator: upstream's Pi adapter fed by the engine (pi-adapter-edits.mjs).
overlays.push(...piAdapterOverlays);
for (const [relative, changes] of Object.entries(piAdapterEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Pre-cutover threads: V1 thinking stored as answers stays out of V2 (legacy-import-edits.mjs).
overlays.push(...legacyImportOverlays);
for (const [relative, changes] of Object.entries(legacyImportEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Context handoffs into a provider that keeps its own thread: an uncertain delivery is re-delivered, and the budget asks the session what it holds (handoff-recovery-edits.mjs).
for (const [relative, changes] of Object.entries(handoffRecoveryEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Rubato's theme library in place of T3's built-in themes (theme-edits.mjs).
overlays.push(...themeOverlays);
for (const [relative, changes] of Object.entries(themeEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Glass, hairlines and layered shadows on T3's floating surfaces (polish-edits.mjs).
overlays.push(...polishOverlays);
for (const [relative, changes] of Object.entries(polishEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Chat tables take the chat width and wrap their cells (chat-table-edits.mjs).
overlays.push(...chatTableOverlays);
for (const [relative, changes] of Object.entries(chatTableEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// A lone ~ in a reply stays a tilde on the Mac and the phone (markdown-tilde-edits.mjs).
overlays.push(...markdownTildeOverlays);
for (const [relative, changes] of Object.entries(markdownTildeEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The sidebar material: opaque, macOS vibrancy or Liquid Glass; its CSS imports after the polish (window-material-edits.mjs).
overlays.push(...windowMaterialOverlays);
for (const [relative, changes] of Object.entries(windowMaterialEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// "Open" on a tool row that read a file (read-open-edits.mjs).
overlays.push(...readOpenOverlays);
for (const [relative, changes] of Object.entries(readOpenEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The project rail, the Recent box and the home row; after schedule-edits, whose Settings nav line it extends (project-rail-edits.mjs).
overlays.push(...projectRailOverlays);
for (const [relative, changes] of Object.entries(projectRailEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// One project order for every project list, edited in Settings > Projects; after the rail, whose list it extends (project-order-edits.mjs).
overlays.push(...projectOrderOverlays);
for (const [relative, changes] of Object.entries(projectOrderEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Subscription bars for Rubato's own accounts on the Usage page (usage-limits-edits.mjs).
overlays.push(...usageLimitsOverlays);
for (const [relative, changes] of Object.entries(usageLimitsEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The floating thread details: workspace label, no empty script row, Team and Agents sections (floating-menu-edits.mjs).
overlays.push(...floatingMenuOverlays);
for (const [relative, changes] of Object.entries(floatingMenuEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Per-part sizes for the rail, the sidebar, the home row and the conversation; last, since it reads text project-rail-edits adds (section-scale-edits.mjs).
overlays.push(...sectionScaleOverlays);
for (const [relative, changes] of Object.entries(sectionScaleEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The sidebar's sections in the user's order; after section-scale-edits, whose drag-offset line it sits beside (sidebar-blocks-edits.mjs).
overlays.push(...sidebarBlocksOverlays);
for (const [relative, changes] of Object.entries(sidebarBlocksEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Settings regrouped into Rubato's layout; last, since it anchors on the sidebar and search other modules edit (settings-layout-edits.mjs).
overlays.push(...settingsLayoutOverlays);
for (const [relative, changes] of Object.entries(settingsLayoutEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Segno, the always-on companion; after the Settings layout, whose Settings lines it anchors on (companion-edits.mjs).
overlays.push(...companionOverlays);
for (const [relative, changes] of Object.entries(companionEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// "Scroll to end" shows under a held new turn too (scroll-to-end-edits.mjs).
for (const [relative, changes] of Object.entries(scrollToEndEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Work cards for conversations launched with session_create / session_fork; its MessagesTimeline
// import anchors beside agents-surface-edits' own (work-card-edits.mjs).
overlays.push(...workCardOverlays);
for (const [relative, changes] of Object.entries(workCardEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
overlays.push(...i18nOverlays);
for (const [relative, changes] of Object.entries(i18nEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The timeline rail at a thread's left edge keeps its spacing, scrolls and names the days (timeline-rail-edits.mjs).
overlays.push(...timelineRailOverlays);
for (const [relative, changes] of Object.entries(timelineRailEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The Rubato iPhone app: T3's apps/mobile under Rubato's name, its shell and logos, and the
// Mac server routes the phone needs (mobile/index.mjs).
overlays.push(...mobileOverlays);
for (const [relative, changes] of Object.entries(mobileEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Thread folders on the Mac and the phone; last, since it anchors on lines project-rail-edits and
// sidebar-blocks-edits add to the sidebar (thread-folders-edits.mjs).
overlays.push(...threadFoldersOverlays);
for (const [relative, changes] of Object.entries(threadFoldersEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Idle threads go to the archive on their own (thread-auto-archive-edits.mjs).
overlays.push(...threadAutoArchiveOverlays);
for (const [relative, changes] of Object.entries(threadAutoArchiveEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The sidebar looks as on T3 v0.1.0 (sidebar-look-edits.mjs); last, since it restyles rows
// other modules already edited.
overlays.push(...sidebarLookOverlays);
for (const [relative, changes] of Object.entries(sidebarLookEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// `t3 thread archive` (thread-archive-edits.mjs).
overlays.push(...threadArchiveOverlays);
for (const [relative, changes] of Object.entries(threadArchiveEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The composer's controls in v0.1.0's places (composer-layout-edits.mjs); after voice-, call- and
// cache-edits, whose lines it moves.
overlays.push(...composerLayoutOverlays);
for (const [relative, changes] of Object.entries(composerLayoutEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// The settings menu in v0.1.0's groups (settings-menu-edits.mjs), after the modules that add pages.
overlays.push(...settingsMenuOverlays);
for (const [relative, changes] of Object.entries(settingsMenuEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
// Local Antigravity agents (local-agy-edits.mjs).
// A local thread's preparing run is not a worktree setup (local-thread-edits.mjs).
overlays.push(...localThreadOverlays);
for (const [relative, changes] of Object.entries(localThreadEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
overlays.push(...localAgyOverlays);
for (const [relative, changes] of Object.entries(localAgyEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
overlays.push(...acpPerfOverlays);
for (const [relative, changes] of Object.entries(acpPerfEdits)) {
  edits[relative] = [...(edits[relative] ?? []), ...changes];
}
/** The full edit and overlay tables, for checks that apply part of them. */
export { edits as integrationEdits, overlays as integrationOverlays };
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
const fileEncoding = (file) => file.endsWith('.png') ? null : 'utf8';
const equalContent = (left, right) => left === right ||
  (Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right));
async function existing(file) {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`Refusing symlink target: ${file}`);
    return await readFile(file,fileEncoding(file));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomic(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary,content,{flag:'wx',mode:0o644}); await rename(temporary,file); }
  finally { await unlink(temporary).catch((error) => { if (error.code!=='ENOENT') throw error; }); }
}
/** Whether two paths are one file (a case-insensitive disk); false when either is missing. */
async function sameFile(a, b) {
  try {
    const [left, right] = await Promise.all([stat(a), stat(b)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// The file as the checked-out T3 commit has it, or null when untracked or no git.
function checkedOut(target, relative) {
  try { return execFileSync('git',['-C',target,'show',`HEAD:${relative}`],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024}); }
  catch { return null; }
}
// The real path of a file's folder, or of its nearest existing ancestor when an overlay
// brings a folder T3 does not have (apps/mobile/src/features/companions). The missing
// tail is plain names from our own tables, so the ancestor decides containment.
async function realParent(destination) {
  let folder = path.dirname(destination);
  for (;;) {
    try { return await realpath(folder); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(folder) === folder) throw error;
      folder = path.dirname(folder);
    }
  }
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
  // A file renamed only in case (V1's rubatoStepRewind.ts, V2's RubatoStepRewind.ts) is the
  // same file on a case-insensitive disk (macOS, Windows): its record is under the old name.
  const oldByLower = new Map(Object.keys(old.files).map((key) => [key.toLowerCase(), key]));
  const priorOf = (relative) => old.files[relative] ?? old.files[oldByLower.get(relative.toLowerCase())];
  // An edit is applied only to a file listed in upstream.json. One that is not
  // listed was skipped without a word, and the staged build then wrote into the
  // output the open app was reading.
  const unlisted = Object.keys(edits).filter((relative) => !(relative in upstream.targets));
  if (unlisted.length) throw new Error(`Edited T3 files missing from upstream.json targets: ${unlisted.join(', ')}`);
  for (const relative of [...Object.keys(upstream.targets),...overlays]) {
    const destination = path.join(target,relative);
    if (relative.split('/').includes('..')) throw new Error(`Target escapes T3 root: ${relative}`);
    const parent = await realParent(destination);
    // Root files (pnpm-lock.yaml) live in the root itself; anything else must stay below it.
    if (parent !== target && !parent.startsWith(target + path.sep)) throw new Error(`Target escapes T3 root: ${relative}`);
    const current = await existing(destination);
    let original;
    let next;
    if (relative in edits) {
      if (current===null) throw new Error(`T3 source file is missing: ${relative}`);
      // A previous overlay can have different replacements. Only trust its
      // recorded original when the installed file still matches its hash;
      // user edits must continue to fail before any writes.
      const prior = priorOf(relative);
      const recorded = prior?.original !== null && typeof prior?.original === 'string'
        && hash(current) === prior.installedHash;
      original = recorded ? prior.original : hash(current) === upstream.targets[relative] ? current : untransform(current,edits[relative]);
      if (hash(original)!==upstream.targets[relative]) throw new Error(`T3 source changed outside this overlay: ${relative}`);
      next = transform(original,edits[relative]);
      if (!recorded && current!==original && current!==next) throw new Error(`Partial external edit in T3 target: ${relative}`);
    } else {
      original = priorOf(relative)?.original ?? null;
      next = await readFile(path.join(root,'overlay',relative),fileEncoding(relative));
      if (current!==null && !equalContent(current,next) && hash(current)!==priorOf(relative)?.installedHash)
        throw new Error(`Refusing to overwrite a different provider file: ${relative}`);
    }
    if (remove) {
      const prior = priorOf(relative);
      if (!prior) throw new Error(`No installation record for ${relative}`);
      if (current===null || hash(current)!==prior.installedHash) throw new Error(`Installed file has local changes: ${relative}`);
      next = prior.original;
    }
    manifest.files[relative] = {original,installedHash:next===null?null:hash(next)};
    planned.push({relative,destination,current,next});
  }
  // 이번 목록에서 빠진 이전 설치분은 되돌린다. 이것이 없으면 걷어낸 overlay 파일이
  // 설치본에 고아로 남고, 다음 설치가 그것을 "사람이 넣은 파일"로 보게 된다.
  for (const [relative,record] of Object.entries(old.files)) {
    if (manifest.files[relative]) continue;
    const destination = path.join(target,relative);
    // The same file under a name that differs only in case belongs to its new entry now.
    const renamed = Object.keys(manifest.files).find((key) => key.toLowerCase() === relative.toLowerCase());
    if (renamed && await sameFile(destination, path.join(target, renamed))) continue;
    const current = await existing(destination);
    // Already back to its original: install-gui.sh checks out the pin before this
    // runs, which restores every tracked file. Refusing it here stopped every
    // install after a target left the list, half-applied (T3's own name and
    // bundle id came back).
    // After a pin bump that checkout is the *new* pin's original, which the
    // manifest (written under the previous pin) does not know. Keep it as is.
    // A file this pin no longer has, and the disk neither (a V1 path V2 moved), stays absent.
    if (current===checkedOut(target,relative)) {
      planned.push({relative,destination,current,next:current});
      continue;
    }
    if (current!==null && current!==record.original && hash(current)!==record.installedHash)
      throw new Error(`Installed file has local changes: ${relative}`);
    planned.push({relative,destination,current,next:record.original});
  }
  if (!check) {
    for (const item of planned) if (!equalContent(item.current,item.next)) {
      if (item.next===null) await unlink(item.destination);
      else {
        await mkdir(path.dirname(item.destination),{recursive:true});
        await atomic(item.destination,item.next);
      }
    }
    if (remove) await unlink(manifestPath);
    else await atomic(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  }
  return {compatible:true,check,remove,changes:planned.filter((item)=>!equalContent(item.current,item.next)).map((item)=>item.relative),
    upstreamCommit:upstream.upstreamCommit};
}
// t3-source 는 핀 + overlay 로 만들어지는 산출물이고, 원본은 이 레포에 있다. 그래도
// 누가 거기서 파일을 고쳤다면 말없이 잃으면 안 된다. install-gui.sh 가 핀으로
// checkout --force 하기 전에 이것을 부른다: 지난 설치가 쓴 내용(매니페스트 해시)도,
// upstream 원본도, 설치기가 까는 아이콘도 아닌 파일을 backupDir 로 옮겨 둔다.
// 옮긴 추적 파일은 checkout 이 원본으로 되돌리고, 옮긴 overlay 파일은 지워서
// applyIntegration 이 새로 쓴다. 전에는 그런 파일 하나가 이후 모든 설치를 막았다.
export async function preserveLocalEdits({t3, backupDir}) {
  const target = await realpath(t3);
  const manifestText = await existing(path.join(target,'.rubato-pi-overlay.json'));
  const files = manifestText ? JSON.parse(manifestText).files ?? {} : {};
  const git = (...args) => execFileSync('git',['-C',target,...args],{encoding:'utf8',maxBuffer:64*1024*1024});
  const tracked = new Set(git('diff','--name-only','-z','HEAD').split('\0').filter(Boolean));
  const installerHashes = new Set();
  for (const file of [path.join(root,'assets','Rubato.png'),
    ...(await readdir(path.join(root,'assets','web')).catch(() => [])).map((name) => path.join(root,'assets','web',name))])
    installerHashes.add(hash(await readFile(file).catch(() => '')));
  const preserved = [];
  for (const relative of new Set([...tracked,...Object.keys(files)])) {
    const destination = path.join(target,relative);
    let current;
    try {
      if ((await lstat(destination)).isSymbolicLink()) continue;
      current = await readFile(destination);
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const record = files[relative];
    const digest = hash(current);
    if (record && digest === record.installedHash) continue;
    if (record && typeof record.original === 'string' && digest === hash(record.original)) continue;
    if (!record && installerHashes.has(digest)) continue;
    const saved = path.join(backupDir,relative);
    await mkdir(path.dirname(saved),{recursive:true});
    await copyFile(destination,saved);
    if (record && record.original === null) await unlink(destination);
    preserved.push(relative);
  }
  return {preserved, backupDir: preserved.length ? backupDir : null};
}
// 트리가 지난 설치가 쓴 그대로인지. 앱 이름과 번들 id 는 켤 때마다 이 트리의
// scripts/electron-launcher.mjs 에서 읽히는데, install-gui.sh 가 핀 checkout 과
// overlay 사이에서 멈추면(overlay 실패, 중간 종료) 그 파일은 T3 원본이다. 그대로
// 켜면 "T3 Code (Alpha).app"(com.t3tools.t3code) 이 새로 만들어져 뜬다.
// start-gui.sh 가 런처를 돌리기 전에 묻는다. 레포의 overlay 목록이 아니라 트리의
// 매니페스트만 본다 — 새 커밋을 받고 아직 설치하지 않은 트리도 온전한 설치다.
export async function installedIntact({t3}) {
  const target = await realpath(t3);
  const manifestText = await existing(path.join(target,'.rubato-pi-overlay.json'));
  if (manifestText===null) return {intact:false,drifted:['.rubato-pi-overlay.json']};
  const drifted = [];
  for (const [relative,record] of Object.entries(JSON.parse(manifestText).files ?? {})) {
    const current = await existing(path.join(target,relative));
    const matches = record.installedHash===null ? current===null
      : current!==null && hash(current)===record.installedHash;
    if (!matches) drifted.push(relative);
  }
  return {intact:drifted.length===0,drifted};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options:{t3:{type:'string'},check:{type:'boolean'},remove:{type:'boolean'},verify:{type:'boolean'},'preserve-edits':{type:'string'}}});
    if (!values.t3) throw new Error('Usage: node harness/t3-integration/apply.mjs --t3 /absolute/t3code [--check | --remove | --verify | --preserve-edits BACKUP_DIR]');
    if (values['preserve-edits']) console.log(JSON.stringify(await preserveLocalEdits({t3:values.t3,backupDir:values['preserve-edits']})));
    else if (values.verify) {
      const result = await installedIntact({t3:values.t3});
      console.log(JSON.stringify(result));
      if (!result.intact) process.exitCode=1;
    } else console.log(JSON.stringify(await applyIntegration(values),null,2));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
