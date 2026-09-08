import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const MANIFEST_URL = new URL("../bundle-dependencies.json", import.meta.url);

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function executableOnPath(command, env) {
  const path = env.PATH || "";
  for (const entry of path.split(delimiter).filter(Boolean)) {
    try {
      await access(join(entry, command), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

async function pathKind(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function loadManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_URL, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.managed) || !Array.isArray(manifest.readiness)) {
    throw new Error("unsupported bundle dependency manifest");
  }
  return manifest;
}

async function managedLinkStep(spec, pluginRoot, codexHome, env) {
  const source = resolve(pluginRoot, spec.source);
  if (!inside(pluginRoot, source)) throw new Error(`${spec.id}: source escapes plugin root`);
  if (await pathKind(source) === "missing") {
    return { ...spec, action: "blocked", source, target: null, reason: "bundled source is missing" };
  }
  const canonicalRoot = await realpath(pluginRoot);
  const canonicalSource = await realpath(source);
  if (!inside(canonicalRoot, canonicalSource)) throw new Error(`${spec.id}: source symlink escapes plugin root`);
  if (await pathKind(canonicalSource) !== "file") {
    return { ...spec, action: "blocked", source, target: null, reason: "bundled source is not a file" };
  }

  const configuredDir = env[spec.targetEnv];
  const target = configuredDir
    ? join(resolve(configuredDir), "outpost")
    : resolve(codexHome, spec.defaultTarget);
  if (configuredDir && !isAbsolute(configuredDir)) throw new Error(`${spec.targetEnv} must be an absolute path`);
  const kind = await pathKind(target);
  if (kind === "missing") return { ...spec, action: "link", source: canonicalSource, target };
  if (kind === "symlink") {
    const current = resolve(dirname(target), await readlink(target));
    if (current === canonicalSource) return { ...spec, action: "current", source: canonicalSource, target };
  }
  return { ...spec, action: "conflict", source: canonicalSource, target, reason: "target already belongs to another installation" };
}

async function linkAction(target, source) {
  const kind = await pathKind(target);
  if (kind === "missing") return "link";
  if (kind === "symlink" && resolve(dirname(target), await readlink(target)) === source) return "current";
  return "conflict";
}

async function managedSetupStep(spec, pluginRoot, codexHome, home, env, platform) {
  if (spec.kind === "managed-link") return managedLinkStep(spec, pluginRoot, codexHome, env);
  if (spec.kind === "brew-cask") {
    if (!spec.platforms.includes(platform)) return { ...spec, action: "deferred", reason: `requires ${spec.platforms.join(" or ")}` };
    if (await executableOnPath("aside", env)) return { ...spec, action: "current" };
    if (!await executableOnPath("brew", env)) return { ...spec, action: "deferred", reason: "Homebrew is not installed" };
    return { ...spec, action: "install", argv: ["brew", "install", "--cask", spec.cask] };
  }
  const prefix = join(codexHome, "rubato-codex", "dependencies", spec.id);
  const binDir = resolve(env.RUBATO_CODEX_BIN_DIR || join(codexHome, "rubato-codex", "bin"));
  if (env.RUBATO_CODEX_BIN_DIR && !isAbsolute(env.RUBATO_CODEX_BIN_DIR)) throw new Error("RUBATO_CODEX_BIN_DIR must be an absolute path");
  if (spec.kind === "npm-prefix") {
    if (!await executableOnPath("npm", env)) return { ...spec, action: spec.required ? "blocked" : "deferred", reason: "npm is required to install public browser tools" };
    const links = await Promise.all(spec.binaries.map(async (binary) => {
      const source = join(prefix, "node_modules", ".bin", binary);
      return { binary, source, target: join(binDir, binary), action: await linkAction(join(binDir, binary), source) };
    }));
    let installed = true;
    for (const item of spec.packages) {
      const at = item.lastIndexOf("@");
      const name = item.slice(0, at);
      const version = item.slice(at + 1);
      try {
        const actual = JSON.parse(await readFile(join(prefix, "node_modules", name, "package.json"), "utf8"));
        if (actual.version !== version) installed = false;
      } catch { installed = false; }
    }
    const conflict = links.find((link) => link.action === "conflict");
    const marker = join(prefix, "rubato-dependencies.json");
    let owned = false;
    try {
      const record = JSON.parse(await readFile(marker, "utf8"));
      owned = record.version === 1 && Array.isArray(record.packages);
      installed = installed && owned && record.packages.join("\n") === spec.packages.join("\n");
    } catch { installed = false; }
    if (await pathKind(prefix) !== "missing" && !owned) return { ...spec, prefix, marker, links, action: "conflict", reason: `managed prefix is not owned: ${prefix}` };
    return { ...spec, prefix, marker, links, action: conflict ? "conflict" : installed && links.every((link) => link.action === "current") ? "current" : "install", reason: conflict ? `managed binary target already exists: ${conflict.target}` : undefined, argv: ["npm", "install", "--prefix", prefix, "--no-audit", "--no-fund", "--save-exact", ...spec.packages] };
  }
  if (spec.kind === "python-venv") {
    if (!await executableOnPath("python3", env)) return { ...spec, action: spec.required ? "blocked" : "deferred", reason: "python3 is required to create the insane-search managed environment" };
    const marker = join(prefix, "rubato-dependencies.json");
    const launcher = join(prefix, "bin", spec.binary);
    const target = join(binDir, spec.binary);
    let installed = false;
    let owned = false;
    try {
      const record = JSON.parse(await readFile(marker, "utf8"));
      owned = record.version === 1 && Array.isArray(record.packages);
      installed = owned && record.packages.join("\n") === spec.packages.join("\n");
    } catch {}
    if (await pathKind(prefix) !== "missing" && !owned) return { ...spec, prefix, marker, action: "conflict", reason: `managed prefix is not owned: ${prefix}` };
    return {
      ...spec,
      prefix,
      marker,
      launcher,
      skillRoot: join(pluginRoot, "skills", "insane-search"),
      link: { source: launcher, target, action: await linkAction(target, launcher) },
      action: (await linkAction(target, launcher)) === "conflict" ? "conflict" : installed && await linkAction(target, launcher) === "current" ? "current" : "install",
    };
  }
  throw new Error(`${spec.id}: unsupported managed dependency kind ${spec.kind}`);
}

async function readinessItem(spec, env, platform, pluginRoot) {
  if (Array.isArray(spec.platforms) && !spec.platforms.includes(platform)) {
    return { ...spec, status: "unavailable", reason: `requires ${spec.platforms.join(" or ")}` };
  }
  if (spec.kind === "source-tree") return { ...spec, status: "manual" };
  if (spec.source && await pathKind(resolve(pluginRoot, spec.source)) === "missing") {
    return { ...spec, status: "unavailable", reason: "bundled setup source is missing" };
  }
  const availability = await Promise.all((spec.commands || []).map((command) => executableOnPath(command, env)));
  let commandsReady = true;
  if (spec.kind === "commands-any") commandsReady = availability.some(Boolean);
  else if (spec.commands?.length) commandsReady = availability.every(Boolean);
  if (!commandsReady) return { ...spec, status: "missing" };
  if (["interactive", "os-permissions", "private-manual", "host-specific", "manual-optional", "on-demand-network"].includes(spec.setup)) {
    return { ...spec, status: "manual" };
  }
  return { ...spec, status: "ready" };
}

export async function planBundleDependencies({ pluginRoot, codexHome, env = process.env, platform = process.platform }) {
  if (!pluginRoot || !codexHome) throw new Error("pluginRoot and codexHome are required");
  const root = resolve(pluginRoot);
  const home = resolve(env.HOME || dirname(resolve(codexHome)));
  const manifest = await loadManifest();
  const resolvedCodexHome = resolve(codexHome);
  const steps = await Promise.all(manifest.managed.map((spec) => managedSetupStep(spec, root, resolvedCodexHome, home, env, platform)));
  const readiness = await Promise.all(manifest.readiness.map((spec) => readinessItem(spec, env, platform, root)));
  const required = steps
    .filter((step) => step.action === "blocked" || (step.required && step.action === "deferred"))
    .map((step) => ({ id: step.id, action: step.action, reason: step.reason }));
  return {
    version: 1,
    manifestVersion: manifest.schemaVersion,
    pluginRoot: root,
    codexHome: resolvedCodexHome,
    steps,
    required,
    readiness,
  };
}

async function run(argv) {
  await new Promise((accept, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? accept() : reject(new Error(`${argv[0]} failed (${signal || code})`)));
  });
}

async function safeLink(link) {
  if (link.action !== "link") return;
  await mkdir(dirname(link.target), { recursive: true });
  await symlink(link.source, link.target);
}

async function atomicManagedPrefix(prefix, build) {
  await mkdir(dirname(prefix), { recursive: true });
  const next = await mkdtemp(join(dirname(prefix), `${basename(prefix)}.next-`));
  const previous = `${prefix}.previous-${randomUUID()}`;
  try {
    await build(next);
    if (await pathKind(prefix) !== "missing") await rename(prefix, previous);
    try {
      await rename(next, prefix);
    } catch (error) {
      if (await pathKind(previous) !== "missing") await rename(previous, prefix);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
  } catch (error) {
    await rm(next, { recursive: true, force: true });
    throw error;
  }
}

async function defaultRunner(step) {
  if (step.kind === "managed-link") {
    await safeLink(step);
    return { executables: { [step.id]: step.target } };
  }
  if (step.kind === "brew-cask") {
    await run(step.argv);
    return { prepared: [step.id] };
  }
  if (step.kind === "npm-prefix") {
    await atomicManagedPrefix(step.prefix, async (next) => {
      const allowScripts = Object.fromEntries((step.allowScripts || []).map((name) => [name, true]));
      await writeFile(join(next, "package.json"), `${JSON.stringify({ private: true, allowScripts }, null, 2)}\n`);
      await run(["npm", "install", "--prefix", next, "--no-audit", "--no-fund", "--save-exact", ...step.packages]);
      for (const binary of step.binaries) {
        await run([join(next, "node_modules", ".bin", binary), "--version"]);
      }
      await writeFile(join(next, "rubato-dependencies.json"), `${JSON.stringify({ version: 1, packages: step.packages }, null, 2)}\n`);
    });
    for (const link of step.links) await safeLink(link);
    return { executables: Object.fromEntries(step.links.map((link) => [link.binary, link.target])) };
  }
  if (step.kind === "python-venv") {
    const launcher = `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync(${JSON.stringify(join(step.prefix, "bin", "python3"))}, ["-m", "engine", ...process.argv.slice(2)], { cwd: ${JSON.stringify(step.skillRoot)}, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`;
    await atomicManagedPrefix(step.prefix, async (next) => {
      await run(["python3", "-m", "venv", next]);
      if (step.packages.length) await run([join(next, "bin", "python3"), "-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...step.packages]);
      const nextLauncher = join(next, "bin", step.binary);
      await writeFile(nextLauncher, launcher);
      await chmod(nextLauncher, 0o755);
      await writeFile(join(next, "rubato-dependencies.json"), `${JSON.stringify({ version: 1, packages: step.packages }, null, 2)}\n`);
    });
    await safeLink(step.link);
    return { executables: { [step.binary]: step.link.target }, environment: { insaneSearchPython: join(step.prefix, "bin", "python3") } };
  }
  throw new Error(`${step.id}: no dependency runner`);
}

export async function applyBundleDependencies(plan, { dryRun = false, runner = defaultRunner } = {}) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.steps)) throw new Error("invalid bundle dependency plan");
  const items = [];
  const cleanup = [];
  const executables = {};
  const environment = { binDirectories: [] };
  for (const step of plan.steps) {
    if (step.action === "current") {
      items.push({ id: step.id, status: "current", target: step.target || step.prefix });
      if (step.target) executables[step.id] = step.target;
      for (const link of step.links || []) executables[link.binary] = link.target;
      if (step.link) executables[step.binary] = step.link.target;
      if (step.kind === "python-venv") environment.insaneSearchPython = join(step.prefix, "bin", "python3");
      if (step.target) cleanup.push({ action: "unlink-if-target", target: step.target, expectedSource: step.source });
      for (const link of step.links || (step.link ? [step.link] : [])) {
        if (link.action === "current") cleanup.push({ action: "unlink-if-target", target: link.target, expectedSource: link.source });
      }
      if (step.marker && step.prefix) cleanup.push({ action: "remove-tree-if-marker", target: step.prefix, marker: step.marker });
      continue;
    }
    if (!["link", "install"].includes(step.action)) {
      items.push({ id: step.id, status: step.action, target: step.target, reason: step.reason });
      continue;
    }
    const applied = dryRun ? undefined : await runner(step);
    Object.assign(executables, applied?.executables || {});
    if (applied?.environment) Object.assign(environment, applied.environment);
    items.push({ id: step.id, status: dryRun ? "planned" : "installed", target: step.target || step.prefix });
    if (step.target) cleanup.push({ action: "unlink-if-target", target: step.target, expectedSource: step.source });
    for (const link of step.links || (step.link ? [step.link] : [])) {
      if (["link", "current"].includes(link.action)) cleanup.push({ action: "unlink-if-target", target: link.target, expectedSource: link.source });
    }
    if (step.marker && step.prefix) cleanup.push({ action: "remove-tree-if-marker", target: step.prefix, marker: step.marker });
  }
  const status = items.some((item) => ["blocked", "conflict"].includes(item.status))
    ? "attention"
    : dryRun ? "planned" : "complete";
  environment.binDirectories = [...new Set(Object.values(executables).map((path) => dirname(path)))];
  const readiness = plan.readiness.map((item) => {
    if (item.id === "aside" && items.some((step) => step.id === "aside-app" && ["installed", "current"].includes(step.status))) {
      return { ...item, status: "manual", reason: "Aside app is installed; first launch and account login remain" };
    }
    return item;
  });
  return {
    status,
    items,
    cleanup,
    executables,
    environment,
    readiness,
    remaining: readiness.filter((item) => item.status !== "ready"),
  };
}
