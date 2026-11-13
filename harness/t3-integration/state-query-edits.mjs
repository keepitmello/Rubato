// The GUI server reads its state DB on one synchronous SQLite connection, so a slow statement
// stops every request. These edits point upstream's hot reads at indexes that answer them, and
// RubatoQueryPlans.test.ts runs those reads and fails on any plan that walks a large table.
//
// The newest V2 thread event: upstream asks MAX(sequence) over V2 thread events, which no index
// answers, so SQLite walked a whole index (0.7s on average, 8.7s cold, on 750k events). Reading
// the (version, sequence) index backwards stops at the first V2 thread event, near the end.
export const stateQueryOverlays = [
  'apps/server/src/RubatoQueryPlans.test.ts',
];

const NEWEST_THREAD_EVENT = `FROM orchestration_events INDEXED BY idx_orchestration_events_application_sequence
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
        ORDER BY sequence DESC
        LIMIT 1`;

export const stateQueryEdits = {
  'apps/server/src/orchestration-v2/ProjectionStore.ts': [
    [`            sql<{ readonly snapshot_sequence: number | null }>\`
        SELECT MAX(sequence) AS snapshot_sequence
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
      \`,`,
    `            sql<{ readonly snapshot_sequence: number | null }>\`
        SELECT sequence AS snapshot_sequence
        ${NEWEST_THREAD_EVENT}
      \`,`,
    'replace'],
  ],
  'apps/server/src/persistence/OrchestrationEventStore.ts': [
    [`      SELECT MAX(sequence) AS sequence
      FROM orchestration_events
      \${
        threadId === undefined
          ? sql\`\`
          : sql\`INDEXED BY idx_orchestration_events_agent_stream_sequence\`
      }
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        \${threadId === undefined ? sql\`\` : sql\`AND stream_id = \${threadId}\`}
    \``,
    `      \${
        threadId === undefined
          ? sql\`SELECT sequence ${NEWEST_THREAD_EVENT}\`
          : sql\`SELECT MAX(sequence) AS sequence
      FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        AND stream_id = \${threadId}\`
      }
    \``,
    'replace'],
  ],
};
