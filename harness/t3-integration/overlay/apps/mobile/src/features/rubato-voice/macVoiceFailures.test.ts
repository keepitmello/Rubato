import { describe, expect, it } from "vite-plus/test";

import { MAC_VOICE_SETUP_HINT, macVoiceFailureMessage } from "./macVoiceFailures";

describe("macVoiceFailureMessage", () => {
  it("sends every setup problem to the Mac's voice settings", () => {
    for (const [status, code] of [
      [400, "missing-api-key"],
      [401, "api-key-rejected"],
      [404, "model-not-found"],
      [503, "voice-not-configured"],
      [503, ""],
    ] as const) {
      expect(macVoiceFailureMessage(status, code)).toContain(MAC_VOICE_SETUP_HINT);
    }
  });

  it("tells an unreachable Mac apart from a refused phone", () => {
    expect(macVoiceFailureMessage(null, "")).toMatch(/could not be reached/);
    expect(macVoiceFailureMessage(401, "")).toMatch(/Pair the phone/);
    expect(macVoiceFailureMessage(500, "voice-failed")).toBe("Your Mac could not transcribe this recording.");
  });
});
