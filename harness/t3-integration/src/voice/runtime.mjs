import { createPresenceTracker } from './targets.mjs';
import { createSessionStore } from './sessions.mjs';
import { createSubmitter } from './submit.mjs';
import { createVoiceService } from './service.mjs';
import { transcribeAudio } from './transcribe.mjs';
import { handleVoiceRequest, bearerMatches } from './http.mjs';

export function createVoiceRuntime({ config, statePath, ...t3 }) {
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('Voice token must contain at least 32 characters');
  const presence = createPresenceTracker();
  const store = createSessionStore({ filename: statePath });
  const service = createVoiceService({
    ...t3, presence, store, defaultProjectId: config.defaultProjectId,
    submitter: createSubmitter(t3),
    transcriber: (audio) => transcribeAudio({
      ...audio, apiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY, model: config.model,
    }),
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
    acceptsToken: (header) => bearerMatches(header, config.token),
    handle: (request, desktopAuthenticated = false) =>
      handleVoiceRequest(request, { service, token: config.token, desktopAuthenticated }),
    wake: service.wake,
    close: service.close,
  };
}
