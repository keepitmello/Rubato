import type { ProviderDriverKind } from "@t3tools/contracts";

import type { Icon } from "../Icons";
import { iconForProviderModel, vendorForModel } from "../chat/rubatoModelIcons";

/**
 * The model's company glyph for a Rubato thread card; the same mapping the model picker uses.
 * Only Rubato threads get one: other drivers keep their instance icon. A Rubato model of no
 * known company returns null, so the card falls back to the instance icon (the Rubato mark).
 */
export function threadModelIcon(driverKind: ProviderDriverKind, model: string): Icon | null {
  if (driverKind !== "rubato-pi") return null;
  const slug = model.toLowerCase();
  if (!slug.includes("deepseek") && !slug.includes("gemini") && !vendorForModel({ slug })) {
    return null;
  }
  return iconForProviderModel(driverKind, { slug });
}
