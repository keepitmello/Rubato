// A file a session shows again under the same path shows as it is now. A session that
// rewrites /tmp/look.png or report.html and attaches it again got the first version:
// the client keeps one signed URL per path while anything shows it (re-signed every
// 30 minutes), and the browser keeps that URL's bytes for an hour.
//
// - The host signs the file's revision (mtime and size) into the URL of a host file, and
//   mints of one revision in the same 30-minute window share a URL, like HTML attachments.
// - Each new consumer of a host file (a message that shows it, a preview that opens it)
//   asks the host once more when the URL it found was already signed. An unchanged file
//   comes back with the same URL and nothing reloads; a rewritten one loads anew, in the
//   older messages too.
export const assetRevisionOverlays = [
  'apps/server/src/assets/RubatoAssetRevision.test.ts',
];

const lines = (...parts) => parts.join('\n');

export const assetRevisionEdits = {
  'apps/server/src/assets/AssetAccess.ts': [
    [
      'const HTML_ATTACHMENT_TOKEN_BUCKET_MS = 30 * 60 * 1000;\n',
      '// Rubato: mints of one host file revision in this window share a URL (asset-revision-edits.mjs).\nconst HOST_FILE_TOKEN_BUCKET_MS = 30 * 60 * 1000;\n',
    ],
    ...['workspace-file', 'workspace-file-exact', 'media-file-exact'].map((kind) => [
      `    kind: Schema.Literal("${kind}"),\n`,
      `    kind: Schema.Literal("${kind}"),\n    /** Rubato: the file's mtime and size at mint time, so a rewritten file gets a new URL. */\n    revision: Schema.optionalKey(Schema.String),\n`,
      'replace',
    ]),
    [
      '  if (claims.kind === "attachment" && claims.mimeType === "text/html") {\n',
      lines(
        '  // Rubato: a host file can be rewritten in place under the same path, and the browser',
        '  // keeps an asset URL\'s bytes for an hour. The file\'s revision goes into the URL, and',
        '  // mints of one revision in the same window share it, so a client can ask again each',
        '  // time it shows the file and only a changed file loads anew (asset-revision-edits.mjs).',
        '  if (',
        '    claims.kind === "media-file-exact" ||',
        '    claims.kind === "workspace-file-exact" ||',
        '    claims.kind === "workspace-file"',
        '  ) {',
        '    const revisionPath =',
        '      claims.kind === "media-file-exact"',
        '        ? claims.filePath',
        '        : claims.kind === "workspace-file-exact"',
        '          ? path.join(claims.workspaceRoot, claims.relativePath)',
        '          : path.join(claims.workspaceRoot, claims.baseRelativePath, fileName);',
        '    const info = yield* fileSystem.stat(revisionPath).pipe(Effect.option);',
        '    if (Option.isSome(info)) {',
        '      const modifiedAt = Option.match(info.value.mtime, {',
        '        onNone: () => "",',
        '        onSome: (date) => String(date.getTime()),',
        '      });',
        '      expiresAt = Math.ceil(expiresAt / HOST_FILE_TOKEN_BUCKET_MS) * HOST_FILE_TOKEN_BUCKET_MS;',
        '      claims = { ...claims, revision: `${modifiedAt}-${info.value.size}`, expiresAt };',
        '    }',
        '  }',
        '',
      ),
    ],
  ],
  'apps/web/src/assets/assetUrls.ts': [
    [
      'import { useCallback, useMemo } from "react";\n',
      'import { useCallback, useEffect, useEffectEvent, useMemo } from "react";\n',
      'replace',
    ],
    [
      '  if (blocked !== null) return blocked;\n  return assetUrlStateFromResult(\n',
      lines(
        '  useHostFileRevalidation(',
        '    environmentId,',
        '    blocked === null ? resource : null,',
        '    result._tag === "Success",',
        '  );',
        '',
      ),
    ],
    [
      'export function useAssetUrls(\n',
      lines(
        '/**',
        ' * Rubato: a session can rewrite a file and show it again under the same path. A URL',
        ' * this consumer finds already signed was minted for the file as it was then, so a new',
        ' * consumer asks the host once more. The host signs the file\'s revision into the URL:',
        ' * an unchanged file keeps its URL, and only a rewritten one loads anew (asset-revision-edits.mjs).',
        ' */',
        'function useHostFileRevalidation(',
        '  environmentId: EnvironmentId | null,',
        '  resource: AssetResource | null,',
        '  alreadySigned: boolean,',
        '): void {',
        '  const refresh = useAssetUrlRefresh(environmentId, resource);',
        '  const revalidate = useEffectEvent(() => {',
        '    if (alreadySigned) void refresh().catch(() => undefined);',
        '  });',
        '  const hostFileKey =',
        '    environmentId !== null &&',
        '    resource !== null &&',
        '    (resource._tag === "media-file" ||',
        '      resource._tag === "workspace-file" ||',
        '      resource._tag === "draft-workspace-file")',
        '      ? JSON.stringify([environmentId, resource])',
        '      : null;',
        '  useEffect(() => {',
        '    if (hostFileKey !== null) revalidate();',
        '  }, [hostFileKey]);',
        '}',
        '',
        '',
      ),
    ],
  ],
  'apps/web/src/assets/assetUrls.test.ts': [
    [
      'vi.mock("react", () => ({ useCallback: <A>(callback: A) => callback }));\n',
      lines(
        'vi.mock("react", () => ({',
        '  useCallback: <A>(callback: A) => callback,',
        '  // Rubato: effects run as the hook is called (asset-revision-edits.mjs).',
        '  useEffect: (effect: () => void) => effect(),',
        '  useEffectEvent: <A>(callback: A) => callback,',
        '}));',
        '',
      ),
      'replace',
    ],
    [
      'it("hides host assets with a denied grant while preserving attachments", () => {\n',
      lines(
        '// Rubato: a file rewritten under the same path (asset-revision-edits.mjs).',
        'it.each(["workspace-file", "media-file"] as const)(',
        '  "asks the host again for a %s whose URL is already signed",',
        '  (_tag) => {',
        '    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };',
        '    useAssetUrlState(environmentId, { ...resource, _tag });',
        '    expect(state.mint).toHaveBeenCalledWith({',
        '      environmentId,',
        '      input: { resource: { ...resource, _tag } },',
        '    });',
        '  },',
        ');',
        '',
        'it("leaves a host file alone while its first URL is being signed", () => {',
        '  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };',
        '  state.assetQuery.mockReturnValue({});',
        '  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Loading" });',
        '  expect(state.mint).not.toHaveBeenCalled();',
        '});',
        '',
        'it("does not ask again for an attachment, which never changes", () => {',
        '  useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: "upload" });',
        '  expect(state.mint).not.toHaveBeenCalled();',
        '});',
        '',
        'it("does not ask for a host file the connection cannot read", () => {',
        '  state.session = { authenticated: true, scopes: [] };',
        '  useAssetUrlState(environmentId, resource);',
        '  expect(state.mint).not.toHaveBeenCalled();',
        '});',
        '',
        '',
      ),
    ],
  ],
};
