// tsconfig.base.json: TypeScript 7 (tsgo) type-checks with several checkers in
// parallel, and each holds its own copy of the program. One checker took the
// server's typecheck from a 6.1GB peak to 3.5GB for ~10% more time.
export const tsgoCheckersOverlays = [];

export const tsgoCheckersEdits = {
  'tsconfig.base.json': [
    ['  "compilerOptions": {\n    "target": "ESNext",\n',
      '  "compilerOptions": {\n    "checkers": 1,\n    "target": "ESNext",\n',
      'replace'],
  ],
};
