// Chat width as a pixel cap. T3 offers three presets (Comfortable / Wide / Full)
// whose pixel caps the settings screen never states, so nobody can tell what
// "Wide" means or aim between two of them. The setting is now the widest the
// messages and the composer may grow, 640-1600px, set with a slider like Glass
// opacity and shown as the number. The top of the slider is "Full": no cap.
//
// A fixed length, so the same setting reads the same on every monitor. A share
// of the window gave a laptop 734px with wide empty margins and an external
// monitor 1280px from the same 50%. A share of the chat column moved with the
// right panel and the sidebar. A length moves with neither: when the chat column
// is narrower than the cap, the column bounds it and the messages fill it.
//
// The old `chatWidth` preset and `chatWidthPercent` share are gone. A saved value
// of either is ignored on load and the width falls back to the default.
//
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
  '    expect(decodeClientSettings({}).chatMaxWidth).toBe(DEFAULT_CHAT_MAX_WIDTH);',
  '  });',
  '',
  '  it.each([MIN_CHAT_MAX_WIDTH, 960, MAX_CHAT_MAX_WIDTH])("round-trips a %spx width", (chatMaxWidth) => {',
  '    const settings = decodeClientSettings({ chatMaxWidth });',
  '    expect(encodeClientSettings(settings).chatMaxWidth).toBe(chatMaxWidth);',
  '    expect(decodeClientSettingsPatch({ chatMaxWidth }).chatMaxWidth).toBe(chatMaxWidth);',
  '  });',
  '',
  '  it("rejects widths outside the slider range", () => {',
  '    for (const chatMaxWidth of [MIN_CHAT_MAX_WIDTH - 1, MAX_CHAT_MAX_WIDTH + 1, 960.5]) {',
  '      expect(() => decodeClientSettings({ chatMaxWidth })).toThrow();',
  '      expect(() => decodeClientSettingsPatch({ chatMaxWidth })).toThrow();',
  '    }',
  '  });',
  '',
  '  it("ignores the widths saved by earlier versions", () => {',
  '    expect(decodeClientSettings({ chatWidth: "wide" }).chatMaxWidth).toBe(DEFAULT_CHAT_MAX_WIDTH);',
  '    expect(decodeClientSettings({ chatWidthPercent: 50 }).chatMaxWidth).toBe(',
  '      DEFAULT_CHAT_MAX_WIDTH,',
  '    );',
  '  });',
  '',
  '  it("caps at the width in pixels and lifts the cap at the top of the slider", () => {',
  '    expect(chatMaxWidthCss(MIN_CHAT_MAX_WIDTH)).toBe(`${MIN_CHAT_MAX_WIDTH}px`);',
  '    expect(chatMaxWidthCss(960)).toBe("960px");',
  '    expect(chatMaxWidthCss(MAX_CHAT_MAX_WIDTH)).toBe("none");',
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
  '            <div className="flex w-full items-center gap-3 sm:w-56">',
  '              <output',
  '                className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"',
  '                htmlFor="chat-width"',
  '              >',
  '                {settings.chatMaxWidth >= MAX_CHAT_MAX_WIDTH ? "Full" : `${settings.chatMaxWidth}px`}',
  '              </output>',
  '              <input',
  '                aria-label="Chat width"',
  '                className="settings-slider min-w-0 flex-1"',
  '                id="chat-width"',
  '                max={MAX_CHAT_MAX_WIDTH}',
  '                min={MIN_CHAT_MAX_WIDTH}',
  '                onChange={(event) => {',
  '                  const chatMaxWidth = Number(event.currentTarget.value);',
  '                  if (',
  '                    Number.isInteger(chatMaxWidth) &&',
  '                    chatMaxWidth >= MIN_CHAT_MAX_WIDTH &&',
  '                    chatMaxWidth <= MAX_CHAT_MAX_WIDTH',
  '                  ) {',
  '                    updateSettings({ chatMaxWidth });',
  '                  }',
  '                }}',
  '                step={CHAT_MAX_WIDTH_STEP}',
  '                style={chatWidthSliderStyle}',
  '                type="range"',
  '                value={settings.chatMaxWidth}',
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
        '/** Widest the timeline and composer may grow, in CSS pixels. The maximum means no cap. */',
        'export const MIN_CHAT_MAX_WIDTH = 640;',
        'export const MAX_CHAT_MAX_WIDTH = 1600;',
        'export const DEFAULT_CHAT_MAX_WIDTH = 960;',
        'export const CHAT_MAX_WIDTH_STEP = 20;',
        'export const ChatMaxWidth = Schema.Int.check(',
        '  Schema.isBetween({ minimum: MIN_CHAT_MAX_WIDTH, maximum: MAX_CHAT_MAX_WIDTH }),',
        ');',
        'export type ChatMaxWidth = typeof ChatMaxWidth.Type;',
        '/** The --chat-max-width value for a setting: a length, or none at the top of the slider. */',
        'export const chatMaxWidthCss = (width: number): string =>',
        '  width >= MAX_CHAT_MAX_WIDTH ? "none" : `${width}px`;',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '  chatWidth: ChatWidth.pipe(Schema.withDecodingDefault(Effect.succeed("comfortable" as const))),\n',
      '  chatMaxWidth: ChatMaxWidth.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAT_MAX_WIDTH))),\n',
      'replace',
    ],
    ['  chatWidth: Schema.optionalKey(ChatWidth),\n', '  chatMaxWidth: Schema.optionalKey(ChatMaxWidth),\n', 'replace'],
  ],
  'packages/contracts/src/settings.test.ts': [
    ['  DEFAULT_SERVER_SETTINGS,\n  resolveProviderInstanceEnabled,\n',
      '  chatMaxWidthCss,\n  DEFAULT_CHAT_MAX_WIDTH,\n  DEFAULT_SERVER_SETTINGS,\n  MAX_CHAT_MAX_WIDTH,\n  MIN_CHAT_MAX_WIDTH,\n  resolveProviderInstanceEnabled,\n',
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
        '/* Chat timeline and composer column width, a length from the Chat width setting',
        '   (__root.tsx sets it; none means no cap). A length reads the same on every',
        '   monitor; a narrower chat column bounds it. No % here: nested boxes cap at',
        '   this value and a % would resolve at each of them. */',
        ':root {',
        '  --chat-max-width: 960px;',
        '}',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/routes/__root.tsx': [
    [
      'import { type ServerLifecycleWelcomePayload } from "@t3tools/contracts";\n',
      'import { chatMaxWidthCss, type ServerLifecycleWelcomePayload } from "@t3tools/contracts";\n',
      'replace',
    ],
    [
      [
        '  const chatWidth = useClientSettings((settings) => settings.chatWidth);',
        '  useEffect(() => {',
        '    document.documentElement.dataset.chatWidth = chatWidth;',
        '  }, [chatWidth]);',
        '',
      ].join('\n'),
      [
        '  const chatMaxWidth = useClientSettings((settings) => settings.chatMaxWidth);',
        '  useEffect(() => {',
        '    document.documentElement.style.setProperty("--chat-max-width", chatMaxWidthCss(chatMaxWidth));',
        '  }, [chatMaxWidth]);',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    ['  const chatWidth = useClientSettings((settings) => settings.chatWidth);\n',
      '  const chatMaxWidth = useClientSettings((settings) => settings.chatMaxWidth);\n', 'replace'],
    ['rows.length, reportContentOverflow, chatWidth]);', 'rows.length, reportContentOverflow, chatMaxWidth]);', 'replace'],
  ],
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['  type ChatWidth,\n', '  CHAT_MAX_WIDTH_STEP,\n  MAX_CHAT_MAX_WIDTH,\n  MIN_CHAT_MAX_WIDTH,\n', 'replace'],
    [
      'const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {\n  comfortable: "Comfortable",\n  wide: "Wide",\n  full: "Full",\n};\n\nconst DIFF_LAYOUT_LABELS',
      '// Chat width is a pixel slider (chat-width-edits.mjs), so it has no labels.\n\nconst DIFF_LAYOUT_LABELS',
      'replace',
    ],
    [
      '  const appearanceContrastRatio =\n',
      [
        '  const chatWidthRatio =',
        '    (settings.chatMaxWidth - MIN_CHAT_MAX_WIDTH) / (MAX_CHAT_MAX_WIDTH - MIN_CHAT_MAX_WIDTH);',
        '  const chatWidthSliderStyle = {',
        '    "--settings-slider-progress": `${chatWidthRatio * 100}%`,',
        '    "--settings-slider-fill-offset": `${0.5 - chatWidthRatio}rem`,',
        '  } as CSSProperties;',
        '',
      ].join('\n'),
    ],
    ['      ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? ["Chat width"] : []),\n',
      '      ...(settings.chatMaxWidth !== DEFAULT_UNIFIED_SETTINGS.chatMaxWidth ? ["Chat width"] : []),\n', 'replace'],
    ['      settings.chatWidth,\n', '      settings.chatMaxWidth,\n', 'replace'],
    ['      chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,\n', '      chatMaxWidth: DEFAULT_UNIFIED_SETTINGS.chatMaxWidth,\n', 'replace'],
    [
      '            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (\n              <SettingResetButton\n                label="chat width"\n                onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}\n              />',
      '            settings.chatMaxWidth !== DEFAULT_UNIFIED_SETTINGS.chatMaxWidth ? (\n              <SettingResetButton\n                label="chat width"\n                onClick={() => updateSettings({ chatMaxWidth: DEFAULT_UNIFIED_SETTINGS.chatMaxWidth })}\n              />',
      'replace',
    ],
    [ROW_OLD, ROW_NEW, 'replace'],
    ['  description="Set how wide messages and the composer can grow on large screens."\n',
      '  description="Set how wide messages and the composer can grow. Narrower windows fill the chat area."\n', 'replace'],
  ],
};
