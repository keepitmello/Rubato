import { BRAND_NAME, BRAND_VERSION } from "../statusline/brand.mjs";

export { BRAND_NAME, BRAND_VERSION };

/** Product version on the startup header. Engine VERSION stays on APP_NAME / updates. */
export function startupDisplayVersion(engineVersion, env = process.env) {
  const override = env?.RUBATO_VERSION;
  if (typeof override === "string" && override.trim()) return override.trim();
  return BRAND_VERSION;
}

export function startupLogoPlain(engineVersion, env = process.env) {
  return `${BRAND_NAME} v${startupDisplayVersion(engineVersion, env)}`;
}
