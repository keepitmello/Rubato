import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import {
  serveTailscaleRoot,
  TAILSCALE_SERVE_RECHECK_INTERVAL,
  type TailscaleServeRootRoute,
} from "./RubatoTailscaleServe.ts";

const encoder = new TextEncoder();
const route: TailscaleServeRootRoute = {
  localPort: 3773,
  urlHost: "127.0.0.1",
  localHost: "127.0.0.1",
  servePort: 443,
};
const ours = "http://127.0.0.1:3773";
const addRoot = ["serve", "--bg", "--https=443", ours];
const removeRoot = ["serve", "--https=443", "--set-path=/", "off"];

/**
 * A fake `tailscale` CLI over one node's Serve config: the root of port 443 and whether the
 * daemon is up. Every command fails while it is stopped, as after a reboot with the Mac app
 * disconnected. `live` lists the loopback ports something listens on.
 */
const makeTailnet = (initial: { running: boolean; root?: string; live?: number[] }) => {
  const world = { running: initial.running, root: initial.root, live: initial.live ?? [] };
  const commands: string[][] = [];
  const respond = (args: ReadonlyArray<string>) => {
    if (!world.running) return { code: 1, stderr: "Tailscale is stopped." };
    if (args[0] === "status") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "box.tailnet.ts.net.", CapMap: { https: [] } },
        }),
      };
    }
    if (args.join(" ") === "serve status --json") {
      return {
        stdout:
          world.root === undefined
            ? "null"
            : JSON.stringify({
                Web: { "box.tailnet.ts.net:443": { Handlers: { "/": { Proxy: world.root } } } },
              }),
      };
    }
    if (args.join(" ") === addRoot.join(" ")) world.root = ours;
    if (args.join(" ") === removeRoot.join(" ")) world.root = undefined;
    return {};
  };
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
    commands.push([...args]);
    const result: { stdout?: string; stderr?: string; code?: number } = respond(args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(result.stdout ?? "")),
        stderr: Stream.make(encoder.encode(result.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  const unused = () => Effect.die("not used by the Serve hold");
  const layer = Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(NetService.NetService, {
      hasListenerOnHost: (port) => Effect.succeed(world.live.includes(port)),
      canListenOnHost: unused,
      isPortAvailableOnLoopback: unused,
      reserveLoopbackPort: unused,
      findAvailablePort: unused,
    }),
  );
  const adds = () => commands.filter((args) => args.join(" ") === addRoot.join(" ")).length;
  return { world, commands, layer, adds };
};

/** Opens the server's Serve lifecycle in a scope the test closes, as server shutdown does. */
const open = (tailnet: ReturnType<typeof makeTailnet>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* serveTailscaleRoot(Effect.succeed(route)).pipe(Scope.provide(scope));
    yield* Effect.yieldNow;
    return scope;
  }).pipe(Effect.provide(tailnet.layer));

const tick = (times = 1) =>
  Effect.gen(function* () {
    for (let index = 0; index < times; index += 1) {
      yield* TestClock.adjust(TAILSCALE_SERVE_RECHECK_INTERVAL);
    }
  });

describe("serveTailscaleRoot", () => {
  it.effect("re-adds the root route once Tailscale comes up after a failed start", () =>
    Effect.gen(function* () {
      // A reboot: the Mac app restores disconnected, so the start's `tailscale serve` failed.
      const tailnet = makeTailnet({ running: false });
      yield* open(tailnet);
      yield* tick(3);
      assert.equal(tailnet.adds(), 0);
      assert.isUndefined(tailnet.world.root);

      tailnet.world.running = true;
      yield* tick();
      assert.equal(tailnet.adds(), 1);
      assert.equal(tailnet.world.root, ours);

      yield* tick(2);
      assert.equal(tailnet.adds(), 1, "a held root is not rewritten");
    }),
  );

  it.effect("re-adds a root route that went missing or was left on a dead port", () =>
    Effect.gen(function* () {
      const tailnet = makeTailnet({ running: true, root: ours });
      yield* open(tailnet);
      yield* tick();
      assert.equal(tailnet.adds(), 0);

      tailnet.world.root = undefined;
      yield* tick();
      assert.equal(tailnet.adds(), 1);
      assert.equal(tailnet.world.root, ours);

      tailnet.world.root = "http://127.0.0.1:4001";
      yield* tick();
      assert.equal(tailnet.adds(), 2);
      assert.equal(tailnet.world.root, ours);
    }),
  );

  it.effect("leaves a root route that another live server or app holds", () =>
    Effect.gen(function* () {
      for (const root of ["http://127.0.0.1:4001", "http://10.0.0.5:8080"]) {
        const tailnet = makeTailnet({ running: true, root, live: [4001] });
        const scope = yield* open(tailnet);
        yield* tick(4);
        assert.equal(tailnet.adds(), 0, root);
        assert.equal(tailnet.world.root, root);

        yield* Scope.close(scope, Exit.void);
        assert.equal(tailnet.world.root, root, "the release leaves it too");
        assert.notDeepInclude(tailnet.commands, removeRoot);
      }
    }),
  );

  it.effect("stops on shutdown, and the release turns off only its own root route", () =>
    Effect.gen(function* () {
      const tailnet = makeTailnet({ running: true, root: ours });
      const scope = yield* open(tailnet);
      yield* tick();
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(tailnet.commands.at(-1), removeRoot);
      assert.isUndefined(tailnet.world.root);

      const afterClose = tailnet.commands.length;
      yield* tick(4);
      assert.equal(tailnet.commands.length, afterClose, "no check runs after shutdown");
      assert.isUndefined(tailnet.world.root, "nothing re-adds the route after its release");
    }),
  );

  it.effect("does not re-add a root route another server took before shutdown", () =>
    Effect.gen(function* () {
      const tailnet = makeTailnet({ running: true, root: ours, live: [4001] });
      const scope = yield* open(tailnet);
      tailnet.world.root = "http://127.0.0.1:4001";
      yield* Scope.close(scope, Exit.void);
      yield* tick(2);
      assert.equal(tailnet.world.root, "http://127.0.0.1:4001");
      assert.notDeepInclude(tailnet.commands, removeRoot);
      assert.equal(tailnet.adds(), 0);
    }),
  );
});
