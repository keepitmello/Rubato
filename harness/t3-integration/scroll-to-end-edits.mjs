// "Scroll to end" in an ordinary thread (user 4e1d4d92: "가끔 맨 아래로 내리는 버튼이 안보이곤 하던데").
//
// A sent message is held near the top while its answer arrives (T3's new-turn anchor), and the list
// stops following the end. T3 counted that hold as following, so the pill stayed hidden even when the
// answer ran on under the composer. A turn with a tool call lets go of the hold and follows the end,
// which is why the pill was missing only sometimes: after a text-only answer longer than the screen.
// Now, once the hold has settled, an answer that runs past the end shows the pill; pressing it lets go
// of the hold and follows the end, as it always did. Reaching the end hides it again.
// The timeline looks again whenever its content changes size (T3's handleContentSizeChanged), so an
// answer growing under a held turn reaches this check without a scroll event.
export const scrollToEndEdits = {
  // The follow state moved out of ChatView into useTimelineFollow's store: a hold is the
  // "following" mode with a settled anchor (scroll.settledAnchor), and a user scroll is the
  // "navigated" event that leaves that mode, which replaces the scroll-generations check.
  'apps/web/src/components/chat/useTimelineFollow.ts': [
    ['  const onIsAtEndChange = (isAtEnd: boolean) => {\n    const scroll = visitScroll();\n    if (!isAtEnd && readFollow().mode === "following") {\n',
      '  const onIsAtEndChange = (isAtEnd: boolean) => {\n'
        + '    const scroll = visitScroll();\n'
        + '    // Rubato: a held new turn does not follow its answer down (scroll-to-end-edits.mjs).\n'
        + '    // The hold is a following mode with a settled anchor; the list leaving the end\n'
        + '    // band there is the answer growing, not the reader scrolling.\n'
        + '    if (\n'
        + '      !isAtEnd &&\n'
        + '      readFollow().mode === "following" &&\n'
        + '      timelineAnchorMessageId !== null &&\n'
        + '      scroll.settledAnchor !== null\n'
        + '    ) {\n'
        + '      scroll.showScrollDebouncer.maybeExecute();\n'
        + '      return;\n'
        + '    }\n'
        + '    if (!isAtEnd && readFollow().mode === "following") {\n',
      'replace'],
  ],
};
