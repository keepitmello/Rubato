// Google Antigravity `/login`. Senpi 가 `auth_url` 을 받으면 브라우저를 연다.
//
// Keychain import 는 세션 시작 이관이다. `/login` 은 사용자가 구글 계정으로
// 다시 묶는 자리이므로 브라우저 흐름이 정본이다.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const ANTIGRAVITY_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ANTIGRAVITY_OAUTH_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

function base64url(buffer) {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function generatePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  return { verifier, challenge, state };
}

export function authorizationUrl({ clientId, redirectUri, challenge, state, scopes = ANTIGRAVITY_OAUTH_SCOPES }) {
  const url = new URL(ANTIGRAVITY_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.href;
}

export function parseAuthorizationInput(input) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value.startsWith("http") ? new URL(value).search : value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

export function startLoopbackCallback({ createServerImpl = createServer } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServerImpl((request, response) => {
      let parsed;
      try {
        parsed = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("invalid callback");
        return;
      }
      const code = parsed.searchParams.get("code") ?? undefined;
      const state = parsed.searchParams.get("state") ?? undefined;
      const error = parsed.searchParams.get("error");
      if (error) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization failed. You can close this window.");
        server.emit("oauth", { error });
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Signed in. You can close this window.");
      server.emit("oauth", { code, state });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}/oauth2callback`,
        waitForCode() {
          return new Promise((waitResolve, waitReject) => {
            const onOauth = (payload) => {
              if (payload.error) waitReject(new Error(`Google authorization failed (${payload.error})`));
              else waitResolve(payload);
            };
            server.once("oauth", onOauth);
            server.cancelWait = () => {
              server.off("oauth", onOauth);
              waitResolve(undefined);
            };
          });
        },
        cancelWait() {
          server.cancelWait?.();
        },
        close() {
          server.close();
        },
      });
    });
  });
}

export async function exchangeAuthorizationCode({
  clients,
  code,
  verifier,
  redirectUri,
  fetchImpl = globalThis.fetch,
  signal,
}) {
  let last;
  for (const client of clients) {
    const response = await fetchImpl(ANTIGRAVITY_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      signal,
    });
    if (!response.ok) {
      last = `token ${response.status}`;
      continue;
    }
    const data = await response.json();
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
      last = "token response missing fields";
      continue;
    }
    return {
      type: "oauth",
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + (Number.isFinite(data.expires_in) ? data.expires_in : 3600) * 1000,
    };
  }
  throw new Error(`Antigravity Google token exchange failed (${last ?? "no clients"})`);
}

export async function loginAntigravityGoogle({
  interaction,
  clients,
  fetchImpl = globalThis.fetch,
  generatePkceImpl = generatePkce,
  startCallback = startLoopbackCallback,
}) {
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error("Antigravity OAuth client configuration has no clients");
  }
  const pkce = generatePkceImpl();
  const callback = await startCallback();
  const url = authorizationUrl({
    clientId: clients[0].id,
    redirectUri: callback.redirectUri,
    challenge: pkce.challenge,
    state: pkce.state,
  });
  interaction.notify?.({
    type: "auth_url",
    url,
    instructions: "A browser window should open. Complete Google sign-in to finish.",
  });
  const onAbort = () => callback.cancelWait();
  interaction.signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const callbackPromise = callback.waitForCode();
    const manualPromise = interaction.prompt?.({
      type: "manual_code",
      message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
      placeholder: callback.redirectUri,
    });
    let result;
    let manual;
    if (!manualPromise) {
      result = await callbackPromise;
    } else {
      const raced = await Promise.race([
        callbackPromise.then((payload) => ({ via: "callback", payload })),
        Promise.resolve(manualPromise).then((input) => {
          callback.cancelWait();
          return { via: "manual", input };
        }),
      ]);
      if (raced.via === "callback") result = raced.payload;
      else manual = raced.input;
    }
    const parsed = result?.code ? result : parseAuthorizationInput(manual);
    if (parsed.state && parsed.state !== pkce.state) {
      throw new Error("Antigravity OAuth state mismatch");
    }
    if (result?.state && result.state !== pkce.state) {
      throw new Error("Antigravity OAuth state mismatch");
    }
    if (typeof parsed.code !== "string" || parsed.code.length === 0) {
      throw new Error("Antigravity OAuth did not receive an authorization code");
    }
    return await exchangeAuthorizationCode({
      clients,
      code: parsed.code,
      verifier: pkce.verifier,
      redirectUri: callback.redirectUri,
      fetchImpl,
      signal: interaction.signal,
    });
  } finally {
    interaction.signal?.removeEventListener?.("abort", onAbort);
    callback.close?.();
  }
}
