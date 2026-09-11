import { create } from "@bufbuild/protobuf";
import { resolveCursorSelectionDescriptor } from "../../cursor/selection-descriptor.js";
import { RequestedModel_ModelParameterbytesSchema, RequestedModelSchema } from "./gen/agent_pb.js";
/**
 * Render the resolved Cursor selection into the protobuf `RequestedModel`
 * fields: resolved wire id, maxMode, and ordered parameters. An absent
 * selection yields the pre-grouping request shape (upstream id, no
 * parameters) byte-for-byte.
 */
export function buildRequestedModelFields(model, selection) {
    const resolved = resolveCursorSelectionDescriptor(model, selection);
    return {
        modelId: resolved.modelId,
        maxMode: model.compat?.cursorMaxMode === true,
        parameters: resolved.parameters.map((parameter) => ({ id: parameter.id, value: parameter.value })),
    };
}
export function buildRequestedModel(model, selection) {
    const fields = buildRequestedModelFields(model, selection);
    return create(RequestedModelSchema, {
        modelId: fields.modelId,
        maxMode: fields.maxMode,
        parameters: fields.parameters.map((parameter) => create(RequestedModel_ModelParameterbytesSchema, { id: parameter.id, value: parameter.value })),
    });
}
//# sourceMappingURL=reasoning-params.js.map