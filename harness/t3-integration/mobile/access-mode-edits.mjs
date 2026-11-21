// The access mode stays out of sight on the phone, as on the desktop (user, session 01a1fa8b item 70c3ee81:
// "전체권한 이거는 그냥 안뜨게하자"). Only the control goes: the composer's thread settings sheet loses its
// "Runtime" row (Supervised / Auto-accept edits / Auto / Full access) and with it the picker it opened. A
// thread keeps the mode it has, the server is unchanged, and the Settings pages are left as they are.
// The options above it close their card on their own last row, and a model with no options shows no
// empty "Options" card.
//
// Cost per upstream bump: 6 anchors in 1 file, all here.
export const mobileAccessModeOverlays = [];

export const mobileAccessModeEdits = {
  "apps/mobile/src/features/threads/ThreadSettingsSheet.tsx": [
    ["        {session.displayedDescriptors.map((descriptor) => {",
      "        {session.displayedDescriptors.map((descriptor, index, all) => {", 'replace'],
    ["                  onPress={() => props.onOpenSubmenu({ kind: \"descriptor\", id: descriptor.id })}",
      "                  onPress={() => props.onOpenSubmenu({ kind: \"descriptor\", id: descriptor.id })}\n                  isLast={index === all.length - 1}", 'replace'],
    ["                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}",
      "                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}\n                isLast={index === all.length - 1}", 'replace'],
    ["        <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>\n          <DisclosureRow\n            isLast\n            label={gt(\"Runtime\", { $context: \"agent permission mode setting\" })}\n            value={(() => {\n              const label = session.runtimeModeChoices.find(\n                (choice) => choice.mode === session.runtimeMode,\n              )?.label;\n              return label === undefined ? undefined : m(label);\n            })()}\n            onPress={() => props.onOpenSubmenu({ kind: \"runtime\" })}\n          />\n        </Animated.View>\n",
      "        {/* Rubato: no access-mode row; the thread keeps its mode (access-mode-edits.mjs). */}\n", 'replace'],
    ["      <Text className=\"px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted\">\n        <T>Options</T>",
      "      {session.displayedDescriptors.length > 0 ? (\n      <>\n      <Text className=\"px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted\">\n        <T>Options</T>", 'replace'],
    ["      <Text className=\"px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted\">\n        {gt(\"Catalog\"",
      "      </>\n      ) : null}\n      <Text className=\"px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted\">\n        {gt(\"Catalog\"", 'replace'],
  ],
};
