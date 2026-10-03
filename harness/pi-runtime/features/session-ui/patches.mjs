import { fileURLToPath } from 'node:url';
const agent = '@earendil-works/pi-coding-agent', tui = '@earendil-works/pi-tui';
import { PI_VERSION as version } from "../../pi-version.mjs";
const manifest = [
  [agent, 'dist/main.d.ts', 'cf197873ee07f73d5682fe2236e24989714d1f5c1acf8820264e570a5c17dadc', 4],
  [agent, 'dist/core/agent-session-runtime.d.ts', '4a18c0f51669b62a297c83334731c8bb5fed58016619a14d42edce414ff8d105', 5],
  [agent, 'dist/core/http-dispatcher.d.ts', 'd0a2f111c02c3126178a992a88d4a82b3f2bd99f6ae762a8dbd8336403b0d1e9', 5],
  [agent, 'dist/modes/interactive/interactive-mode.d.ts', '2dec53d6ab8b53edf72e7df055b201f5aeddc7ee0439a1d7e523f87a632e3991', 6],
  [agent, 'dist/main.js', '060521b0b81f91948d8ded9139e423e5d0c9e6808a45c81750cc30519de4d2db', 4],
  [agent, 'dist/cli/session-picker.js', 'b5b3cc89815cc11f4519af27b9abb5a972a110fcfa08096f70dc0623e763cd44', 5],
  [agent, 'dist/cli/file-processor.js', '4946f4e3e193713135a4924982d31c9403190befd421b7be9893d0e5c65055ae', 5],
  [agent, 'dist/cli/startup-ui.js', 'f0fa56d9aeb064abfc0c0b1370140e7ff1925cc707fe6952815a8b5d96649b48', 5],
  [agent, 'dist/migrations.js', '8514d2573b028baeba60635498a1c5f129a602abd203ea5c37a63df2eea3fb6b', 4],
  [agent, 'dist/utils/paths.js', 'd5d48c2b2b2442c7e72aee6e98a79d828a52dce9526b152288186834c1dcf4a5', 5],
  [agent, 'dist/core/agent-session-runtime.js', '928b6528bb17d26273af8f7023a4f98e5f440d5896a4280d060b9b3e1f9a6882', 5],
  [agent, 'dist/core/session-manager.js', '046b6a1109ac3f0ed893bb85bf0648709362fa926a5da75761216cf2fcf9d926', 5],
  [agent, 'dist/core/http-dispatcher.js', 'f9aa2c81b0a5958ffba6368506f24c9b202904c234ada19494cdc9c4a1d0e97b', 5],
  [agent, 'dist/core/model-runtime.js', 'da26f76339a031456f6d239a249159231776f760ab4ac538c6b54c417dea6f67', 5],
  [agent, 'dist/core/resolve-config-value.js', '01fdb1673990635bb419c7418eefa298b6a1c6fbb3c6193d3b05a4902e51992d', 5],
  [agent, 'dist/core/output-guard.js', 'e860db94650c57e07582c300983671737bf9e796682193b498f75e3dd72e9024', 5],
  [agent, 'dist/modes/print-mode.js', 'f2eb170b9620c1d37e68b788ff71257a4402a23e7f3999575feee8e5d9e13b3f', 5],
  [agent, 'dist/modes/rpc/rpc-mode.js', '631697cd35928fc827f4a423538c43ff227b8cbf63c2a2f11060616f55eba6db', 6],
  [agent, 'dist/modes/interactive/interactive-mode.js', '14508d43f3dd47faa6b10c4a6537740f1cf238eee3fc873a9e0648125214bbcc', 6],
  [agent, 'dist/modes/interactive/theme/theme.js', 'a7b93b9cc50d9f44c2a728c8df5de67dc41efead57d1554e0ff32b73bb358cf4', 7],
  [agent, 'dist/modes/interactive/external-editor.js', '27c7133602240acd07c849994a82058eb9ef3ae15299f386808c1dd0b85486d6', 6],
  [agent, 'dist/utils/clipboard.js', '9026155915928019229a3120119c76a4bf040a81b3792a09f04218f93ea0529b', 5],
  [agent, 'dist/utils/shell.js', 'c8378f2b0566e35f90dfbb622a2214acf5cf45d15107c44b260cad897b539f72', 5],
  [agent, 'dist/core/agent-session.js', '35ca1dabd54d98c236c9601b569c2856b726ade392d06b2eaaf50158f48913ab', 5],
  [tui, 'dist/keys.js', '14b18205fd5e56ed3b183392c82bd72e41ba3dab1d345e47b2b17af6988493cc', 4],
  [tui, 'dist/terminal.js', 'e3a594cb638d57da4e195bee6a4ad10e4ebeb3335dbf2bd9990d913ef03ee4fb', 4],
  [tui, 'dist/keybindings.js', '499582d22b576b7e73952ec9e8ad72e833e76fb72005d98bad499b0b7eb6d936', 4],
  [tui, 'dist/terminal-image.js', '5dd2e88f00fbd89b96a08ed4d7d83213f14c046f14f07725cac80bfe3229f5cb', 4],
];
// Last column: how many `../` lead from the patched file to the stage root, where
// rubato-features/ lives. npm hoists pi-tui next to pi-coding-agent since 1.0, so
// its dist/ files sit four levels down (0.86.1 nested it under pi-coding-agent: seven).
function once(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`session-ui anchor mismatch: ${before}`);
  return source.replace(before, after);
}
// These are pinned module variables, not arbitrary identifiers: declaration
// removal fails on drift and tests compile and exercise every rewritten module.
function scoped(source, declarations) {
  for (const [name, declaration] of declarations) {
    source = once(source, declaration, '');
    source = source.replaceAll(new RegExp(`\\b${name}\\b`, 'g'), `uiState().${name}`);
  }
  return source;
}
export const patches = manifest.map(([packageName, path, preimageSha256, depth]) => ({
  id: path, packageName, path, preimageSha256, version,
  apply(source) {
    if (source.includes('session-ui/context.mjs')) throw new Error('session-ui anchor mismatch: already patched');
    const imports = `import { uiState, uiScope, uiProcess as process, uiConsole as console, bindUiCallback, bindUiContext, exitUiProcess } from "${'../'.repeat(depth)}rubato-features/session-ui/context.mjs";\n`;
    let next = source;
    if (path === 'dist/core/model-runtime.js') {
      next = once(next, ' createModels, lazyStream,', ' defaultProviderAuthContext, createModels, lazyStream,');
      next = once(next, 'this.models = createModels({ credentials, modelsStore });', `const context = defaultProviderAuthContext();
        const env = uiScope()?.env;
        const authContext = env ? { ...context, async env(name) {
            const value = env[name]; return typeof value === "string" && value.trim() ? value : undefined;
        } } : context;
        this.models = createModels({ credentials, modelsStore, authContext });`);
      next = once(next, '    async prepareRequest(model, options) {',
        '    async prepareRequest(model, options) {\n        if (uiScope()) options = { ...options, env: { ...process.env, ...options?.env } };');
    }
    if (path === 'dist/core/resolve-config-value.js') {
      next = scoped(next, [['commandResultCache', 'const commandResultCache = new Map();']]);
      next = next.replaceAll('            encoding: "utf-8",',
        '            encoding: "utf-8",\n            env: process.env, cwd: process.cwd(),');
    }
    if (path === 'dist/core/session-manager.js') {
      const check = '\n        const writer = uiScope()?.getSessionWriter?.(this.sessionFile, this.sessionId);\n        if (writer && writer !== this) throw new Error("Session file already has a live engine writer");';
      next = once(next, '    _rewriteFile() {', '    _rewriteFile() {' + check);
      next = once(next, '    _persist(entry) {', '    _persist(entry) {' + check);
      next = once(next, '    appendSessionInfo(name) {', '    appendSessionInfo(name) {\n        const writer = uiScope()?.getSessionWriter?.(this.sessionFile, this.sessionId);\n        if (writer && writer !== this) return writer.appendSessionInfo(name);');
    }
    if (path.endsWith('.d.ts')) {
      if (path === 'dist/main.d.ts') next = once(next, 'export interface MainOptions {', `export interface MainOptions {
    createRuntimeHost?: (factory: import("./core/agent-session-runtime.ts").CreateAgentSessionRuntimeFactory,
        initial: Parameters<import("./core/agent-session-runtime.ts").CreateAgentSessionRuntimeFactory>[0]) => Promise<import("./core/agent-session-runtime.ts").AgentSessionRuntime>;
    onInteractiveMode?: (mode: import("./modes/interactive/interactive-mode.ts").InteractiveMode) => void;
    configureHttp?: (settings: SettingsManager) => void | Promise<void>;`);
      if (path === 'dist/modes/interactive/interactive-mode.d.ts') next = once(next, 'export interface InteractiveModeOptions {',
        'export interface InteractiveModeOptions {\n    hosted?: boolean;');
      if (path === 'dist/core/http-dispatcher.d.ts') next += '\nexport declare function releaseScopedHttpDispatcher(): Promise<void>;\n';
      if (path === 'dist/core/agent-session-runtime.d.ts') {
        next = once(next, 'export declare class AgentSessionRuntime {', `export interface PresentationLifecycle {
    beforeSwitch(info: { reason: string; targetSessionFile?: string; invalidate(): void }): void | Promise<void>;
    dispose(invalidate: () => void): Promise<void>;
    beforeImport?(file: string): Promise<string | undefined>;
}
export declare class AgentSessionRuntime {
    readonly lifecycle?: PresentationLifecycle;`);
        next = once(next, '_modelFallbackMessage?: string);', '_modelFallbackMessage?: string, lifecycle?: PresentationLifecycle);');
      }
      return '// session-ui/context.mjs hosted presentation types\n' + next;
    }
    if (path === 'dist/core/output-guard.js') next = scoped(next, [
      ['stdoutTakeoverState', 'let stdoutTakeoverState;'],
      ['rawStdoutWriteTail', 'let rawStdoutWriteTail = Promise.resolve();'],
    ]);
    if (path === 'dist/modes/print-mode.js') next = once(next, 'await session.bindExtensions({',
      'await session.bindExtensions({\n            presentationOnly: Boolean(runtimeHost.lifecycle),');
    if (path === 'dist/modes/rpc/rpc-mode.js') {
      next = next.replaceAll('process.exit(', 'return process.exit(');
      next = once(next, '    return new Promise(() => { });', '    return new Promise(resolve => { uiScope()?.onClose(resolve); });');
      if (next.includes('            presentationOnly,')) next = once(next, '            presentationOnly,', '            presentationOnly: presentationOnly || Boolean(runtimeHost.lifecycle),');
      else next = once(next, 'await session.bindExtensions({', 'await session.bindExtensions({\n            presentationOnly: Boolean(runtimeHost.lifecycle),');
      next = once(next, '        for (const cleanup of signalCleanupHandlers) {',
        '        if (uiScope()) for (const pending of pendingExtensionRequests.values()) pending.resolve({ cancelled: true });\n        for (const cleanup of signalCleanupHandlers) {');
    }
    if (path === 'dist/core/http-dispatcher.js') {
      next = once(next, 'let installedGlobalFetch;', `let installedGlobalFetch;
const scopedDispatchers = new Map();
export async function releaseScopedHttpDispatcher() {
    const state = uiScope()?.state;
    const previous = state?.httpEntry;
    if (!previous) return;
    state.httpEntry = undefined; state.httpDispatcher = undefined;
    if (--previous.references === 0) {
        scopedDispatchers.delete(previous.key);
        await previous.dispatcher.close();
    }
}`);
      next = once(next, '    const dispatcher = withUndiciErrorListener(new undici.EnvHttpProxyAgent({', `    const scopedEnv = uiScope() ? {
        httpProxy: process.env.http_proxy ?? process.env.HTTP_PROXY ?? "",
        httpsProxy: process.env.https_proxy ?? process.env.HTTPS_PROXY ?? "",
        noProxy: process.env.no_proxy ?? process.env.NO_PROXY ?? "",
    } : undefined;
    const key = JSON.stringify([normalizedTimeoutMs, scopedEnv]);
    if (uiScope()?.state.httpEntry?.key === key) return;
    if (uiScope()?.state.httpEntry) void releaseScopedHttpDispatcher().catch(() => {});
    const cached = uiScope() && scopedDispatchers.get(key);
    if (cached) {
        cached.references++; uiState().httpEntry = cached; uiState().httpDispatcher = cached.dispatcher;
        return;
    }
    const dispatcher = withUndiciErrorListener(new undici.EnvHttpProxyAgent({
        ...scopedEnv,`);
      next = once(next, '    undici.setGlobalDispatcher(dispatcher);', `    if (uiScope()) {
        const entry = { key, dispatcher, references: 1 };
        scopedDispatchers.set(key, entry); uiState().httpEntry = entry; uiState().httpDispatcher = dispatcher;
    } else undici.setGlobalDispatcher(dispatcher);`);
      next = once(next, '        installedGlobalFetch = globalThis.fetch;', `        const nativeFetch = globalThis.fetch;
        globalThis.fetch = (input, init) => {
            const dispatcher = init?.dispatcher ?? uiScope()?.state.httpDispatcher;
            return nativeFetch(input, dispatcher ? { ...init, dispatcher } : init);
        };
        installedGlobalFetch = globalThis.fetch;`);
    }
    if (path === 'dist/core/agent-session-runtime.js') {
      next = once(next, 'constructor(_session, _services, createRuntime, _diagnostics = [], _modelFallbackMessage) {',
        'constructor(_session, _services, createRuntime, _diagnostics = [], _modelFallbackMessage, lifecycle) {\n        this.lifecycle = lifecycle;');
      next = once(next, '    async teardownCurrent(reason, targetSessionFile) {',
        '    async teardownCurrent(reason, targetSessionFile) {\n        if (this.lifecycle) return this.lifecycle.beforeSwitch({ reason, targetSessionFile, invalidate: () => this.beforeSessionInvalidate?.() });');
      // A hosting server reclaims a runtime (idle unload, server stop) without the user quitting;
      // it passes its own shutdown reason so the original cleanup order stays intact.
      next = once(next, '    async dispose() {',
        '    async dispose(reason = "quit") {\n        if (this.lifecycle) return this.lifecycle.dispose(() => this.beforeSessionInvalidate?.());');
      next = once(next, '            type: "session_shutdown",\n            reason: "quit",', '            type: "session_shutdown",\n            reason,');
      next = once(next, '        const sessionDir = this.session.sessionManager.getSessionDir();\n        if (!existsSync(sessionDir)) {',
        '        const existing = await this.lifecycle?.beforeImport?.(resolvedPath);\n        if (existing) return this.switchSession(existing);\n        const sessionDir = this.session.sessionManager.getSessionDir();\n        if (!existsSync(sessionDir)) {');
      next = once(next, '        const sessionManager = this.session.sessionManager;',
        '        const sessionManager = this.lifecycle\n            ? SessionManager.inMemory(this.cwd, undefined, structuredClone([this.session.sessionManager.getHeader(), ...this.session.sessionManager.getEntries()]))\n            : this.session.sessionManager;');
    }
    if (path === 'dist/main.js') {
      next = next.replaceAll('process.exit(', 'exitUiProcess(');
      next = once(next, 'const runtime = await createAgentSessionRuntime(createRuntime, {', 'const runtime = await (options?.createRuntimeHost ?? createAgentSessionRuntime)(createRuntime, {');
      next = once(next, '        sessionManager.appendSessionInfo(name);', '        if (!options?.createRuntimeHost) sessionManager.appendSessionInfo(name);');
      next = once(next, '    const { services, session, modelFallbackMessage } = runtime;',
        '    const { services, session, modelFallbackMessage } = runtime;\n    if (options?.createRuntimeHost && parsed.name !== undefined) session.sessionManager.appendSessionInfo(normalizeSessionName(parsed.name));');
      next = once(next, 'const interactiveMode = new InteractiveMode(runtime, {', 'const interactiveMode = new InteractiveMode(runtime, {\n            hosted: Boolean(options?.createRuntimeHost),');
      next = once(next, '        if (startupBenchmark) {', '        options?.onInteractiveMode?.(interactiveMode);\n        if (startupBenchmark) {');
      // Keep canonical argument/selection/migration/trust policy. The engine
      // alone owns process-wide HTTP setup.
      next = once(next, '    applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);\n    configureHttpDispatcher();',
        '    if (options?.configureHttp) await options.configureHttp(bootstrapSettingsManager);\n    else { applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy); configureHttpDispatcher(); }');
      next = once(next, '    applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);\n    configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());',
        '    if (options?.configureHttp) await options.configureHttp(settingsManager);\n    else { applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy); configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs()); }');
    }
    if (path === 'dist/cli/file-processor.js') next = next.replaceAll('process.exit(', 'exitUiProcess(');
    if (path === 'dist/cli/session-picker.js') {
      if (next.includes('const finish = (value) => {')) {
        next = once(next, '            process.exit(0);', '            if (uiScope()) finish(null); else process.exit(0);');
        next = once(next, '        let resolved = false;', '        let resolved = false;\n        const detachClose = uiScope()?.onClose(() => finish(null));');
        next = once(next, '            resolved = true;', '            detachClose?.();\n            resolved = true;');
      } else {
        next = once(next, '            process.exit(0);', '            if (uiScope()) { resolved = true; resolve(null); } else process.exit(0);');
        next = once(next, '        let resolved = false;', '        let resolved = false;\n        const detachClose = uiScope()?.onClose(() => { if (!resolved) { resolved = true; ui.stop(); resolve(null); } });');
        next = next.replaceAll('                resolved = true;', '                detachClose?.();\n                resolved = true;');
      }
    }
    if (path === 'dist/cli/startup-ui.js') {
      const anchor = '        let settled = false;';
      if (next.split(anchor).length !== 4) throw new Error('session-ui startup close anchors');
      next = next.replaceAll(anchor, anchor + '\n        const detachClose = uiScope()?.onClose(() => { void finish(undefined); });');
      next = next.replaceAll('            settled = true;', '            detachClose?.();\n            settled = true;');
    }
    if (path.endsWith('/theme.js')) {
      next = scoped(next, [
        ...['currentThemeName', 'themeWatcher', 'themeReloadTimer', 'onThemeChangeCallback', 'cachedHighlightThemeFor', 'cachedCliHighlightTheme']
          .map(name => [name, `let ${name};`]),
        ['registeredThemes', 'const registeredThemes = new Map();'],
        // 1.0 keeps the colors a terminal reported (OSC 10/11/4 replies, mode 2031) in module
        // variables. Each hosted presentation is its own terminal, so they live in its scope.
        ['terminalColors', 'let terminalColors = {};'],
        ['terminalColorsPending', 'let terminalColorsPending = false;'],
        ['terminalColorScheme', 'let terminalColorScheme;'],
      ]);
      next = once(next, 'const t = globalThis[THEME_KEY];', 'const t = uiScope() ? uiState().theme : globalThis[THEME_KEY];');
      next = once(next, 'function setGlobalTheme(t) {', 'function setGlobalTheme(t) {\n    if (uiScope()) { uiState().theme = t; return; }');
    }
    if (path === 'dist/keys.js') next = scoped(next, [['_kittyProtocolActive', 'let _kittyProtocolActive = false;'], ['_lastEventType', 'let _lastEventType = "press";']]);
    if (path === 'dist/keybindings.js') next = scoped(next, [['globalKeybindings', 'let globalKeybindings = null;']]);
    if (path === 'dist/terminal-image.js') {
      next = scoped(next, [
        ['cachedCapabilities', 'let cachedCapabilities = null;'], ['capabilityOverrides', 'let capabilityOverrides = {};'],
        ['kittyTransmissionGeneration', 'let kittyTransmissionGeneration = 0;'],
      ]);
      // The image sizing functions also have a LOCAL parameter with this name.
      next = once(next, 'let cellDimensions = { widthPx: 9, heightPx: 18 };', '');
      next = once(next, 'return cellDimensions;', 'return uiState().cellDimensions;');
      next = once(next, 'cellDimensions = dims;', 'uiState().cellDimensions = dims;');
    }
    if (path === 'dist/utils/shell.js') next = scoped(next, [['trackedDetachedChildPids', 'const trackedDetachedChildPids = new Set();']]);
    if (path.endsWith('/external-editor.js')) next = once(next, 'export async function editInExternalEditor(options) {',
      'export async function editInExternalEditor(options) {\n    if (uiScope()?.edit) return uiScope().edit(options);');
    if (path.endsWith('/interactive-mode.js')) {
      // remote-surface 가 `bindStockUiHost(this, this.createExtensionUIContext())` 호출을 먼저 넣는다.
      // 그게 없으면(단독 적용, 또는 remote-surface 없이 스테이징) 붙일 자리가 없으므로 건너뛰는 것이
      // 맞다 — compaction:anthropic-server-params 의 providerNative 조기 반환과 같은 성질이다.
      // 카탈로그의 session-ui.requires 가 remote-surface 를 앞세우므로 합성 경로에서는 반드시 참이지만,
      // 순서가 뒤집히면 이 가드가 **조용히** 거짓이 되어 hosted 배선이 꺼진 후보가 나온다.
      // 그 회귀는 session-ui.test.mjs 의 합성 단언이 잡는다 — 여기서 조용해도 거기서는 시끄럽다.
      if (next.includes('bindStockUiHost(')) next = once(next, 'bindStockUiHost(this, this.createExtensionUIContext())',
        'bindStockUiHost(this, this.createExtensionUIContext(), { env: process.env, onClose: uiScope()?.onClose, run: uiScope()?.run })');
      next = next.replaceAll('process.exit(', 'return process.exit(');
      next = once(next, 'await this.session.bindExtensions({', 'await this.session.bindExtensions({\n            presentationOnly: this.options.hosted === true,');
      next = once(next, '// Main interactive loop\n        while (true) {\n            const userInput = await this.getUserInput();',
        '// Main interactive loop\n        while (!this.isShuttingDown) {\n            const userInput = await this.getUserInput();\n            if (this.isShuttingDown) break;');
      // Hiding a dialog does not settle the promise awaited by its tool. This
      // must work even when the optional remote-control factory is inactive.
      next = once(next, '    resetExtensionUI() {\n',
        '    resetExtensionUI() {\n        for (const close of [...(this.rubatoCustomClosers ?? [])]) close(undefined);\n');
      for (const kind of ['Selector', 'Input', 'Editor']) next = once(next,
        `        if (this.extension${kind}) {\n            this.hideExtension${kind}();\n        }`,
        `        if (this.extension${kind}) {\n            this.extension${kind}.onCancelCallback();\n        }`);
      next = once(next, '            const close = (result) => {\n                if (closed)\n                    return;\n                closed = true;',
        '            const close = (result) => {\n                if (closed)\n                    return;\n                closed = true;\n                this.rubatoCustomClosers.delete(close);');
      next = once(next, '            Promise.resolve(factory(this.ui, theme, this.keybindings, close))',
        '            (this.rubatoCustomClosers ??= new Set()).add(close);\n            Promise.resolve().then(() => factory(this.ui, theme, this.keybindings, close))');
      next = once(next, '                .then((c) => {\n                if (closed)\n                    return;\n                component = c;',
        '                .then((c) => {\n                if (closed) { c?.dispose?.(); return; }\n                component = c;');
      next = once(next, '                .catch((err) => {\n                if (closed)\n                    return;\n                if (!isOverlay)',
        '                .catch((err) => {\n                if (closed)\n                    return;\n                closed = true;\n                this.rubatoCustomClosers.delete(close);\n                if (!isOverlay)');
    }
    if (path === 'dist/core/agent-session.js') {
      next = once(next, '            this._extensionErrorListener = bindings.onError;\n        }\n        this._applyExtensionBindings(this._extensionRunner);',
        '            this._extensionErrorListener = bindings.onError;\n        }\n        this._applyExtensionBindings(this._extensionRunner);\n        await this._extensionRunner.emit({ type: "rubato.presentation.bind" });');
      next = once(next, '    async bindExtensions(bindings) {', `    async bindExtensions(bindings) {
        if (bindings.presentationOnly) {
            this._extensionAbortHandler = bindings.abortHandler;
            this._extensionShutdownHandler = bindings.shutdownHandler;
            this._extensionErrorListener = bindings.onError;
            if (bindings.uiContext === undefined) this._extensionUIContext = undefined;
        }`);
      next = once(next, '    subscribe(listener) {\n        this._eventListeners.push(listener);',
        '    subscribe(listener) {\n        listener = bindUiCallback(listener);\n        this._eventListeners.push(listener);');
      next = once(next, 'this._extensionUIContext = bindings.uiContext;', 'this._extensionUIContext = bindUiContext(bindings.uiContext, this._extensionUIContext);');
      next = once(next, 'this._extensionCommandContextActions = bindings.commandContextActions;', 'this._extensionCommandContextActions = bindUiContext(bindings.commandContextActions);');
    }
    return imports + next;
  },
}));
export const files = [{ target: 'runtime', version, path: 'rubato-features/session-ui/context.mjs',
  sourcePath: fileURLToPath(new URL('./context.mjs', import.meta.url)) }];
