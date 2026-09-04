import { HubControlClient, HubLifecycleClient, defaultHubSocketPath } from "./hub-client.mjs";
import { pickLiveSession } from "./picker.mjs";
import { runBootstrap } from "./bootstrap.mjs";
import { ZmxAdapter } from "./zmx-adapter.mjs";
import { createRemoteOperations } from "./remote-operations.mjs";

function optionValue(args, index, name) {
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

export async function renderPairingQr(value) {
  const qrTerminal = (await import("qrcode-terminal")).default;
  let rendered = "";
  qrTerminal.generate(value, { small: true }, (qr) => { rendered = qr; });
  return rendered;
}

export function parseNewArguments(args) {
  const options = { args: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      options.args = args.slice(index + 1);
      return options;
    }
    if (argument === "--detach") options.detach = true;
    else if (argument === "--cwd") options.cwd = optionValue(args, index++, "--cwd");
    else if (argument.startsWith("--cwd=")) options.cwd = argument.slice(6);
    else if (argument === "--name") options.name = optionValue(args, index++, "--name");
    else if (argument.startsWith("--name=")) options.name = argument.slice(7);
    else throw new Error(`unknown rubato new option: ${argument}`);
  }
  return options;
}

function sessionOption(args) {
  const index = args.indexOf("--session");
  if (index < 0 || !args[index + 1]) throw new Error("--session <session-file> is required");
  if (args.length !== 2) throw new Error("unexpected Vault arguments");
  return args[index + 1];
}

export function createDefaultLifecycle({ env = process.env } = {}) {
  return new HubLifecycleClient({
    env,
    control: new HubControlClient({ socketPath: defaultHubSocketPath(env) }),
    zmx: new ZmxAdapter({ env }),
  });
}

export async function runCli(args, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const lifecycle = options.lifecycle ?? createDefaultLifecycle({ env });
  const picker = options.picker ?? pickLiveSession;
  const bootstrap = options.bootstrap ?? runBootstrap;
  const remoteOperations = options.remoteOperations ?? createRemoteOperations({ env });
  const [command, ...rest] = args;
  if (command === "pick") {
    if (rest.length !== 0) throw new Error("usage: rubato");
    const sessions = await lifecycle.list();
    const selected = await picker(sessions);
    if (selected.kind === "quit") return 0;
    if (selected.kind === "new") await lifecycle.create({ environment: env });
    else await lifecycle.attach(selected.liveSessionId);
    return 0;
  }
  if (command === "new") {
    const createOptions = parseNewArguments(rest);
    const session = await lifecycle.create({ ...createOptions, environment: env });
    if (createOptions.detach) stdout.write(`${session.liveSessionId}\n`);
    return 0;
  }
  if (command === "attach") {
    if (rest.length !== 1) throw new Error("usage: rubato attach <live-id-or-prefix>");
    await lifecycle.attach(rest[0]);
    return 0;
  }
  if (command === "list") {
    if (rest.some((argument) => argument !== "--json")) throw new Error("usage: rubato list [--json]");
    const sessions = await lifecycle.list();
    if (rest.includes("--json")) stdout.write(JSON.stringify(sessions) + "\n");
    else for (const session of sessions) stdout.write(`${session.liveSessionId}\t${session.title}\t${session.cwd}\n`);
    return 0;
  }
  if (command === "kill") {
    const force = rest.includes("--force");
    const ids = rest.filter((argument) => argument !== "--force");
    if (ids.length !== 1) throw new Error("usage: rubato kill <live-id-or-prefix> [--force]");
    await lifecycle.kill(ids[0], force);
    return 0;
  }
  if (command === "vault-resume") {
    await lifecycle.vaultResume(sessionOption(rest));
    return 0;
  }
  if (command === "vault-fork") {
    await lifecycle.vaultFork(sessionOption(rest));
    return 0;
  }
  if (command === "remote") {
    const [subcommand, ...remoteRest] = rest;
    const simple = new Set(["setup", "status", "add-host"]);
    if (simple.has(subcommand) && remoteRest.length !== 0) throw new Error("usage: rubato remote <setup|status|add-host|doctor|update|uninstall>");
    if (subcommand === "setup") {
      stderr.write("Rubato will encrypt the current shell environment on this Mac for mobile launches.\n");
      await lifecycle.saveBaseline(env);
      stdout.write("Rubato remote launch environment configured.\n");
      return 0;
    }
    if (subcommand === "status") {
      stdout.write(JSON.stringify(await lifecycle.status()) + "\n");
      return 0;
    }
    if (subcommand === "add-host") {
      const added = await lifecycle.addHost();
      const renderQr = options.renderPairingQr ?? renderPairingQr;
      stdout.write(`${added.url}\n${added.qrPayload}\n${await renderQr(added.url)}\nMac 주소: ${added.pairing.baseUrl}\n연결 코드: ${added.pairing.nonce}\n이 QR과 연결 코드는 10분 뒤 만료됩니다.\n`);
      return 0;
    }
    if (subcommand === "doctor") {
      if (remoteRest.length !== 0) throw new Error("usage: rubato remote doctor");
      const operation = await remoteOperations.doctor();
      stdout.write(JSON.stringify(operation.result) + "\n");
      return operation.exitCode;
    }
    if (subcommand === "update-guard") {
      if (remoteRest.length !== 0) throw new Error("usage: rubato remote update-guard");
      await remoteOperations.guardUpdate();
      return 0;
    }
    if (subcommand === "update") {
      validateRemoteArguments(remoteRest, { values: ["--release", "--public-key", "--repository"], flags: ["--force-live", "--trusted-local-build", "--skip-smoke"] });
      if (!remoteRest.includes("--release")) throw new Error("usage: rubato remote update --release <verified-release> [--force-live]");
      const operation = await remoteOperations.update(remoteRest);
      stdout.write(JSON.stringify(operation.result) + "\n");
      return operation.exitCode;
    }
    if (subcommand === "uninstall") {
      validateRemoteArguments(remoteRest, { values: ["--repository"], flags: ["--yes", "--force-live", "--remove-registry", "--remove-push"] });
      if (!remoteRest.includes("--yes")) throw new Error("rubato remote uninstall requires --yes after reviewing preserved data");
      const operation = await remoteOperations.uninstall(remoteRest);
      stdout.write(JSON.stringify(operation.result) + "\n");
      return operation.exitCode;
    }
    throw new Error("usage: rubato remote <setup|status|add-host|doctor|update|uninstall>");
  }
  if (command === "internal-run") {
    if (rest.length !== 2 || rest[0] !== "--descriptor") throw new Error("usage: rubato internal-run --descriptor <path>");
    await bootstrap(rest[1]);
    return 0;
  }
  throw new Error("usage: rubato <new|attach|list|kill|vault-resume|vault-fork|remote>");
}

function validateRemoteArguments(args, allowed) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (allowed.flags.includes(argument)) continue;
    if (allowed.values.includes(argument)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      continue;
    }
    throw new Error(`unknown remote option: ${argument}`);
  }
}
