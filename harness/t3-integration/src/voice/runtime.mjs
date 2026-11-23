import { createPresenceTracker } from './targets.mjs';
import { createSessionStore } from './sessions.mjs';
import { createSubmitter } from './submit.mjs';
import { createVoiceService } from './service.mjs';
import { DEFAULT_HINTS, transcribeAudio } from './transcribe.mjs';
import { dictationTerms, learnTerms, recordCorrections } from './vocabulary.mjs';
import { createTermClassifier } from './term-classifier.mjs';
import { mintLiveTranscription } from './live.mjs';
import { handleVoiceRequest, bearerMatches } from './http.mjs';
import {
  createVoiceConfigReader, handleVoiceSettingsRequest, voiceApiKey, voiceConfigUsable, voiceLanguages,
} from './settings.mjs';

/**
 * The voice service T3's server mounts at `/rubato/voice/*` (overlay RubatoVoice.ts).
 *
 * `configPath` names voice.json, which is read again whenever it changes: Settings
 * and voice-setup.mjs take effect on the next request, without restarting the app.
 * Without a usable file the routes answer 503 and only `/settings/*` works.
 * A fixed `config` is the older call shape (an app built before `configPath`).
 */
/** The hints every dictation gets: the built-in names, then this person's own (vocabulary.mjs). */
const hintsFor = (env) => [...DEFAULT_HINTS, ...dictationTerms(env)];

export function createVoiceRuntime({ config, configPath, statePath, env = process.env, classifyTerm, ...t3 }) {
  // A fix the person made teaches its term at once (vocabulary.mjs learnTerms), one fix after another.
  const classify = classifyTerm ?? createTermClassifier({ env });
  let learning = Promise.resolve();
  const learn = (pairs) => {
    learning = learning.then(() => learnTerms(pairs, { classify, env })).catch(() => {});
  };
  const readConfig = configPath ? createVoiceConfigReader(configPath) : () => ({ config, error: null });
  if (!configPath && !voiceConfigUsable(config)) throw new Error('Voice token must contain at least 32 characters');
  const current = () => {
    const value = readConfig().config;
    return voiceConfigUsable(value) ? value : null;
  };
  const presence = createPresenceTracker();
  const store = createSessionStore({ filename: statePath });
  const service = createVoiceService({
    ...t3, presence, store, defaultProjectId: () => current()?.defaultProjectId,
    submitter: createSubmitter(t3),
    transcriber: (audio) => {
      const settings = current();
      return transcribeAudio({ ...audio, apiKey: voiceApiKey(settings, env), model: settings?.model,
        languages: voiceLanguages(settings), hints: hintsFor(env) });
    },
  });
  const notConfigured = () => Response.json({ error: { code: 'voice-not-configured' } }, {
    status: 503, headers: { 'cache-control': 'no-store' },
  });
  return {
    noteActivity(input) {
      presence.noteActivity(input);
      void service.rememberMobileProject().catch(() => {});
    },
    noteSubscription(input) {
      const end = presence.noteSubscription(input);
      void service.rememberMobileProject().catch(() => {});
      return end;
    },
    acceptsToken: (header) => bearerMatches(header, current()?.token),
    handle(request, desktopAuthenticated = false) {
      const settings = current();
      if (!settings) return Promise.resolve(notConfigured());
      const live = () => mintLiveTranscription({ apiKey: voiceApiKey(settings, env),
        languages: voiceLanguages(settings), hints: hintsFor(env) });
      const corrections = (input) => ({ recorded: recordCorrections(input, { env, onRecorded: learn }) });
      return handleVoiceRequest(request, { service, token: settings.token, live, corrections, desktopAuthenticated });
    },
    /** Settings › Chat › Voice input. The caller has checked the desktop session. */
    handleSettings(request) {
      if (!configPath) return Promise.resolve(Response.json({ error: { code: 'not-found' } }, { status: 404 }));
      return handleVoiceSettingsRequest(request, { configPath, env });
    },
    wake: service.wake,
    close: service.close,
  };
}
