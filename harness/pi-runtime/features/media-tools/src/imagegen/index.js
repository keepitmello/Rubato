import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexImageModel } from "./codex.js";
import { imageCreateTool, imageEditTool } from "./tool.js";
const IMAGEGEN_BASE_DIR = dirname(fileURLToPath(import.meta.url));
// Bun compile extracts imported file assets to a real path; Node dist keeps using the copied skill.
const embeddedSkillPath = process.versions.bun
    ? import("./skill/SKILL.md", { with: { type: "file" } }).then((module) => module.default)
    : Promise.resolve(undefined);
let loggedMissingSkill = false;
async function bundledSkillPath(baseDir) {
    const skillPath = join(baseDir, "skill", "SKILL.md");
    if (existsSync(skillPath))
        return skillPath;
    const embeddedPath = await embeddedSkillPath;
    if (baseDir === IMAGEGEN_BASE_DIR && embeddedPath !== undefined && existsSync(embeddedPath))
        return embeddedPath;
    if (!loggedMissingSkill) {
        loggedMissingSkill = true;
        console.error(`[imagegen] bundled skill not found at ${skillPath}; skipping contribution`);
    }
    return undefined;
}
export function registerImageGenExtension(pi, baseDir = IMAGEGEN_BASE_DIR) {
    pi.registerTool(imageCreateTool);
    pi.registerTool(imageEditTool);
    pi.on("resources_discover", async (_event, ctx) => {
        if (!resolveCodexImageModel(ctx.modelRegistry).ok)
            return undefined;
        const skillPath = await bundledSkillPath(baseDir);
        return skillPath === undefined ? undefined : { skillPaths: [skillPath] };
    });
}
export default function imageGenExtension(pi) {
    registerImageGenExtension(pi);
}
