// Local Antigravity: an Antigravity instance whose environment sets RUBATO_LOCAL_AGY_AGENT
// drives the user's own official `agy` CLI with that agy agent.
//
// Two account modes are supported:
//   - Default (no RUBATO_LOCAL_AGY_ISOLATED): uses the login `agy` already holds under HOME,
//     never authenticates or signs out on agy's behalf.
//   - Isolated (RUBATO_LOCAL_AGY_ISOLATED=1): uses T3's per-instance `--gemini-dir` profile
//     and browser Google sign-in (`authFlow.controller`) so users can sign in multiple Google
//     accounts like Claude multi-account, while sharing `~/.gemini/config/{agents,skills,mcp_config.json}`.
//
// Both modes always identify as `t3-code`, verify the agent exists via `agy agents`, filter to
// Gemini models labelled with the instance name, and disable background text
// generation. Instances without RUBATO_LOCAL_AGY_AGENT keep upstream's behavior.
const driver = 'apps/server/src/provider/Drivers/AntigravityDriver.ts';
const support = 'apps/server/src/provider/acp/AntigravityAcpSupport.ts';

export const localAgyOverlays = [
  'apps/server/src/provider/RubatoLocalAgy.ts',
  'apps/server/src/provider/Drivers/RubatoLocalAgyDriver.test.ts',
];

export const localAgyEdits = {
  'apps/server/src/provider/antigravityUsageLimits.ts': [
    [
      'import * as NodeModule from "node:module";',
      'import { execFile } from "node:child_process";\nimport * as NodeModule from "node:module";',
      'replace',
    ],
    [
      '        platform === "win32"\n          ? readWindowsCliCredential(architecture)',
      `        platform === "darwin"
          // go-keyring trusts Apple's security tool, not the Electron server. Keep
          // this read out of the server's worker pool and bound the wait.
          ? await new Promise<Buffer | undefined>((resolve) => {
              execFile(
                "/usr/bin/security",
                ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
                { encoding: "buffer", timeout: 2000, maxBuffer: 65536, killSignal: "SIGKILL" },
                (error, stdout) => resolve(error ? undefined : Buffer.from(stdout.toString().trim())),
              );
            })
          : platform === "win32"
          ? readWindowsCliCredential(architecture)`,
      'replace',
    ],
    [
      '  readonly readKeyringSecret?: Effect.Effect<string | undefined, AntigravityKeyringError>;',
      '  readonly useLocalAgyLogin?: boolean;\n' +
      '  readonly readKeyringSecret?: Effect.Effect<string | undefined, AntigravityKeyringError>;',
      'replace',
    ],
    [
      '    if (!(yield* fs.exists(tokenPath))) {',
      '    if (input.useLocalAgyLogin || !(yield* fs.exists(tokenPath))) {',
      'replace',
    ],
    [
      '      const stored = (yield* fs.exists(cliTokenPath))\n        ? yield* fs.readFileString(cliTokenPath)\n        : input.authMethod === "oauth-business"',
      '      const stored = !input.useLocalAgyLogin && (yield* fs.exists(cliTokenPath))\n' +
      '        ? yield* fs.readFileString(cliTokenPath)\n' +
      '        : input.useLocalAgyLogin || input.authMethod === "oauth-business"',
      'replace',
    ],
  ],
  'apps/server/src/provider/antigravityUsageLimits.test.ts': [
    [
      '  it.effect("reads the native CLI\'s stored sign-in when acp_token.json is absent", () =>',
      '  it.effect("uses the existing agy login for a local personal account", () =>\n' +
      '    Effect.gen(function* () {\n' +
      '      const { probe, requests } = yield* fixture({\n' +
      '        useLocalAgyLogin: true, missingToken: true,\n' +
      '        keyringSecret: JSON.stringify({ token: { access_token: "access-token", expiry: "2099-01-01T00:00:00Z" } }),\n' +
      '      });\n' +
      '      expect((yield* probe).unavailable?.reason).not.toBe("unsupported");\n' +
      '      expect(requests.length).toBeGreaterThan(0);\n' +
      '    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),\n' +
      '  );\n\n' +
      '  it.effect("reads the native CLI\'s stored sign-in when acp_token.json is absent", () =>',
      'replace',
    ],
    [
      '    keyringSecret?: string;',
      '    useLocalAgyLogin?: boolean;\n    keyringSecret?: string;',
      'replace',
    ],
    [
      '    authMethod: options.authMethod ?? "oauth-personal",',
      '    authMethod: options.authMethod ?? "oauth-personal",\n    useLocalAgyLogin: options.useLocalAgyLogin,',
      'replace',
    ],
  ],
  [support]: [
    [
      '  readonly authMethod?: AntigravityAuthMethod;\n',
      '  readonly authMethod?: AntigravityAuthMethod;\n' +
      '  /** Rely on the login the agy CLI already holds: no eager or on-demand authenticate. */\n' +
      '  readonly useExistingLogin?: boolean;\n' +
      '  /** Always identify as `t3-code` even when runtimeVersion is unknown before initialize. */\n' +
      '  readonly preferT3ClientInfo?: boolean;\n',
      'replace',
    ],
    [
      '      authenticateEagerly: true,',
      '      authenticateEagerly: !input.useExistingLogin,\n' +
      '      ...(input.useExistingLogin ? { authenticateOnAuthRequired: false } : {}),',
      'replace',
    ],
    [
      '      clientInfo: antigravityClientInfo(input.runtimeVersion),',
      '      clientInfo: antigravityClientInfo(\n' +
      '        input.useExistingLogin || input.preferT3ClientInfo\n' +
      '          ? OPEN_MODEL_ACCESS_RELEASE.join(".")\n' +
      '          : input.runtimeVersion,\n' +
      '      ),',
      'replace',
    ],
  ],
  [driver]: [
    [
      'import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";\n',
      'import { hasLocalAgyAgent, linkLocalAgyProfileConfig, localAgyAgent, localAgyApprovalSpawn, localAgyIsolated, localAgyModels, localAgySpawn, localAgyWithAgentArgs } from "../RubatoLocalAgy.ts";\n',
    ],
    [
      '    const settings = { ...config, enabled } satisfies AntigravitySettings;\n',
      '    const settings = { ...config, enabled } satisfies AntigravitySettings;\n' +
      '    const localAgent = localAgyAgent(environment);\n' +
      '    const localIsolated = Boolean(localAgent) && localAgyIsolated(environment);\n' +
      '    const localExistingLogin = Boolean(localAgent) && !localIsolated;\n',
      'replace',
    ],
    [
      '        Effect.map((catalog) => stampIdentity(ModelCatalog.applyModelCatalog(draft, catalog))),',
      `        Effect.map((catalog) => {
          const classified = ModelCatalog.applyModelCatalog(draft, catalog);
          return stampIdentity(
            localAgent
              ? { ...classified, models: localAgyModels(classified.models, displayName ?? localAgent) }
              : classified,
          );
        }),`,
      'replace',
    ],
    // The spawn is the only difference for sessions: upstream's runtime wrapper still maps
    // modes agy rejects and refuses agy releases this T3 does not support.
    [
      '      const executable = yield* installation.acquire(settings.binaryPath, processEnvironment).pipe(\n',
      `      if (localAgent) {
        if (auth.authMethod !== "oauth-personal" || !path.isAbsolute(settings.binaryPath)) {
          return yield* new ProviderSetupError({
            instanceId,
            operation: "configure",
            detail: "Use an absolute path to official agy and sign in with Google.",
          });
        }
        const localBaseSpawn = localAgySpawn(settings.binaryPath, localAgent, cwd, userHome, baseEnv);
        const agentMissing = (cause?: unknown) =>
          new ProviderSetupError({
            instanceId,
            operation: "start",
            detail: \`The registered agy agent '\${localAgent}' is not available. Check it with agy agents.\`,
            cause,
          });
        const listing = yield* spawner
          .string(
            ChildProcess.make(localBaseSpawn.command, ["agents"], {
              cwd,
              env: localBaseSpawn.env,
              extendEnv: false,
              shell: false,
            }),
          )
          .pipe(
            Effect.mapError(agentMissing),
            Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.fail(agentMissing()) }),
          );
        if (!hasLocalAgyAgent(listing, localAgent)) return yield* agentMissing();
        const executable: AntigravityInstallation.AntigravityExecutable = {
          executablePath: settings.binaryPath,
          source: "override",
          version: null,
          managedVersionDirectory: null,
        };
        if (!localIsolated) {
          return { executable, spawn: localAgyApprovalSpawn(localBaseSpawn, environment) };
        }
        const profile = yield* prepareAntigravityProfile({
          profileDirectory,
          baseEnv: processEnvironment,
          auth,
          userHome,
          tempDirectory: directories.runtimeTemp,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) =>
            isNodeRuntimeUnavailableError(cause.cause)
              ? new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: nodeRuntimeUnavailableMessage("Antigravity sign-in"),
                  cause,
                })
              : cause,
          ),
        );
        yield* Effect.promise(() =>
          linkLocalAgyProfileConfig(profile.geminiHome, userHome, profile.platform),
        );
        const runtimeTempDirectory = yield* Effect.acquireRelease(
          fileSystem.makeTempDirectory({ directory: profile.tempDirectory, prefix: "run-" }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: "Could not create an Antigravity runtime temp directory.",
                  cause,
                }),
            ),
          ),
          (directory) =>
            fileSystem
              .remove(directory, { recursive: true, force: true })
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning("Could not remove an Antigravity runtime temp directory."),
                ),
              ),
        );
        const isolatedSpawn = localAgyWithAgentArgs(
          buildAntigravityAcpSpawnInput({
            installation: executable,
            profile,
            cwd,
            baseEnv,
            auth,
            runtimeTempDirectory,
          }),
          localAgent,
        );
        return { executable, spawn: localAgyApprovalSpawn(isolatedSpawn, environment) };
      }
`,
    ],
    [
      '        runtimeVersion: executable.version,\n',
      '        runtimeVersion: executable.version,\n' +
      '        ...(localExistingLogin\n' +
      '          ? { useExistingLogin: true }\n' +
      '          : localIsolated\n' +
      '            ? { preferT3ClientInfo: true }\n' +
      '            : {}),\n',
      'replace',
    ],
    [
      '      const executable = yield* installation.resolve(settings.binaryPath, processEnvironment).pipe(\n',
      `      if (localAgent) {
        const available = yield* fileSystem
          .exists(settings.binaryPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (!available || !path.isAbsolute(settings.binaryPath)) {
          return yield* new ProviderSetupError({
            instanceId,
            operation: "resolve",
            detail: "The official agy binary is missing. Install it and sign in with agy.",
          });
        }
        return {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: localIsolated ? [{ id: "oauth-personal", name: "Log in with Google" }] : [],
          agentInfo: { name: "agy", version: "" },
        };
      }
`,
    ],
    [
      '    const usage = yield* makeAntigravityUsageProbe({\n      profileDirectory,',
      '    const usage = yield* makeAntigravityUsageProbe({\n      profileDirectory,\n      useLocalAgyLogin: localExistingLogin,',
      'replace',
    ],
    [
      '      supportsTextGeneration: isAntigravityTextGenerationAvailable(profileDirectory).pipe(',
      '      supportsTextGeneration: localAgent\n' +
      '        ? Effect.succeed(false)\n' +
      '        : isAntigravityTextGenerationAvailable(profileDirectory).pipe(',
      'replace',
    ],
    [
      '      makeRuntime: (cwd) =>\n        makeRuntime({\n',
      `      makeRuntime: (cwd) =>
        localAgent
          ? Effect.fail(
              new ProviderSetupError({
                instanceId,
                operation: "configure",
                detail: "The local Antigravity agent is for interactive chat only.",
              }),
            )
          : makeRuntime({
`,
      'replace',
    ],
    [
      '    return {\n      instanceId,\n      driverKind: DRIVER,\n      continuationIdentity,\n',
      `    // Read the account's actual model list at start, without sending a prompt.
    if (enabled && localExistingLogin) {
      yield* refreshModels().pipe(
        Effect.catch((cause) => Effect.logWarning(cause.detail)),
        Effect.forkScoped,
      );
    }

`,
    ],
    // Without the controller nothing can start agy's sign-in or sign it out of its own login.
    // Isolated accounts use their own per-instance profile, so they keep the sign-in controller.
    [
      '      auth: authFlow.controller,\n      refreshModels,\n',
      '      ...(localExistingLogin ? {} : { auth: authFlow.controller }),\n      refreshModels,\n',
      'replace',
    ],
  ],
};
