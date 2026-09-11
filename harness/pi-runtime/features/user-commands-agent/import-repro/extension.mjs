import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const GIST_ID_RE = /^[0-9a-fA-F]{20,}$/;
const GIST_URL_RE = /^https:\/\/gist\.github\.com\/(?:[^/]+\/)?([0-9a-fA-F]{20,})(?:[/#?].*)?$/;
const SHARE_URL_RE = /^https:\/\/pi\.dev\/session\/#([0-9a-fA-F]{20,})(?:[/#?].*)?$/;
const ISSUE_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/#?].*)?$/;
const SESSION_DATA_RE = /<script id="session-data" type="application\/json">([^<]+)<\/script>/;

export function parseRef(ref, cwd) {
  if (ref.endsWith(".html") || ref.endsWith(".jsonl")) {
    return { type: "file", path: isAbsolute(ref) ? ref : resolve(cwd, ref) };
  }
  const shareMatch = ref.match(SHARE_URL_RE);
  if (shareMatch) return { type: "gist", id: shareMatch[1] };
  const gistMatch = ref.match(GIST_URL_RE);
  if (gistMatch) return { type: "gist", id: gistMatch[1] };
  const issueMatch = ref.match(ISSUE_URL_RE);
  if (issueMatch) return { type: "issue", owner: issueMatch[1], repo: issueMatch[2], issue: issueMatch[3] };
  if (GIST_ID_RE.test(ref)) return { type: "gist", id: ref };
  throw new Error("expected a gist ID, gist URL, pi.dev share URL, issue URL, .html file, or .jsonl file: " + ref);
}

export function parseSessionJsonl(raw) {
  const newlineIndex = raw.indexOf("\n");
  const firstLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex);
  let parsed;
  try { parsed = JSON.parse(firstLine); }
  catch { throw new Error("first line of session file is not valid JSON"); }
  if (parsed.type !== "session" || typeof parsed.id !== "string" || typeof parsed.cwd !== "string" || parsed.cwd === "") {
    throw new Error("session file has no valid session header with a cwd");
  }
  return { header: parsed, jsonl: raw };
}

function escapeJsonString(value) {
  return JSON.stringify(value).slice(1, -1);
}

function trimTrailingPathSeparators(value) {
  return value.replace(/[\\/]+$/, "");
}

export function rewriteSessionCwd(raw, sourceCwd, targetCwd) {
  const source = trimTrailingPathSeparators(sourceCwd);
  if (!source || source === targetCwd) return raw;
  return raw.split(escapeJsonString(source)).join(escapeJsonString(targetCwd));
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error("failed to fetch " + url + ": HTTP " + response.status);
  return await response.text();
}

async function fetchGistSession(fetchImpl, gistId) {
  const response = await fetchImpl("https://api.github.com/gists/" + gistId, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error("failed to fetch gist " + gistId + ": HTTP " + response.status);
  const gist = await response.json();
  const files = Object.values(gist.files ?? {});
  const jsonlFile = files.find((file) => file.filename?.endsWith(".jsonl"));
  if (jsonlFile) return parseSessionJsonl(jsonlFile.content ?? await fetchText(fetchImpl, jsonlFile.raw_url));
  throw new Error("gist " + gistId + " has no .jsonl or .html session file");
}

export function createImportReproExtension(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return (pi) => {
    pi.registerCommand("ir", {
      description: "Import a CI issue-analysis session from a gist ID, share URL, or issue URL and switch to it",
      handler: async (args, ctx) => {
        if (!ctx.isIdle() || ctx.isCompacting?.() === true) {
          ctx.ui.notify("/ir is unavailable while the agent is working", "warning");
          return;
        }
        const ref = args.trim();
        if (!ref) {
          ctx.ui.notify("Usage: /ir <gist-id | gist-url | pi.dev/session URL | issue URL>", "error");
          return;
        }
        try {
          const targetCwd = ctx.sessionManager.getCwd();
          const sessionDir = ctx.sessionManager.getSessionDir();
          const parsedRef = parseRef(ref, targetCwd);
          ctx.ui.notify("Importing repro session from " + ref + "...", "info");
          let sourceName;
          let decoded;
          if (parsedRef.type === "gist") {
            decoded = await fetchGistSession(fetchImpl, parsedRef.id);
            sourceName = parsedRef.id + ".jsonl";
          } else if (parsedRef.type === "issue") {
            throw new Error("issue URL import requires a gist mock; pass a gist id or local jsonl in this candidate");
          } else {
            if (!existsSync(parsedRef.path)) throw new Error("session file not found: " + parsedRef.path);
            const raw = readFileSync(parsedRef.path, "utf8");
            decoded = parseSessionJsonl(raw);
            sourceName = basename(parsedRef.path).replace(/\.html$/, ".jsonl");
          }
          const rewritten = rewriteSessionCwd(decoded.jsonl, decoded.header.cwd, targetCwd);
          const destination = join(sessionDir, sourceName);
          writeFileSync(destination, rewritten);
          ctx.ui.notify("Imported session " + decoded.header.id + " (cwd " + decoded.header.cwd + " -> " + targetCwd + ")", "info");
          await ctx.switchSession(destination);
        } catch (error) {
          ctx.ui.notify("ir: " + (error instanceof Error ? error.message : String(error)), "error");
        }
      },
    });
  };
}

export default createImportReproExtension;

