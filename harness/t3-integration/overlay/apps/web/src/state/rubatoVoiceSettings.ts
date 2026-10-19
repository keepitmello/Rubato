import type { EnvironmentId } from "@t3tools/contracts";

import { postRubato } from "./rubatoHttp";

/** Settings › Chat › Voice input, served by the voice module (src/voice/settings.mjs). */
const VOICE_SETTINGS_ROUTE = "/rubato/voice/settings";

export interface VoiceSettingsStatus {
  readonly configPath: string;
  /** voice.json exists but is not JSON this page can merge into. */
  readonly configError: "invalid" | "unreadable" | null;
  /** A model, a Shortcut token and a key: the composer microphone works. */
  readonly ready: boolean;
  readonly model: string | null;
  readonly defaultModel: string;
  readonly apiKey: {
    /** "settings": saved here. "environment": OPENAI_API_KEY of the app. */
    readonly source: "settings" | "environment" | null;
    /** First and last characters only. */
    readonly preview: string | null;
  };
  readonly shortcutToken: string | null;
}

function call(environmentId: EnvironmentId | null, action: string, body: Record<string, unknown> = {}) {
  return postRubato<VoiceSettingsStatus>(environmentId, VOICE_SETTINGS_ROUTE, action, body, "voice settings");
}

export const rubatoVoiceSettings = {
  status: (env: EnvironmentId | null) => call(env, "status"),
  saveApiKey: (env: EnvironmentId | null, openaiApiKey: string | null) => call(env, "save", { openaiApiKey }),
  saveModel: (env: EnvironmentId | null, model: string) => call(env, "save", { model }),
  rotateToken: (env: EnvironmentId | null) => call(env, "rotate-token"),
};
