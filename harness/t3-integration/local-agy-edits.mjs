// Local Antigravity: an Antigravity instance whose environment sets RUBATO_LOCAL_AGY_AGENT
// drives the user's own official `agy` CLI with that agy agent and the login agy already
// has, instead of T3's isolated profile and sign-in. The instance starts
// `agy acp --sandbox --agent <name>` with the user's HOME and a minimal environment, refuses
// agents `agy agents` does not list (agy would silently fall back to its default), never
// authenticates or signs out on agy's behalf, offers only Gemini models labelled with the
// agent, and has no quota probe or background text generation. Instances without the
// variable keep upstream's behavior.
const driver = 'apps/server/src/provider/Drivers/AntigravityDriver.ts';
const support = 'apps/server/src/provider/acp/AntigravityAcpSupport.ts';

export const localAgyOverlays = [
  'apps/server/src/provider/RubatoLocalAgy.ts',
  'apps/server/src/provider/Drivers/RubatoLocalAgyDriver.test.ts',
];

export const localAgyEdits = {
  [support]: [
    [
      '  readonly authMethod?: AntigravityAuthMethod;\n',
      '  readonly authMethod?: AntigravityAuthMethod;\n' +
      '  /** Rely on the login the agy CLI already holds: no eager or on-demand authenticate. */\n' +
      '  readonly useExistingLogin?: boolean;\n' +
      '  readonly clientInfo?: AcpSessionRuntime.AcpSessionRuntimeOptions["clientInfo"];\n',
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
      '      clientInfo: input.clientInfo ?? antigravityClientInfo(input.runtimeVersion),',
      'replace',
    ],
  ],
  [driver]: [
    [
      'import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";\n',
      'import { hasLocalAgyAgent, localAgyAgent, localAgyModels, localAgySpawn } from "../RubatoLocalAgy.ts";\n',
    ],
    [
      '    const settings = { ...config, enabled } satisfies AntigravitySettings;\n',
      '    const settings = { ...config, enabled } satisfies AntigravitySettings;\n' +
      '    const localAgent = localAgyAgent(environment);\n',
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
            detail: "Use an absolute path to official agy and sign in from agy itself.",
          });
        }
        const spawn = localAgySpawn(settings.binaryPath, localAgent, cwd, userHome, baseEnv);
        const agentMissing = (cause?: unknown) =>
          new ProviderSetupError({
            instanceId,
            operation: "start",
            detail: \`The registered agy agent '\${localAgent}' is not available. Check it with agy agents.\`,
            cause,
          });
        const listing = yield* spawner
          .string(
            ChildProcess.make(spawn.command, ["agents"], {
              cwd,
              env: spawn.env,
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
        return { executable, spawn };
      }
`,
    ],
    [
      '        runtimeVersion: executable.version,\n',
      '        runtimeVersion: executable.version,\n' +
      '        ...(localAgent\n' +
      '          ? {\n' +
      '              useExistingLogin: true,\n' +
      '              clientInfo: { name: "rubato", version: processEnvironment.RUBATO_APP_VERSION || "0.0.0" },\n' +
      '            }\n' +
      '          : {}),\n',
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
          authMethods: [],
          agentInfo: { name: "agy", version: "" },
        };
      }
`,
    ],
    [
      '      probeUsage: usage.probe,\n      clearUsage: usage.clear,\n',
      '      ...(localAgent ? {} : { probeUsage: usage.probe, clearUsage: usage.clear }),\n',
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
    if (enabled && localAgent) {
      yield* refreshModels().pipe(
        Effect.catch((cause) => Effect.logWarning(cause.detail)),
        Effect.forkScoped,
      );
    }

`,
    ],
    // Without the controller nothing can start agy's sign-in or sign it out of its own login.
    [
      '      auth: authFlow.controller,\n      refreshModels,\n',
      '      ...(localAgent ? {} : { auth: authFlow.controller }),\n      refreshModels,\n',
      'replace',
    ],
  ],
};
