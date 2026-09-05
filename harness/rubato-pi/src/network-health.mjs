import net from "node:net";
import { mad, median } from "./speed-index.mjs";
import { SPEED_INDEX_NETWORK_ROUTES } from "./speed-index-routes.mjs";

export const PROBE_INTERVAL_MS = 15_000;
export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_CLASSIFY_AFTER = 20;
export const PROBE_REFERENCE_WINDOW = 60;
export const RTT_FLOOR_MS = 20;
export const RTT_MAD_MULT = 6;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function probeTarget(origin) {
  if (typeof origin !== "string" || origin.length === 0) return undefined;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (LOOPBACK.has(url.hostname)) return undefined;
  const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  if (!Number.isFinite(port) || port <= 0) return undefined;
  return { host: url.hostname, port };
}

export function rttLimit(successfulRtts) {
  const center = median(successfulRtts);
  if (center === undefined) return undefined;
  const spread = mad(successfulRtts, center) ?? 0;
  return center + Math.max(RTT_FLOOR_MS, RTT_MAD_MULT * spread);
}

export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function isOutlier(probe, limit) {
  return !Number.isFinite(limit) || !Number.isFinite(probe?.rttMs) || probe.rttMs > limit;
}

export function classifyCallNetwork({
  probes = [],
  startMs,
  endMs,
  origin,
  intervalMs = PROBE_INTERVAL_MS,
} = {}) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { status: "unknown", source: "probe", reason: "invalid_window" };
  }
  const mine = probes.filter((probe) => probe.origin === origin);
  const history = mine.filter((probe) => probe.ok && probe.endMs <= startMs);
  if (history.length < PROBE_CLASSIFY_AFTER) {
    return { status: "unknown", source: "probe", reason: "insufficient_probes", probeCount: history.length };
  }
  const reference = history.slice(-PROBE_REFERENCE_WINDOW).map((probe) => probe.rttMs);
  const limit = rttLimit(reference);
  const prior = mine
    .filter((probe) => Number.isFinite(probe.endMs) && probe.endMs <= startMs)
    .sort((a, b) => a.endMs - b.endMs)
    .at(-1);
  if (!prior) {
    return { status: "unknown", source: "probe", reason: "missing_prior_probe", rttLimitMs: limit };
  }
  if (startMs - prior.endMs > intervalMs) {
    return { status: "unknown", source: "probe", reason: "stale_probe", rttMs: prior.rttMs, rttLimitMs: limit };
  }
  if (!prior.ok) {
    return { status: "degraded", source: "probe", reason: "probe_failure", rttMs: prior.rttMs, rttLimitMs: limit };
  }
  if (isOutlier(prior, limit)) {
    return { status: "degraded", source: "probe", reason: "rtt_outlier", rttMs: prior.rttMs, rttLimitMs: limit };
  }
  const during = mine.filter((probe) => probe.endMs > startMs && probe.endMs <= endMs);
  if (during.some((probe) => !probe.ok)) {
    return { status: "degraded", source: "probe", reason: "probe_failure", rttMs: prior.rttMs, rttLimitMs: limit };
  }
  const duringOutlier = during.find((probe) => isOutlier(probe, limit));
  if (duringOutlier) {
    return { status: "degraded", source: "probe", reason: "rtt_outlier", rttMs: duringOutlier.rttMs, rttLimitMs: limit };
  }
  const coverage = during.length
    ? during.slice().sort((a, b) => a.endMs - b.endMs).at(-1)
    : prior;
  if (endMs - coverage.endMs > intervalMs) {
    return { status: "unknown", source: "probe", reason: "stale_probe", rttMs: coverage.rttMs, rttLimitMs: limit };
  }
  return { status: "healthy", source: "probe", rttMs: coverage.rttMs, rttLimitMs: limit };
}

export function classifyProviderCall({
  providerId,
  startMs,
  endMs,
  serverDurationMs,
  probes,
  intervalMs = PROBE_INTERVAL_MS,
} = {}) {
  const route = SPEED_INDEX_NETWORK_ROUTES[providerId];
  if (!route) {
    return { status: "unknown", source: "undeclared", reason: "no_route" };
  }
  if (route.kind === "server_duration") {
    if (Number.isFinite(serverDurationMs) && serverDurationMs > 0) {
      return { status: "healthy", source: "server_duration", serverDurationMs };
    }
    return { status: "unknown", source: "server_duration", reason: "missing_server_duration" };
  }
  if (route.kind !== "probe") {
    return { status: "unknown", source: "undeclared", reason: route.reason ?? "unsupported" };
  }
  const target = probeTarget(route.origin);
  if (!target) {
    return { status: "unknown", source: "undeclared", reason: "unprobed_origin" };
  }
  return classifyCallNetwork({
    probes,
    startMs,
    endMs,
    origin: route.origin,
    intervalMs,
  });
}

export function tcpConnect({ host, port, timeoutMs = PROBE_TIMEOUT_MS, now = () => performance.now() } = {}) {
  return new Promise((resolve) => {
    const start = now();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      const rttMs = Math.max(0, now() - start);
      try { socket.destroy(); } catch {}
      resolve({ ok, rttMs });
    };
    const socket = net.connect({ host, port });
    // Probe sockets are diagnostics. DNS/connect stalls must never keep an RPC
    // process alive or delay a child-process shutdown.
    socket.unref?.();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function createNetworkHealth({
  routes = SPEED_INDEX_NETWORK_ROUTES,
  now = () => performance.now(),
  connect = tcpConnect,
  intervalMs = PROBE_INTERVAL_MS,
  timeoutMs = PROBE_TIMEOUT_MS,
  autostart = false,
} = {}) {
  const probes = [];
  const timers = [];
  let stopped = false;
  let started = false;

  const origins = [...new Set(
    Object.values(routes)
      .filter((route) => route.kind === "probe" && probeTarget(route.origin))
      .map((route) => route.origin),
  )];

  async function probeOrigin(origin) {
    const target = probeTarget(origin);
    if (!target || stopped) return undefined;
    const startMs = now();
    let result;
    try {
      result = await connect({ ...target, timeoutMs, now });
    } catch {
      result = { ok: false, rttMs: Math.max(0, now() - startMs) };
    }
    const endMs = now();
    const probe = {
      origin,
      startMs,
      endMs,
      ok: result.ok === true,
      rttMs: Number.isFinite(result.rttMs) ? result.rttMs : Math.max(0, endMs - startMs),
    };
    probes.push(probe);
    return probe;
  }

  async function warmup(origin) {
    // Sequential 20 connects could finish after the first user turn. Fire them
    // together so classifyCallNetwork has a window before that call ends.
    await Promise.all(Array.from({ length: PROBE_CLASSIFY_AFTER }, () => {
      if (stopped) return undefined;
      return probeOrigin(origin);
    }));
  }

  function start() {
    if (stopped || started) return;
    started = true;
    // 15s ticks alone need ~5 minutes before a call is classifiable.
    // Warm the window now so the first scoreable turn can paint Speed N.
    for (const origin of origins) {
      void warmup(origin).then(() => {
        if (stopped) return;
        const timer = setInterval(() => {
          if (stopped) return;
          probeOrigin(origin);
        }, intervalMs);
        timer.unref?.();
        timers.push(timer);
      });
    }
  }

  function stop() {
    stopped = true;
    started = false;
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
  }

  if (autostart) start();

  return {
    probes,
    origins,
    start,
    stop,
    probeOrigin,
    classify(fields) {
      return classifyProviderCall({ ...fields, probes, intervalMs });
    },
  };
}
