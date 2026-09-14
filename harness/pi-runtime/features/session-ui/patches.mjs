import { fileURLToPath } from 'node:url';
const agent = '@earendil-works/pi-coding-agent', tui = '@earendil-works/pi-tui';
const version = '0.85.1';
const manifest = [
  [agent, 'dist/main.d.ts', 'cf197873ee07f73d5682fe2236e24989714d1f5c1acf8820264e570a5c17dadc', 4],
  [agent, 'dist/core/agent-session-runtime.d.ts', '4a18c0f51669b62a297c83334731c8bb5fed58016619a14d42edce414ff8d105', 5],
  [agent, 'dist/core/http-dispatcher.d.ts', 'd0a2f111c02c3126178a992a88d4a82b3f2bd99f6ae762a8dbd8336403b0d1e9', 5],
  [agent, 'dist/modes/interactive/interactive-mode.d.ts', '25d25af71429fe0a38ec3b57701fa43a349e48a91cff4b96ad4a58216a54b6d5', 6],
  [agent, 'dist/main.js', 'f0b7e5a8419af8d149ffe367af2992c76ce70b73484c15492bd50787d4f4962a', 4],
  [agent, 'dist/cli/session-picker.js', 'b5b3cc89815cc11f4519af27b9abb5a972a110fcfa08096f70dc0623e763cd44', 5],
  [agent, 'dist/cli/file-processor.js', '4946f4e3e193713135a4924982d31c9403190befd421b7be9893d0e5c65055ae', 5],
  [agent, 'dist/cli/startup-ui.js', '0c74df92c94ff3ede0ed65d811b1604b305c7636b898e5023995f15618ea697b', 5],
  [agent, 'dist/migrations.js', 'aa57901e3dd13f38d3d4e95b40ea3a9062e4943feff4535285cc41ece0d98f69', 4],
  [agent, 'dist/utils/paths.js', '09046a2443dfb6434e4c5c62656fb73edc33e776dc6cc35b785ef1dbf8483c93', 5],
  [agent, 'dist/core/agent-session-runtime.js', '61375f59afc3395940c05832c3f992e8020139a2f4a53065cccacbc370b65f16', 5],
  [agent, 'dist/core/session-manager.js', 'ccace64949db25379a43971ecea750c1b7ec6344e1bc31b9d5fe596ac2f1c9f3', 5],
  [agent, 'dist/core/http-dispatcher.js', 'f9aa2c81b0a5958ffba6368506f24c9b202904c234ada19494cdc9c4a1d0e97b', 5],
  [agent, 'dist/core/model-runtime.js', '32cd50599d9e6e001229090e3d0554b60e4addb8ab7b3165635a574feb660b74', 5],
  [agent, 'dist/core/resolve-config-value.js', '01fdb1673990635bb419c7418eefa298b6a1c6fbb3c6193d3b05a4902e51992d', 5],
  [agent, 'dist/core/output-guard.js', 'e860db94650c57e07582c300983671737bf9e796682193b498f75e3dd72e9024', 5],
  [agent, 'dist/modes/print-mode.js', 'f2eb170b9620c1d37e68b788ff71257a4402a23e7f3999575feee8e5d9e13b3f', 5],
  [agent, 'dist/modes/rpc/rpc-mode.js', 'e7e4724aa55c5aac73cf36793653b26736200e5c59d58373990fc31028f86477', 6],
  [agent, 'dist/modes/interactive/interactive-mode.js', '802ff14f5a47710e5a46d8141b238c4d5ffca30e8ca26bad18f838eddbf086bf', 6],
  [agent, 'dist/modes/interactive/theme/theme.js', '5ced0adb09ca8ce0f9b4eefcf89825755e9873cd53388825694025a4b046d1d5', 7],
  [agent, 'dist/modes/interactive/external-editor.js', '27c7133602240acd07c849994a82058eb9ef3ae15299f386808c1dd0b85486d6', 6],
  [agent, 'dist/utils/clipboard.js', '344311d1e7d8c2dd981a92260fea0af2cc9627b354ff3e61cd480a6e60f4aaa0', 5],
  [agent, 'dist/utils/shell.js', '9874bbe8f6e26dd05029c3487d7789b160e92470696b2168424394f5dd00a34a', 5],
  [agent, 'dist/core/agent-session.js', 'fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f', 5],
  [tui, 'dist/keys.js', '14b18205fd5e56ed3b183392c82bd72e41ba3dab1d345e47b2b17af6988493cc', 7],
  [tui, 'dist/terminal.js', 'd0b29feb487659b65797e5ed706c6cbb4859be9359c8539851a2ec6419a2b048', 7],
  [tui, 'dist/keybindings.js', '499582d22b576b7e73952ec9e8ad72e833e76fb72005d98bad499b0b7eb6d936', 7],
  [tui, 'dist/terminal-image.js', '471f5ba18f5e23fd4f14358af615e1be0631f867189f428d023b069894130f62', 7],
];
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
      next = once(next, 'import { createModels,', 'import { defaultProviderAuthContext, createModels,');
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
      next = once(next, '    async dispose() {',
        '    async dispose() {\n        if (this.lifecycle) return this.lifecycle.dispose(() => this.beforeSessionInvalidate?.());');
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
