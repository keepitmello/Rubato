// The companion room's composer field and live dictation (rubato-voice/RubatoComposerField.tsx):
// the field grows with its text up to six lines and opens full screen past that, and dictation
// writes its words into the field while the person talks, grey with the newest words blue (user
// 2026-11-20, after ChatGPT's iOS app). The words come from the Mac's one-time key and OpenAI's
// live transcription (rubato-voice/macLiveDictation.ts, @t3tools/shared/rubatoLiveDictation).
// Thread composers keep T3's own composer and dictation controls; they transcribe through the same
// Mac (shell-edits.mjs, VoiceInputProvider).
//
// T3 pieces this touches:
// - T3ComposerEditorView/Module (iOS): `dictationJson` colours the text word by word. The field's
//   height comes from T3's own onContentSizeChange.
// - rubatoLiveDictationDisplay beside the shared voice controller places the heard words where the
//   final text will land, for this field and the desktop's.
export const mobileComposerOverlays = [
  'apps/mobile/src/features/rubato-voice/RubatoComposerField.tsx',
  'apps/mobile/src/features/rubato-voice/RubatoDictationStrip.tsx',
  // Shared with the desktop's composer, which places the heard words the same way.
  'packages/client-runtime/src/voice-input/rubatoLiveDictationDisplay.ts',
  'packages/client-runtime/src/voice-input/rubatoLiveDictationDisplay.test.ts',
];

const SWIFT_VIEW = 'apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift';

export const mobileComposerEdits = {
  [SWIFT_VIEW]: [
    ['private enum ComposerEnterBehavior: String {\n', [
      '/// Rubato: how live dictation colours the text. `base` is every character\'s colour (the theme\'s',
      '/// placeholder grey when absent); each run then paints its range (source offsets) its own colour.',
      '/// Colours are RGBA, 0...1. The words fade in blue and fade to grey on their own clocks, as',
      '/// ChatGPT draws dictation; the JS side sends a new payload each frame while something moves.',
      'private struct ComposerDictationRun: Decodable, Equatable {',
      '  let start: Int',
      '  let end: Int',
      '  let color: [Double]',
      '}',
      '',
      'private struct ComposerDictationPayload: Decodable, Equatable {',
      '  let base: [Double]?',
      '  let runs: [ComposerDictationRun]',
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
      '    // Only colours change frame to frame: repaint them in place when the text is the document,',
      '    // so the caret, the keyboard and the layout are left alone.',
      '    if textView.serializedText() == value && documentMatchesExpectedTokens() {',
      '      let storage = textView.textStorage',
      '      storage.beginEditing()',
      '      applyDictationColors(to: storage)',
      '      storage.endEditing()',
      '    } else {',
      '      applyControlledDocument(force: true)',
      '    }',
      '  }',
      '',
      '  private func dictationColor(_ rgba: [Double]?) -> UIColor? {',
      '    guard let rgba, rgba.count == 4 else {',
      '      return nil',
      '    }',
      '    return UIColor(red: rgba[0], green: rgba[1], blue: rgba[2], alpha: rgba[3])',
      '  }',
      '',
      '  private func applyDictationColors(to text: NSMutableAttributedString) {',
      '    let whole = NSRange(location: 0, length: text.length)',
      '    guard let dictation else {',
      '      text.addAttribute(.foregroundColor, value: UIColor(composerHex: theme.text) ?? .label, range: whole)',
      '      return',
      '    }',
      '    let base = dictationColor(dictation.base) ?? UIColor(composerHex: theme.placeholder) ?? .secondaryLabel',
      '    text.addAttribute(.foregroundColor, value: base, range: whole)',
      '    for run in dictation.runs {',
      '      let start = min(text.length, displayOffset(forSourceOffset: run.start))',
      '      let end = min(text.length, displayOffset(forSourceOffset: run.end))',
      '      guard end > start, let color = dictationColor(run.color) else {',
      '        continue',
      '      }',
      '      text.addAttribute(.foregroundColor, value: color, range: NSRange(location: start, length: end - start))',
      '    }',
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
      '    if dictation != nil {',
      '      applyDictationColors(to: result)',
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
    ['  readonly onComposerBlur?: () => void;\n', '  readonly dictationJson: string;\n'],
    ['  contentInsetVertical = 0,\n  readResetGeneration = NO_RESET,\n  ...props\n}: ComposerEditorProps) {',
      '  contentInsetVertical = 0,\n  readResetGeneration = NO_RESET,\n  dictation,\n  ...props\n}: ComposerEditorProps) {', 'replace'],
    ['      clipboardFragment={props.clipboardFragment ?? ""}\n',
      '      dictationJson={dictation ? JSON.stringify(dictation) : ""}\n'],
  ],
  'apps/mobile/src/native/T3ComposerEditor.types.ts': [
    ['  readonly onSubmit?: (alternate: boolean) => void;\n}', [
      '  readonly onSubmit?: (alternate: boolean) => void;',
      '  /**',
      '   * Rubato (iOS): how live dictation colours the text: every character `base` (the placeholder grey',
      '   * when absent), each run its own colour. RGBA, 0…1.',
      '   */',
      '  readonly dictation?: {',
      '    readonly base?: readonly [number, number, number, number];',
      '    readonly runs: ReadonlyArray<{ readonly start: number; readonly end: number; readonly color: readonly [number, number, number, number] }>;',
      '  } | null;',
      '}',
    ].join('\n'), 'replace'],
  ],
  'packages/client-runtime/src/voice-input/index.ts': [
    ['export {\n  VoiceTranscriptionError,\n',
      'export {\n  liveDictationDisplay,\n  type LiveDictationDisplay,\n  type LiveDictationRun,\n} from "./rubatoLiveDictationDisplay.ts";\n'],
  ],
};
