/** Manual account rows stay below ordinary models, including in search/favorites. */
export function rubatoAccountModelRank(slug: string): number {
  return /^(?:anthropic|openai-codex)\/.+-sub(?:2)?$/.test(slug) ? 1 : 0;
}
