// Office documents in the file viewer. Upstream T3 reads a workspace file as UTF-8
// text, so .docx/.xlsx/.pptx/.hwp(x) opened in the sidebar explorer stopped at
// "This file contains binary data". The bytes now come from the same signed asset
// URL the image and PDF viewers use, and the client turns them into pages:
//
// - docx: docx-preview (its only dependency, jszip, is already T3's);
// - pptx: @jvmr/pptx-to-html (jszip only);
// - hwp/hwpx: @rhwp/core (Rust + WebAssembly, loaded only when one opens);
// - xlsx/xlsm: read here with jszip into a table (rubatoXlsx.ts), no library.
//
// The server issues these as exact single-file assets, like images, so a document
// never opens its folder to the frame. Legacy binary .doc/.xls/.ppt stay unsupported.
//
// The packages are added to apps/web/package.json AND pnpm-lock.yaml together.
// CI installs with --frozen-lockfile, and install-gui.sh only reinstalls when the
// lockfile hash changes; editing package.json alone would break both. The lockfile
// blocks below are what `pnpm install --lockfile-only` (pnpm 11.10.0) wrote at the pin.
export const officeOverlays = [
  'apps/web/src/components/files/OfficeDocumentPreview.tsx',
  'apps/web/src/components/files/rubatoXlsx.ts',
  'apps/web/src/components/files/rubatoXlsx.test.ts',
  'apps/server/src/assets/RubatoOfficeAssets.test.ts',
  'packages/shared/src/rubatoOfficePreview.test.ts',
];

const OFFICE_TYPES = `// Rubato: office documents the file viewer renders in the client.
export type OfficePreviewKind = "docx" | "xlsx" | "pptx" | "hwp";

const OFFICE_PREVIEW_BY_EXTENSION = new Map<
  string,
  { readonly kind: OfficePreviewKind; readonly mimeType: string }
>([
  [".docx", { kind: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
  [".xlsx", { kind: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  [".xlsm", { kind: "xlsx", mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12" }],
  [".pptx", { kind: "pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }],
  [".hwp", { kind: "hwp", mimeType: "application/x-hwp" }],
  [".hwpx", { kind: "hwp", mimeType: "application/hwp+zip" }],
]);

/** Classifies a literal filesystem path by its extension. */
export function officePreviewKind(path: string): OfficePreviewKind | null {
  const extensionIndex = path.lastIndexOf(".");
  if (extensionIndex < 0) return null;
  return OFFICE_PREVIEW_BY_EXTENSION.get(path.slice(extensionIndex).toLowerCase())?.kind ?? null;
}

`;

const lockPackage = (name, integrity) => `  ${name}:\n    resolution: {integrity: ${integrity}}\n\n`;

export const officeEdits = {
  'packages/shared/src/filePreview.ts': [
    ['const AUDIO_MIME_TYPE_BY_EXTENSION = new Map([', OFFICE_TYPES],
    ['    BROWSER_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??\n    null',
      '    BROWSER_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??\n    OFFICE_PREVIEW_BY_EXTENSION.get(extension.toLowerCase())?.mimeType ??\n    null',
      'replace'],
    ['  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);',
      '  return (\n    isWorkspaceBrowserPreviewPath(path) ||\n    isWorkspaceImagePreviewPath(path) ||\n    officePreviewKind(path) !== null\n  );',
      'replace'],
  ],
  'apps/server/src/assets/AssetAccess.ts': [
    ['  isWorkspacePreviewEntryPath,\n  WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,', '  officePreviewKind,\n'],
    ['      claims: isWorkspaceImagePreviewPath(resolved.relativePath)\n',
      '      claims:\n        isWorkspaceImagePreviewPath(resolved.relativePath) ||\n        officePreviewKind(resolved.relativePath) !== null\n',
      'replace'],
  ],
  'apps/web/src/components/files/FilePreviewPanel.tsx': [
    ['  isWorkspaceVideoPreviewPath,\n} from "@t3tools/shared/filePreview";', '  officePreviewKind,\n'],
    ['import { AudioPreview } from "./AudioPreview";', 'import { OfficeDocumentPreview } from "./OfficeDocumentPreview";\n'],
    // An office document never shows its text, so it counts as media for the
    // truncation banner and the text re-read on workspace changes.
    ['  const isMedia = isImage || isVideo || isAudio;',
      '  const officeKind =\n    relativePath !== null && attachment === undefined ? officePreviewKind(relativePath) : null;\n  const isMedia = isImage || isVideo || isAudio || officeKind !== null;',
      'replace'],
    ['          ) : relativePath && renderBrowserFile && absolutePath ? (\n',
      [
        '          ) : relativePath && officeKind && absolutePath ? (',
        '            <OfficeDocumentPreview',
        '              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}',
        '              environmentId={environmentId}',
        '              threadRef={threadRef}',
        '              absolutePath={absolutePath}',
        '              workspaceRoot={cwd}',
        '              name={relativePath}',
        '              kind={officeKind}',
        '              workspaceMutationId={workspaceMutationId}',
        '            />',
        '',
      ].join('\n')],
  ],
  'apps/web/package.json': [
    ['    "@legendapp/list": "catalog:",\n', '    "@jvmr/pptx-to-html": "1.1.2",\n'],
    ['    "@t3tools/client-runtime": "workspace:*",\n', '    "@rhwp/core": "0.8.6",\n'],
    ['    "effect": "catalog:",\n', '    "docx-preview": "0.4.1",\n'],
  ],
  'pnpm-lock.yaml': [
    // importers: apps/web
    ["      '@formkit/auto-animate':\n        specifier: ^0.9.0\n        version: 0.9.0\n",
      "      '@formkit/auto-animate':\n        specifier: ^0.9.0\n        version: 0.9.0\n      '@jvmr/pptx-to-html':\n        specifier: 1.1.2\n        version: 1.1.2\n",
      'replace'],
    ["        version: 1.0.0-beta.4(react-dom@19.2.6(react@19.2.6))(react@19.2.6)\n      '@t3tools/client-runtime':\n",
      "        version: 1.0.0-beta.4(react-dom@19.2.6(react@19.2.6))(react@19.2.6)\n      '@rhwp/core':\n        specifier: 0.8.6\n        version: 0.8.6\n      '@t3tools/client-runtime':\n",
      'replace'],
    ['      culori:\n        specifier: ^4.0.2\n        version: 4.0.2\n',
      '      culori:\n        specifier: ^4.0.2\n        version: 4.0.2\n      docx-preview:\n        specifier: 0.4.1\n        version: 0.4.1\n',
      'replace'],
    // packages
    ["  '@legendapp/list@3.3.5':\n    resolution:",
      lockPackage("'@jvmr/pptx-to-html@1.1.2'", 'sha512-ixZ6ikF8j7uNNA1QdF0wWnZUd7nzhJhBnzjzKILwrCr73xb8b1h8ciZW+BCae+9OwMMF/Af9SiIdWkq5Zcg7Yw==')],
    ["  '@rolldown/binding-android-arm-eabi@1.2.5':\n    resolution:",
      lockPackage("'@rhwp/core@0.8.6'", 'sha512-ZMO2QMHbR4v7t86feMWiRJ4QozjjqHDGv4PyzTT4LyMuX1LeUpmQaOHrGLQpbYMJV0IWCYjVRewKqkXx+w16XQ==')],
    ['  dom-accessibility-api@0.5.16:\n    resolution:',
      lockPackage('docx-preview@0.4.1', 'sha512-Dv4g+LeE0swHpPvNC0lAT0YsR5Zq5pAxw7d3vHQ8EChBLgIrqqe9VPL5nVt2HBJap8bEZbXUI0TJob7kBeNU9w==')],
    // snapshots
    ["      jsbi: 4.3.2\n\n  '@legendapp/list@3.3.5(",
      "      jsbi: 4.3.2\n\n  '@jvmr/pptx-to-html@1.1.2':\n    dependencies:\n      jszip: 3.10.1\n\n  '@legendapp/list@3.3.5(",
      'replace'],
    ["  '@rolldown/binding-android-arm-eabi@1.2.5':\n    optional: true", "  '@rhwp/core@0.8.6': {}\n\n"],
    ['  dom-accessibility-api@0.5.16: {}', '  docx-preview@0.4.1:\n    dependencies:\n      jszip: 3.10.1\n\n'],
  ],
};
