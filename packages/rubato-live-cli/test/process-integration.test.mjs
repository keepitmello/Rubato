import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LiveLifecycle } from "../src/lifecycle.mjs";
import { OneTimeLaunchBroker } from "../src/launch-handoff.mjs";
import { LiveStateStore } from "../src/state-store.mjs";
import { ZmxAdapter } from "../src/zmx-adapter.mjs";

async function eventChannel(path) {
  const queued = [];
  const waiters = [];
  const server = createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      const event = JSON.parse(text.slice(0, newline));
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(event);
      else queued.push(event);
      socket.end();
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, resolveListen);
  });
  return {
    next(timeoutMs = 5_000) {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      return new Promise((resolveEvent, reject) => {
        const waiter = { resolve: resolveEvent };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("mock process event timed out"));
        }, timeoutMs);
        timer.unref?.();
        waiter.resolve = (value) => { clearTimeout(timer); resolveEvent(value); };
      });
    },
    close() { return new Promise((resolveClose) => server.close(resolveClose)); },
  };
}

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

test("real bootstrap handoff keeps one detached mock PID through attach and Vault resume", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rubato-live-process-"));
  const handoffDirectory = mkdtempSync("/tmp/rh-");
  const eventSocket = join(root, "events.sock");
  const events = await eventChannel(eventSocket);
  t.after(async () => {
    await events.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(handoffDirectory, { recursive: true, force: true });
  });
  const zmxState = join(root, "zmx-state.json");
  const processLog = join(root, "process.log");
  const attachLog = join(root, "attach.log");
  const fakeZmx = join(root, "zmx.mjs");
  const fakeLauncher = join(root, "rubato-pi.mjs");
  const bootstrap = resolve(import.meta.dirname, "../../../harness/scripts/remote/rubato-live-bootstrap.mjs");

  executable(fakeLauncher, `#!${process.execPath}\nimport { createConnection } from "node:net";\nconst socket=createConnection(process.env.MOCK_ENGINE_SOCKET);\nsocket.end(JSON.stringify({kind:"engine",pid:process.pid,argv:process.argv.slice(2),liveSessionId:process.env.RUBATO_LIVE_SESSION_ID})+"\\n");\nsetInterval(()=>{}, 60000);\n`);
  executable(fakeZmx, `#!${process.execPath}\nimport { appendFileSync, openSync, readFileSync, writeFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nimport { createConnection } from "node:net";\nconst statePath=process.env.MOCK_ZMX_STATE;\nconst read=()=>{try{return JSON.parse(readFileSync(statePath,"utf8"))}catch{return {sessions:{},runs:0}}};\nconst save=(state)=>writeFileSync(statePath,JSON.stringify(state));\nconst [command,...args]=process.argv.slice(2);\nif(command==="version"){console.log("zmx 0.7.1-rubato");process.exit(0)}\nconst state=read();\nif(command==="run"){const [name,_detach,script]=args;const log=openSync(process.env.MOCK_PROCESS_LOG,"a");const child=spawn("/bin/sh",["-c",'read ready; eval "$1"',"sh",script],{detached:true,stdio:["pipe",log,log],env:{...process.env,ZMX_SESSION:name}});child.unref();state.sessions[name]={pid:child.pid,labels:{}};state.runs+=1;save(state);child.stdin.end("ready\\n");process.exit(0)}\nif(command==="set"){const [name,...fields]=args;for(const field of fields){const at=field.indexOf("=");state.sessions[name].labels[field.slice(0,at)]=field.slice(at+1)}save(state);process.exit(0)}\nif(command==="list"){for(const name of Object.keys(state.sessions))console.log(name);process.exit(0)}\nif(command==="get"){const labels=state.sessions[args[0]]?.labels??{};console.log(Object.entries(labels).map(([k,v])=>k+"="+v).join(" "));process.exit(0)}\nif(command==="attach"){const session=state.sessions[args[0]];appendFileSync(process.env.MOCK_ATTACH_LOG,String(session.pid)+"\\n");process.exit(0)}\nif(command==="kill"){const session=state.sessions[args[0]];if(session)process.kill(session.pid,"SIGTERM");delete state.sessions[args[0]];save(state);process.exit(0)}\nprocess.exit(2);\n`);

  const env = {
    ...process.env,
    MOCK_ZMX_STATE: zmxState,
    MOCK_ENGINE_SOCKET: eventSocket,
    MOCK_PROCESS_LOG: processLog,
    MOCK_ATTACH_LOG: attachLog,
  };
  const zmx = new ZmxAdapter({ binary: fakeZmx, env });
  const lifecycle = new LiveLifecycle({
    zmx,
    store: new LiveStateStore(join(root, "state")),
    handoff: new OneTimeLaunchBroker({ directory: handoffDirectory, ttlMs: 5_000 }),
    launcherPath: fakeLauncher,
    bootstrapPath: bootstrap,
    env,
  });
  const sessionFile = join(root, "session.jsonl");
  const engineSignal = events.next();
  const session = await lifecycle.create({ cwd: root, detach: true, args: ["--session", sessionFile] });
  let engine;
  try {
    engine = await engineSignal;
  } catch (error) {
    const log = (() => { try { return readFileSync(processLog, "utf8"); } catch { return "<no process log>"; } })();
    throw new Error(`${error.message}: ${log}`);
  }
  assert.equal(engine.kind, "engine");
  assert.deepEqual(engine.argv, ["direct", "--session", sessionFile]);
  assert.equal(engine.liveSessionId, session.liveSessionId);

  lifecycle.attach(session.liveSessionId);
  assert.deepEqual(readFileSync(attachLog, "utf8").trim().split("\n"), [String(engine.pid)]);

  const resumed = await lifecycle.vaultResume(sessionFile);
  assert.equal(resumed.attached, true);
  assert.deepEqual(readFileSync(attachLog, "utf8").trim().split("\n"), [String(engine.pid), String(engine.pid)]);
  assert.equal(JSON.parse(readFileSync(zmxState, "utf8")).runs, 1);
  lifecycle.kill(session.liveSessionId);
});
