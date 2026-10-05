// Closing the last tab in the right panel hid the whole column. The panel's own
// launcher — the "Open a surface" list of Agents, Files, Markdown note, Browser,
// Terminal, Diff, Pull request, Device — is what the column shows when it has no
// surfaces, and the layout toggle already reaches it, so the tab's close button
// dropped the user somewhere the same click had just come from.
//
// The last close now lands on that launcher: the tab's ✕ means the tab, the
// layout toggle still means the panel. Three store transitions used to drop
// `isOpen` to false once `surfaces` came out empty, and they no longer touch it
// — closeSurface, closeTerminal (a terminal surface's last pane) and
// closeAllSurfaces. Hiding stays its own act (`close`, `toggleVisibility`), and
// a panel that was already hidden does not open itself.
//
// Upstream's store tests asserted the removed contract ("closes the panel"); each
// of the three now asserts the launcher, and rubatoRightPanelLauncher.test.ts
// holds what they do not cover: a hidden panel stays hidden.
export const rightPanelOverlays = ['apps/web/src/rubatoRightPanelLauncher.test.ts'];

export const rightPanelEdits = {
  'apps/web/src/rightPanelStore.ts': [
    [
      [
        '            if (terminalIds.length === 0) {',
        '              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);',
        '              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);',
        '              const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;',
        '              return {',
        '                ...current,',
        '                isOpen: surfaces.length > 0 && current.isOpen,',
        '                surfaces,',
        '                activeSurfaceId:',
        '                  current.activeSurfaceId === surfaceId',
        '                    ? (fallback?.id ?? null)',
        '                    : current.activeSurfaceId,',
        '              };',
        '            }',
        '',
      ].join('\n'),
      [
        '            if (terminalIds.length === 0) {',
        '              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);',
        '              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);',
        '              const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;',
        '              return {',
        '                ...current,',
        '                surfaces,',
        '                activeSurfaceId:',
        '                  current.activeSurfaceId === surfaceId',
        '                    ? (fallback?.id ?? null)',
        '                    : current.activeSurfaceId,',
        '              };',
        '            }',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      [
        '      closeSurface: (ref, surfaceId) =>',
        '        set((state) =>',
        '          userAction(state, scopedThreadKey(ref), (current) => {',
        '            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);',
        '            if (index < 0) return current;',
        '            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);',
        '            if (current.activeSurfaceId !== surfaceId) {',
        '              return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };',
        '            }',
        '            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;',
        '            return {',
        '              ...current,',
        '              isOpen: surfaces.length > 0 && current.isOpen,',
        '              surfaces,',
        '              activeSurfaceId: fallback?.id ?? null,',
        '            };',
        '          }),',
        '        ),',
        '',
      ].join('\n'),
      [
        '      closeSurface: (ref, surfaceId) =>',
        '        set((state) =>',
        '          userAction(state, scopedThreadKey(ref), (current) => {',
        '            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);',
        '            if (index < 0) return current;',
        '            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);',
        '            if (current.activeSurfaceId !== surfaceId) {',
        '              return { ...current, surfaces };',
        '            }',
        '            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;',
        '            return {',
        '              ...current,',
        '              surfaces,',
        '              activeSurfaceId: fallback?.id ?? null,',
        '            };',
        '          }),',
        '        ),',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      [
        '            current.surfaces.length === 0',
        '              ? current',
        '              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },',
        '',
      ].join('\n'),
      [
        '            current.surfaces.length === 0',
        '              ? current',
        '              : { ...current, surfaces: [], activeSurfaceId: null },',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/rightPanelStore.test.ts': [
    [
      [
        '  it("closing the final terminal pane removes its surface and closes the panel", () => {',
        '    useRightPanelStore.getState().openTerminal(refA, "term-1");',
        '    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");',
        '',
        '    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({',
        '      isOpen: false,',
        '',
      ].join('\n'),
      [
        '  it("closing the final terminal pane removes its surface and leaves the launcher", () => {',
        '    useRightPanelStore.getState().openTerminal(refA, "term-1");',
        '    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");',
        '',
        '    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({',
        '      isOpen: true,',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      [
        '  it("closing the final surface closes the panel", () => {',
        '    useRightPanelStore.getState().openTerminal(refA, "term-1");',
        '    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");',
        '',
        '    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({',
        '      isOpen: false,',
        '',
      ].join('\n'),
      [
        '  it("closing the final surface leaves the launcher", () => {',
        '    useRightPanelStore.getState().openTerminal(refA, "term-1");',
        '    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");',
        '',
        '    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({',
        '      isOpen: true,',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      [
        '  it("closing all surfaces closes the panel", () => {',
        '    useRightPanelStore.getState().openBrowser(refA, "tab-a");',
        '    useRightPanelStore.getState().openFile(refA, "src/index.ts");',
        '',
        '    useRightPanelStore.getState().closeAllSurfaces(refA);',
        '',
        '    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({',
        '      isOpen: false,',
        '',
      ].join('\n'),
      [
        '  it("closing all surfaces leaves the launcher", () => {',
        '    useRightPanelStore.getState().openBrowser(refA, "tab-a");',
        '    useRightPanelStore.getState().openFile(refA, "src/index.ts");',
        '',
        '    useRightPanelStore.getState().closeAllSurfaces(refA);',
        '',
        '    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({',
        '      isOpen: true,',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
};
