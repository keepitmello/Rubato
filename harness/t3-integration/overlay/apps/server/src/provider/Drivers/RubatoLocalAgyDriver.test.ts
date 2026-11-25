import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ModelManifest from "../ModelManifest.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { resolveProviderCompatibility } from "../providerCompatibility.ts";
import { AntigravityDriver } from "./AntigravityDriver.ts";
import { checkAgyLogin } from "../RubatoAgyLogin.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const decodeRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(
        Schema.Struct({
          clientInfo: Schema.optional(
            Schema.Struct({
              name: Schema.String,
              title: Schema.optional(Schema.String),
              version: Schema.String,
            }),
          ),
        }),
      ),
    }),
  ),
);
const minimalEnvironment = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  // The workspace Rubato's agy tools act in (localAgySpawn).
  "RUBATO_AGY_WORKSPACE",
]);
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

// A stand-in for the official agy CLI: `agy agents` lists one agent, `agy acp ...` runs T3's mock
// ACP agent. Every call records its arguments and HOME.
const makeHarness = Effect.fn("makeLocalAgyHarness")(function* (
  agent: string,
  options: {
    readonly id?: string;
    readonly isolated?: boolean;
    readonly login?: string;
    /** While this file exists, `agy acp` answers with a Google sign-in link, as a signed-out agy does. */
    readonly signedOutMarker?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nodePath = yield* HostProcess.ExecutablePath;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-agy-" });
  const home = path.join(root, "home");
  yield* fs.makeDirectory(home);
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const requestLog = path.join(root, "requests.jsonl");
  const callLog = path.join(root, "calls.log");
  const agy = path.join(root, "agy");
  yield* fs.writeFileString(
    agy,
    [
      "#!/bin/sh",
      `printf '%s|%s|%s\\n' "$HOME" "\${GEMINI_API_KEY:-}" "$*" >> ${quote(callLog)}`,
      `if [ "$1" = agents ]; then printf 'Available agents:\\nrubato-lead-alt\\nrubato-lead\\n'; exit 0; fi`,
      ...(options.signedOutMarker
        ? [
            `if [ "$1" = acp ] && [ -f ${quote(options.signedOutMarker)} ]; then`,
            "  printf 'Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http://127.0.0.1:4567/\\n'",
            "  exec sleep 30",
            "fi",
          ]
        : []),
      "export T3_ACP_ANTIGRAVITY=1 T3_ACP_AGENT_VERSION=1.5.13",
      `export T3_ACP_REQUEST_LOG_PATH=${quote(requestLog)}`,
      `exec ${quote(nodePath)} ${quote(mockAgentPath)} "$@"`,
      "",
    ].join("\n"),
  );
  yield* fs.chmod(agy, 0o755);

  const installationUses: Array<string> = [];
  const layerInstallation = Layer.mock(AntigravityInstallation.AntigravityInstallation)({
    managedDirectory: root,
    compatibility: (version) =>
      Effect.succeed(
        resolveProviderCompatibility(
          ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
          ProviderDriverKind.make("antigravity"),
          version,
        ),
      ),
    resolve: () =>
      Effect.sync(() => installationUses.push("resolve")).pipe(
        Effect.andThen(Effect.die("local agy must not resolve T3's Antigravity install")),
      ),
    acquire: () =>
      Effect.sync(() => installationUses.push("acquire")).pipe(
        Effect.andThen(Effect.die("local agy must not acquire T3's Antigravity install")),
      ),
  });
  const launches: Array<{
    command: string;
    args: ReadonlyArray<string>;
    extendEnv: boolean | undefined;
    environment: Record<string, string | undefined>;
  }> = [];
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline.");
      const environment = command.options.env ?? {};
      launches.push({
        command: command.command,
        args: command.args.map(String),
        extendEnv: command.options.extendEnv,
        environment: Object.fromEntries(
          Object.entries(environment).map(([name, value]) => [
            name,
            Redacted.isRedacted(value) ? Redacted.value(value) : value,
          ]),
        ),
      });
      return yield* spawner.spawn(command);
    }),
  );
  const instance = yield* AntigravityDriver.create({
    instanceId: ProviderInstanceId.make(options.id ?? `local-${path.basename(root)}`),
    displayName: "Lead",
    enabled: true,
    config: { ...AntigravityDriver.defaultConfig(), authMethod: "oauth-personal", binaryPath: agy },
    environment: [
      { name: "RUBATO_LOCAL_AGY_AGENT", value: agent },
      ...(options.isolated ? [{ name: "RUBATO_LOCAL_AGY_ISOLATED", value: "1" }] : []),
      ...(options.login ? [{ name: "RUBATO_LOCAL_AGY_LOGIN", value: options.login }] : []),
      { name: "HOME", value: home },
      { name: "GEMINI_API_KEY", value: "must-not-be-forwarded" },
      { name: "T3_ACP_ANTIGRAVITY", value: "must-not-be-forwarded" },
    ].map((variable) => ({ ...variable, sensitive: false })),
  }).pipe(
    Effect.provide(layerInstallation),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
  );
  const readLines = (file: string) =>
    fs.exists(file).pipe(
      Effect.flatMap((exists) => (exists ? fs.readFileString(file) : Effect.succeed(""))),
      Effect.map((text) => text.split(/\r?\n/u).filter(Boolean)),
    );
  return {
    instance,
    agy,
    home,
    launches,
    installationUses,
    calls: readLines(callLog),
    requests: readLines(requestLog).pipe(
      Effect.flatMap((lines) => Effect.forEach(lines, (line) => decodeRequest(line))),
    ),
    methods: readLines(requestLog).pipe(
      Effect.flatMap((lines) => Effect.forEach(lines, (line) => decodeRequest(line))),
      Effect.map((requests) => requests.map((request) => request.method)),
    ),
  };
});

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-agy-config-" }).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected quota request")),
        ),
      ),
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provideMerge(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provideMerge(ModelManifest.layerTest),
      Layer.provideMerge(IdAllocator.layer),
      Layer.provideMerge(McpProviderSessions.layer),
    ),
  ),
);

it.layer(layerTest)("Rubato local agy", (it) => {
  it.effect.skipIf(windowsHost)(
    "drives official agy with the named agent and the login it already holds",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness("rubato-lead");
        yield* h.instance.refreshModels!();

        expect(h.installationUses).toEqual([]);
        expect(h.instance.auth).toBeUndefined();
        const agyLaunches = h.launches.filter((launch) => launch.command === h.agy);
        // Each session start first checks that agy really has the agent.
        expect(agyLaunches.map((launch) => launch.args.join(" "))).toContain("agents");
        expect(agyLaunches.map((launch) => launch.args.join(" "))).toContain(
          "acp --sandbox --agent rubato-lead",
        );
        expect(
          agyLaunches.filter(
            (launch) => !["agents", "acp --sandbox --agent rubato-lead"].includes(launch.args.join(" ")),
          ),
        ).toEqual([]);
        for (const launch of agyLaunches) {
          expect(launch.extendEnv).toBe(false);
          expect(launch.environment.HOME).toBe(h.home);
          expect(
            Object.keys(launch.environment).filter((name) => !minimalEnvironment.has(name)),
          ).toEqual([]);
        }
        const calls = yield* h.calls;
        expect(calls).toContain(`${h.home}||agents`);
        expect(calls).toContain(`${h.home}||acp --sandbox --agent rubato-lead`);
        const requests = yield* h.requests;
        const methods = requests.map((request) => request.method);
        expect(methods).toContain("initialize");
        expect(methods).toContain("session/new");
        expect(methods).not.toContain("auth/login");
        expect(methods).not.toContain("authenticate");
        const initRequest = requests.find((request) => request.method === "initialize");
        expect(initRequest?.params?.clientInfo).toMatchObject({
          name: "t3-code",
          title: "T3 Code",
        });

        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.status).toBe("ready");
        expect(snapshot.supportsTextGeneration).toBe(false);
        // The mock agent offers only `gemini-test-*`, which is not a Gemini release model.
        expect(snapshot.models).toEqual([]);

        const launchesBefore = h.launches.length;
        const title = yield* h.instance.textGeneration
          .generateThreadTitle({
            cwd: h.home,
            message: "Name this thread",
            modelSelection: { instanceId: h.instance.instanceId, model: "gemini-test-low" },
          })
          .pipe(Effect.flip);
        expect(title).toBeDefined();
        expect(h.launches.length).toBe(launchesBefore);
      }),
  );

  it.effect.skipIf(windowsHost)("refuses an agent agy does not list instead of its fallback", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("rubato");
      const error = yield* h.instance.refreshModels!().pipe(Effect.flip);
      expect(error.detail).toBe(
        "The registered agy agent 'rubato' is not available. Check it with agy agents.",
      );
      const agyLaunches = h.launches.filter((launch) => launch.command === h.agy);
      expect(agyLaunches.length).toBeGreaterThan(0);
      expect(agyLaunches.filter((launch) => launch.args.join(" ") !== "agents")).toEqual([]);
      expect(yield* h.methods).toEqual([]);
    }),
  );

  it.effect.skipIf(windowsHost)(
    "checks every agent on an isolated login at start, and a pass brings back the signed-out ones",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-login-" });
        const signedOutMarker = path.join(scratch, "signed-out");
        yield* fs.writeFileString(signedOutMarker, "");
        const login = `sub-${path.basename(scratch)}`;
        const lead = yield* makeHarness("rubato-lead", { id: login, isolated: true, signedOutMarker });
        const helena = yield* makeHarness("rubato-lead-alt", {
          id: `${login}-helena`,
          isolated: true,
          login,
          signedOutMarker,
        });
        const authOf = (h: typeof lead) =>
          h.instance.snapshot.getSnapshot.pipe(Effect.map((snapshot) => snapshot.auth.status));
        const bothSignedOut = Effect.all([authOf(lead), authOf(helena)]).pipe(
          Effect.map((states) => states.every((state) => state === "unauthenticated")),
        );
        // The start checks run in the background; wait for them in real time.
        for (let attempt = 0; attempt < 200 && !(yield* bothSignedOut); attempt += 1) {
          yield* TestClock.withLive(Effect.sleep("50 millis"));
        }
        expect(yield* bothSignedOut).toBe(true);

        const profiles = [...lead.launches, ...helena.launches]
          .filter((launch) => launch.command !== process.execPath && launch.args[0] === "acp")
          .map((launch) => launch.args[launch.args.indexOf("--gemini-dir") + 1]);
        expect(profiles.length).toBeGreaterThanOrEqual(2);
        expect(new Set(profiles).size).toBe(1);

        // Signed in again: one passing check of the login brings back the other agent on it.
        yield* fs.remove(signedOutMarker);
        expect(yield* checkAgyLogin(profiles[0]!, login)).toBe(true);
        expect(yield* authOf(lead)).toBe("authenticated");
        expect(yield* authOf(helena)).toBe("authenticated");
      }),
  );
});
