// The thread composer's controls sit where T3 v0.1.0 had them (intent t3-v0-1-11-bump, user
// 10dd0a87: "스레드에서 모델 위치나 마이크 버튼같은 배치는 기존처럼이 좋고(에포트랑 합치는 건 신버전이
// 좋음)", "뉴스레드는 … 걍 애프터로 두자"). T3 v0.1.11 moved the model picker to the right, the
// attach button (and with it Rubato's mic and call button) to the left, and the access mode out of
// the composer while it is the default. In a thread, back to v0.1.0:
//
//   [model+effort]                             [speed] [mic] [call] [attach] [ring] [send]
//
// The access mode ("Full access") shows nowhere (user 70c3ee81: "전체권한 이거는 그냥 안뜨게하자"):
// not as a composer chip, not in the new-thread strip, not in the model picker's footer. The
// thread's mode itself is untouched; only the control is gone.
// keeping upstream's model button with its effort and its two-pane picker, which now opens above
// the button at the left edge (popupAlign start) instead of over the transcript. The new-thread
// composer (draft route) keeps T3 v0.1.11's layout, its strip included.
// Below 640px T3 stacks that picker's two panes and leaves the popup as narrow as its content
// (about 260px), which cuts model names to a letter; there it takes the window's width up to 30rem.
// Registered last: it moves lines voice-, call- and cache-edits put in.
const voiceControl = [
  '                {isElectron ? (',
  '                  <RubatoVoiceControl',
  '                    state={voiceInput.state}',
  '                    stage={voiceInput.stage}',
  '                    readLevel={voiceInput.readLevel}',
  '                    onStart={voiceInput.start}',
  '                    onStop={voiceInput.stop}',
  '                    onCancel={voiceInput.cancel}',
  '                  />',
  '                ) : null}',
  '',
].join('\n');

const leadingControls = [
  voiceControl.replace(/\n$/, ''),
  '                <RubatoCallComposerButton environmentId={environmentId} threadId={activeThreadId} />',
  '                {composerAttachButton && !dictationTakesFooter ? (',
  '                  <div className="me-2">{composerAttachButton}</div>',
  '                ) : null}',
  '                <div',
  '                  data-chat-composer-actions="right"',
  '                  data-chat-composer-transition-actions="true"',
  '                  data-chat-composer-primary-actions-compact={',
  '                    isComposerPrimaryActionsCompact ? "true" : "false"',
  '                  }',
  '                  className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2"',
  '                >',
  '',
].join('\n');

const footerControls = [
  '                  <div',
  '                    ref={attachExpandedComposerControls}',
  '                    data-chat-composer-controls="footer"',
  '                    data-chat-composer-footer-controls="true"',
  '                    className={cn(',
  '                      "relative flex min-w-0 flex-1 items-center justify-end gap-0.5",',
  '                      dictationTakesFooter && "hidden",',
  '                    )}',
  '                  >',
  '                    {composerControls}',
  '                  </div>',
  '',
].join('\n');

export const composerLayoutOverlays = [];

export const composerLayoutEdits = {
  'apps/web/src/components/chat/ChatComposer.tsx': [
    // A thread opens the row with the model and access mode; a new thread keeps T3's order.
    [leadingControls,
      [
        '                {/* Rubato: in a thread, model and access mode lead the row, as on v0.1.0 (composer-layout-edits.mjs). */}',
        '                {routeKind !== "draft" ? (',
        '                  <div',
        '                    ref={attachExpandedComposerControls}',
        '                    data-chat-composer-controls="footer"',
        '                    data-chat-composer-footer-controls="true"',
        '                    className={cn(',
        '                      "relative flex min-w-0 flex-1 items-center justify-start gap-0.5",',
        '                      dictationTakesFooter && "hidden",',
        '                    )}',
        '                  >',
        '                    {composerControls}',
        '                  </div>',
        '                ) : (',
        '                  <>',
        voiceControl.replace(/^ {16}/gm, '                    ').replace(/\n$/, ''),
        '                    <RubatoCallComposerButton environmentId={environmentId} threadId={activeThreadId} />',
        '                    {composerAttachButton && !dictationTakesFooter ? (',
        '                      <div className="me-2">{composerAttachButton}</div>',
        '                    ) : null}',
        '                  </>',
        '                )}',
        '                <div',
        '                  data-chat-composer-actions="right"',
        '                  data-chat-composer-transition-actions="true"',
        '                  data-chat-composer-primary-actions-compact={',
        '                    isComposerPrimaryActionsCompact ? "true" : "false"',
        '                  }',
        '                  className={cn(',
        '                    "flex flex-nowrap items-center justify-end gap-2",',
        '                    routeKind !== "draft" && !dictationTakesFooter ? "shrink-0" : "min-w-0 flex-1",',
        '                  )}',
        '                >',
        '',
      ].join('\n'),
      'replace'],
    // In a thread, speed, mic, call and attach stand before the ring and send.
    [footerControls,
      [
        '                  {routeKind !== "draft" ? (',
        '                    <>',
        voiceControl.replace(/^ {16}/gm, '                      ').replace(/\n$/, ''),
        '                      <RubatoCallComposerButton environmentId={environmentId} threadId={activeThreadId} />',
        '                      {composerAttachButton && !dictationTakesFooter ? composerAttachButton : null}',
        '                    </>',
        '                  ) : (',
        footerControls.replace(/^ {18}/gm, '                    ').replace(/\n$/, ''),
        '                  )}',
        '',
      ].join('\n'),
      'replace'],
  ],
  'apps/web/src/components/chat/ComposerControlsBar.tsx': [
    ['    matchesDefault: accessMatchesDefault || props.permissionsShownInStrip,',
      '    // Rubato: the access mode is never shown as a chip (composer-layout-edits.mjs).\n    matchesDefault: true,',
      'replace'],
    ['      popupAlign={composerControlsCollapsed ? "start" : "end"}',
      '      // Rubato: in a thread the picker leads the row and opens above it from the left (composer-layout-edits.mjs).\n      popupAlign={routeKind !== "draft" || composerControlsCollapsed ? "start" : "end"}',
      'replace'],
  ],
  // The picker's footer keeps speed and Ultracode; with neither it is not drawn.
  'apps/web/src/components/chat/ComposerModelEffort.tsx': [
    [[
      '    <div className="flex flex-wrap items-center gap-2 border-t border-border/70 bg-muted/40 px-3 py-2">',
      '      {props.traits ? <SpeedControl traits={props.traits} /> : null}',
      '      {props.traits ? <UltracodeControl traits={props.traits} /> : null}',
      '      <PermissionsMenu',
      '        runtimeMode={props.runtimeMode}',
      '        options={props.runtimeModeOptions}',
      '        onChange={props.onRuntimeModeChange}',
      '      />',
      '    </div>',
      '',
    ].join('\n'),
      [
        '    // Rubato: no access mode here (composer-layout-edits.mjs); an empty footer is not drawn.',
        '    <div className="flex flex-wrap items-center gap-2 border-t border-border/70 bg-muted/40 px-3 py-2 empty:hidden">',
        '      {props.traits ? <SpeedControl traits={props.traits} /> : null}',
        '      {props.traits ? <UltracodeControl traits={props.traits} /> : null}',
        '    </div>',
        '',
      ].join('\n'),
      'replace'],
  ],
  // The new-thread strip's access control renders nothing; T3's stays in its file, unrendered.
  'apps/web/src/components/ComposerContextPermissions.tsx': [
    ['export function ComposerContextPermissions(props: {\n',
      [
        '// Rubato: the access mode is not shown (composer-layout-edits.mjs).',
        'export function ComposerContextPermissions(',
        '  _props: Parameters<typeof UpstreamComposerContextPermissions>[0],',
        '): null {',
        '  return null;',
        '}',
        '',
        'export function UpstreamComposerContextPermissions(props: {',
        '',
      ].join('\n'),
      'replace'],
  ],
  // T3's own test of the strip control keeps testing it.
  'apps/web/src/components/chat/ComposerPermissionsSection.browser.test.tsx': [
    ['import { ComposerContextPermissions } from "../ComposerContextPermissions";\n',
      'import { UpstreamComposerContextPermissions as ComposerContextPermissions } from "../ComposerContextPermissions";\n',
      'replace'],
    // The picker's footer has no Permissions menu to tap outside of.
    ['it("on a touch tablet, tapping outside the Permissions menu leaves the editor unfocused", async () => {\n',
      '// Rubato: the model picker has no Permissions menu (composer-layout-edits.mjs).\nit.skip("on a touch tablet, tapping outside the Permissions menu leaves the editor unfocused", async () => {\n',
      'replace'],
  ],
  'apps/web/src/components/chat/ProviderModelPicker.tsx': [
    ['        className="before:hidden"\n',
      [
        '        // Rubato: stacked below 640px, the picker takes the window width (composer-layout-edits.mjs).',
        '        className={cn("before:hidden", docked && "max-sm:w-[min(30rem,calc(100vw-1rem))]")}',
        '',
      ].join('\n'),
      'replace'],
  ],
};
