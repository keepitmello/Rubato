# Hono security-version deviation

Recorded: 2026-08-30

The Stage design's older Hono references are not release pins. Rubato requires exact `hono@4.13.5` and `@hono/node-server@1.19.17` in both the root overrides and Remote Hub package because the older design versions are covered by reviewed security advisories.

Authority evidence was queried from the OSV API (`https://api.osv.dev/v1/query`) for the exact npm package versions:

- `hono@4.12.18` is affected by GitHub-reviewed **HIGH** advisory [GHSA-88fw-hqm2-52qc](https://github.com/honojs/hono/security/advisories/GHSA-88fw-hqm2-52qc), fixed in 4.12.25. Its wildcard-default CORS middleware can reflect arbitrary origins while allowing credentials.
- `hono@4.12.18` is also affected by reviewed routing, cookie injection, request-smuggling/routing, denial-of-service, cross-request disclosure, authorization, XSS, body-limit, and adapter advisories including GHSA-2gcr-mfcq-wcc3, GHSA-3hrh-pfw6-9m5x, GHSA-54fx-42gc-7vw4, GHSA-8j4g-w8fx-2239, GHSA-f23p-vx2j-j53r, GHSA-f577-qrjj-4474, GHSA-hvrm-45r6-mjfj, GHSA-rv63-4mwf-qqc2, GHSA-w62v-xxxg-mg59, GHSA-wwfh-h76j-fc44, and GHSA-xrhx-7g5j-rcj5. The latest listed fixed floor among these is 4.12.34.
- `@hono/node-server@1.19.13` is affected by reviewed **MODERATE** path traversal advisory [GHSA-frvp-7c67-39w9](https://github.com/honojs/node-server/security/advisories/GHSA-frvp-7c67-39w9), fixed on the 1.x line in 1.19.15.

The selected exact versions exceed those fixed floors. Release verification runs `bun audit --production`; the 2026-08-30 audit checked 270 production packages and reported no vulnerabilities.
