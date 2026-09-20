import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildStockPiArgs, stockPiSupportEnv } from '../../rubato-pi/src/launch.mjs';

// One engine process is a profile boundary. Do not let a second caller repin
// process-level configuration while an existing profile has live runtimes.
let identity;

const UNLOAD_DISPOSE = Symbol('rubato.hosted.unload-dispose');

/**
 * A hosted worker is disposed when the host reclaims it (idle unload after the last
 * presentation detached, or server stop), never because the user quit: the session file
 * survives and the next attach resumes it. Stock `dispose()` announces
 * `session_shutdown reason:"quit"`, which the task lifecycle reads as "dispose every child",
 * so a lead's team members were destroyed 60s after its tab detached. Announce `unload`
 * instead so children suspend and revive on resume. A runtime that already carries a
 * lifecycle (the CLI cursor) keeps its own dispose.
 */
export function announceUnloadOnDispose(runtime, emitSessionShutdownEvent) {
  if (!runtime || runtime.lifecycle || runtime.dispose?.[UNLOAD_DISPOSE]) return runtime;
  const dispose = async () => {
    await emitSessionShutdownEvent(runtime.session.extensionRunner, { type: 'session_shutdown', reason: 'unload' });
    runtime.beforeSessionInvalidate?.();
    runtime.session.dispose();
  };
  dispose[UNLOAD_DISPOSE] = true;
  runtime.dispose = dispose;
  return runtime;
}

export async function loadHostedRuntime({ runtimeRoot, agentDir }) {
  if (!path.isAbsolute(runtimeRoot ?? '') || !path.isAbsolute(agentDir ?? '')) throw new TypeError('Hosted runtime requires absolute runtimeRoot and agentDir');
  const root = await realpath(runtimeRoot);
  agentDir = await realpath(agentDir);
  const key = JSON.stringify([root, agentDir]);
  if (identity && identity !== key) throw new Error('One engine process cannot host different runtime builds or profiles');
  identity = key;
  const load = file => import(pathToFileURL(path.join(root, file)).href);
  const { prepareRubatoCandidate } = await load('rubato-features/rubato-components/candidate-main.mjs');
  if (typeof prepareRubatoCandidate !== 'function') throw new Error('Build does not support hosted runtimes; rebuild the candidate');
  Object.assign(process.env, stockPiSupportEnv());
  const { createRubatoExtensionFactories } = await prepareRubatoCandidate(agentDir);
  const base = 'node_modules/@earendil-works/pi-coding-agent/dist/';
  const { createCliRuntimeFactory, main } = await load(base + 'main.js');
  const { parseArgs } = await load(base + 'cli/args.js');
  const { createAgentSessionRuntime, AgentSessionRuntime } = await load(base + 'core/agent-session-runtime.js');
  const { emitSessionShutdownEvent } = await load(base + 'core/extensions/runner.js');
  const { SettingsManager } = await load(base + 'core/settings-manager.js');
  const { SessionManager } = await load(base + 'core/session-manager.js');
  const { assertSessionCwdExists } = await load(base + 'core/session-cwd.js');
  const { runRpcMode } = await load(base + 'modes/rpc/rpc-mode.js');
  const { runMigrations } = await load(base + 'migrations.js');
  if (typeof createCliRuntimeFactory !== 'function') throw new Error('Build does not expose the canonical CLI runtime factory');
  let sessionHost;
  const getSessionWriter = (file, id) => {
    if (!file) return;
    const worker = sessionHost?.getSessionWorker(id);
    const manager = worker?.runtime?.session.sessionManager;
    if (!manager) return;
    if (manager.getSessionFile() === file) return manager;
    try { if (realpathSync(file) === worker.metadata.file) return manager; } catch {}
  };
  const hosted = {
    bindHost(host) { sessionHost = host; },
    runRpcMode,
    async loadTerminalApi() {
      const context = await load('rubato-features/session-ui/context.mjs');
      const theme = await load(base + 'modes/interactive/theme/theme.js');
      const { validateThemeJson } = await load(base + 'modes/interactive/theme/theme-json.js');
      theme.setThemeJsonValidator(validateThemeJson);
      const http = await load(base + 'core/http-dispatcher.js');
      return { ...context, ...theme, main, parseArgs, AgentSessionRuntime, createAgentSessionRuntime,
        createUiScope(options) { const scope = context.createUiScope(options); scope.getSessionWriter = getSessionWriter; return scope; },
        configureHttp(settingsManager) {
          http.applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
          http.configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
        },
        releaseHttp: http.releaseScopedHttpDispatcher,
        createExtensionFactories: ctx => createRubatoExtensionFactories({ ...ctx, env: context.uiProcess.env, hosted: true }).extensionFactories };
    },
    async createRuntime(metadata) {
      runMigrations(metadata.cwd);
      const parsed = parseArgs(buildStockPiArgs(['--mode', 'rpc']));
      const sessionManager = SessionManager.open(metadata.file, path.dirname(metadata.file));
      if (sessionManager.getSessionId() !== metadata.id) throw new Error('Persisted session identity changed before open');
      assertSessionCwdExists(sessionManager, metadata.cwd);
      // Use the persisted cwd; never process.chdir in a shared host.
      const cwd = sessionManager.getCwd();
      const api = await hosted.loadTerminalApi();
      const createRuntime = createCliRuntimeFactory({ cwd, agentDir, parsed, appMode: 'rpc',
        startupSettingsManager: SettingsManager.create(cwd, agentDir),
        options: { createExtensionFactories: api.createExtensionFactories },
      });
      const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
      const errors = runtime.diagnostics.filter(item => item.type === 'error');
      if (errors.length) {
        await runtime.dispose();
        throw new Error(errors.map(item => item.message).join('\n'));
      }
      return runtime;
    },
  };
  // Actor context outlives any terminal and keeps its cwd/network pool independent
  // of the presentation that originally opened it. A GUI request re-enters this
  // context; native TUI subscribers still carry their own rendering context.
  hosted.createWorkerOptions = async () => {
    const api = await hosted.loadTerminalApi();
    return (metadata, creation) => {
      const scope = api.createUiScope({ process: { cwd: () => metadata.cwd }, env: { ...(creation?.env ?? process.env) } });
      const fromCli = Boolean(creation?.createRuntime);
      let runtime;
      let refresh, refreshController, refreshTimeout;
      return { ...creation,
        createRuntime: () => scope.run(async () => {
          try { runtime = await (creation?.createRuntime ? creation.createRuntime() : hosted.createRuntime(metadata)); }
          finally { creation = undefined; } // Startup's UI/trust callback must not pin a detached terminal.
          announceUnloadOnDispose(runtime, emitSessionShutdownEvent);
          api.configureHttp(runtime.services.settingsManager);
          // GUI actors need the same native theme/catalog bootstrap even when
          // there is no terminal main. No watcher belongs to an invisible actor.
          api.initTheme(runtime.services.settingsManager.getTheme(), false);
          if (!fromCli && !scope.env.PI_OFFLINE) {
            refreshController = new AbortController();
            refreshTimeout = setTimeout(() => refreshController.abort(), 15000);
            refresh = runtime.services.modelRuntime.refresh({ signal: refreshController.signal })
              .catch(() => {}).finally(() => clearTimeout(refreshTimeout));
          }
          return runtime;
        }),
        runRpcMode: (runtime, transport) => scope.run(async () => {
          const controller = await runRpcMode(runtime, transport);
          const bound = api.bindUiContext(controller);
          return { ...controller,
            dispatch: bound.dispatch,
            close: bound.close,
            activatePresentation: () => scope.run(async () => {
              api.configureHttp(runtime.services.settingsManager);
              await controller.activatePresentation();
            }),
          };
        }),
        disposeContext: () => scope.run(async () => {
          scope.close(); refreshController?.abort(); clearTimeout(refreshTimeout);
          await refresh; await api.releaseHttp?.();
        }),
      };
    };
  };
  return hosted;
}
