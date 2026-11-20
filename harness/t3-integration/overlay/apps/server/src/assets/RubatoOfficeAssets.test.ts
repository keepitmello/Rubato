import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as AssetSigner from "./AssetSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

// Rubato: Hangul documents and macro-enabled workbooks join upstream's office table, so the
// asset server issues them the way it issues upstream's office documents: one exact file.

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "rubato-office-asset-test-",
});
const testLayer = Layer.mergeAll(
  NodeHttpPlatform.layer,
  // Document assets never read a turn item; AssetAccess still needs the service.
  Layer.mock(Orchestrator.OrchestratorV2)({ getTurnItem: () => Effect.succeed(null) }),
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(configLayer)),
  AssetSigner.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(configLayer))),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const tokenOf = (relativeUrl: string) => {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  return suffix.slice(0, suffix.indexOf("/"));
};

const DOCUMENTS = [
  ["공문.hwp", "application/x-hwp"],
  ["공문.hwpx", "application/hwp+zip"],
  ["macro.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"],
  ["보고서.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
] as const;

const workspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rubato-office-workspace-" });
  for (const [name] of DOCUMENTS) yield* fileSystem.writeFileString(path.join(root, name), "PK");
  yield* fileSystem.writeFileString(path.join(root, "page.html"), "<p>sibling</p>");
  yield* fileSystem.writeFileString(path.join(root, "notes.txt"), "sibling");
  return root;
});

describe("Rubato office document assets", () => {
  it.effect("issues a workspace document the file viewer opens as that file alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* workspace;
      for (const [name, mimeType] of DOCUMENTS) {
        // FilePreviewPanel asks for an open workspace document by its absolute path.
        const result = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: path.join(root, name),
          },
          workspaceRoot: root,
        });
        const token = tokenOf(result.relativeUrl);
        // The exact-file asset also carries the file it opened while checking it.
        expect(yield* resolveAsset(token, name)).toMatchObject({
          kind: "file",
          path: yield* fileSystem.realPath(path.join(root, name)),
          mimeType,
        });
        expect(yield* resolveAsset(token, "page.html")).toBeNull();
        expect(yield* resolveAsset(token, "notes.txt")).toBeNull();
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues a draft's workspace document as that file alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* workspace;
      for (const [name] of DOCUMENTS) {
        const result = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: name },
          workspaceRoot: root,
        });
        const token = tokenOf(result.relativeUrl);
        expect(yield* resolveAsset(token, name)).toEqual({
          kind: "file",
          path: yield* fileSystem.realPath(path.join(root, name)),
        });
        expect(yield* resolveAsset(token, "page.html")).toBeNull();
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues a Hangul document outside the workspace by its exact host path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "rubato-office-host-",
      });
      const documentPath = path.join(directory, "letter.hwpx");
      yield* fileSystem.writeFileString(documentPath, "PK");

      const result = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: documentPath },
      });
      expect(yield* resolveAsset(tokenOf(result.relativeUrl), "letter.hwpx")).toMatchObject({
        kind: "file",
        mimeType: "application/hwp+zip",
      });
    }).pipe(Effect.provide(testLayer)),
  );
});
