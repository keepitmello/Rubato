import { describe, expect, it } from "vite-plus/test";

import { BUILTIN_SOUNDS, decodeBase64, syncNotificationSounds, type SoundFolder } from "./sounds";

const MAC = { environmentId: "env-mac", httpBaseUrl: "https://wy-mac.tail.ts.net/", bearerToken: "session-token" };

function world(sounds: unknown) {
  const files = new Map<string, Uint8Array>();
  const folder: SoundFolder = {
    size: (name) => files.get(name)?.length ?? null,
    write: async (name, bytes) => void files.set(name, bytes),
  };
  const requests: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    requests.push({ url, auth: headers.authorization ?? null, body: JSON.parse(init.body as string) });
    if (url.endsWith("/rubato/push/sounds")) return sounds === null ? new Response("{}", { status: 404 }) : Response.json({ sounds });
    if (url.endsWith("/rubato/sounds/file")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { files, requests, deps: { folder, fetch } };
}

describe("the chimes thread alerts ring with", () => {
  it("are T3's own two chimes, as CAF files, until the Mac picks one of its sounds", async () => {
    const { files, requests, deps } = world([
      { kind: "completion", id: "builtin:completion", file: "rubato-completion.caf" },
      { kind: "input", id: "builtin:input", file: "rubato-input.caf" },
    ]);
    await syncNotificationSounds(deps, [MAC]);
    expect([...files.keys()].sort()).toEqual(["rubato-completion.caf", "rubato-input.caf"]);
    for (const [name, base64] of Object.entries(BUILTIN_SOUNDS)) {
      const bytes = files.get(name)!;
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("caff");
      expect(bytes).toEqual(decodeBase64(base64));
    }
    expect(requests.map((item) => item.url)).toEqual(["https://wy-mac.tail.ts.net/rubato/push/sounds"]);
    // Written once: a second sync leaves them.
    files.set("rubato-input.caf", files.get("rubato-input.caf")!);
    const before = files.get("rubato-completion.caf");
    await syncNotificationSounds(deps, [MAC]);
    expect(files.get("rubato-completion.caf")).toBe(before);
  });

  it("fetch a Mac sound the desktop picked once, as the phone plays it", async () => {
    const { files, requests, deps } = world([
      { kind: "completion", id: "mac:system/Glass.aiff", file: "rubato-mac-0123456789ab.caf" },
      { kind: "input", id: "builtin:input", file: "rubato-input.caf" },
    ]);
    await syncNotificationSounds(deps, [MAC]);
    expect(files.get("rubato-mac-0123456789ab.caf")).toEqual(new Uint8Array([1, 2, 3]));
    expect(requests[1]).toEqual({
      url: "https://wy-mac.tail.ts.net/rubato/sounds/file",
      auth: "Bearer session-token",
      body: { id: "mac:system/Glass.aiff", for: "phone" },
    });
    requests.length = 0;
    await syncNotificationSounds(deps, [MAC]);
    expect(requests.map((item) => item.url)).toEqual(["https://wy-mac.tail.ts.net/rubato/push/sounds"]);
  });

  it("never writes a name outside the app's own chimes, and a Mac without chimes leaves the built-in ones", async () => {
    const { files, deps } = world([{ kind: "completion", id: "mac:system/Glass.aiff", file: "../Glass.caf" }]);
    await syncNotificationSounds(deps, [MAC]);
    expect([...files.keys()].sort()).toEqual(["rubato-completion.caf", "rubato-input.caf"]);
    const old = world(null);
    await syncNotificationSounds(old.deps, [MAC]);
    expect([...old.files.keys()].sort()).toEqual(["rubato-completion.caf", "rubato-input.caf"]);
  });
});
