interface ProjectRef {
  readonly environmentId: string;
  readonly projectId: string;
}

export const projectKey = (project: ProjectRef) => `${project.environmentId}:${project.projectId}`;

export function visibleProjects<T extends ProjectRef>(items: readonly T[], hidden: ReadonlySet<string>): readonly T[] {
  return hidden.size === 0 ? items : items.filter((item) => !hidden.has(projectKey(item)));
}

export function toggleProjectVisibility(previous: readonly string[], keys: readonly string[]): string[] {
  const next = new Set(previous);
  const show = keys.every((key) => next.has(key));
  for (const key of keys) {
    if (show) next.delete(key);
    else next.add(key);
  }
  return [...next];
}
