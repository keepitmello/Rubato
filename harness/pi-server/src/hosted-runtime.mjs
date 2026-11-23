import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildStockPiArgs, stockPiSupportEnv } from '../../rubato-pi/src/launch.mjs';
import { createSessionLink } from './session-link.mjs';
import { COMPANION_ROLE } from '../../companion/companion.mjs';
import { clearCompanionEnv, companionEnv, companionModelSelection, validModelSelection } from '../../companion/registry.mjs';
import { COMPANION_AGY_PROVIDER, createCompanionAgyProvider, resolveCompanionAgy } from './companion-agy.mjs';

const COMPANION_MODEL_ENTRY = 'rubato.companion-model';

// One engine process is a profile boundary. Do not let a second caller repin
// process-level configuration while an existing profile has live runtimes.
let identity;
// Every runtime in this engine gets the same link; the profile server binds it to
// the host and socket once they exist. Extensions see only the six methods.
let sessionLink;

const UNLOAD_DISPOSE = Symbol('rubato.hosted.unload-dispose');

/**
 * A hosted worker is disposed when the host reclaims it (idle unload after the last
 * presentation detached, or server stop), never because the user quit: the session file
 * survives and the next attach resumes it. Stock `dispose()` announces
 * `session_shutdown reason:"quit"`, which the task lifecycle reads as "dispose every child",
 * so a lead's team members were destroyed 60s after its tab detached. The rpc controller
 * calls `dispose()` with no arguments, so bind the reason here: the original cleanup runs
 * unchanged (the session-ui patch lets it take a reason) and only announces `unload`.
 * A runtime that already carries a lifecycle (the CLI cursor) keeps its own dispose.
 */
export function announceUnloadOnDispose(runtime) {
  if (!runtime || runtime.lifecycle || runtime.dispose?.[UNLOAD_DISPOSE]) return runtime;
  const original = runtime.dispose;
  const dispose = () => original.call(runtime, 'unload');
  dispose[UNLOAD_DISPOSE] = true;
  runtime.dispose = dispose;
  return runtime;
}

/**
 * One runtime's own environment: what the CLI that created it carried, or the engine's. The
 * companion's conversation (harness/companion) runs under its own role, whoever opens it.
 */
export function workerEnv(metadata, creation, base = process.env) {
  const inherited = creation?.env ?? base;
  return metadata?.companion
    ? { ...companionEnv(metadata.companionId, inherited), RUBATO_PI_ROLE: COMPANION_ROLE }
    : clearCompanionEnv(inherited);
}

export async function loadHostedRuntime({ runtimeRoot, agentDir }) {
  if (!path.isAbsolute(runtimeRoot ?? '') || !path.isAbsolute(agentDir ?? '')) throw new TypeError('Hosted runtime requires absolute runtimeRoot and agentDir');
  const root = await realpath(runtimeRoot);
  agentDir = await realpath(agentDir);
  const key = JSON.stringify([root, agentDir]);
  if (identity && identity !== key) throw new Error('One engine process cannot host different runtime builds or profiles');
  identity = key;
  sessionLink ??= createSessionLink();
  const load = file => import(pathToFileURL(path.join(root, file)).href);
  const { prepareRubatoCandidate } = await load('rubato-features/rubato-components/candidate-main.mjs');
  if (typeof prepareRubatoCandidate !== 'function') throw new Error('Build does not support hosted runtimes; rebuild the candidate');
  Object.assign(process.env, stockPiSupportEnv());
  const { createRubatoExtensionFactories } = await prepareRubatoCandidate(agentDir);
  const base = 'node_modules/@earendil-works/pi-coding-agent/dist/';
  const { createCliRuntimeFactory, main } = await load(base + 'main.js');
  const { parseArgs } = await load(base + 'cli/args.js');
  const { createAgentSessionRuntime, AgentSessionRuntime } = await load(base + 'core/agent-session-runtime.js');
  const { SettingsManager } = await load(base + 'core/settings-manager.js');
  const { SessionManager } = await load(base + 'core/session-manager.js');
  const { assertSessionCwdExists } = await load(base + 'core/session-cwd.js');
  const { runRpcMode } = await load(base + 'modes/rpc/rpc-mode.js');
  const { runMigrations } = await load(base + 'migrations.js');
  const ai = 'node_modules/@earendil-works/pi-ai/dist/';
  async function configureCompanionModel(runtime, metadata, selection, env) {
    if (!selection) return;
    const modelRuntime = runtime.services.modelRuntime;
    const account = await resolveCompanionAgy(selection, env);
    let provider, modelId;
    if (account) {
      const [{ createAssistantMessageEventStream }, { getCurrentSystemPrompt }, { kCursorExecResolved }] = await Promise.all([
        load(ai + 'index.js'), load(ai + 'utils/transcript.js'), load(ai + 'utils/block-symbols.js'),
      ]);
      const route = createCompanionAgyProvider({ companionId: metadata.companionId ?? 'segno',
        account, createAssistantMessageEventStream, getCurrentSystemPrompt,
        markResolved(block) { block[kCursorExecResolved] = true; },
      });
      provider = route.provider;
      modelId = selection.model;
      modelRuntime.registerProvider(provider, route.config);
    } else {
      const split = selection.model.indexOf('/');
      if (split < 1) throw new Error('Select a valid companion model');
      provider = selection.model.slice(0, split);
      modelId = selection.model.slice(split + 1);
      if (provider.startsWith(COMPANION_AGY_PROVIDER)) throw new Error('Select the Antigravity account, not its internal route');
    }
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Companion model is unavailable: ${selection.model}`);
    if (runtime.session.model?.provider !== provider || runtime.session.model?.id !== modelId) {
      await runtime.session.setModel(model);
    }
    return { provider, id: modelId, contextWindow: model.contextWindow, selection };
  }
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
    sessionLink,
    runRpcMode,
    /** The process gate every agent loop of this build waits at during a restart; none in an older build. */
    async loadDrainGate() {
      try { return (await load('node_modules/@earendil-works/pi-agent-core/dist/rubato-features/drain-gate/gate.mjs')).rubatoDrainGate; }
      catch (error) { if (error?.code === 'ERR_MODULE_NOT_FOUND') return undefined; throw error; }
    },
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
        createExtensionFactories: ctx => createRubatoExtensionFactories({ ...ctx, env: context.uiProcess.env, hosted: true,
          sessionLink: sessionLink.api }).extensionFactories };
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
      const scope = api.createUiScope({ process: { cwd: () => metadata.cwd }, env: workerEnv(metadata, creation) });
      const fromCli = Boolean(creation?.createRuntime);
      let runtime;
      let refresh, refreshController, refreshTimeout;
      return { ...creation,
        createRuntime: () => scope.run(async () => {
          try { runtime = await (creation?.createRuntime ? creation.createRuntime() : hosted.createRuntime(metadata)); }
          finally { creation = undefined; } // Startup's UI/trust callback must not pin a detached terminal.
          announceUnloadOnDispose(runtime);
          if (metadata.companion) {
            try {
              const entries = runtime.session.sessionManager.getEntries();
              const saved = entries.findLast(entry => entry.type === 'custom' && entry.customType === COMPANION_MODEL_ENTRY);
              const selection = saved ? validModelSelection(saved.data)
                : companionModelSelection(metadata.companionId, scope.env);
              await configureCompanionModel(runtime, metadata, selection, scope.env);
            } catch (error) {
              await runtime.dispose();
              throw error;
            }
          }
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
            dispatch: async command => {
              if (metadata.companion && command.type === 'set_model' &&
                  runtime.session.model?.provider.startsWith(COMPANION_AGY_PROVIDER)) {
                // The room has a native T3 carrier. The adapter can replay its
                // last Pi choice during reconnect; only the companion model
                // command can change an active ACP route.
                return transport.output({ id: command.id, type: 'response', command: command.type,
                  success: true, data: runtime.session.model });
              }
              if (command.type !== 'set_companion_model') return bound.dispatch(command);
              try {
                if (!metadata.companion) throw new Error('Only a companion room can set its own companion model');
                if (runtime.session.isStreaming) throw new Error('Wait for the companion to finish before changing its model');
                const selection = validModelSelection(command.modelSelection);
                const result = await configureCompanionModel(runtime, metadata, selection, scope.env);
                runtime.session.sessionManager.appendCustomEntry(COMPANION_MODEL_ENTRY, selection);
                return transport.output({ id: command.id, type: 'response', command: command.type, success: true, data: result });
              } catch (error) {
                return transport.output({ id: command.id, type: 'response', command: command.type, success: false, error: error.message });
              }
            },
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
