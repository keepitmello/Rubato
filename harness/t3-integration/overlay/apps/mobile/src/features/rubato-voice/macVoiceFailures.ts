// What the phone tells the person when the Mac's voice service says no. The Mac's Settings
// is where every one of these is fixed; the phone has no voice settings of its own.
export const MAC_VOICE_SETUP_HINT = "In Rubato on your Mac, open Settings › Chat › Voice input.";

/** The Mac's error code (or a missing answer) as a line a person can act on. Never the raw body. */
export function macVoiceFailureMessage(status: number | null, code: string): string {
  if (status === null) return "Your Mac could not be reached. Check that Rubato is open on the Mac and that this phone is on its network or Tailscale.";
  if (code === "missing-api-key") return `Add an OpenAI API key for voice input. ${MAC_VOICE_SETUP_HINT}`;
  if (code === "api-key-rejected") return `OpenAI did not accept the voice input API key. ${MAC_VOICE_SETUP_HINT}`;
  if (code === "model-not-found") return `OpenAI does not know the voice input model. ${MAC_VOICE_SETUP_HINT}`;
  if (status === 503 || code === "voice-not-configured" || code === "missing-model" || code === "voice-unavailable") {
    return `Voice input is not set up on your Mac yet. ${MAC_VOICE_SETUP_HINT}`;
  }
  if (code === "expired-session" || code === "session-closed") return "The recording took too long. Start again.";
  if (status === 401 || status === 403) return "Your Mac did not allow voice input from this phone. Pair the phone with the Mac again.";
  return "Your Mac could not transcribe this recording.";
}
