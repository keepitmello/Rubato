// The Rubato provider runs on upstream's Pi adapter. Pi and Rubato speak the same
// RPC protocol: every Rubato session is a `rubato-pi --mode rpc` worker behind the
// shared engine (harness/pi-server), so upstream's mapping of Pi events onto the V2
// orchestrator (turns, items, settles, wakes, usage) is the one we want. What differs
// is where the RPC stream comes from: upstream spawns one `pi` per session, Rubato
// attaches to the engine through the bridge (src/bridge.mjs openRpc). These edits
// only open the adapter to a caller-supplied driver kind, connection and capability
// set; with none supplied the upstream Pi driver behaves exactly as before.
export const piAdapterOverlays = [];

export const piAdapterEdits = {
  'packages/provider-pi/src/server/adapter.ts': [
    [
      'export interface PiAdapterV2Options {\n',
      [
        '/** The upstream capability set, for adapters that start from it (Rubato). */',
        'export const PI_CAPABILITIES_V2: OrchestrationV2ProviderCapabilities = PiProviderCapabilitiesV2;',
        '',
        '',
      ].join('\n'),
    ],
    [
      '  readonly environment: NodeJS.ProcessEnv;\n',
      [
        '  readonly environment: NodeJS.ProcessEnv;',
        '  /** Driver kind stamped on every event and ref; defaults to Pi. */',
        '  readonly driverKind?: ProviderDriverKind;',
        '  /** Replaces spawning `pi --mode rpc` with a connection the caller owns. */',
        '  readonly openConnection?: (',
        '    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput & { readonly cwd: string },',
        '  ) => Effect.Effect<PiRpcConnection, import("./rpc.ts").PiRpcError, import("effect/Scope").Scope>;',
        '  /** What this provider can do, when it is not upstream Pi. */',
        '  readonly capabilities?: OrchestrationV2ProviderCapabilities;',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;\n  const agentScope = yield* AgentScope;\n',
      [
        '  // Rubato: shadow the module constants so a caller-supplied kind and capability',
        '  // set reach every event, ref and session this adapter makes.',
        '  const PI_PROVIDER = options.driverKind ?? PI_DRIVER_KIND;',
        '  const PiProviderCapabilitiesV2 = options.capabilities ?? PI_CAPABILITIES_V2;',
        '  const providerRef = (',
        '    nativeId: string,',
        '    strength: "strong" | "weak" = "strong",',
        '  ): OrchestrationV2ProviderRef => ({ driver: PI_PROVIDER, nativeId, strength });',
        '',
      ].join('\n'),
    ],
    [
      '      const connection: PiRpcConnection = yield* makePiRpcConnection({\n        command: scopedLaunch.command,\n',
      [
        '      const connection: PiRpcConnection = options.openConnection',
        '        ? yield* options.openConnection({ ...input, cwd }).pipe(',
        '            Effect.mapError(',
        '              (cause) =>',
        '                new ProviderAdapter.ProviderAdapterOpenSessionError({',
        '                  driver: PI_PROVIDER,',
        '                  providerSessionId: input.providerSessionId,',
        '                  cause,',
        '                }),',
        '            ),',
        '          )',
        '        : yield* makePiRpcConnection({',
        '        command: scopedLaunch.command,',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'packages/provider-pi/src/server.ts': [
    [
      'export { PI_PROVIDER, PiAdapterV2Driver, type PiAdapterV2DriverEnv } from "./server/adapter.ts";\n',
      [
        'export { PI_PROVIDER, PiAdapterV2Driver, type PiAdapterV2DriverEnv } from "./server/adapter.ts";',
        'export {',
        '  PI_CAPABILITIES_V2,',
        '  makePiAdapterV2,',
        '  type PiAdapterV2Options,',
        '} from "./server/adapter.ts";',
        'export { PiRpcError, type PiRpcConnection, type PiRpcRecord } from "./server/rpc.ts";',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
};
