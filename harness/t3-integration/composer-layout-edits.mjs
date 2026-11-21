// The composer's controls sit where T3 v0.1.0 had them (intent t3-v0-1-11-bump: the user kept
// v0.1.11's look but not its rearranged controls). T3 v0.1.11 moved the model picker to the
// right, the attach button (and with it Rubato's mic and call button) to the left, and the
// access mode out of the composer while it is the default. Back to v0.1.0, in the thread and
// the new-thread composer alike:
//
//   [model] [effort] [access mode]            [speed] [mic] [call] [attach] [ring] [send]
//
// The effort is its own button again (TraitsPicker), not a suffix on the model button; the model
// picker keeps its effort column.
// The access chip shows even at the default mode, so the new-thread strip below the composer
// no longer repeats it. Registered last: it moves lines voice-, call- and cache-edits put in.
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
    // The model picker and access mode open the row.
    [leadingControls,
      [
        '                {/* Rubato: model and access mode lead the row, as on v0.1.0 (composer-layout-edits.mjs). */}',
        '                <div',
        '                  ref={attachExpandedComposerControls}',
        '                  data-chat-composer-controls="footer"',
        '                  data-chat-composer-footer-controls="true"',
        '                  className={cn(',
        '                    "relative flex min-w-0 flex-1 items-center justify-start gap-0.5",',
        '                    dictationTakesFooter && "hidden",',
        '                  )}',
        '                >',
        '                  {composerControls}',
        '                </div>',
        '                <div',
        '                  data-chat-composer-actions="right"',
        '                  data-chat-composer-transition-actions="true"',
        '                  data-chat-composer-primary-actions-compact={',
        '                    isComposerPrimaryActionsCompact ? "true" : "false"',
        '                  }',
        '                  className={cn(',
        '                    "flex flex-nowrap items-center justify-end gap-2",',
        '                    dictationTakesFooter ? "min-w-0 flex-1" : "shrink-0",',
        '                  )}',
        '                >',
        '',
      ].join('\n'),
      'replace'],
    // Speed, mic, call and attach stand before the ring and send.
    [footerControls,
      [
        '                  {isElectron ? (',
        '                    <RubatoVoiceControl',
        '                      state={voiceInput.state}',
        '                      stage={voiceInput.stage}',
        '                      readLevel={voiceInput.readLevel}',
        '                      onStart={voiceInput.start}',
        '                      onStop={voiceInput.stop}',
        '                      onCancel={voiceInput.cancel}',
        '                    />',
        '                  ) : null}',
        '                  <RubatoCallComposerButton environmentId={environmentId} threadId={activeThreadId} />',
        '                  {composerAttachButton && !dictationTakesFooter ? composerAttachButton : null}',
        '',
      ].join('\n'),
      'replace'],
  ],
  'apps/web/src/components/chat/ComposerControlsBar.tsx': [
    ['import type { PromptUltrathink } from "./TraitsPicker";\n',
      'import { TraitsPicker, type PromptUltrathink } from "./TraitsPicker"; // Rubato: the effort button (composer-layout-edits.mjs)\n',
      'replace'],
    ['      triggerSuffix={effort.suffix}\n      triggerDetail={effort.detail}\n',
      '      // Rubato: the effort has its own button beside the picker (composer-layout-edits.mjs).\n      triggerSuffix={null}\n      triggerDetail={null}\n',
      'replace'],
    ['      {composerModelPicker}\n',
      [
        '      {composerModelPicker}',
        '      {/* Rubato: the effort as its own button, as on v0.1.0 (composer-layout-edits.mjs). */}',
        '      {traitsInput ? (',
        '        <TraitsPicker',
        '          {...traitsInput}',
        '          size={controlSize}',
        '          hidden={composerControlsHidden}',
        '          disabled={providerCatalogPending || isSendBusy}',
        '        />',
        '      ) : null}',
        '',
      ].join('\n'),
      'replace'],
    ['    matchesDefault: accessMatchesDefault || props.permissionsShownInStrip,',
      '    // Rubato: the access chip stays in the composer at the default mode too (composer-layout-edits.mjs).\n    matchesDefault: false,',
      'replace'],
    ['      popupAlign={composerControlsCollapsed ? "start" : "end"}',
      '      popupAlign="start" // Rubato: the picker leads the row (composer-layout-edits.mjs)',
      'replace'],
  ],
  'apps/web/src/components/ChatView.tsx': [
    [
      [
        '                                  {...(isServerThread',
        '                                    ? {}',
        '                                    : {',
        '                                        trailing: (',
        '                                          <ComposerContextPermissions',
        '                                            environmentId={environmentId}',
        '                                            runtimeMode={runtimeMode}',
        '                                            supportedRuntimeModes={',
        '                                              activeProviderStatus?.supportedRuntimeModes',
        '                                            }',
        '                                            onRuntimeModeChange={handleRuntimeModeChangeStable}',
        '                                          />',
        '                                        ),',
        '                                      })}',
        '',
      ].join('\n'),
      '                                  // Rubato: the access mode is in the composer (composer-layout-edits.mjs).\n',
      'replace'],
    ['import { ComposerContextPermissions } from "./ComposerContextPermissions";\n',
      '// Rubato: the strip no longer shows the access mode (composer-layout-edits.mjs).\n',
      'replace'],
  ],
};
