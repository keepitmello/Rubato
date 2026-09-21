import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.86.1";
const featureDir = dirname(fileURLToPath(import.meta.url));

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[video-in:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[video-in:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

/** Stock always emits type:"image". Kimi's Anthropic-compatible endpoint needs type:"video" for video/* blocks. */
export function patchAnthropicMessagesVideo(source) {
  let next = replaceOnce(
    source,
    `        return {
            type: "image",
            source: {
                type: "base64",
                media_type: block.mimeType,
                data: block.data,
            },
        };
`,
    `        if (typeof block.mimeType === "string" && block.mimeType.toLowerCase().startsWith("video/")) {
            return {
                type: "video",
                source: {
                    type: "base64",
                    media_type: block.mimeType,
                    data: block.data,
                },
            };
        }
        return {
            type: "image",
            source: {
                type: "base64",
                media_type: block.mimeType,
                data: block.data,
            },
        };
`,
    "convert-content-blocks",
  );
  return replaceOnce(
    next,
    `                    else {
                        return {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: item.mimeType,
                                data: item.data,
                            },
                        };
                    }
`,
    `                    else if (typeof item.mimeType === "string" && item.mimeType.toLowerCase().startsWith("video/")) {
                        return {
                            type: "video",
                            source: {
                                type: "base64",
                                media_type: item.mimeType,
                                data: item.data,
                            },
                        };
                    }
                    else {
                        return {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: item.mimeType,
                                data: item.data,
                            },
                        };
                    }
`,
    "user-content-blocks",
  );
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const runtimeSources = [
  join(featureDir, "LICENSE"),
  join(featureDir, "THIRD_PARTY_NOTICES.md"),
  ...walk(join(featureDir, "src")),
].sort();

export const patches = Object.freeze([
  Object.freeze({
    id: "anthropic-messages-video-blocks",
    packageName: "@earendil-works/pi-ai",
    version: VERSION,
    path: "dist/api/anthropic-messages.js",
    preimageSha256: "54f32708dc88d951d4c1aacd9e2e531da098967cb61b98a726b43e99277e7754",
    apply: patchAnthropicMessagesVideo,
  }),
]);

export const files = Object.freeze(
  runtimeSources.map((sourcePath) =>
    Object.freeze({
      target: "runtime",
      version: VERSION,
      path: `rubato-features/video-in/${relative(featureDir, sourcePath).split(sep).join("/")}`,
      sourcePath,
    }),
  ),
);

export const feature = Object.freeze({ id: "video-in", patches, files });
