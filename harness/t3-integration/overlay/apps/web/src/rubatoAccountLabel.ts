/** Display the model-to-account mapping returned by Rubato, never infer it from `default`. */
export function rubatoAccountLabel(modelSuffix: string | null | undefined): string | null {
  if (modelSuffix === "") return "Main account";
  if (modelSuffix === "-sub") return "Sub account";
  if (modelSuffix === "-sub2") return "Sub account 2";
  return null;
}

export function rubatoAccountOrder(modelSuffix: string | null | undefined): number {
  return modelSuffix === "" ? 0 : modelSuffix === "-sub" ? 1 : modelSuffix === "-sub2" ? 2 : 3;
}
