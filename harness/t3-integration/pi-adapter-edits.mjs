// The Rubato provider runs on upstream's Pi adapter. Pi and Rubato speak the same
// RPC protocol: every Rubato session is a `rubato-pi --mode rpc` worker behind the
// shared engine (harness/pi-server), so upstream's mapping of Pi events onto the V2
// orchestrator (turns, items, settles, wakes, usage) is the one we want. What differs
// is where the RPC stream comes from: upstream spawns one `pi` per session, Rubato
// attaches to the engine through the bridge (src/bridge.mjs openRpc). These edits
// only open the adapter to a caller-supplied driver kind, connection and capability
// set; with none supplied the upstream Pi driver behaves exactly as before.
export const piAdapterOverlays = [
  'apps/server/src/provider/RubatoThreadImporter.ts',
  'apps/server/src/provider/RubatoThreadImporter.test.ts',
];

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
        '  /** Forks through the caller instead of a short-lived `pi --fork` process; returns the new native id. */',
        '  readonly forkSession?: (input: {',
        '    readonly sourceNativeId: string;',
        '    /** The first entry the fork leaves out; null keeps the completed history. */',
        '    readonly beforeEntryId: string | null;',
        '    readonly cwd: string;',
        '  }) => Effect.Effect<string, import("./rpc.ts").PiRpcError>;',
        '  /** Answers T3\'s history handoffs natively (true) or leaves them inline (false). */',
        '  readonly injectHistory?: ProviderAdapter.ProviderAdapterV2SessionRuntime["injectHistory"];',
        '  /** One more record after the model and thinking level, for options upstream Pi has no field for. */',
        '  readonly selectionRecord?: (modelSelection: ModelSelection) => PiRpcRecord | null;',
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
    [
      '          appliedThinking = thinking;\n        }\n      });\n\n      const resolvePromptPayload',
      [
        '          appliedThinking = thinking;',
        '        }',
        '        const extra = options.selectionRecord?.(modelSelection) ?? null;',
        '        if (extra !== null) yield* request(extra);',
        '      });',
        '',
        '      const resolvePromptPayload',
      ].join('\n'),
      'replace',
    ],
    [
      '            const nativeId = yield* Effect.scoped(\n',
      [
        '            const nativeId = options.forkSession !== undefined',
        '              ? yield* options.forkSession({ sourceNativeId: sourceFile, beforeEntryId: beforeEntry, cwd })',
        '              : yield* Effect.scoped(',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '        events: Stream.fromQueue(events),\n        hasPendingBackgroundWork:',
      '        ...(options.injectHistory === undefined ? {} : { injectHistory: options.injectHistory }),\n',
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
  // The Rubato thread writer (RubatoThreadImporter.ts) runs inside the V2 runtime beside
  // upstream's AgentSessionImporter: both write through the runtime's own event sink.
  'apps/server/src/orchestration-v2/runtimeLayer.ts': [
    ['import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";\n',
      'import * as RubatoThreadImporter from "../provider/RubatoThreadImporter.ts";\n'],
    ['  layerAgentSessionImporterProvided,\n  EffectOutbox.layerPruneWorker',
      '  RubatoThreadImporter.layer.pipe(Layer.provide(Layer.mergeAll(layerEventSinkProvided, IdAllocator.layer))),\n'],
  ],
};
