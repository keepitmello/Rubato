// The phone composers' field and live dictation (rubato-voice/RubatoComposerField.tsx): the field
// grows with its text up to six lines and opens full screen past that, and dictation writes its
// words into the field while the person talks, grey with the newest words blue (user 2026-11-20,
// after ChatGPT's iOS app). The words come from the Mac's one-time key and OpenAI's live
// transcription (rubato-voice/macLiveDictation.ts, @t3tools/shared/rubatoLiveDictation).
//
// T3 pieces this touches:
// - T3ComposerEditorView/Module (iOS): `dictationJson` paints the dictated range; the editor
//   already emitted its content height, now the JS view passes it on (onTextHeightChange).
// - the shared voice controller: Korean gets a space where dictation meets a word, as English does
//   (T3 joined "테스트" and "실시간" into "테스트실시간"); rubatoLiveDictationDisplay beside it
//   places the heard words where the final text will land, for this field and the desktop's.
// - ThreadComposer: the field in place of the bare editor, and dictation opens the card.
export const mobileComposerOverlays = [
  'apps/mobile/src/features/rubato-voice/RubatoComposerField.tsx',
  // Shared with the desktop's composer, which places the heard words the same way.
  'packages/client-runtime/src/voice-input/rubatoLiveDictationDisplay.ts',
  'packages/client-runtime/src/voice-input/rubatoLiveDictationDisplay.test.ts',
];

const SWIFT_VIEW = 'apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift';

export const mobileComposerEdits = {
  [SWIFT_VIEW]: [
    ['private struct ComposerChipStyle {\n', [
      '/// Rubato: the range live dictation is writing, in source offsets. While it is set the whole',
      '/// text reads grey and `freshStart..<end` blue, as ChatGPT draws dictation.',
      'private struct ComposerDictationPayload: Decodable, Equatable {',
      '  let freshStart: Int',
      '  let end: Int',
      '}',
      '',
      '',
    ].join('\n')],
    ['  private let placeholderLabel = UILabel()\n', '  private var dictation: ComposerDictationPayload?\n'],
    ['  func setPlaceholder(_ placeholder: String) {\n', [
      '  func setDictationJson(_ json: String) {',
      '    let next = json.isEmpty ? nil : decode(ComposerDictationPayload.self, from: json)',
      '    guard next != dictation else {',
      '      return',
      '    }',
      '    dictation = next',
      '    applyControlledDocument(force: true)',
      '  }',
      '',
      '',
    ].join('\n')],
    [[
      '    if cursor < source.length {',
      '      appendPlainText(',
      '        source.substring(with: NSRange(location: cursor, length: source.length - cursor)),',
      '        to: result',
      '      )',
      '    }',
      '    return result',
      '  }',
    ].join('\n'), [
      '    if cursor < source.length {',
      '      appendPlainText(',
      '        source.substring(with: NSRange(location: cursor, length: source.length - cursor)),',
      '        to: result',
      '      )',
      '    }',
      '    if let dictation {',
      '      result.addAttribute(',
      '        .foregroundColor,',
      '        value: UIColor(composerHex: theme.placeholder) ?? .secondaryLabel,',
      '        range: NSRange(location: 0, length: result.length)',
      '      )',
      '      let freshStart = min(result.length, displayOffset(forSourceOffset: dictation.freshStart))',
      '      let freshEnd = min(result.length, displayOffset(forSourceOffset: dictation.end))',
      '      if freshEnd > freshStart {',
      '        result.addAttribute(',
      '          .foregroundColor,',
      '          value: UIColor.systemBlue,',
      '          range: NSRange(location: freshStart, length: freshEnd - freshStart)',
      '        )',
      '      }',
      '    }',
      '    return result',
      '  }',
    ].join('\n'), 'replace'],
  ],
  'apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorModule.swift': [
    ['      Prop("placeholder") { (view: T3ComposerEditorView, placeholder: String) in\n', [
      '      Prop("dictationJson") { (view: T3ComposerEditorView, json: String) in',
      '        view.setDictationJson(json)',
      '      }',
      '',
    ].join('\n')],
  ],
  'apps/mobile/src/native/T3ComposerEditor.ios.tsx': [
    ['  readonly onComposerBlur?: () => void;\n', [
      '  readonly dictationJson: string;',
      '  readonly onComposerContentSizeChange?: (',
      '    event: NativeSyntheticEvent<{ readonly width: number; readonly height: number }>,',
      '  ) => void;',
      '',
    ].join('\n')],
    ['  contentInsetVertical = 0,\n  ...props\n}: ComposerEditorProps) {\n  const nativeRef',
      '  contentInsetVertical = 0,\n  dictation,\n  onTextHeightChange,\n  ...props\n}: ComposerEditorProps) {\n  const nativeRef', 'replace'],
    ['      clipboardFragment={props.clipboardFragment ?? ""}\n', [
      '      dictationJson={dictation ? JSON.stringify(dictation) : ""}',
      '      onComposerContentSizeChange={(event) => onTextHeightChange?.(event.nativeEvent)}',
      '',
    ].join('\n')],
  ],
  'apps/mobile/src/native/T3ComposerEditor.types.ts': [
    ['  readonly onSubmit?: (alternate: boolean) => void;\n}', [
      '  readonly onSubmit?: (alternate: boolean) => void;',
      '  /** Rubato (iOS): the range live dictation is writing; the text reads grey, `freshStart…end` blue. */',
      '  readonly dictation?: { readonly freshStart: number; readonly end: number } | null;',
      '  /** Rubato (iOS): the text\'s full height, for a field that grows with it. */',
      '  readonly onTextHeightChange?: (size: { readonly width: number; readonly height: number }) => void;',
      '}',
    ].join('\n'), 'replace'],
  ],
  'packages/client-runtime/src/voice-input/controller.ts': [
    ['  const usesEnglishSpacing = normalizedLocale === "en" || normalizedLocale.startsWith("en-");', [
      '  // Rubato: Korean separates words with spaces too; T3 joined dictation onto the word before it.',
      '  const usesEnglishSpacing =',
      '    normalizedLocale === "en" ||',
      '    normalizedLocale.startsWith("en-") ||',
      '    normalizedLocale === "ko" ||',
      '    normalizedLocale.startsWith("ko-");',
    ].join('\n'), 'replace'],
    ['      /[A-Za-z0-9.!?,:;)\\]}\'"]/.test(left) &&', '      /[A-Za-z0-9.!?,:;)\\]}\'"가-힣]/.test(left) &&', 'replace'],
    ['      /[A-Za-z0-9([{\'"]/.test(right) &&', '      /[A-Za-z0-9([{\'"가-힣]/.test(right) &&', 'replace'],
  ],
  'packages/client-runtime/src/voice-input/index.ts': [
    ['export {\n  VoiceTranscriptionError,\n',
      'export { liveDictationDisplay, type LiveDictationDisplay } from "./rubatoLiveDictationDisplay.ts";\n'],
  ],
  'apps/mobile/src/features/threads/ThreadComposer.tsx': [
    ['import { useVoiceInputController } from "../voice-input/useVoiceInputController";\n',
      'import { RubatoComposerField } from "../rubato-voice/RubatoComposerField";\n'],
    ['  const isExpanded = isFocused || settingsSheetPresentation.keepsComposerExpanded;', [
      '  // Rubato: dictation opens the card, so the words it hears are written in the field.',
      '  const isExpanded =',
      '    isFocused || settingsSheetPresentation.keepsComposerExpanded || voiceInput.isBusy;',
    ].join('\n'), 'replace'],
    ['              <ComposerEditor\n                draftKey={composerDraftKey}\n', [
      '              <RubatoComposerField',
      '                dictating={voiceInput.isBusy}',
      '                lineHeight={bodyText.lineHeight}',
      '                maxLines={isExpanded ? 6 : 1}',
      '                expand={{ sendLabel, canSend, onSend: () => void handleSend() }}',
      '                draftKey={composerDraftKey}',
      '',
    ].join('\n'), 'replace'],
    [[
      '                style={',
      '                  isExpanded',
      '                    ? {',
      '                        minHeight: 72,',
      '                        maxHeight: 160,',
      '                        paddingVertical: 4,',
      '                      }',
      '                    : {',
      '                        height: 36,',
      '                      }',
      '                }',
      '',
    ].join('\n'), '                // Rubato: the field sizes itself to its text (RubatoComposerField).\n', 'replace'],
  ],
};
