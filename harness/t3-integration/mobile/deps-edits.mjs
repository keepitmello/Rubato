// Packages the Rubato iPhone app adds to T3's apps/mobile: LiveKit for companion calls
// (features/companions) and the config plugins that wire its native side, and
// @bacons/apple-targets for the notification service extension (targets/).
//
// package.json and pnpm-lock.yaml change together: install-gui.sh reinstalls only when
// the lockfile hash changes, and CI installs with --frozen-lockfile. deps-lock.json is
// generated, not written by hand:
//
//   1. add the package to apps/mobile/package.json in a scratch tree (pin + apply.mjs)
//   2. corepack pnpm install --lockfile-only there
//   3. node lock-diff.mjs <base lockfile> <new lockfile> <pin lockfile> > deps-lock.json
//
// livekit-client stays at 2.23.0: 2.24.0 is younger than pnpm-workspace.yaml's
// minimumReleaseAge, and taking it would mean editing that file too.
import { readFileSync } from 'node:fs';

export const depsOverlays = [];

export const depsEdits = {
  'apps/mobile/package.json': [
    ['    "@clerk/expo": "catalog:",\n    "@effect/atom-react": "catalog:",',
      '    "@bacons/apple-targets": "5.0.0",\n    "@clerk/expo": "catalog:",\n    "@config-plugins/react-native-webrtc": "15.0.2",\n    "@effect/atom-react": "catalog:",', 'replace'],
    ['    "@legendapp/list": "catalog:",\n    "@material/material-color-utilities": "0.3.0",',
      '    "@legendapp/list": "catalog:",\n    "@livekit/react-native": "3.1.0",\n    "@livekit/react-native-expo-plugin": "1.1.0",\n    "@livekit/react-native-webrtc": "150.1.1",\n    "@material/material-color-utilities": "0.3.0",', 'replace'],
    ['    "expo-widgets": "58.0.11",\n    "react": "19.3.0",',
      '    "expo-widgets": "58.0.11",\n    "livekit-client": "2.23.0",\n    "react": "19.3.0",', 'replace'],
  ],
  // T3's build stops on a bundled package with no license file; this plugin is MIT (expo/config-plugins).
  'third-party-licenses.config.json': [
    ['    {\n      "name": "@connectrpc/connect",\n      "version": "1.7.0",',
      '    {\n      "name": "@config-plugins/react-native-webrtc",\n      "version": "15.0.2",\n      "license": "MIT",\n      "sourceUrl": "https://github.com/expo/config-plugins/tree/main/packages/react-native-webrtc",\n      "generatedNotice": {\n        "licenseId": "MIT",\n        "copyrights": ["Copyright (c) 650 Industries, Inc. (aka Expo)"]\n      }\n    },\n    {\n      "name": "@connectrpc/connect",\n      "version": "1.7.0",', 'replace'],
  ],
  'pnpm-lock.yaml': JSON.parse(readFileSync(new URL('./deps-lock.json', import.meta.url), 'utf8')),
};
