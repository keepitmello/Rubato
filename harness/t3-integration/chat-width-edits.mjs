// Chat width as a percentage. T3 offers three presets (Comfortable / Wide / Full)
// whose pixel caps the settings screen never states, so nobody can tell what
// "Wide" means or aim between two of them. The setting is a percentage, 40-100%,
// set with a slider like Glass opacity.
//
// The width grows with the window but not as a plain share of it:
// width = percent x (0.6 x window width + 1024px). A plain share looked right on
// a 4K monitor (window 2560px, 50% = 1280px) and narrow on a laptop (window
// 1472px, 50% = 736px, about 200px empty on each side of an 1150px chat column),
// because a short line reads as narrow however much of the column it fills. The
// fixed part gives a small window a larger share: at 50% the laptop gets 954px
// and the 4K monitor still 1280px. At 100% the width passes the chat column on
// both, so the messages fill it. A fixed pixel cap was tried and rejected: the
// width has to grow with the monitor.
//
// The old `chatWidth` preset is gone. A saved "wide" or "full" is ignored on
// load and the width falls back to the 50% default.
//
// The base is the window (vw), not the chat column. Opening or resizing the right
// panel or the sidebar narrows the column; a share of the column made the
// messages shrink with it while empty margins stayed. When the column gets
// narrower than the width, the column bounds it.
// The value holds no `%` on purpose: the composer stack, shell and form and the
// timeline rows and separator all cap at it one inside the other, and a `%` (or a
// `cqi` inside the shell, itself a container) resolves at each of them again.
export const chatWidthOverlays = [];

const SETTINGS_TEST_OLD = [
  'describe("ClientSettings chat width", () => {',
  '  it("keeps the comfortable width for existing settings without a saved width", () => {',
  '    expect(decodeClientSettings({}).chatWidth).toBe("comfortable");',
  '  });',
  '',
  '  it.each(["comfortable", "wide", "full"])("round-trips the %s width", (chatWidth) => {',
  '    const settings = decodeClientSettings({ chatWidth });',
  '    expect(encodeClientSettings(settings).chatWidth).toBe(chatWidth);',
  '    expect(decodeClientSettingsPatch({ chatWidth }).chatWidth).toBe(chatWidth);',
  '  });',
  '',
  '  it("rejects unsupported widths", () => {',
  '    expect(() => decodeClientSettings({ chatWidth: "huge" })).toThrow();',
  '    expect(() => decodeClientSettingsPatch({ chatWidth: "huge" })).toThrow();',
  '  });',
  '});',
  '',
].join('\n');

const SETTINGS_TEST_NEW = [
  'describe("ClientSettings chat width", () => {',
  '  it("defaults to the shared default width when none is saved", () => {',
  '    expect(decodeClientSettings({}).chatWidthPercent).toBe(DEFAULT_CHAT_WIDTH_PERCENT);',
  '  });',
  '',
  '  it.each([MIN_CHAT_WIDTH_PERCENT, 72, MAX_CHAT_WIDTH_PERCENT])(',
  '    "round-trips a %s percent width",',
  '    (chatWidthPercent) => {',
  '      const settings = decodeClientSettings({ chatWidthPercent });',
  '      expect(encodeClientSettings(settings).chatWidthPercent).toBe(chatWidthPercent);',
  '      expect(decodeClientSettingsPatch({ chatWidthPercent }).chatWidthPercent).toBe(',
  '        chatWidthPercent,',
  '      );',
  '    },',
  '  );',
  '',
  '  it("rejects widths outside the slider range", () => {',
  '    for (const chatWidthPercent of [MIN_CHAT_WIDTH_PERCENT - 1, MAX_CHAT_WIDTH_PERCENT + 1, 50.5]) {',
  '      expect(() => decodeClientSettings({ chatWidthPercent })).toThrow();',
  '      expect(() => decodeClientSettingsPatch({ chatWidthPercent })).toThrow();',
  '    }',
  '  });',
  '',
  '  it("ignores the old preset names saved by earlier versions", () => {',
  '    expect(decodeClientSettings({ chatWidth: "wide" }).chatWidthPercent).toBe(',
  '      DEFAULT_CHAT_WIDTH_PERCENT,',
  '    );',
  '  });',
  '});',
  '',
].join('\n');

const ROW_OLD = [
  '          control={',
  '            <div className="w-full sm:w-40">',
  '              <Select',
  '                value={settings.chatWidth}',
  '                onValueChange={(value) => {',
  '                  if (value === "comfortable" || value === "wide" || value === "full")',
  '                    updateSettings({ chatWidth: value });',
  '                }}',
  '              >',
  '                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Chat width">',
  '                  <SelectValue>{CHAT_WIDTH_LABELS[settings.chatWidth]}</SelectValue>',
  '                </SelectTrigger>',
  '                <SelectPopup align="end" alignItemWithTrigger={false}>',
  '                  <SelectItem value="comfortable">Comfortable (default)</SelectItem>',
  '                  <SelectItem value="wide">Wide</SelectItem>',
  '                  <SelectItem value="full">Full</SelectItem>',
  '                </SelectPopup>',
  '              </Select>',
  '            </div>',
  '          }',
  '',
].join('\n');

const ROW_NEW = [
  '          control={',
  '            <div className="flex w-full items-center gap-3 sm:w-52">',
  '              <output',
  '                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"',
  '                htmlFor="chat-width"',
  '              >',
  '                {settings.chatWidthPercent}%',
  '              </output>',
  '              <input',
  '                aria-label="Chat width"',
  '                className="settings-slider min-w-0 flex-1"',
  '                id="chat-width"',
  '                max={MAX_CHAT_WIDTH_PERCENT}',
  '                min={MIN_CHAT_WIDTH_PERCENT}',
  '                onChange={(event) => {',
  '                  const chatWidthPercent = Number(event.currentTarget.value);',
  '                  if (',
  '                    Number.isInteger(chatWidthPercent) &&',
  '                    chatWidthPercent >= MIN_CHAT_WIDTH_PERCENT &&',
  '                    chatWidthPercent <= MAX_CHAT_WIDTH_PERCENT',
  '                  ) {',
  '                    updateSettings({ chatWidthPercent });',
  '                  }',
  '                }}',
  '                step={1}',
  '                style={chatWidthSliderStyle}',
  '                type="range"',
  '                value={settings.chatWidthPercent}',
  '              />',
  '            </div>',
  '          }',
  '',
].join('\n');

export const chatWidthEdits = {
  'packages/contracts/src/settings.ts': [
    [
      '/** Maximum width of the chat timeline and composer on wide screens. */\nexport const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);\nexport type ChatWidth = typeof ChatWidth.Type;\n',
      [
        '/** Chat width in percent; it scales with the window (index.css --chat-max-width). */',
        'export const MIN_CHAT_WIDTH_PERCENT = 40;',
        'export const MAX_CHAT_WIDTH_PERCENT = 100;',
        'export const DEFAULT_CHAT_WIDTH_PERCENT = 50;',
        'export const ChatWidthPercent = Schema.Int.check(',
        '  Schema.isBetween({ minimum: MIN_CHAT_WIDTH_PERCENT, maximum: MAX_CHAT_WIDTH_PERCENT }),',
        ');',
        'export type ChatWidthPercent = typeof ChatWidthPercent.Type;',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '  chatWidth: ChatWidth.pipe(Schema.withDecodingDefault(Effect.succeed("comfortable" as const))),\n',
      '  chatWidthPercent: ChatWidthPercent.pipe(\n    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAT_WIDTH_PERCENT)),\n  ),\n',
      'replace',
    ],
    ['  chatWidth: Schema.optionalKey(ChatWidth),\n', '  chatWidthPercent: Schema.optionalKey(ChatWidthPercent),\n', 'replace'],
  ],
  'packages/contracts/src/settings.test.ts': [
    ['  DEFAULT_SERVER_SETTINGS,\n  resolveProviderInstanceEnabled,\n',
      '  DEFAULT_CHAT_WIDTH_PERCENT,\n  DEFAULT_SERVER_SETTINGS,\n  MAX_CHAT_WIDTH_PERCENT,\n  MIN_CHAT_WIDTH_PERCENT,\n  resolveProviderInstanceEnabled,\n',
      'replace'],
    [SETTINGS_TEST_OLD, SETTINGS_TEST_NEW, 'replace'],
  ],
  'apps/web/src/index.css': [
    [
      [
        '/* Chat timeline and composer column width, set from the Chat width setting. */',
        ':root {',
        '  --chat-max-width: 48rem;',
        '}',
        '',
        ':root[data-chat-width="wide"] {',
        '  --chat-max-width: 72rem;',
        '}',
        '',
        ':root[data-chat-width="full"] {',
        '  --chat-max-width: 100%;',
        '}',
        '',
      ].join('\n'),
      [
        '/* Chat timeline and composer column width. --chat-width-percent comes from the',
        '   Chat width setting (__root.tsx). The width grows with the window, and the',
        '   fixed part gives a small window a larger share: at 50% a 1472px window gets',
        '   954px and a 2560px one 1280px (chat-width-edits.mjs). Side panels and the',
        '   sidebar leave it alone until the chat column is narrower. No % here:',
        '   nested boxes cap at this value and a % would resolve at each of them. */',
        ':root {',
        '  --chat-width-percent: 50;',
        '  --chat-max-width: calc(var(--chat-width-percent) * (0.6vw + 10.24px));',
        '}',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/routes/__root.tsx': [
    [
      [
        '  const chatWidth = useClientSettings((settings) => settings.chatWidth);',
        '  useEffect(() => {',
        '    document.documentElement.dataset.chatWidth = chatWidth;',
        '  }, [chatWidth]);',
        '',
      ].join('\n'),
      [
        '  const chatWidthPercent = useClientSettings((settings) => settings.chatWidthPercent);',
        '  useEffect(() => {',
        '    document.documentElement.style.setProperty("--chat-width-percent", String(chatWidthPercent));',
        '  }, [chatWidthPercent]);',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    ['  const chatWidth = useClientSettings((settings) => settings.chatWidth);\n',
      '  const chatWidthPercent = useClientSettings((settings) => settings.chatWidthPercent);\n', 'replace'],
    ['rows.length, reportContentOverflow, chatWidth]);', 'rows.length, reportContentOverflow, chatWidthPercent]);', 'replace'],
  ],
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['  type ChatWidth,\n', '  MAX_CHAT_WIDTH_PERCENT,\n  MIN_CHAT_WIDTH_PERCENT,\n', 'replace'],
    [
      'const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {\n  comfortable: "Comfortable",\n  wide: "Wide",\n  full: "Full",\n};\n\nconst DIFF_LAYOUT_LABELS',
      '// Chat width is a percentage slider (chat-width-edits.mjs), so it has no labels.\n\nconst DIFF_LAYOUT_LABELS',
      'replace',
    ],
    [
      '  const appearanceContrastRatio =\n',
      [
        '  const chatWidthRatio =',
        '    (settings.chatWidthPercent - MIN_CHAT_WIDTH_PERCENT) /',
        '    (MAX_CHAT_WIDTH_PERCENT - MIN_CHAT_WIDTH_PERCENT);',
        '  const chatWidthSliderStyle = {',
        '    "--settings-slider-progress": `${chatWidthRatio * 100}%`,',
        '    "--settings-slider-fill-offset": `${0.5 - chatWidthRatio}rem`,',
        '  } as CSSProperties;',
        '',
      ].join('\n'),
    ],
    ['      ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? ["Chat width"] : []),\n',
      '      ...(settings.chatWidthPercent !== DEFAULT_UNIFIED_SETTINGS.chatWidthPercent\n        ? ["Chat width"]\n        : []),\n', 'replace'],
    ['      settings.chatWidth,\n', '      settings.chatWidthPercent,\n', 'replace'],
    ['      chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,\n', '      chatWidthPercent: DEFAULT_UNIFIED_SETTINGS.chatWidthPercent,\n', 'replace'],
    [
      '            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (\n              <SettingResetButton\n                label="chat width"\n                onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}\n              />',
      '            settings.chatWidthPercent !== DEFAULT_UNIFIED_SETTINGS.chatWidthPercent ? (\n              <SettingResetButton\n                label="chat width"\n                onClick={() =>\n                  updateSettings({ chatWidthPercent: DEFAULT_UNIFIED_SETTINGS.chatWidthPercent })\n                }\n              />',
      'replace',
    ],
    [ROW_OLD, ROW_NEW, 'replace'],
    ['  description="Set how wide messages and the composer can grow on large screens."\n',
      '  description="Set how wide messages and the composer grow. The width scales with the window; smaller windows get a larger share."\n', 'replace'],
  ],
};
