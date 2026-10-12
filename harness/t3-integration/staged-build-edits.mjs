// Builds the desktop app into sibling directories while the app keeps running.
//
// A restart used to quit the app first and build after, because the build
// replaces the files the running app reads (apps/server/dist, its client copy,
// apps/desktop/dist-electron). That left the app closed for the whole build,
// about 30s whenever the overlay or the pin changed. install-gui.sh --prepare
// now builds into `<dir>.rubato-next` with the app still open, and --apply
// renames those directories into place once the app has quit.
//
// The web and desktop builds take their output directory as a flag
// (install-gui.sh passes it). The server build is T3's own script: it bundles,
// then copies the web build into dist/client and puts icons over it, with all
// three paths fixed. RUBATO_T3_OUT_SUFFIX moves them together. Unset, the script
// does exactly what T3's does.
export const stagedBuildOverlays = [];

export const stagedBuildEdits = {
  'apps/server/scripts/cli.ts': [
    ['const RepoRoot = Effect.service(Path.Path).pipe(',
      [
        '// Rubato: install-gui.sh --prepare builds into dist<suffix> while the app runs.',
        '// oxlint-disable-next-line t3code/no-global-process-runtime -- build script, read once at start.',
        'const rubatoOutSuffix = process.env.RUBATO_T3_OUT_SUFFIX ?? "";',
        'const rubatoServerDist = `dist${rubatoOutSuffix}`;',
        '',
        '',
      ].join('\n')],
    ['    const targetPath = path.join(serverDir, override.targetRelativePath);',
      '    const targetPath = path.join(\n      serverDir,\n      override.targetRelativePath.replace(/^dist\\//, `${rubatoServerDist}/`),\n    );',
      'replace'],
    ['ChildProcess.make(process.execPath, ["--run", "build:bundle"], {',
      'ChildProcess.make(\n          process.execPath,\n          ["--run", "build:bundle", ...(rubatoOutSuffix ? ["--", "--out-dir", rubatoServerDist] : [])],\n          {',
      'replace'],
    ['      const webDist = path.join(repoRoot, "apps/web/dist");\n      const clientTarget = path.join(serverDir, "dist/client");',
      '      const webDist = path.join(repoRoot, `apps/web/dist${rubatoOutSuffix}`);\n      const clientTarget = path.join(serverDir, `${rubatoServerDist}/client`);',
      'replace'],
  ],
};
