import { afterEach, describe, expect, it } from "@effect/vitest";

import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";
import { rubatoHttpAccess } from "./rubatoHttp";

type Prepared = Parameters<typeof rubatoHttpAccess>[0];
const prepared = (httpBaseUrl: string, httpAuthorization: unknown = null) =>
  ({ httpBaseUrl, httpAuthorization }) as unknown as Prepared;

function stubWindow(origin: string, desktopToken?: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: `${origin}/settings/memory`, origin },
      ...(desktopToken === undefined
        ? {}
        : { desktopBridge: { getLocalEnvironmentBearerToken: async () => desktopToken } }),
    },
  });
}

// The server answers CORS with a wildcard origin, so a cross-origin request
// carrying credentials never reaches it ("Failed to fetch" in the desktop app).
describe.sequential("Rubato route credentials", () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("sends the session cookie only from a page the server serves itself", async () => {
    stubWindow("http://127.0.0.1:3773");
    expect(await rubatoHttpAccess(prepared("http://127.0.0.1:3773/"))).toEqual({
      baseUrl: "http://127.0.0.1:3773",
      headers: {},
      credentials: "include",
    });
  });

  it("uses the desktop bearer token and no cookie in the desktop renderer", async () => {
    stubWindow("http://127.0.0.1:5733", "desktop-token");
    expect(await rubatoHttpAccess(prepared("http://127.0.0.1:3774"))).toEqual({
      baseUrl: "http://127.0.0.1:3774",
      headers: { authorization: "Bearer desktop-token" },
      credentials: "omit",
    });
  });

  it("uses the connection's bearer token without a cookie", async () => {
    stubWindow("http://127.0.0.1:3773");
    const access = await rubatoHttpAccess(
      prepared("http://127.0.0.1:3773", { _tag: "Bearer", token: "session-token" }),
    );
    expect(access?.credentials).toBe("omit");
    expect(access?.headers).toEqual({ authorization: "Bearer session-token" });
  });

  it("refuses a relay connection", async () => {
    stubWindow("http://127.0.0.1:3773");
    expect(
      await rubatoHttpAccess(prepared("https://relay.example", { _tag: "Dpop", accessToken: "x" })),
    ).toBeNull();
  });
});
