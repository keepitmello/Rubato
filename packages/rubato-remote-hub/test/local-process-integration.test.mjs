import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionActionQueue } from "../src/action-queue.ts";
import { EnvironmentHandoffStore, EnvironmentVault } from "../src/environment.ts";
import { RemoteHub } from "../src/hub.ts";
import { EventJournal } from "../src/journal.ts";
import { AllowedPathResolver } from "../src/path-security.ts";
import { LiveRegistry } from "../src/registry.ts";
import { SurfaceReconnectCredentials } from "../src/surface-credentials.ts";
import { SurfaceTokenStore } from "../src/surface-tokens.ts";
import { SurfaceSocketServer } from "../src/unix-server.ts";
import { ZmxProcessAdapter } from "../src/zmx.ts";
import { HubControlClient, HubLifecycleClient } from "../../rubato-live-cli/src/hub-client.mjs";
import { ZmxAdapter } from "../../rubato-live-cli/src/zmx-adapter.mjs";

const HOST_ID = "018f1e2d-3c4b-7a6f-8abc-1234567890ab";
const SESSION_ID = "018f1e2d-3c4b-7b6f-8abc-1234567890ab";
const cleanups = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

test("real hub create/list/attach/kill preserves PID and Vault resume does not duplicate", async () => {
  const root = mkdtempSync(join(tmpdir(), "rubato-hub-process-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "hub.sock");
  const eventPath = join(root, "events.sock");
  const events = await eventChannel(eventPath);
  cleanups.push(() => events.close());
  const statePath = join(root, "zmx-state.json");
  const fakeZmx = join(root, "zmx.mjs");
  const processLog = join(root, "process.log");
  const fakeLauncher = join(root, "rubato.mjs");
  const bootstrap = join(root, "bootstrap.mjs");
  const bootstrapModule = resolve(import.meta.dirname, "../../rubato-live-cli/src/bootstrap.mjs");

  executable(bootstrap, `#!${process.execPath}\nimport { runBootstrap } from ${JSON.stringify(new URL(`file://${bootstrapModule}`).href)};\nawait runBootstrap(process.argv[2]);\n`);
  executable(fakeLauncher, `#!${process.execPath}\nimport { createConnection } from "node:net";\nconst send=(kind)=>new Promise((resolve)=>{const socket=createConnection(process.env.MOCK_EVENT_SOCKET);socket.end(JSON.stringify({kind,pid:process.pid,argv:process.argv.slice(2),secret:process.env.SECRET})+"\\n",resolve)});\nawait send("engine");\nprocess.on("SIGTERM",()=>void send("exit").finally(()=>process.exit(0)));\nsetInterval(()=>{},60000);\n`);
  executable(fakeZmx, `#!${process.execPath}\nimport { openSync,readFileSync,writeFileSync } from "node:fs";import { spawn } from "node:child_process";import { createConnection } from "node:net";\nconst path=process.env.MOCK_ZMX_STATE;const read=()=>{try{return JSON.parse(readFileSync(path,"utf8"))}catch{return {sessions:{},runs:0}}};const save=(s)=>writeFileSync(path,JSON.stringify(s));const send=(value)=>new Promise((resolve)=>{const socket=createConnection(process.env.MOCK_EVENT_SOCKET);socket.end(JSON.stringify(value)+"\\n",resolve)});const [command,...args]=process.argv.slice(2);const state=read();\nif(command==="version"){console.log("zmx 0.7.1-rubato");process.exit(0)}\nif(command==="run"){const [name,_detach,script]=args;const log=openSync(process.env.MOCK_PROCESS_LOG,"a");const child=spawn("/bin/sh",["-c",script],{detached:true,stdio:["ignore",log,log],env:{...process.env,ZMX_SESSION:name}});child.unref();state.sessions[name]={pid:child.pid,labels:{}};state.runs++;save(state);process.exit(0)}\nif(command==="set"){const [name,...fields]=args;for(const field of fields){const at=field.indexOf("=");state.sessions[name].labels[field.slice(0,at)]=field.slice(at+1)}save(state);process.exit(0)}\nif(command==="list"){for(const name of Object.keys(state.sessions))console.log(name);process.exit(0)}\nif(command==="get"){const session=state.sessions[args[0]];if(args[1]==="pid")console.log(session?.pid??"");else console.log(session?.labels?.[args[1]]??"");process.exit(0)}\nif(command==="attach"){const session=state.sessions[args[0]];await send({kind:"attach",pid:session.pid});process.exit(0)}\nif(command==="kill"){const session=state.sessions[args[0]];if(session)process.kill(session.pid,"SIGTERM");delete state.sessions[args[0]];save(state);process.exit(0)}\nprocess.exit(2);\n`);

  const env = { ...process.env, MOCK_ZMX_STATE: statePath, MOCK_EVENT_SOCKET: eventPath, MOCK_PROCESS_LOG: processLog };
  const processAdapter = new ZmxProcessAdapter({ zmx: fakeZmx, bootstrap, descriptorRoot: join(root, "launch"), runner: new EnvironmentRunner(env) });
  const registry = new LiveRegistry(HOST_ID, processAdapter);
  const journal = new EventJournal(join(root, "journal"), join(root, "snapshots"), HOST_ID);
  await journal.load();
  const handoffs = new EnvironmentHandoffStore();
  const tokens = new SurfaceTokenStore();
  const server = new SurfaceSocketServer(socketPath, registry, journal, tokens, handoffs, new SurfaceReconnectCredentials(join(root, "credentials")));
  const hub = new RemoteHub({
    registry,
    journal,
    actions: new SessionActionQueue(server, () => 0),
    controller: processAdapter,
    paths: new AllowedPathResolver([root]),
    vault: new EnvironmentVault(join(root, "baseline.enc"), { getOrCreate: async () => Buffer.alloc(32) }),
    handoffs,
    surfaceTokens: tokens,
    newLiveSessionId: () => SESSION_ID,
    runtime: { socketPath, launcherPath: fakeLauncher, zmxBinary: fakeZmx, buildId: "integration" },
  });
  server.setControl(hub);
  await server.listen();
  cleanups.push(() => server.close());

  const lifecycle = new HubLifecycleClient({
    control: new HubControlClient({ socketPath }),
    zmx: new ZmxAdapter({ binary: fakeZmx, env }),
    env: { ...env, SECRET: "terminal-socket-only" },
  });
  const sessionFile = join(root, "session.jsonl");
  const engineSignal = events.next("engine");
  const session = await lifecycle.create({ cwd: root, detach: true, args: ["--session", sessionFile] });
  const engine = await engineSignal.catch((error) => { throw new Error(`${error.message}: ${readFileSync(processLog, "utf8")}`); });
  expect(engine).toMatchObject({ kind: "engine", argv: ["direct", "--session", sessionFile], secret: "terminal-socket-only" });
  expect(session.pid).toBe(engine.pid);
  expect((await lifecycle.list())[0]).toMatchObject({ liveSessionId: SESSION_ID, pid: engine.pid });

  const attachSignal = events.next("attach");
  await lifecycle.attach(SESSION_ID.slice(0, 8));
  expect(await attachSignal).toEqual({ kind: "attach", pid: engine.pid });
  const resumeSignal = events.next("resume");
  const resumed = await lifecycle.vaultResume(sessionFile);
  expect(resumed.attached).toBeTrue();
  expect(await resumeSignal).toEqual({ kind: "attach", pid: engine.pid });
  expect(JSON.parse(readFileSync(statePath, "utf8")).runs).toBe(1);

  const exitSignal = events.next("exit");
  await lifecycle.kill(SESSION_ID);
  expect(await exitSignal).toEqual({ kind: "exit", pid: engine.pid, argv: ["direct", "--session", sessionFile], secret: "terminal-socket-only" });
  expect(await lifecycle.list()).toEqual([]);
});

class EnvironmentRunner {
  constructor(env) { this.env = env; }
  async run(file, args, options = {}) {
    const { execFile } = await import("node:child_process");
    return new Promise((resolveRun, reject) => execFile(file, [...args], { env: this.env, timeout: options.timeoutMs ?? 10_000 }, (error, stdout, stderr) => error ? reject(error) : resolveRun({ stdout, stderr })));
  }
}

async function eventChannel(path) {
  const queue = [];
  const waiters = [];
  const server = createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("end", () => {
      if (!text) return;
      const value = JSON.parse(text);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value); else queue.push(value);
    });
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(path, resolveListen); });
  return {
    next(label = "event") {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolveValue, reject) => {
        const waiter = { resolve: resolveValue };
        waiters.push(waiter);
        const timeout = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error(`${label} event timed out`)); }, 5_000);
        timeout.unref();
        waiter.resolve = (value) => { clearTimeout(timeout); resolveValue(value); };
      });
    },
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
