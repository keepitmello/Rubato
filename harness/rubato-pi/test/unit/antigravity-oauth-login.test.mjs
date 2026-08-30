import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTIGRAVITY_AUTHORIZE_URL,
  authorizationUrl,
  exchangeAuthorizationCode,
  loginAntigravityGoogle,
  parseAuthorizationInput,
} from "../../src/antigravity-oauth-login.mjs";

test("authorizationUrl은 Google 브라우저 로그인 주소를 만든다", () => {
  const url = authorizationUrl({
    clientId: "client",
    redirectUri: "http://127.0.0.1:9/oauth2callback",
    challenge: "chal",
    state: "st",
  });
  assert.equal(url.startsWith(ANTIGRAVITY_AUTHORIZE_URL), true);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("client_id"), "client");
  assert.equal(parsed.searchParams.get("redirect_uri"), "http://127.0.0.1:9/oauth2callback");
  assert.equal(parsed.searchParams.get("code_challenge"), "chal");
  assert.equal(parsed.searchParams.get("access_type"), "offline");
});

test("parseAuthorizationInput은 URL·code를 읽는다", () => {
  assert.deepEqual(
    parseAuthorizationInput("http://127.0.0.1:9/oauth2callback?code=abc&state=st"),
    { code: "abc", state: "st" },
  );
  assert.deepEqual(parseAuthorizationInput("abc"), { code: "abc" });
});

test("loginAntigravityGoogle은 auth_url을 알리고 code를 교환한다", async () => {
  const events = [];
  const fetches = [];
  const credential = await loginAntigravityGoogle({
    interaction: {
      notify: (event) => events.push(event),
    },
    clients: [{ id: "client", secret: "secret" }],
    generatePkceImpl: () => ({ verifier: "ver", challenge: "chal", state: "st" }),
    startCallback: async () => ({
      redirectUri: "http://127.0.0.1:9/oauth2callback",
      waitForCode: async () => ({ code: "abc", state: "st" }),
      cancelWait: () => {},
      close: () => {},
    }),
    fetchImpl: async (url, init) => {
      fetches.push({ url: String(url), body: String(init.body) });
      return {
        ok: true,
        json: async () => ({ access_token: "ak", refresh_token: "rk", expires_in: 60 }),
      };
    },
  });
  assert.equal(events[0]?.type, "auth_url");
  assert.match(events[0].url, /accounts\.google\.com/);
  assert.equal(credential.access, "ak");
  assert.equal(credential.refresh, "rk");
  assert.match(fetches[0].body, /code=abc/);
  assert.match(fetches[0].body, /code_verifier=ver/);
});

test("브라우저 콜백이 오면 수동 입력을 기다리지 않는다", async () => {
  let loginSettled = false;
  const work = loginAntigravityGoogle({
    interaction: {
      notify: () => {},
      prompt: () => new Promise(() => {}),
    },
    clients: [{ id: "client", secret: "secret" }],
    generatePkceImpl: () => ({ verifier: "ver", challenge: "chal", state: "st" }),
    startCallback: async () => ({
      redirectUri: "http://127.0.0.1:9/oauth2callback",
      waitForCode: async () => ({ code: "abc", state: "st" }),
      cancelWait: () => {},
      close: () => {},
    }),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ access_token: "ak", refresh_token: "rk", expires_in: 60 }),
    }),
  }).then((credential) => {
    loginSettled = true;
    return credential;
  });
  const credential = await work;
  assert.equal(loginSettled, true);
  assert.equal(credential.access, "ak");
});

test("exchangeAuthorizationCode는 다음 client로 넘어간다", async () => {
  const seen = [];
  const credential = await exchangeAuthorizationCode({
    clients: [
      { id: "bad", secret: "x" },
      { id: "good", secret: "y" },
    ],
    code: "abc",
    verifier: "ver",
    redirectUri: "http://127.0.0.1:9/oauth2callback",
    fetchImpl: async (_url, init) => {
      const body = String(init.body);
      seen.push(body);
      if (body.includes("client_id=bad")) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, json: async () => ({ access_token: "ak", refresh_token: "rk", expires_in: 30 }) };
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(credential.access, "ak");
});
