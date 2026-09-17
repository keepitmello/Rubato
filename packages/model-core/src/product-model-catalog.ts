// The runtime SSOT is the sibling .mjs so CLI staging can copy it as plain JS.
// @ts-expect-error JS catalog module is copied into the CLI picker; types are declared on these re-exports.
import * as catalog from "./product-model-catalog.mjs"

export type ProductCatalogItem = {
  readonly provider: string
  readonly id: string
  readonly model?: { readonly name?: string }
  readonly name?: string
}

export const PRODUCT_PROVIDER_ORDER: readonly string[] = catalog.PRODUCT_PROVIDER_ORDER
export const PRODUCT_MODEL_ORDER: Readonly<Record<string, readonly string[]>> = catalog.PRODUCT_MODEL_ORDER
export const CURSOR_GROK_PRESENTED_ID: string = catalog.CURSOR_GROK_PRESENTED_ID
export const CURSOR_GROK_DEFAULT_FAST_ID: string = catalog.CURSOR_GROK_DEFAULT_FAST_ID
export const CURSOR_GROK_LIVE_IDS: readonly string[] = catalog.CURSOR_GROK_LIVE_IDS

export const catalogSlugs: () => string[] = catalog.catalogSlugs
export const isProductCatalogRow: (item: ProductCatalogItem | null | undefined) => boolean = catalog.isProductCatalogRow
export const isProductCatalogSlug: (model: string) => boolean = catalog.isProductCatalogSlug
export const admitProductCatalogItems: <T extends ProductCatalogItem>(
  models: readonly T[],
  options?: { readonly keep?: (item: T) => boolean },
) => T[] = catalog.admitProductCatalogItems
export const sortProductCatalogItems: <T extends ProductCatalogItem>(models: readonly T[]) => T[] =
  catalog.sortProductCatalogItems
export const productCatalogLabel: (item: ProductCatalogItem) => string = catalog.productCatalogLabel
export const productCatalogIdentity: (model: string) => string = catalog.productCatalogIdentity
export const productCatalogAliases: (model: string) => readonly string[] = catalog.productCatalogAliases
export const launchProductModel: (model: string) => string = catalog.launchProductModel
export const availableProductModelIds: (
  entries: ReadonlyArray<{ readonly provider?: string; readonly id?: string } | null | undefined>,
) => string[] = catalog.availableProductModelIds
export const expandProductCatalogVisibility: (visible: ReadonlySet<string>) => Set<string> =
  catalog.expandProductCatalogVisibility
