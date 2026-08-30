import { rubatoExtension } from "./engine-paths.mjs";

export function rubatoExtensionPath() {
  return rubatoExtension;
}

export async function loadRubatoExtension() {
  return import(rubatoExtensionPath());
}
