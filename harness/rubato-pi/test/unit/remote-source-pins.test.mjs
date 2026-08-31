import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const evidence = JSON.parse(readFileSync(
  new URL("../fixtures/remote/source-pins.json", import.meta.url),
  "utf8",
));
const rootPackage = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"));

const PI_COMMIT = "914cf1472e715297caa30db4b9535d534a9eb718";
const ZMX_COMMIT = "0266042ca8f399c9d76825739b93443e2d5bf47a";
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function assertLicensePin(license) {
  assert.equal(license.spdx, "MIT");
  if (license.sha256 !== undefined) assert.match(license.sha256, SHA256);
}

test("every Pi package remains exactly 0.84.2 at the asserted upstream source commit", () => {
  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(
    {
      repository: evidence.pi.repository,
      tag: evidence.pi.tag,
      version: evidence.pi.version,
      commit: evidence.pi.commit,
      tree: evidence.pi.tree,
    },
    {
      repository: "https://github.com/earendil-works/pi",
      tag: "v0.84.2",
      version: "0.84.2",
      commit: PI_COMMIT,
      tree: "73f6a2a71a4fb941c5688753931c2aa6f95902c5",
    },
  );

  const names = [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ];
  assert.deepEqual(evidence.pi.packages.map((entry) => entry.name), names);
  for (const entry of evidence.pi.packages) {
    assert.equal(rootPackage.overrides[entry.name], "0.84.2", `${entry.name} root override`);
    assert.match(entry.sourceSha256, SHA256, `${entry.name} source hash`);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, `${entry.name} registry integrity`);
  }
  assertLicensePin(evidence.pi.license);
});

test("zmx source and MIT evidence are pinned to the qualified commit", () => {
  assert.deepEqual(
    {
      repository: evidence.zmx.repository,
      commit: evidence.zmx.commit,
      tree: evidence.zmx.tree,
      baseRelease: evidence.zmx.baseRelease,
      baseReleaseCommit: evidence.zmx.baseReleaseCommit,
      releaseLineRelation: evidence.zmx.releaseLineRelation,
      describe: evidence.zmx.describe,
      binaryVersion: evidence.zmx.binaryVersion,
    },
    {
      repository: "https://github.com/neurosnap/zmx",
      commit: ZMX_COMMIT,
      tree: "76d677df2844eff6ce8a553163f5c53511184151",
      baseRelease: "0.7.1",
      baseReleaseCommit: "1cea103fef83cd53586fcb2c5f90d693fc9f5a30",
      releaseLineRelation: "diverged-not-ancestor",
      describe: "v0.7.0-47-g0266042",
      binaryVersion: "0.7.0",
    },
  );
  assert.match(evidence.zmx.commit, SHA1);
  assertLicensePin(evidence.zmx.license);
  assert.equal(evidence.zmx.license.copyright, "Copyright (c) 2025 Eric Bower");
});

test("pi-web-ui reference source, published commit, and MIT evidence are explicit", () => {
  assert.deepEqual(
    {
      repository: evidence.piWebUi.repository,
      package: evidence.piWebUi.package,
      version: evidence.piWebUi.version,
      tag: evidence.piWebUi.tag,
      tagCommit: evidence.piWebUi.tagCommit,
      publishedGitHead: evidence.piWebUi.publishedGitHead,
    },
    {
      repository: "https://github.com/kkkiio/pi-web-ui",
      package: "@kkkiio/pi-web-ui",
      version: "0.1.1",
      tag: "v0.1.1",
      tagCommit: "d3d7b9fdf6f7cb576d422eb6605a55604cda887d",
      publishedGitHead: "a3ab3b1c46f0ad3d837d7ba9e968b7e61d5259da",
    },
  );
  assert.match(evidence.piWebUi.tagTree, SHA1);
  assert.match(evidence.piWebUi.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
  assert.equal(evidence.piWebUi.license.spdx, "MIT");
  assert.match(evidence.piWebUi.license.packageJsonSha256, SHA256);
  assert.match(evidence.piWebUi.license.readmeSha256, SHA256);
});
