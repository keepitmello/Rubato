// The file surface's explorer as a file browser.
//
// - The explorer tree sits left of the preview, where file browsers put it,
//   and its toggle sits at the left end of the subheader, beside it.
// - Back and forward walk the paths this panel showed (fileNavigationHistory.ts),
//   from buttons before the breadcrumbs and the mouse's side buttons.
//   Cmd+[ and Cmd+] stay with the app's thread navigation.
export const fileExplorerOverlays = [
  'apps/web/src/components/files/fileNavigationHistory.ts',
  'apps/web/src/components/files/fileNavigationHistory.test.ts',
];

const explorerToggle = [
  '          {!isHostFile && previewPath !== null ? (',
  '            <FileSurfaceAction',
  '              label={explorerOpen ? "Hide file explorer" : "Show file explorer"}',
  '              pressed={explorerOpen}',
  '              onPress={toggleExplorer}',
  '            >',
  '              <FolderTree className="size-3.5" />',
  '            </FileSurfaceAction>',
  '          ) : null}',
  '',
].join('\n');

export const fileExplorerEdits = {
  'apps/web/src/components/files/FilePreviewPanel.tsx': [
    ['import { Code2, Eye, FolderTree, Globe2, Table2, WrapTextIcon } from "lucide-react";',
      'import {\n  ArrowLeft,\n  ArrowRight,\n  Code2,\n  Eye,\n  FolderTree,\n  Globe2,\n  Table2,\n  WrapTextIcon,\n} from "lucide-react";',
      'replace'],
    ['import FileBrowserPanel from "./FileBrowserPanel";', 'import { useFileNavigation } from "./fileNavigationHistory";\n'],
    ['  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);\n',
      [
        '  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);',
        '  // Rubato: back and forward through what this panel showed in this thread.',
        '  const navigation = useFileNavigation(',
        '    `${threadRef.environmentId}:${threadRef.threadId}:${cwd}`,',
        '    attachment === undefined ? relativePath : null,',
        '  );',
        '  const navigate = (delta: -1 | 1) => {',
        '    const target = navigation.step(delta);',
        '    if (target !== null) onOpenFile(target);',
        '  };',
        '',
      ].join('\n'),
      'replace'],
    ['    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">',
      [
        '    <div',
        '      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"',
        '      onMouseUp={(event) => {',
        '        // Mouse side buttons: 3 is back, 4 is forward.',
        '        if (event.button !== 3 && event.button !== 4) return;',
        '        event.preventDefault();',
        '        navigate(event.button === 3 ? -1 : 1);',
        '      }}',
        '    >',
      ].join('\n'),
      'replace'],
    // The toggle moves to the left end (next edit). Removing it first keeps that
    // anchor unique; the marker stays because an empty replacement cannot be reversed.
    [explorerToggle, '          {/* Rubato: the explorer toggle sits at the left end. */}\n', 'replace'],
    ['          <ScrollArea\n            radius="none"\n            ref={breadcrumbRef}',
      [
        explorerToggle.trimEnd(),
        '          <div className="flex shrink-0 items-center">',
        '            <FileSurfaceAction',
        '              label="Back"',
        '              disabled={!navigation.canGoBack}',
        '              onPress={() => navigate(-1)}',
        '            >',
        '              <ArrowLeft className="size-3.5" />',
        '            </FileSurfaceAction>',
        '            <FileSurfaceAction',
        '              label="Forward"',
        '              disabled={!navigation.canGoForward}',
        '              onPress={() => navigate(1)}',
        '            >',
        '              <ArrowRight className="size-3.5" />',
        '            </FileSurfaceAction>',
        '          </div>',
        '',
      ].join('\n')],
    ['                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"',
      '                ? "order-first w-[min(22rem,46%)] min-w-64 border-r border-border/60"',
      'replace'],
  ],
};
