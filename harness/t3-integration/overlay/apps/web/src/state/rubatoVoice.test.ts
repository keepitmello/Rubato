import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { withVoiceFailure } from "../components/chat/useRubatoVoiceInput";
import { createRubatoVoiceTranscriber, type RubatoVoiceFailure } from "./rubatoVoice";

vi.mock("./session", () => ({ readPreparedConnection: () => ({}) }));
vi.mock("./rubatoHttp", () => ({
  rubatoHttpAccess: async () => ({
    baseUrl: "http://mac.test",
    headers: { authorization: "Bearer desktop" },
    credentials: "omit",
  }),
}));

type Sent = { url: string; method: string; headers: Record<string, string> };
let sent: Sent[] = [];
let answer: (url: string) => Response;

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("blob:")) return new Response(new Blob(["audio"], { type: "audio/webm;codecs=opus" }));
    sent.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])),
    });
    return answer(url);
  });
});
afterEach(() => vi.unstubAllGlobals());

const environmentId = EnvironmentId.make("env");
const signal = new AbortController().signal;

it("sends only methods and headers T3's CORS allows, so the browser lets the recording through", async () => {
  // T3's own list, read at run time: the web project does not compile server files.
  const corsFile = new URL("../../../server/src/httpCors.ts", import.meta.url).pathname;
  const cors = (await import(/* @vite-ignore */ corsFile)) as {
    browserApiCorsAllowedMethods: readonly string[];
    browserApiCorsAllowedHeaders: readonly string[];
  };
  answer = (url) =>
    url.endsWith("/transcribe")
      ? Response.json({ text: "안녕하세요" })
      : Response.json({ voiceSessionId: "s1" });

  const prepared = await createRubatoVoiceTranscriber(() => environmentId).prepare({ signal });
  expect(await prepared.transcribe("blob:recording", { signal } as never)).toBe("안녕하세요");

  expect(sent.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    "POST /rubato/voice/session",
    "POST /rubato/voice/session/s1/transcribe",
    "POST /rubato/voice/session/s1/cancel",
  ]);
  for (const request of sent) {
    expect(cors.browserApiCorsAllowedMethods).toContain(request.method);
    for (const header of Object.keys(request.headers)) {
      expect(cors.browserApiCorsAllowedHeaders).toContain(header);
    }
  }
});

it("names the setting to fix when the Mac is not set up, in place of T3's generic line", async () => {
  answer = () => Response.json({ error: { code: "voice-not-configured" } }, { status: 503 });
  let failure: RubatoVoiceFailure | null = null;
  const transcriber = createRubatoVoiceTranscriber(
    () => environmentId,
    (reported) => {
      failure = reported;
    },
  );
  await expect(transcriber.prepare({ signal })).rejects.toThrow("Voice input is not set up yet.");
  expect(failure).toEqual({ message: "Voice input is not set up yet.", fixInSettings: true });

  const generic = { phase: "error", error: "Could not prepare voice transcription.", errorAction: "retry" } as const;
  expect(withVoiceFailure(generic, failure)).toEqual({
    phase: "error",
    error: "Voice input is not set up yet.",
    errorAction: "settings",
  });
  expect(withVoiceFailure({ phase: "idle", error: null, errorAction: null }, failure).error).toBeNull();
});
