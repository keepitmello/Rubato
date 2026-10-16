// Pre-cutover threads move to V2 through upstream's LegacyV1ThreadImporter, which brings
// user and assistant text only (user decision, intent rev 4: option A). One V1 bridge bug
// stored a reply's thinking as an assistant message with an id ending `:reasoning`
// (713 rows across 19 threads on the live database); the V1 screen filtered them out, the
// V2 one would show each as an extra answer. The importer leaves them out instead.
export const legacyImportOverlays = [
  'apps/server/src/orchestration-v2/legacy/RubatoLegacyReasoning.test.ts',
];

const MALFORMED = (alias) =>
  `NOT (${alias}role = 'assistant' AND ${alias}message_id LIKE 'assistant:pi:%:reasoning')`;

const earlier = "              AND earlier.role IN ('user', 'assistant')\n";
const earlierFixed = `${earlier}              AND ${MALFORMED('earlier.')}\n`;
const shellBetween = [
  '              AND (',
  '                earlier.created_at < message.created_at',
  '                OR (',
  '                  earlier.created_at = message.created_at',
  '                  AND earlier.message_id <= message.message_id',
  '                )',
  '              )',
  '          ) AS ordinal',
  '        FROM projection_thread_messages AS message',
  '        WHERE message.thread_id = ${threadId}',
  '',
].join('\n');
const outerShell = "          AND message.role IN ('user', 'assistant')\n";

export const legacyImportEdits = {
  'apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts': [
    [
      "        AND role IN ('user', 'assistant')\n      ORDER BY created_at ASC, message_id ASC\n",
      `        AND role IN ('user', 'assistant')\n        AND ${MALFORMED('')}\n      ORDER BY created_at ASC, message_id ASC\n`,
      'replace',
    ],
    // The latest-message shell query: its ordinal subquery and its own filter. Taken first,
    // so the identical subquery of the latest-user query is then the only one left.
    [
      earlier + shellBetween + outerShell,
      earlierFixed + shellBetween + outerShell + `          AND ${MALFORMED('message.')}\n`,
      'replace',
    ],
    [`${earlier}              AND (\n`, `${earlierFixed}              AND (\n`, 'replace'],
  ],
};
