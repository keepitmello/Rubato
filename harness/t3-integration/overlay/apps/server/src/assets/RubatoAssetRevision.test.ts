import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

// A session rewrites a file and attaches it again under the same path
// (asset-revision-edits.mjs).
const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "rubato-asset-revision-test-",
});
const testLayer = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({ getTurnItem: () => Effect.succeed(null) }),
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(configLayer)),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

const tokenOf = (relativeUrl: string) => {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  return suffix.slice(0, suffix.indexOf("/"));
};
const threadId = ThreadId.make("thread-1");

describe("Rubato host file revisions", () => {
  it.effect("gives a rewritten host file a new URL and an unchanged one the same URL", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "rubato-revision-host-",
      });
      const imagePath = path.join(directory, "look.png");
      const mint = () =>
        issueAssetUrl({ resource: { _tag: "media-file", threadId, path: imagePath } });

      yield* fileSystem.writeFileString(imagePath, "first");
      const first = yield* mint();
      expect((yield* mint()).relativeUrl).toBe(first.relativeUrl);

      yield* fileSystem.writeFileString(imagePath, "second version");
      const second = yield* mint();
      expect(second.relativeUrl).not.toBe(first.relativeUrl);
      expect(yield* resolveAsset(tokenOf(second.relativeUrl), "look.png")).toMatchObject({
        kind: "file",
        path: yield* fileSystem.realPath(imagePath),
        mimeType: "image/png",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("tells a rewrite of the same size apart by its modified time", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "rubato-revision-mtime-",
      });
      const imagePath = path.join(directory, "look.png");
      const mint = () =>
        issueAssetUrl({ resource: { _tag: "media-file", threadId, path: imagePath } });

      yield* fileSystem.writeFileString(imagePath, "aaaa");
      yield* fileSystem.utimes(imagePath, 1_000_000, 1_000_000);
      const first = yield* mint();
      yield* fileSystem.writeFileString(imagePath, "bbbb");
      yield* fileSystem.utimes(imagePath, 2_000_000, 2_000_000);
      expect((yield* mint()).relativeUrl).not.toBe(first.relativeUrl);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("versions workspace images and documents the same way", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "rubato-revision-workspace-",
      });
      for (const name of ["shot.png", "report.html"]) {
        const filePath = path.join(root, name);
        const mint = () =>
          issueAssetUrl({
            resource: { _tag: "workspace-file", threadId, path: filePath },
            workspaceRoot: root,
          });

        yield* fileSystem.writeFileString(filePath, "first");
        const first = yield* mint();
        expect((yield* mint()).relativeUrl).toBe(first.relativeUrl);

        yield* fileSystem.writeFileString(filePath, "second version");
        const second = yield* mint();
        expect(second.relativeUrl).not.toBe(first.relativeUrl);
        expect(yield* resolveAsset(tokenOf(second.relativeUrl), name)).toEqual({
          kind: "file",
          path: yield* fileSystem.realPath(filePath),
        });
      }
    }).pipe(Effect.provide(testLayer)),
  );
});
