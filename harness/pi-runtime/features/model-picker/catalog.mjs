export {
  PRODUCT_PROVIDER_ORDER as PROVIDER_ORDER,
  PRODUCT_MODEL_ORDER as MODEL_ORDER,
  admitProductCatalogItems,
  catalogSlugs,
  sortProductCatalogItems as sortModelItems,
  productCatalogLabel as modelPickerLabel,
} from "./product-model-catalog.mjs";

import { admitProductCatalogItems } from "./product-model-catalog.mjs";

export function admitPickerItems(models, currentModel, modelsAreEqual) {
  return admitProductCatalogItems(models, {
    keep: (item) => currentModel != null && modelsAreEqual(currentModel, item.model),
  });
}
