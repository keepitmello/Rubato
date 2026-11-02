// "Scroll to end" in an ordinary thread (user 4e1d4d92: "가끔 맨 아래로 내리는 버튼이 안보이곤 하던데").
//
// A sent message is held near the top while its answer arrives (T3's new-turn anchor), and the list
// stops following the end. T3 counted that hold as following, so the pill stayed hidden even when the
// answer ran on under the composer. A turn with a tool call lets go of the hold and follows the end,
// which is why the pill was missing only sometimes: after a text-only answer longer than the screen.
// Now, once the hold has settled, an answer that runs past the end shows the pill; pressing it lets go
// of the hold and follows the end, as it always did. Reaching the end hides it again.
// The list reports where it is only on a scroll event, and an answer growing under a held turn moves
// no scroll, so while a turn is held the timeline also looks again when a row changes size.
export const scrollToEndEdits = {
  'apps/web/src/components/ChatView.tsx': [
    ['  const onIsAtEndChange = (isAtEnd: boolean) => {\n    if (\n      !isAtEnd &&\n',
      '  const onIsAtEndChange = (isAtEnd: boolean) => {\n'
        + '    // Rubato: a held new turn does not follow its answer down (scroll-to-end-edits.mjs).\n'
        + '    if (\n'
        + '      timelineScrollModeRef.current === "anchoring-new-turn" &&\n'
        + '      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current\n'
        + '    ) {\n'
        + '      if (!isAtEnd && settledTimelineAnchorRef.current !== null) {\n'
        + '        showScrollDebouncer.current.maybeExecute();\n'
        + '      } else {\n'
        + '        showScrollDebouncer.current.cancel();\n'
        + '        setShowScrollToBottom(false);\n'
        + '      }\n'
        + '      return;\n'
        + '    }\n'
        + '    if (\n      !isAtEnd &&\n',
      'replace'],
  ],
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    ['  const handleItemSizeChanged = useCallback(() => {\n',
      '  // Rubato: a held turn\'s answer grows past the end without a scroll event (scroll-to-end-edits.mjs).\n'
        + '  const rubatoEndCheckRef = useRef<{ frame: number | null; check: () => void }>({ frame: null, check: () => {} });\n'],
    ['    reportContentOverflow();\n  }, [pinDisclosureToEnd, reportContentOverflow, scheduleDisclosureSettle]);\n',
      '    reportContentOverflow();\n'
        + '    if (anchorMessageId !== null && rubatoEndCheckRef.current.frame === null) {\n'
        + '      rubatoEndCheckRef.current.frame = requestAnimationFrame(() => {\n'
        + '        rubatoEndCheckRef.current.frame = null;\n'
        + '        rubatoEndCheckRef.current.check();\n'
        + '      });\n'
        + '    }\n'
        + '  }, [anchorMessageId, pinDisclosureToEnd, reportContentOverflow, scheduleDisclosureSettle]);\n',
      'replace'],
    ['  useEffect(() => {\n    const frame = requestAnimationFrame(handleScroll);\n',
      '  useLayoutEffect(() => {\n    rubatoEndCheckRef.current.check = handleScroll;\n  }, [handleScroll]);\n'],
  ],
};
