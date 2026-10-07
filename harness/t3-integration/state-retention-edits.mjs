// Retention for the GUI server's state DB (RubatoStateRetention.ts). T3 keeps
// every orchestration event, command receipt and work-log row forever, and the
// file grew ~150MB a day. The server's persistence layer becomes T3's SQLite
// layer plus a job that prunes at startup and every 6 hours, and that switches
// the file to incremental auto-vacuum with one VACUUM the first time.
//
// Only the server takes the job. The project CLI opens the same file through
// its own layer and is left as it is.
//
// tsconfig.base.json: TypeScript 7 (tsgo) type-checks with several checkers in
// parallel, and each holds its own copy of the program. One checker took the
// server's typecheck from a 6.1GB peak to 3.5GB for ~10% more time.
export const stateRetentionOverlays = [
  'apps/server/src/RubatoStateRetention.ts',
];

export const stateRetentionEdits = {
  'apps/server/src/server.ts': [
    ['import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";',
      'import { rubatoStatePersistenceLayer as SqlitePersistenceLayerLive } from "./RubatoStateRetention.ts";',
      'replace'],
  ],
  'tsconfig.base.json': [
    ['  "compilerOptions": {\n    "target": "ESNext",\n',
      '  "compilerOptions": {\n    "checkers": 1,\n    "target": "ESNext",\n',
      'replace'],
  ],
};
