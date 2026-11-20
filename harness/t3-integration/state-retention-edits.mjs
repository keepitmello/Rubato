// Retention for the GUI server's state DB on T3's V2 orchestrator (RubatoStateRetention.ts).
// Upstream compacts the event store only when asked (Settings' Reclaim at exit, `t3 doctor`)
// and otherwise keeps every event and receipt. The server's persistence layer gains a job that
// prunes after activation/initial UI loading and every 6 hours, and switches a file created
// before upstream's incremental auto-vacuum default to it the first time.
//
// Only the server takes the job: the CLI opens the same file through its own layers.
export const stateRetentionOverlays = [
  'apps/server/src/RubatoStateRetention.ts',
  'apps/server/src/RubatoStateRetention.test.ts',
];

export const stateRetentionEdits = {
  'apps/server/src/server.ts': [
    ['import * as SqlitePersistence from "./persistence/Sqlite.ts";\n',
      'import * as SqlitePersistence from "./persistence/Sqlite.ts";\nimport { rubatoStateRetentionLayer } from "./RubatoStateRetention.ts";\n',
      'replace'],
    ['const layerPersistence = Layer.empty.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));',
      '// Rubato: the state DB stays bounded (state-retention-edits.mjs).\nconst layerPersistence = rubatoStateRetentionLayer.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));',
      'replace'],
  ],
};
