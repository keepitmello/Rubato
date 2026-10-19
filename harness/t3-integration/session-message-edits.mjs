// A message another Rubato conversation sent into this one. The bridge stores it
// as a user message carrying one `rubato-session` context record (src/events.mjs
// sessionMessageFrom; the server appends it in RubatoPiInventory.ts). The
// timeline draws that message as its own bubble, headed by the sending
// conversation's title, instead of as the person's own bubble.
// A wake whose answer is for the person (Segno asked to review its prompt) arrives the same
// way, so it opens its turn, but its row draws nothing and, marked data-rubato-wake-row, takes no room
// (rubatoPolish.css): only the turn shows.
export const sessionMessageOverlays = [
  'apps/web/src/components/chat/RubatoSessionMessage.tsx',
  'apps/web/src/components/chat/RubatoSessionMessage.test.tsx',
];

export const sessionMessageEdits = {
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    // Such a wake opens its turn but shows nothing; the marker lets its row give back the room
    // a message row keeps (rubatoPolish.css).
    ['      data-timeline-row-kind={row.kind}\n',
      '      data-rubato-wake-row={\n'
      + '        row.kind === "message" && rubatoSessionMessageOf(row.message)?.kind === "wake" ? "" : undefined\n'
      + '      }\n'],
    ['import { MessageCopyButton } from "./MessageCopyButton";\n',
      'import { RubatoSessionMessageBubble, rubatoSessionMessageOf } from "./RubatoSessionMessage";\n'],
    [
      '      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}\n',
      [
        '      {row.kind === "message" && row.message.role === "user" ? (',
        '        rubatoSessionMessageOf(row.message) ? (',
        '          <RubatoSessionTimelineRow row={row} />',
        '        ) : (',
        '          <UserTimelineRow row={row} />',
        '        )',
        '      ) : null}',
        '',
      ].join('\n'),
      'replace',
    ],
    ['function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {\n',
      [
        '// Rubato: a message another conversation sent into this one (RubatoSessionMessage.tsx).',
        '// Its text is markdown like any prompt; it offers no revert, since no prompt of',
        '// this thread stands behind it.',
        'const renderSessionContextReference = (reference: ChatMarkdownContextReference) =>',
        '  reference.label;',
        '',
        'function RubatoSessionTimelineRow({',
        '  row,',
        '}: {',
        '  row: Extract<TimelineRow, { kind: "message" }>;',
        '}) {',
        '  const ctx = use(TimelineRowCtx);',
        '  const link = rubatoSessionMessageOf(row.message);',
        '  if (!link) return null;',
        '  return (',
        '    <RubatoSessionMessageBubble',
        '      link={link}',
        '      text={row.message.text}',
        '      meta={',
        '        <div className="flex shrink-0 items-center gap-2">',
        '          <Tooltip>',
        '            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>',
        '              {formatDayAwareTimestamp(row.message.createdAt, ctx.timestampFormat)}',
        '            </TooltipTrigger>',
        '            <TooltipPopup>',
        '              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}',
        '            </TooltipPopup>',
        '          </Tooltip>',
        '          {row.message.text ? <MessageCopyButton text={row.message.text} variant="ghost" /> : null}',
        '        </div>',
        '      }',
        '    >',
        '      <CollapsibleUserMessageBody',
        '        text={row.message.text}',
        '        renderContextReference={renderSessionContextReference}',
        '        skills={ctx.skills}',
        '        markdownCwd={ctx.markdownCwd}',
        '      />',
        '    </RubatoSessionMessageBubble>',
        '  );',
        '}',
        '',
        '',
      ].join('\n')],
  ],
};
