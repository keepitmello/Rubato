// The runtime SSOT is the sibling .mjs so CLI staging can copy it as plain JS.
// @ts-expect-error JS label module is copied into the CLI surfaces; types are declared on this re-export.
import * as label from "./model-label.mjs"

export const shortModelLabel: (modelId: string | null | undefined) => string = label.shortModelLabel
