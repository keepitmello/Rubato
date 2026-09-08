import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const OPENCODEX_VERSION = "2.48.0";
const PACKAGE = `@bitkyc08/opencodex@${OPENCODEX_VERSION}`;
const PACKAGE_NAME = "@bitkyc08/opencodex";
const OWNERSHIP_MARKER = "rubato-opencodex.json";

async function exists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

function fromPath(name, env) {
  for (const entry of (env.PATH || "").split(delimiter)) {
    const candidate = join(entry, process.platform === "win32" ? `${name}.cmd` : name);
    try {
      const result = spawnSync(candidate, ["--version"], { encoding: "utf8", env, timeout: 10_000 });
      if (!result.error && result.status === 0) return { path: candidate, output: `${result.stdout}${result.stderr}` };
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

function versionOf(path, env) {
  const result = spawnSync(path, ["--version"], { encoding: "utf8", env, timeout: 10_000 });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}${result.stderr}`.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
}

function assertManagedTarget(codexHome, targetRoot) {
  const managedRoot = resolve(codexHome, "rubato-codex", "dependencies");
  const relativeTarget = relative(managedRoot, resolve(targetRoot));
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget) || relativeTarget !== "opencodex") {
    throw new Error("OpenCodex target must be the managed CODEX_HOME dependency path");
  }
}

export function planOpenCodexSetup(options) {
  const selectedProviders = options.selectedProviders || [];
  const env = options.env || process.env;
  const codexHome = resolve(options.codexHome);
  const targetRoot = resolve(options.targetRoot || join(codexHome, "rubato-codex", "dependencies", "opencodex"));
  assertManagedTarget(codexHome, targetRoot);
  if (!selectedProviders.length) return { action: "skip", reason: "native-codex-only", selectedProviders, targetRoot, codexHome };
  const explicit = options.opencodexPath ? resolve(options.opencodexPath) : null;
  const managedCommand = join(targetRoot, "node_modules", ".bin", process.platform === "win32" ? "ocx.cmd" : "ocx");
  const managedVersion = explicit ? null : versionOf(managedCommand, env);
  const pathMatch = explicit || managedVersion === OPENCODEX_VERSION ? null : fromPath("ocx", env);
  const discovered = explicit
    ? { path: explicit, managed: false }
    : managedVersion === OPENCODEX_VERSION
      ? { path: managedCommand, managed: true }
      : pathMatch ? { ...pathMatch, managed: false } : null;
  const version = discovered ? versionOf(discovered.path, env) : null;
  if (version === OPENCODEX_VERSION) {
    return { action: "use-existing", selectedProviders, command: discovered.path, version, targetRoot, codexHome, authentication: "not-verified", managed: discovered.managed };
  }
  return {
    action: "install-private",
    selectedProviders,
    targetRoot,
    codexHome,
    command: managedCommand,
    version: OPENCODEX_VERSION,
    package: PACKAGE,
    foundVersion: version,
    authentication: "user-completion-may-be-required",
  };
}

async function defaultInstall(plan, next, env) {
  const npm = env.RUBATO_CODEX_NPM || fromPath("npm", env)?.path;
  if (!npm) throw new Error("npm is required to install the private OpenCodex dependency");
  const result = spawnSync(npm, ["install", "--prefix", next, "--no-save", "--no-audit", "--no-fund", plan.package], {
    encoding: "utf8",
    env: { ...env, CI: "1", npm_config_yes: "true" },
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`OpenCodex private install failed${detail ? `: ${detail}` : ""}`);
  }
}

export async function applyOpenCodexSetup(plan, options = {}) {
  if (options.dryRun) return { ...plan, status: plan.action === "skip" ? "skipped" : "planned", managed: Boolean(plan.managed) };
  if (plan.action !== "install-private") return { ...plan, status: plan.action === "skip" ? "skipped" : "ready", managed: Boolean(plan.managed) };
  await mkdir(dirname(plan.targetRoot), { recursive: true });
  const next = await mkdtemp(join(dirname(plan.targetRoot), `${plan.targetRoot.split(/[\\/]/).pop()}.next-`));
  const previous = `${plan.targetRoot}.previous-${randomUUID()}`;
  try {
    await (options.install || defaultInstall)(plan, next, options.env || process.env);
    const manifest = JSON.parse(await readFile(join(next, "node_modules", "@bitkyc08", "opencodex", "package.json"), "utf8"));
    if (manifest.version !== OPENCODEX_VERSION) throw new Error(`OpenCodex install produced ${manifest.version || "an unknown version"}, expected ${OPENCODEX_VERSION}`);
    await writeFile(join(next, OWNERSHIP_MARKER), `${JSON.stringify({ version: 1, packageName: PACKAGE_NAME, installedVersion: manifest.version }, null, 2)}\n`);
    if (await exists(plan.targetRoot)) {
      const currentManifest = JSON.parse(await readFile(join(plan.targetRoot, "node_modules", "@bitkyc08", "opencodex", "package.json"), "utf8"));
      let marker;
      try { marker = JSON.parse(await readFile(join(plan.targetRoot, OWNERSHIP_MARKER), "utf8")); } catch { throw new Error(`refusing to replace unowned OpenCodex target at ${plan.targetRoot}`); }
      if (marker.version !== 1 || marker.packageName !== PACKAGE_NAME || marker.installedVersion !== currentManifest.version) {
        throw new Error(`refusing to replace unowned OpenCodex target at ${plan.targetRoot}`);
      }
      await rename(plan.targetRoot, previous);
    }
    try {
      await rename(next, plan.targetRoot);
    } catch (error) {
      if (await exists(previous)) await rename(previous, plan.targetRoot);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
    return { ...plan, status: "installed", managed: true };
  } catch (error) {
    await rm(next, { recursive: true, force: true });
    throw error;
  }
}

export async function removeManagedOpenCodex(record) {
  if (!record?.managed) return;
  assertManagedTarget(record.codexHome, record.targetRoot);
  const manifestPath = join(record.targetRoot, "node_modules", "@bitkyc08", "opencodex", "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== record.version) throw new Error(`refusing to remove modified private OpenCodex at ${record.targetRoot}`);
  await rm(record.targetRoot, { recursive: true, force: true });
}

function defaultProviderRunner(command, providerId, env) {
  const result = spawnSync(command, ["provider", "add", providerId, "--json"], { encoding: "utf8", env, timeout: 20_000 });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`OpenCodex provider registration failed for ${providerId}${detail ? `: ${detail}` : ""}`);
  }
}

export async function registerOpenCodexProviders(setup, catalog, options = {}) {
  if (!setup?.selectedProviders?.length) return { status: "native-codex-only", providers: [], nextSteps: [] };
  const configured = new Set((catalog?.providers || []).filter((provider) => provider.configured).map((provider) => provider.id));
  const missing = setup.selectedProviders.filter((id) => !configured.has(id));
  const env = options.env || process.env;
  const runner = options.runner || defaultProviderRunner;
  for (const providerId of missing) await runner(setup.command, providerId, env);
  return {
    status: "authentication-pending",
    providers: setup.selectedProviders.map((id) => ({ id, registration: missing.includes(id) ? "registered" : "current", authentication: "pending-verification" })),
    nextSteps: [
      ...setup.selectedProviders.map((id) => `${setup.command} login ${id}`),
    ],
  };
}

function defaultRosterRunner(command, roster, env) {
  const result = spawnSync(command, ["agent", "subagents", "set", roster.join(","), "--json"], { encoding: "utf8", env, timeout: 20_000 });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`OpenCodex roster setup failed${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Provider preference inside the roster. Direct providers come before proxied ones so a
 * sub-agent spends the account we authenticated rather than a resold seat, and the picker's
 * top band ends up grouped by provider instead of interleaved.
 */
const ROSTER_PROVIDER_RANK = Object.freeze({ anthropic: 0, xai: 1, cursor: 2, kiro: 3 });

/**
 * Roles the roster fills, in priority order. Every slot is a ROUTED model on purpose.
 *
 * Codex offers native ChatGPT models as spawn candidates whether or not they are listed
 * here (clearing the roster leaves `gpt-*` as the advertised set), so spending a slot on
 * `gpt-5.6-sol` buys nothing and costs one of the five that only a routed model can use.
 */
const ROSTER_ROLES = Object.freeze([
  { suffix: "/claude-opus-5", pattern: /opus/i },
  { suffix: "/claude-fable-5-1", pattern: /fable/i },
  { suffix: "/grok-4.6", pattern: /grok/i },
  { suffix: "/claude-sonnet-5", pattern: /sonnet/i },
  { suffix: null, pattern: /gemini.*flash|flash.*gemini/i },
]);

const MAX_ROSTER_MODELS = 5;

export async function configureOpenCodexRoster(setup, catalog, options = {}) {
  if (!setup?.selectedProviders?.length) return { status: "native-codex-only", models: [] };
  if (options.preserveExisting && catalog?.roster?.length) return { status: "preserved", models: catalog.roster };
  const selected = new Set(setup.selectedProviders);
  const rank = (id) => (Object.hasOwn(ROSTER_PROVIDER_RANK, id) ? ROSTER_PROVIDER_RANK[id] : Number.MAX_SAFE_INTEGER);
  const routed = (catalog?.providers || [])
    .filter((provider) => selected.has(provider.id))
    .slice()
    .sort((left, right) => rank(left.id) - rank(right.id) || left.id.localeCompare(right.id))
    .flatMap((provider) => provider.models || []);
  // One model answers at most one role: without this a single `grok-4.6` would win both the
  // grok slot and any later pattern it happens to match, silently shrinking the roster.
  const taken = new Set();
  const external = [];
  for (const { suffix, pattern } of ROSTER_ROLES) {
    if (external.length >= MAX_ROSTER_MODELS) break;
    const hit = (suffix ? routed.find((model) => model.endsWith(suffix) && !taken.has(model)) : undefined)
      ?? routed.find((model) => pattern.test(model) && !taken.has(model));
    if (!hit) continue;
    taken.add(hit);
    external.push(hit);
  }
  if (!external.length) {
    return { status: "pending-catalog", models: ["gpt-5.6-sol", "gpt-5.6-terra"], reason: "selected provider models are not available until authentication and catalog sync" };
  }
  // Group by provider for the picker's top band; roles keep their order inside a provider.
  const order = new Map(external.map((model, index) => [model, index]));
  const roster = external
    .slice()
    .sort((left, right) => rank(left.split("/")[0]) - rank(right.split("/")[0]) || order.get(left) - order.get(right))
    .slice(0, MAX_ROSTER_MODELS);
  await (options.runner || defaultRosterRunner)(setup.command, roster, options.env || process.env);
  return { status: "configured", models: roster };
}

function defaultMultiAgentRunner(command, env) {
  const result = spawnSync(command, ["v2", "keep-native-v1", "on"], { encoding: "utf8", env, timeout: 20_000 });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`OpenCodex multi-agent setup failed${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Let a native ChatGPT parent spawn a routed sub-agent.
 *
 * Codex's v2 multi-agent surface encrypts the child NEW_TASK body for the ChatGPT backend, so a
 * routed provider receives ciphertext it cannot read and the spawn dies with
 * `unreadable_encrypted_agent_task` — the model override is accepted, then the run fails.
 * `keep-native-v1` stamps ChatGPT-native catalog rows as v1 while routed rows stay v2, which is
 * the one supported way out (opencodex issue #92).
 *
 * The cost is real and belongs in the install record: a v1-stamped row is an eligible LEAF
 * worker, so a sub-agent under a native parent cannot itself delegate, and the v2-only tools
 * (`followup_task`, `interrupt_agent`, `list_agents`) are gone for that parent. Routed parents
 * keep the full v2 surface. Without this step the roster above is decoration: every model in it
 * is advertised and every spawn using one fails.
 */
export async function configureOpenCodexMultiAgent(setup, options = {}) {
  if (!setup?.selectedProviders?.length) return { status: "native-codex-only" };
  if (options.dryRun) return { status: "planned", keepNativeChatGptOnV1: true };
  await (options.runner || defaultMultiAgentRunner)(setup.command, options.env || process.env);
  return {
    status: "configured",
    keepNativeChatGptOnV1: true,
    tradeoff: "native ChatGPT parents use the v1 surface: sub-agents under them are leaf workers and lose followup_task/interrupt_agent/list_agents",
  };
}
