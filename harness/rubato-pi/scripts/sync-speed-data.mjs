#!/usr/bin/env node
/**
 * Explicit opt-in, out-of-band GitHub upload. A durable pending batch is written
 * before PUT; a retry checks the same immutable path before advancing cursors.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { exportSpeedSample, SPEED_DATA_DISABLED_FILE } from "../src/speed-data-export.mjs";
import { resolveSpeedIndexAgentDir } from "../src/speed-index-store.mjs";

const MAX_ROWS = 2000;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const READ_BYTES = 4 * 1024 * 1024;
const BATCH_ROWS = 500;
const MAX_BATCH_BYTES = 750_000; // Contents GET returns a normal file blob below 1MB.
const WINDOW_MS = 30 * 86_400_000;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HELP = `Usage: node scripts/sync-speed-data.mjs --repo OWNER/REPO [--upload]
  --samples DIR    Speed samples directory (default: current agent's speed-index/samples)
  --state FILE     Local private identity/cursors/outbox (default: speed-index/github-sync.json)
  --gh PATH        GitHub CLI executable (default: gh)

Default is a local dry run: no writes or network requests.
--upload explicitly enables transmission to an existing PRIVATE repository.
RUBATO_SPEED_DATA_UPLOAD=0 or a sibling github-sync.disabled file stops uploads.
Uses your existing gh login; no credential is embedded or copied into state.
Only capture-v1 main-stream rows from the last 30 days are exported.
At most 2000 new rows / 64 MiB source scan per run; rerun to drain a backlog.
Do not delete state: it preserves device identity and duplicate prevention.`;

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    if (process.platform !== "win32") {
      const dir = openSync(dirname(path), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } finally { rmSync(temp, { force: true }); }
}

function acquireLock(statePath) {
  const path = `${statePath}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const pid = JSON.parse(readFileSync(path, "utf8")).pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid sync lock; inspect it before removing it");
    try {
      process.kill(pid, 0);
      throw new Error("another sync process holds the state lock");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      // Leave crash recovery explicit rather than racing a second process that
      // may be reclaiming the same stale lock. Pending batches are still safe.
      throw new Error("stale sync lock; confirm no sync is running, then remove the .lock file and rerun");
    }
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  return () => rmSync(path, { force: true });
}

function initialState(repo, samplesDir) {
  return { version: 1, repo, samplesDir, deviceId: randomBytes(16).toString("hex"),
    secret: randomBytes(32).toString("hex"), cursors: {}, pending: null };
}

function loadState(path, repo, samplesDir) {
  if (!existsSync(path)) return initialState(repo, samplesDir);
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state.version !== 1 || state.repo !== repo || state.samplesDir !== samplesDir ||
      !/^[a-f0-9]{32}$/.test(state.deviceId) || !/^[a-f0-9]{64}$/.test(state.secret) ||
      !state.cursors || typeof state.cursors !== "object" || Array.isArray(state.cursors)) {
    throw new Error("sync state does not match this repository/source; do not reset it to bypass duplicate protection");
  }
  return state;
}

/** Advance only complete lines. An in-flight last line is retried next run. */
export function collectSpeedRows(state, { now = Date.now(), maxRows = MAX_ROWS } = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) throw new Error("invalid scan row bound");
  const cursors = { ...state.cursors };
  const rows = [];
  const diagnostics = { scannedBytes: 0, ignoredRows: 0, invalidJsonLines: 0, deferredPartialFiles: 0, deferredFutureFiles: 0 };
  const names = readdirSync(state.samplesDir).filter((name) => /^\d+-\d+-[a-f0-9]+\.jsonl$/i.test(name)).sort();
  outer: for (const name of names) {
    if (rows.length >= maxRows || diagnostics.scannedBytes >= MAX_SCAN_BYTES) break;
    const path = join(state.samplesDir, name);
    const size = statSync(path).size;
    let offset = cursors[name] ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error("sample file was truncated or its cursor is invalid");
    const fd = openSync(path, "r");
    try {
      while (offset < size) {
        const length = Math.min(READ_BYTES, size - offset, MAX_SCAN_BYTES - diagnostics.scannedBytes);
        if (length === 0) break outer;
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, offset);
        const end = buffer.lastIndexOf(10, read - 1);
        if (read === 0 || end < 0) {
          if (size - offset >= READ_BYTES) throw new Error("sample line exceeds scan buffer");
          diagnostics.deferredPartialFiles += 1;
          break;
        }
        let start = 0;
        while (start <= end) {
          const newline = buffer.indexOf(10, start);
          const line = buffer.subarray(start, newline).toString("utf8");
          const recordKey = `${name}:${offset + start}`;
          if (line.trim()) {
            try {
              const raw = JSON.parse(line);
              // Future timestamps must not be consumed before their window opens.
              if (typeof raw?.at === "string" && Date.parse(raw.at) >= now) {
                diagnostics.deferredFutureFiles += 1;
                continue outer;
              }
              const row = exportSpeedSample(raw, { ...state, recordKey, from: now - WINDOW_MS, to: now });
              if (row) rows.push(row);
              else diagnostics.ignoredRows += 1;
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              diagnostics.invalidJsonLines += 1;
            }
          }
          const consumed = newline + 1 - start;
          diagnostics.scannedBytes += consumed;
          cursors[name] = offset + newline + 1;
          start = newline + 1;
          if (rows.length >= maxRows) break outer;
        }
        offset = cursors[name];
      }
    } finally { closeSync(fd); }
  }
  // Local sample retention may remove files; only stale cursor metadata is pruned.
  const present = new Set(names);
  for (const name of Object.keys(cursors)) if (!present.has(name)) delete cursors[name];
  return { rows, cursors, diagnostics: { ...diagnostics, rowLimitReached: rows.length === maxRows } };
}

export function makeSpeedBatches(rows, deviceId) {
  const days = new Map();
  for (const row of rows) {
    const day = row.at.slice(0, 10);
    const bucket = days.get(day) ?? [];
    bucket.push(row);
    days.set(day, bucket);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).flatMap(([day, records]) => {
    const batches = [];
    for (let i = 0; i < records.length; i += BATCH_ROWS) {
      const part = records.slice(i, i + BATCH_ROWS);
      const bytes = gzipSync(`${part.map((row) => JSON.stringify(row)).join("\n")}\n`);
      if (bytes.length > MAX_BATCH_BYTES) throw new Error("compressed batch exceeds the upload bound");
      const hash = createHash("sha256").update(bytes).digest("hex");
      batches.push({ path: `samples/${day}/${deviceId}/${hash}.jsonl.gz`,
        content: bytes.toString("base64"), records: part.length });
    }
    return batches;
  });
}

export function githubApi(gh = "gh") {
  return (method, path, body) => {
    const args = ["api", "--hostname", "github.com", "--method", method, path];
    if (body !== undefined) args.push("--input", "-");
    try {
      const stdout = execFileSync(gh, args, { input: body === undefined ? undefined : JSON.stringify(body),
        encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "" }, stdio: ["pipe", "pipe", "pipe"] });
      return stdout.trim() ? JSON.parse(stdout) : null;
    } catch (error) {
      let status;
      try { status = Number(JSON.parse(String(error.stdout)).status); } catch {}
      if (method === "GET" && status === 404) return null;
      // Never echo gh debug output, credentials or request bodies into logs.
      throw new Error(`GitHub ${method} failed${status ? ` (HTTP ${status})` : ""}; batch remains pending`);
    }
  };
}

function assertPrivateRepo(api, repo) {
  const metadata = api("GET", `repos/${repo}`);
  if (metadata?.full_name?.toLowerCase() !== repo.toLowerCase() || metadata.private !== true || metadata.permissions?.push !== true) {
    throw new Error("upload requires the exact private repository and authenticated write permission");
  }
}

function uploadBatch(api, repo, batch) {
  const bytes = Buffer.from(batch.content, "base64");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length > MAX_BATCH_BYTES || !batch.path.endsWith(`/${hash}.jsonl.gz`) ||
      !/^samples\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{32}\/[a-f0-9]{64}\.jsonl\.gz$/.test(batch.path)) {
    throw new Error("pending batch checksum/path is invalid");
  }
  const expectedSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const endpoint = `repos/${repo}/contents/${batch.path}`;
  const existing = api("GET", endpoint);
  if (existing) {
    if (existing.sha !== expectedSha) throw new Error("immutable batch path already contains different bytes; refusing overwrite");
    return "already_present";
  }
  const created = api("PUT", endpoint, { message: "Add opt-in timing batch", content: batch.content });
  if (created?.content?.sha !== expectedSha) throw new Error("GitHub did not confirm the expected blob; batch remains pending");
  return "uploaded";
}

export function syncSpeedData({ repo, samplesDir, statePath, upload = false, now = Date.now(), api = githubApi() }) {
  if (typeof repo !== "string" || !REPO.test(repo)) throw new Error("--repo OWNER/REPO is required");
  if (!Number.isFinite(now)) throw new Error("invalid sync clock");
  if (upload && existsSync(join(dirname(statePath), SPEED_DATA_DISABLED_FILE))) return { mode: "disabled", repo };
  samplesDir = realpathSync(samplesDir);
  const release = upload ? acquireLock(statePath) : () => {};
  try {
    let state = loadState(statePath, repo, samplesDir);
    if (upload) assertPrivateRepo(api, repo);
    let collected;
    if (!state.pending) {
      collected = collectSpeedRows(state, { now });
      state.pending = { cursors: collected.cursors, batches: makeSpeedBatches(collected.rows, state.deviceId) };
    }
    const result = { mode: upload ? "upload" : "dry_run", repo, deviceId: state.deviceId,
      records: state.pending.batches.reduce((sum, batch) => sum + batch.records, 0),
      batches: state.pending.batches.length, uploaded: 0, alreadyPresent: 0,
      compressedBytes: state.pending.batches.reduce((sum, batch) => sum + Buffer.from(batch.content, "base64").length, 0),
      diagnostics: collected?.diagnostics ?? { resumedPending: true } };
    if (!upload) return result;
    // Persist identity AND exact pending bytes before any remote mutation.
    atomicJson(statePath, state);
    for (const batch of state.pending.batches) {
      // Recheck visibility each time, not only when configuration was created.
      assertPrivateRepo(api, repo);
      const status = uploadBatch(api, repo, batch);
      if (status === "uploaded") result.uploaded += 1;
      else result.alreadyPresent += 1;
    }
    state = { ...state, cursors: state.pending.cursors, pending: null, lastSuccessAt: new Date(now).toISOString() };
    atomicJson(statePath, state);
    return result;
  } finally { release(); }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) { process.stdout.write(`${HELP}\n`); return; }
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--upload") args.upload = true;
    else if (["--repo", "--samples", "--state", "--gh"].includes(key)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
      args[key.slice(2)] = value;
    } else throw new Error(`unknown argument: ${key}`);
  }
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const agentDir = resolveSpeedIndexAgentDir(process.env, home) ?? join(home, ".rubato-pi", "agent");
  const root = join(agentDir, "speed-index");
  if (args.upload && process.env.RUBATO_SPEED_DATA_UPLOAD === "0") {
    process.stdout.write(`${JSON.stringify({ mode: "disabled", repo: args.repo })}\n`);
    return;
  }
  const result = syncSpeedData({ repo: args.repo, samplesDir: args.samples ?? join(root, "samples"),
    statePath: args.state ?? join(root, "github-sync.json"), upload: args.upload, api: githubApi(args.gh) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`Speed data sync: ${error.message}`); process.exitCode = 1; }
}
