import { files, patches } from "./patches.mjs";

export { files, patches };
export const feature = Object.freeze({ id: "parity-gaps", patches, files });
export default feature;
