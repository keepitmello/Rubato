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
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "rubato-office-asset-test-",
});
const testLayer = Layer.mergeAll(
  NodeHttpPlatform.layer,
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

describe("Rubato office document assets", () => {
  it.effect("serves a workspace document alone, never its neighbours", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rubato-office-workspace-" });
      for (const name of ["보고서.docx", "plan.xlsx", "deck.pptx", "공문.hwp", "공문.hwpx"]) {
        yield* fileSystem.writeFileString(path.join(root, name), "PK");
      }
      yield* fileSystem.writeFileString(path.join(root, "page.html"), "<p>sibling</p>");

      for (const name of ["보고서.docx", "plan.xlsx", "deck.pptx", "공문.hwp", "공문.hwpx"]) {
        const result = yield* issueAssetUrl({
          resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: path.join(root, name) },
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

  it.effect("serves a document outside the workspace by its exact host path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rubato-office-host-" });
      const documentPath = path.join(directory, "letter.docx");
      yield* fileSystem.writeFileString(documentPath, "PK");

      const result = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: documentPath },
      });
      const resolved = yield* resolveAsset(tokenOf(result.relativeUrl), "letter.docx");
      expect(resolved).toMatchObject({
        kind: "file",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    }).pipe(Effect.provide(testLayer)),
  );
});
