// Retention for the GUI server's state DB on T3's V2 orchestrator (RubatoStateRetention.ts).
// Upstream keeps every event and receipt, never calls its own compaction, and starts
// statev2.sqlite as a full copy of the V1 database. The server's persistence layer gains a
// job that prunes at startup and every 6 hours and switches the file to incremental
// auto-vacuum the first time.
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
