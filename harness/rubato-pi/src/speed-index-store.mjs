import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROCESS_STARTED_AT } from "./process-start.mjs";
import { createNetworkHealth } from "./network-health.mjs";
import { hasCursorExecResolved, resolveCallIdentity } from "./speed-index-identity.mjs";
import {
  LOCAL_ORIGIN,
  MATCHED_CAP,
  MIN_REFERENCE_CALLS,
  PROVISIONAL_ORIGIN,
  SAMPLE_WINDOW_MS,
  SCOREABLE_TERMINALS,
  SPEED_INDEX_EPOCH,
  SPEED_INDEX_SCHEMA_VERSION,
  freezeBaseline,
  identityKey,
  isCalibrationCandidate,
  isScoreableSample,
  mergeBaselines,
  scoreGroup,
  validateBaseline,
} from "./speed-index.mjs";
import { normalizeProviderUsage } from "./measurement-recorder.mjs";
import { SPEED_CAPTURE_FIELDS, sanitizeCapture } from "./speed-index-capture.mjs";
import { SPEED_TIER_FIELDS, sanitizeSpeedTier } from "./speed-index-tier.mjs";
import { isSpeedTierKey, speedTierKey } from "./speed-index-tier.mjs";
import {
  SPEED_V2_PROFILE_FILE, scoreSpeedV2, speedV2Identity, speedV2IdentityKey, validateSpeedV2Profile,
} from "./speed-index-v2.mjs";
export { SPEED_CAPTURE_VERSION, SPEED_CAPTURE_MILESTONES } from "./speed-index-capture.mjs";

const CAPTURE_FIELDS = new Set([...SPEED_CAPTURE_FIELDS, ...SPEED_TIER_FIELDS]);

export const SAMPLE_FIELDS = Object.freeze([
  "schemaVersion",
  "epoch",
  "at",
  "provider",
  "model",
  "effort",
  "effortSource",
  "reasoning",
  "streamKind",
  "clientDurationMs",
  "serverDurationMs",
  "networkStatus",
  "networkSource",
  "networkRttMs",
  "newInputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "fullInputTokens",
  "cacheHitRate",
  "terminalStatus",
  "processId",
  "exclusion",
  ...CAPTURE_FIELDS,
]);

export const BASELINE_FILE = "baseline-v1.json";

/**
 * The bundled provisional baseline ships with the harness so Speed works on a
 * fresh installation. It is read once at construction — never during render —
 * and is superseded the moment a valid local v1 exists.
 */
export const BUNDLED_BASELINE_PATH = fileURLToPath(new URL("../data/speed-index-baseline-v0.json", import.meta.url));

let bundledCache;

export function loadBundledBaseline(path = BUNDLED_BASELINE_PATH) {
  if (bundledCache && bundledCache.path === path) return bundledCache.value;
  let value;
  try {
    value = validateBaseline(JSON.parse(readFileSync(path, "utf8")), { origin: PROVISIONAL_ORIGIN });
  } catch {
    value = undefined;
  }
  bundledCache = { path, value };
  return value;
}

const FORBIDDEN = Object.freeze([
  "prompt", "prompts", "messages", "cwd", "session", "sessionId", "body",
  "text", "content", "systemPrompt", "result", "results", "transcript",
]);

const AGENT_DIR_ENV_NAMES = Object.freeze([
  "RUBATO_PI_CODING_AGENT_DIR",
  "SENPI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
]);

export function resolveSpeedIndexAgentDir(env = process.env, home = homedir()) {
  for (const name of AGENT_DIR_ENV_NAMES) {
    const value = env?.[name];
    if (typeof value === "string" && value.length > 0) {
      return value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
    }
  }
  return undefined;
}

export function speedIndexBaselinePath(agentDir) {
  return join(agentDir, "speed-index", BASELINE_FILE);
}

export function writeBaselineExclusive(path, baseline) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(fd, `${JSON.stringify(baseline)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { chmodSync(temp, 0o600); } catch {}
    try {
      linkSync(temp, path);
    } catch (error) {
      try { unlinkSync(temp); } catch {}
      if (error.code === "EEXIST") return { ok: false, reason: "exists" };
      throw error;
    }
    try { unlinkSync(temp); } catch {}
    return { ok: true };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temp); } catch {}
    if (error.code === "EEXIST") return { ok: false, reason: "exists" };
    throw error;
  }
}

export function loadBaseline(path) {
  try {
    return validateBaseline(JSON.parse(readFileSync(path, "utf8")), { origin: LOCAL_ORIGIN });
  } catch {
    return undefined;
  }
}

export function sanitizeSample(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  for (const key of FORBIDDEN) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      // Presence is stripped rather than poisoning neighbors. The sample may
      // still be kept if the remaining allowlist is complete.
    }
  }
  const sample = {};
  for (const key of SAMPLE_FIELDS) {
    if (CAPTURE_FIELDS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (value === undefined) continue;
    if (key === "reasoningTokens" && (!Number.isFinite(value) || value < 0)) continue;
    sample[key] = value;
  }
  Object.assign(sample, sanitizeCapture(raw));
  Object.assign(sample, sanitizeSpeedTier(raw));
  if (sample.schemaVersion !== SPEED_INDEX_SCHEMA_VERSION) return undefined;
  if (sample.epoch !== SPEED_INDEX_EPOCH) return undefined;
  if (typeof sample.at !== "string") return undefined;
  return sample;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return sanitizeSample(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function processId({ startedAt, pid, nonce }) {
  return `${startedAt}-${pid}-${nonce}`;
}

export function sampleFileName({ startedAt, pid, nonce }) {
  return `${startedAt}-${pid}-${nonce}.jsonl`;
}

function startedAtFromName(name) {
  const match = String(name).match(/^(\d+)-\d+-[0-9a-f]+\.jsonl$/i);
  return match ? Number(match[1]) : undefined;
}

function shouldAdoptIdentity(sample) {
  return sample.streamKind === "main"
    && !sample.exclusion
    && sample.effort != null
    && sample.effort !== ""
    && sample.effortSource !== "unknown"
    && SCOREABLE_TERMINALS.includes(sample.terminalStatus);
}

function identityFromSample(sample) {
  return {
    provider: sample.provider,
    model: sample.model,
    effort: sample.effort,
    effortSource: sample.effortSource,
    ...sanitizeSpeedTier(sample),
  };
}

// Historical untagged groups keep their key, but newly observed tiers never
// pool in either the transitional legacy display or the new calculator.
function storeIdentityKey(sample) {
  const tier = speedTierKey(sample);
  return `${identityKey(sample)}${tier === "unobserved" ? "" : `\0${tier}`}`;
}

function positiveMs(...candidates) {
  for (const value of candidates) {
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export function createSpeedIndexStore({
  agentDir,
  now = () => Date.now(),
  pid = process.pid,
  startedAt = PROCESS_STARTED_AT,
  nonce = randomBytes(4).toString("hex"),
  networkHealth,
  autostartProbes = false,
  probesEnabled = true,
  tailMs = 30_000,
  windowMs = SAMPLE_WINDOW_MS,
  cap = MATCHED_CAP,
  bundledBaselinePath = BUNDLED_BASELINE_PATH,
  deliveryProfile,
} = {}) {
  const root = agentDir ? join(agentDir, "speed-index") : undefined;
  const dir = root ? join(root, "samples") : undefined;
  const baselinePath = root ? join(root, BASELINE_FILE) : undefined;
  const ownName = sampleFileName({ startedAt, pid, nonce });
  const ownPath = dir ? join(dir, ownName) : undefined;
  const ownProcessId = processId({ startedAt, pid, nonce });
  const profilePath = root ? join(root, SPEED_V2_PROFILE_FILE) : undefined;
  // Registration is explicit. An absent new profile keeps the old display for
  // the whole process; a present but invalid one fails closed, never falls back
  // per model to a differently defined number.
  const deliveryMode = deliveryProfile !== undefined || Boolean(profilePath && existsSync(profilePath));
  let profile = deliveryProfile;
  if (profile === undefined && deliveryMode) {
    try { profile = JSON.parse(readFileSync(profilePath, "utf8")); } catch { profile = null; }
  }
  profile = validateSpeedV2Profile(profile);
  const deliveryOwn = [];
  let deliveryHistory = [];
  let deliveryRevision = 0;
  let deliveryLoaded = !deliveryMode || !dir;
  let deliveryLoading;
  let deliveryLoadSeq = 0;
  let deliveryAppliedSeq = 0;
  let lastDeliveryLoad = -Infinity;
  let expiryTimer;
  let stopped = false;
  const health = networkHealth ?? createNetworkHealth({ autostart: false });
  const groups = new Map();
  const diagnostics = [];
  const calibration = [];
  // Live scoring reads only this map: samples observed by this process since the
  // current session started. History feeds calibration, never the footer score.
  const sessionGroups = new Map();
  let activeIdentity;
  let localBaseline;
  let bundledBaseline;
  let cached;
  let lastTailAt = 0;
  const fileSizes = new Map();
  const scoreListeners = new Set();

  function notifyScore(store) {
    if (scoreListeners.size === 0) return;
    let result;
    try { result = store.getCachedScore(); } catch { return; }
    for (const listener of scoreListeners) {
      try { listener(result); } catch { /* a GUI subscriber must not break recording */ }
    }
  }

  function baselineOf() {
    return mergeBaselines(localBaseline, bundledBaseline);
  }

  function remember(sample, { source } = {}) {
    if (source === "own" && (shouldAdoptIdentity(sample) ||
      (deliveryMode && sample.streamKind === "main" && (!sample.exclusion || sample.exclusion === "aborted") &&
        sample.effort && sample.effortSource !== "unknown"))) {
      activeIdentity = identityFromSample(sample);
    }
    cached = undefined;
    if (deliveryMode && source === "own" && sample.captureVersion === 1) {
      deliveryOwn.push(sample);
      const cutoff = now() - windowMs;
      while (deliveryOwn.length && Date.parse(deliveryOwn[0].at) < cutoff) deliveryOwn.shift();
      deliveryRevision += 1;
    }
    if (source === "own" && isScoreableSample(sample)) {
      const key = storeIdentityKey(sample);
      const live = sessionGroups.get(key) ?? [];
      live.push(sample);
      sessionGroups.set(key, live.slice(-cap));
    }
    // Clean reference candidates keep accumulating while v0 is active; only a
    // published local v1 stops calibration.
    if (!localBaseline && isCalibrationCandidate(sample)) {
      calibration.push(sample);
    }
    if (isScoreableSample(sample)) {
      const key = storeIdentityKey(sample);
      const rows = groups.get(key) ?? [];
      rows.push(sample);
      rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      groups.set(key, rows.slice(0, cap));
    } else {
      diagnostics.push(sample);
      if (diagnostics.length > 500) diagnostics.shift();
    }
  }

  function tryFreeze() {
    if (localBaseline?.status === "frozen") return localBaseline;
    if (calibration.length < MIN_REFERENCE_CALLS) return undefined;
    const frozen = freezeBaseline(calibration, { now });
    if (frozen.status !== "frozen") return undefined;
    if (baselinePath) {
      const written = writeBaselineExclusive(baselinePath, frozen);
      if (!written.ok) {
        const loaded = loadBaseline(baselinePath);
        if (loaded) {
          localBaseline = loaded;
          cached = undefined;
          return localBaseline;
        }
        return undefined;
      }
    }
    localBaseline = frozen;
    cached = undefined;
    return localBaseline;
  }

  function pruneExpired() {
    if (!dir || !existsSync(dir)) return;
    const cutoff = now() - windowMs;
    let names;
    // A directory we cannot list is not a directory we may prune or treat as empty.
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const started = startedAtFromName(name);
      const path = join(dir, name);
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch { continue; }
      const stamp = Number.isFinite(started) ? started : mtime;
      if (stamp < cutoff && mtime < cutoff) {
        try { unlinkSync(path); } catch {}
      }
    }
  }

  function ingestFile(path, from = 0) {
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { return 0; }
    const slice = from > 0 ? text.slice(from) : text;
    const lines = slice.split("\n");
    // A torn last line has no trailing newline; skip it until it completes.
    const complete = slice.endsWith("\n") ? lines : lines.slice(0, -1);
    for (const line of complete) {
      const sample = parseLine(line);
      if (sample) remember(sample, { source: "history" });
    }
    return text.length;
  }

  function loadAll() {
    if (!dir || !existsSync(dir)) return;
    const cutoff = now() - windowMs;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch { continue; }
      const started = startedAtFromName(name);
      if ((Number.isFinite(started) ? started : mtime) < cutoff && mtime < cutoff) continue;
      fileSizes.set(path, ingestFile(path));
    }
    lastTailAt = now();
  }

  function tail({ force = false } = {}) {
    if (!dir) return;
    const t = now();
    if (!force && t - lastTailAt < tailMs) return;
    lastTailAt = t;
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      if (path === ownPath) continue;
      let size = 0;
      try { size = statSync(path).size; } catch { continue; }
      const prev = fileSizes.get(path) ?? 0;
      if (size < prev) {
        fileSizes.set(path, ingestFile(path));
      } else if (size > prev) {
        fileSizes.set(path, ingestFile(path, prev));
      }
    }
    tryFreeze();
  }

  function persist(sample) {
    if (!ownPath) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(sample)}\n`;
    let fd;
    try {
      fd = openSync(ownPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
      writeSync(fd, line);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    try { chmodSync(ownPath, 0o600); } catch {}
  }

  /**
   * A missing directory is an empty history. Any other readdir failure is not
   * "no samples": stay unloaded so the next attempt retries instead of scoring
   * an empty basket as if it were the truth.
   */
  function deliveryFileNames() {
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      return error?.code === "ENOENT" ? [] : undefined;
    }
    const cutoff = now() - windowMs;
    const eligible = [];
    for (const name of names) {
      if (!/^\d+-\d+-[0-9a-f]+\.jsonl$/i.test(name) || join(dir, name) === ownPath) continue;
      // mtime is never older than the rows inside, so an out-of-window file
      // cannot contribute to the window.
      try { if (statSync(join(dir, name)).mtimeMs < cutoff) continue; } catch { continue; }
      eligible.push(name);
    }
    return eligible;
  }

  function acceptDeliveryText(text, rows) {
    // No partial-tail ingestion. Each refresh replaces this snapshot, so
    // retries, truncated files and multibyte cursor offsets cannot double
    // observations. Own records are kept separately and their file skipped.
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    const cutoff = now() - windowMs;
    for (const line of complete.split("\n")) {
      const sample = parseLine(line);
      if (sample?.captureVersion === 1 && Date.parse(sample.at) >= cutoff) rows.push(sample);
    }
  }

  function applyDeliveryRows(rows, seq) {
    if (seq < deliveryAppliedSeq) return;
    deliveryAppliedSeq = seq;
    deliveryHistory = rows;
    deliveryLoaded = true;
    deliveryRevision += 1;
    cached = undefined;
    notifyScore(store);
  }

  /**
   * The provider boundary stamps one call with one score. It must not freeze the
   * transient "still reading history" answer, so that path may read history now.
   * Once per process, and only when a profile is registered.
   */
  function loadDeliveryHistorySync() {
    if (!deliveryMode || !dir || deliveryLoaded) return;
    const seq = ++deliveryLoadSeq;
    const names = deliveryFileNames();
    if (names === undefined) return;
    const rows = [];
    for (const name of names) {
      try { acceptDeliveryText(readFileSync(join(dir, name), "utf8"), rows); } catch { continue; }
    }
    applyDeliveryRows(rows, seq);
  }

  async function refreshDeliveryHistory({ force = false } = {}) {
    if (!deliveryMode || !dir || stopped) return;
    if (deliveryLoading) return deliveryLoading;
    if (!force && now() - lastDeliveryLoad < tailMs) return;
    lastDeliveryLoad = now();
    const seq = ++deliveryLoadSeq;
    deliveryLoading = (async () => {
      const names = deliveryFileNames();
      if (names === undefined) return;
      const rows = [];
      for (const name of names) {
        let text;
        try { text = await readFile(join(dir, name), "utf8"); } catch { continue; }
        acceptDeliveryText(text, rows);
      }
      if (stopped) return;
      applyDeliveryRows(rows, seq);
    })().finally(() => { deliveryLoading = undefined; });
    return deliveryLoading;
  }

  if (baselinePath) localBaseline = loadBaseline(baselinePath);
  bundledBaseline = loadBundledBaseline(bundledBaselinePath);
  pruneExpired();
  // History is calibration-only. The footer scores this process's own
  // samples, so reading every sample file here blocked TUI startup on
  // machines with a large speed-index dir (measured: 1.3s / 7.8MB).
  let historyLoaded = false;
  function ensureHistory() {
    if (historyLoaded) return;
    historyLoaded = true;
    loadAll();
    tryFreeze();
  }
  if (autostartProbes) health.start();

  function samplesFor(identity) {
    if (!identity) {
      return [...sessionGroups.values()].flat();
    }
    return sessionGroups.get(storeIdentityKey(identity)) ?? [];
  }

  function calibrationProgress() {
    if (localBaseline?.status === "frozen") {
      return {
        status: "frozen",
        count: localBaseline.calibration?.count ?? MIN_REFERENCE_CALLS,
        required: MIN_REFERENCE_CALLS,
      };
    }
    return { status: "calibrating", count: calibration.length, required: MIN_REFERENCE_CALLS };
  }

  const store = {
    dir,
    root,
    baselinePath,
    ownPath,
    processId: ownProcessId,
    deliveryMode,
    deliveryProfilePath: profilePath,
    getDeliveryProfile: () => profile,
    refreshDeliveryHistory,
    ready: () => deliveryLoading ?? Promise.resolve(),
    networkHealth: health,
    get groups() {
      ensureHistory();
      return groups;
    },
    sessionGroups,
    diagnostics,
    get calibration() {
      ensureHistory();
      return calibration;
    },
    persistDisabled: !ownPath,
    record(raw) {
      const sample = sanitizeSample(raw);
      if (!sample) return undefined;
      remember(sample, { source: "own" });
      persist(sample);
      tryFreeze();
      notifyScore(this);
      void refreshDeliveryHistory();
      return sample;
    },
    setBaseline(next) {
      localBaseline = next;
      cached = undefined;
    },
    getBaseline() {
      return baselineOf();
    },
    getLocalBaseline() {
      return localBaseline;
    },
    getBundledBaseline() {
      return bundledBaseline;
    },
    baselineOrigin() {
      return baselineOf()?.origin ?? (baselineOf() ? LOCAL_ORIGIN : undefined);
    },
    getCalibrationProgress() {
      return calibrationProgress();
    },
    lastIdentity() {
      return activeIdentity;
    },
    activeIdentity() {
      return activeIdentity;
    },
    setActiveIdentity(identity) {
      activeIdentity = identity ? { ...identity } : undefined;
      cached = undefined;
      notifyScore(this);
    },
    /**
     * Model selection changes which identity the footer scores. Samples already
     * observed in this session stay put, so switching back restores that score
     * without re-measuring.
     */
    clearActiveIdentity() {
      activeIdentity = undefined;
      cached = undefined;
      notifyScore(this);
    },
    /** A new or switched session starts from zero live samples. */
    resetSession() {
      sessionGroups.clear();
      activeIdentity = undefined;
      cached = undefined;
      notifyScore(this);
    },
    refresh() {
      // Do not ingest history here. session_start calls refresh() before the
      // TUI paints; tailing sample files would put the 1.3s read back on boot.
      cached = undefined;
      void refreshDeliveryHistory();
    },
    tail(options) {
      ensureHistory();
      return tail(options);
    },
    getCachedScore(identity = activeIdentity, { blockOnLoad = false } = {}) {
      if (deliveryMode) {
        if (!deliveryLoaded && blockOnLoad) loadDeliveryHistorySync();
        if (!deliveryLoaded) return { metricVersion: 2, status: "unavailable", reason: "history_loading", score: undefined, matched: 0, valid: 0, coverage: 0 };
        const target = isSpeedTierKey(identity?.tierKey)
          ? { provider: identity.provider, model: identity.model, effort: identity.effort, tierKey: identity.tierKey }
          : speedV2Identity(identity);
        const key = `v2:${speedV2IdentityKey(target)}:${deliveryRevision}`;
        const clock = now();
        if (cached?.key === key && clock < cached.expiresAt) return cached.result;
        const rows = [...deliveryHistory, ...deliveryOwn];
        const result = scoreSpeedV2(rows, target, profile, { now: clock });
        let expiresAt = Infinity;
        for (const row of rows) {
          const time = Date.parse(row.at);
          const expiry = time >= clock ? time + 1 : time + windowMs + 1;
          if (expiry > clock) expiresAt = Math.min(expiresAt, expiry);
        }
        cached = { key, result, expiresAt };
        clearTimeout(expiryTimer);
        if (Number.isFinite(expiresAt)) {
          expiryTimer = setTimeout(() => { cached = undefined; notifyScore(store); },
            Math.min(2_147_483_647, Math.max(1, expiresAt - clock)));
          expiryTimer.unref?.();
        }
        return result;
      }
      const baseline = baselineOf();
      const key = `${storeIdentityKey(identity)}\0${baseline?.hash ?? ""}\0${samplesFor(identity).length}`;
      if (cached && cached.key === key) return cached.result;
      // No windowMs: current-session samples are already the scope.
      const result = { metricVersion: 1, ...scoreGroup(samplesFor(identity), identity, baseline, { now: now(), cap }) };
      cached = { key, result };
      return result;
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      scoreListeners.add(listener);
      return () => scoreListeners.delete(listener);
    },
    startProbes() {
      if (probesEnabled) health.start();
    },
    stop() {
      stopped = true;
      clearTimeout(expiryTimer);
      health.stop();
    },
    _ingestFile: ingestFile,
    _tail: tail,
    _loadAll: ensureHistory,
  };
  void refreshDeliveryHistory();
  return store;
}

let singleton;

export function speedIndexStore(env = process.env) {
  if (env?.RUBATO_SPEED_INDEX === "0") return undefined;
  // node:test inherits the developer agent dir. Do not write samples or open
  // TCP probes unless the test passed an isolated env.
  if (process.env.NODE_TEST_CONTEXT && env === process.env) return undefined;
  if (singleton && singleton._env === env) return singleton;
  const agentDir = resolveSpeedIndexAgentDir(env);
  if (!agentDir) return undefined;
  const inNodeTest = Boolean(process.env.NODE_TEST_CONTEXT);
  singleton = createSpeedIndexStore({
    agentDir,
    // The statusline is a reader and may load in RPC processes that never make
    // model calls. Provider registration starts probes lazily instead.
    autostartProbes: false,
    probesEnabled: !inNodeTest && env?.RUBATO_SPEED_INDEX_PROBE !== "0",
  });
  singleton._env = env;
  return singleton;
}

export function recordSpeedIndexCall({
  store,
  model,
  options = {},
  state,
  message,
  terminalStatus,
  endedAtMs,
  isCursorExecResolved,
  aborted = false,
}) {
  if (!store || typeof store.record !== "function") return undefined;
  const identity = state?.identity ?? resolveCallIdentity(model, options);
  const usage = normalizeProviderUsage(message?.providerUsage ?? message?.usage);
  const end = endedAtMs ?? state?.monotonic?.() ?? performance.now();
  const clientDurationMs = Number.isFinite(state?.sentAtMs) ? end - state.sentAtMs : undefined;
  const streamKind = options.streamKind === "main" ? "main" : (typeof options.streamKind === "string" ? options.streamKind : "auxiliary");
  const exec = hasCursorExecResolved(message, isCursorExecResolved);
  const network = store.networkHealth?.classify?.({
    providerId: identity.provider,
    startMs: state?.sentAtMs,
    endMs: end,
    serverDurationMs: message?.timing?.serverDurationMs ?? message?.serverDurationMs,
  }) ?? { status: "unknown", source: "undeclared", reason: "no_classifier" };

  const exclusion = exec
    ? "cursor_exec_resolved"
    : aborted
      ? "aborted"
      : identity.effortSource === "unknown" || identity.effort == null
        ? "unknown_effort"
        : streamKind !== "main"
          ? "auxiliary_stream"
          : undefined;

  const sample = {
    schemaVersion: SPEED_INDEX_SCHEMA_VERSION,
    epoch: SPEED_INDEX_EPOCH,
    at: new Date(state?.sentAtWallMs ?? Date.now()).toISOString(),
    provider: identity.provider,
    model: identity.model,
    effort: identity.effort,
    effortSource: identity.effortSource,
    reasoning: identity.reasoning,
    streamKind,
    ...sanitizeCapture(state?.speedCapture),
    ...sanitizeSpeedTier(state?.speedTier),
    ...(Number.isFinite(clientDurationMs) ? { clientDurationMs } : {}),
    ...(() => {
      const serverDurationMs = network.source === "server_duration"
        ? positiveMs(network.serverDurationMs, message?.timing?.serverDurationMs, message?.serverDurationMs)
        : undefined;
      return serverDurationMs !== undefined ? { serverDurationMs } : {};
    })(),
    networkStatus: network.status,
    networkSource: network.source,
    ...(Number.isFinite(network.rttMs) ? { networkRttMs: network.rttMs } : {}),
    ...(Number.isFinite(usage?.newInputTokens) ? { newInputTokens: usage.newInputTokens } : {}),
    ...(Number.isFinite(usage?.cacheReadTokens) ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(Number.isFinite(usage?.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(Number.isFinite(usage?.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
    ...(Number.isFinite(usage?.reasoningTokens) ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(Number.isFinite(usage?.fullInputTokens) ? { fullInputTokens: usage.fullInputTokens } : {}),
    ...(Number.isFinite(usage?.cacheHitRate) ? { cacheHitRate: usage.cacheHitRate } : {}),
    terminalStatus,
    processId: store.processId,
    ...(exclusion ? { exclusion } : {}),
  };
  return store.record(sample);
}
