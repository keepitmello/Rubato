// Settings > Providers > Thinking effort: the level new conversations start at, for every model
// and for single models. The values are Pi's own `defaultThinkingLevel` and `modelThinkingLevels`
// in the profile's settings.json, the ones the engine reads when it opens a conversation or moves
// it to another model (pi-server host.mjs withStartThinkingLevels). Pi's SettingsManager from the
// engine's build writes them, so the file lock and the merge with the engine's own writes are Pi's.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSpeedIndexAgentDir } from '../../../rubato-pi/src/speed-index-store.mjs';
import { resolveLaunchEngine } from '../../../rubato-pi/src/engine-selection.mjs';

/** Pi's levels, weakest first (pi-ai THINKING levels). */
export const EFFORT_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MODEL = /^[a-z0-9][a-z0-9-]{0,63}\/[^\s/][^\s]{0,199}$/;

export class EffortRequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'bad-request';
  }
}

/** The engine build that runs the conversations: the live engine's, else the one a launch would pick. */
async function runtimeRootOf(agentDir, env) {
  try {
    const descriptor = JSON.parse(await readFile(path.join(agentDir, 'server', 'connection.json'), 'utf8'));
    if (typeof descriptor?.runtimeRoot === 'string' && path.isAbsolute(descriptor.runtimeRoot)) return descriptor.runtimeRoot;
  } catch { /* no live engine */ }
  const selection = resolveLaunchEngine({ env });
  if (selection.error || !selection.root) throw new Error(selection.error ?? 'No Rubato engine build is installed.');
  return selection.root;
}

async function loadSettingsManager(runtimeRoot) {
  const file = path.join(runtimeRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'settings-manager.js');
  const { SettingsManager } = await import(pathToFileURL(file).href);
  if (typeof SettingsManager?.create !== 'function') throw new Error('The engine build has no settings manager.');
  return SettingsManager;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, agentDir?: string, settingsManager?: () => Promise<any> }} [options]
 *   `settingsManager` opens the profile's settings; a test passes its own.
 */
export function createEffortSettings(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const agentDir = options.agentDir ?? resolveSpeedIndexAgentDir(env, home) ?? path.join(home, '.rubato-pi', 'agent');
  // Global settings only: the cwd is the profile itself, which has no project settings of its own.
  const open = options.settingsManager
    ?? (async () => (await loadSettingsManager(await runtimeRootOf(agentDir, env))).create(agentDir, agentDir));

  const snapshot = (settings) => ({
    defaultLevel: settings.getDefaultThinkingLevel() ?? null,
    models: settings.getAllModelThinkingLevels(),
  });

  return {
    async read() {
      return snapshot(await open());
    },
    /** `{ defaultLevel }` sets the level for every model; `{ model, level }` one model's, `level: null` drops it. */
    async write(input = {}) {
      const settings = await open();
      if ('defaultLevel' in input) {
        if (!EFFORT_LEVELS.includes(input.defaultLevel)) throw new EffortRequestError(`defaultLevel must be one of ${EFFORT_LEVELS.join(', ')}.`);
        settings.setDefaultThinkingLevel(input.defaultLevel);
      } else if ('model' in input) {
        if (typeof input.model !== 'string' || !MODEL.test(input.model)) throw new EffortRequestError('model must be provider/model-id.');
        const slash = input.model.indexOf('/');
        const [provider, id] = [input.model.slice(0, slash), input.model.slice(slash + 1)];
        if (input.level === null) settings.removeModelThinkingLevel(provider, id);
        else if (EFFORT_LEVELS.includes(input.level)) settings.setModelThinkingLevel(provider, id, input.level);
        else throw new EffortRequestError(`level must be null or one of ${EFFORT_LEVELS.join(', ')}.`);
      } else {
        throw new EffortRequestError('Send defaultLevel, or model with level.');
      }
      await settings.flush();
      // A settings file Pi could not read is not written at all; that and a failed write land here.
      const [failed] = settings.drainErrors?.() ?? [];
      if (failed) {
        const cause = failed.error ?? failed;
        throw cause instanceof Error ? cause : new Error(String(cause));
      }
      return snapshot(settings);
    },
  };
}
