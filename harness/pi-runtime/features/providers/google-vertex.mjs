import { VERTEX_SERVICE_ACCOUNT_JSON_ENV } from "../../../rubato-pi/src/vertex-keychain.mjs";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[providers:${label}] expected stock anchor exactly once`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

/**
 * Stock Vertex takes a service account only as a file path (GOOGLE_APPLICATION_CREDENTIALS).
 * The Keychain lane hands the JSON over in the request env instead, so it never touches disk.
 * Only the scoped request env is read — not process.env.
 *
 * @google/genai console.debug()s a notice every time a client is built with explicit
 * credentials, and that line would land on the TUI screen or the engine's stdout once per
 * turn. The constructor is synchronous, so only that call is muted.
 */
export function patchVertexServiceAccountJson(source) {
  const next = replaceOnce(
    source,
    `function createClient(model, project, location, optionsHeaders, env) {
    const googleAuthOptions = buildGoogleAuthOptions(env);
    return new GoogleGenAI({
        vertexai: true,
        project,
        location,
        apiVersion: API_VERSION,
        ...(googleAuthOptions ? { googleAuthOptions } : {}),
        httpOptions: buildHttpOptions(model, optionsHeaders),
    });
}`,
    `function createClient(model, project, location, optionsHeaders, env) {
    const googleAuthOptions = buildGoogleAuthOptions(env);
    const clientOptions = {
        vertexai: true,
        project,
        location,
        apiVersion: API_VERSION,
        ...(googleAuthOptions ? { googleAuthOptions } : {}),
        httpOptions: buildHttpOptions(model, optionsHeaders),
    };
    if (!googleAuthOptions?.credentials)
        return new GoogleGenAI(clientOptions);
    const debug = console.debug;
    console.debug = () => { };
    try {
        return new GoogleGenAI(clientOptions);
    }
    finally {
        console.debug = debug;
    }
}`,
    "vertex-quiet-credentials-notice",
  );
  return replaceOnce(
    next,
    `function buildGoogleAuthOptions(env) {
    const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);`,
    `function buildGoogleAuthOptions(env) {
    const serviceAccountJson = env?.[${JSON.stringify(VERTEX_SERVICE_ACCOUNT_JSON_ENV)}];
    if (serviceAccountJson)
        return { credentials: JSON.parse(serviceAccountJson) };
    const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);`,
    "vertex-service-account-json",
  );
}

/**
 * Stock only recognizes Gemini 3 ids as thinking-level models, so Gemini 4 falls through to
 * thinking_budget — which gemini-4-argon rejects with HTTP 400 (LOW/MEDIUM/HIGH levels only).
 */
export function patchGemini4ThinkingLevel(source) {
  return replaceOnce(
    source,
    `    /gemini-3(?:\\.\\d+)?-(?:pro|flash)/.test(id) ||
`,
    `    /gemini-3(?:\\.\\d+)?-(?:pro|flash)/.test(id) ||
        (getGeminiMajorVersion(id) ?? 0) >= 4 ||
`,
    "gemini-4-thinking-level",
  );
}
