// Office documents in the file viewer. Upstream T3 previews Word, Excel, PowerPoint,
// OpenDocument, RTF, EPUB and notebooks itself (filePreview.ts OFFICE_MIME_TYPES ->
// OfficeFilePreview -> OfficeViewer), and Rubato uses that viewer for everything it covers.
// Rubato adds what upstream does not open, as rows of the same table:
//
// - hwp/hwpx: Hangul documents, laid out by @rhwp/core (Rust + WebAssembly, loaded only
//   when one opens) in HwpViewer.tsx;
// - xlsm: a macro-enabled workbook is an xlsx package, so upstream's Open XML viewer
//   reads it as xlsx (macros never run).
//
// Being rows of upstream's table is what makes the rest follow: the file explorer opens
// them as documents, attachments preview them, and the asset server issues them as exact
// single-file assets with their content type (hostPreviewMimeTypeFromExtension), so a
// document never opens its folder to the page.
//
// The package is added to apps/web/package.json AND pnpm-lock.yaml together. CI installs
// with --frozen-lockfile, and install-gui.sh only reinstalls when the lockfile hash
// changes; editing package.json alone would break both. The lockfile blocks below are
// what `pnpm install --lockfile-only` (pnpm 12.14.0) wrote at the pin.
export const officeOverlays = [
  'apps/web/src/components/files/HwpViewer.tsx',
  'apps/web/src/components/files/rubatoOfficeRoute.ts',
  'apps/web/src/components/files/rubatoOfficeRoute.test.ts',
  'apps/server/src/assets/RubatoOfficeAssets.test.ts',
  'packages/shared/src/rubatoOfficePreview.test.ts',
];

export const officeEdits = {
  'packages/shared/src/filePreview.ts': [
    ['  | "ipynb"\n  | "text"', '  | "ipynb"\n  | "hwp"\n  | "hwpx"\n  | "xlsm"\n  | "text"', 'replace'],
    ['  ipynb: "application/x-ipynb+json",\n} as const;',
      [
        '  ipynb: "application/x-ipynb+json",',
        '  // Rubato: Hangul documents (HwpViewer) and macro-enabled workbooks (read as xlsx).',
        '  hwp: "application/x-hwp",',
        '  hwpx: "application/hwp+zip",',
        '  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",',
        '} as const;',
      ].join('\n'),
      'replace'],
  ],
  'apps/web/src/components/files/OfficeViewer.tsx': [
    ['const OpenXmlOfficeViewer = lazy(() => import("./OpenXmlOfficeViewer"));\n',
      'const OpenXmlOfficeViewer = lazy(() => import("./OpenXmlOfficeViewer"));\nconst HwpViewer = lazy(() => import("./HwpViewer"));\n',
      'replace'],
    ['import VirtualTablePreview from "./VirtualTablePreview";\n',
      'import VirtualTablePreview from "./VirtualTablePreview";\nimport { officeViewerRoute } from "./rubatoOfficeRoute";\n',
      'replace'],
    [
      [
        '  if (props.kind === "docx" || props.kind === "xlsx" || props.kind === "pptx")',
        '    return (',
        '      <Suspense fallback={<FileSurfaceLoading />}>',
        '        <OpenXmlOfficeViewer {...props} kind={props.kind} />',
        '      </Suspense>',
        '    );',
        '  return <ExtendedOfficeViewer {...props} />;',
      ].join('\n'),
      [
        '  const route = officeViewerRoute(props.kind);',
        '  if (route.viewer === "hwp")',
        '    return (',
        '      <Suspense fallback={<FileSurfaceLoading />}>',
        '        <HwpViewer {...props} kind={route.kind} />',
        '      </Suspense>',
        '    );',
        '  if (route.viewer === "open-xml")',
        '    return (',
        '      <Suspense fallback={<FileSurfaceLoading />}>',
        '        <OpenXmlOfficeViewer {...props} kind={route.kind} />',
        '      </Suspense>',
        '    );',
        '  return <ExtendedOfficeViewer {...props} kind={route.kind} />;',
      ].join('\n'),
      'replace'],
  ],
  // The preparation worker never sees Rubato's kinds; OfficeViewer routes them elsewhere.
  'apps/web/src/components/files/officePreviewProtocol.ts': [
    ['import type { PreviewFailure } from "./previewFailure";\n',
      'import type { PreviewFailure } from "./previewFailure";\nimport type { RubatoOfficePreviewKind } from "./rubatoOfficeRoute";\n',
      'replace'],
    ['  | { readonly type: "open"; readonly kind: OfficePreviewKind; readonly bytes: ArrayBuffer }\n',
      [
        '  | {',
        '      readonly type: "open";',
        '      readonly kind: Exclude<OfficePreviewKind, RubatoOfficePreviewKind>;',
        '      readonly bytes: ArrayBuffer;',
        '    }',
        '',
      ].join('\n'),
      'replace'],
  ],
  'apps/web/package.json': [
    ['    "@t3tools/client-runtime": "workspace:*",\n', '    "@rhwp/core": "0.8.6",\n'],
  ],
  'pnpm-lock.yaml': [
    // importers: apps/web
    ["(react@19.3.0)(shiki@4.2.0)\n      '@t3tools/client-runtime':\n",
      "(react@19.3.0)(shiki@4.2.0)\n      '@rhwp/core':\n        specifier: 0.8.6\n        version: 0.8.6\n      '@t3tools/client-runtime':\n",
      'replace'],
    // packages
    ["  '@rolldown/binding-android-arm-eabi@1.2.13':\n    resolution:",
      "  '@rhwp/core@0.8.6':\n    resolution: {integrity: sha512-ZMO2QMHbR4v7t86feMWiRJ4QozjjqHDGv4PyzTT4LyMuX1LeUpmQaOHrGLQpbYMJV0IWCYjVRewKqkXx+w16XQ==}\n\n"],
    // snapshots
    ["  '@rolldown/binding-android-arm-eabi@1.2.13':\n    optional: true", "  '@rhwp/core@0.8.6': {}\n\n"],
  ],
};
