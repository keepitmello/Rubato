export const TOOL_SEARCH_ACTIVATION_MARKER_V2 = "[tool_search:activated:v2]";
export const LEGACY_TOOL_SEARCH_ACTIVATION_MARKER = "[tool_search:activated]";

export function deriveMcpRegistrationId(server, toolName) {
  return `mcp\0${server}\0${toolName}`;
}

export function deriveExtensionRegistrationId(sourceInfo, toolName) {
  return `${sourceInfo.resolvedPath ?? sourceInfo.path}\0${toolName}`;
}

export function emitActivationMarker(activations) {
  return `${TOOL_SEARCH_ACTIVATION_MARKER_V2} ${JSON.stringify(activations)}`;
}

export function parseActivationMarkers(messages) {
  const markers = [];
  for (const message of messages) {
    let blob;
    try {
      blob = JSON.stringify(message) ?? "";
    } catch {
      continue;
    }
    for (const payload of extractV2Payloads(blob)) {
      try {
        const parsed = JSON.parse(payload);
        const activations = Array.isArray(parsed) ? parsed.filter(isActivationIdentity) : [];
        if (activations.length > 0) markers.push({ version: 2, activations });
      } catch {
        // Malformed history is ignored during best-effort rehydration.
      }
    }
    for (const segment of extractLegacySegments(blob)) {
      const names = segment.trim().split(/\s+/).filter(Boolean);
      if (names.length > 0) markers.push({ version: 1, names });
    }
  }
  return markers;
}

export function rehydrate(messages, currentDocsByName) {
  const restored = new Set();
  for (const marker of parseActivationMarkers(messages)) {
    if (marker.version === 2) {
      for (const activation of marker.activations) {
        const current = currentDocsByName.get(activation.name);
        if (current?.allowLazyActivation !== false && current?.registrationId === activation.registrationId) {
          restored.add(activation.name);
        }
      }
      continue;
    }
    for (const name of marker.names) {
      const current = currentDocsByName.get(name);
      if (current?.source === "mcp" && current.allowLazyActivation !== false) restored.add(name);
    }
  }
  return [...restored].sort();
}

function extractV2Payloads(blob) {
  const payloads = [];
  let cursor = blob.indexOf(TOOL_SEARCH_ACTIVATION_MARKER_V2);
  while (cursor >= 0) {
    const remainder = extractEncodedRemainder(blob, cursor + TOOL_SEARCH_ACTIVATION_MARKER_V2.length);
    if (remainder !== undefined) {
      try {
        const decoded = JSON.parse(`"${remainder}"`);
        const payload = extractJsonArrayPrefix(decoded.trimStart());
        if (payload !== undefined) payloads.push(payload);
      } catch {
        // Continue scanning other markers.
      }
    }
    cursor = blob.indexOf(TOOL_SEARCH_ACTIVATION_MARKER_V2, cursor + TOOL_SEARCH_ACTIVATION_MARKER_V2.length);
  }
  return payloads;
}

function extractEncodedRemainder(blob, start) {
  let encoded = "";
  for (let index = start; index < blob.length; index += 1) {
    const character = blob[index];
    if (character === '"') return encoded;
    if (character === "\n") return undefined;
    if (character === "\\") {
      if (blob[index + 1] === undefined) return undefined;
      encoded += character + blob[index + 1];
      index += 1;
    } else {
      encoded += character;
    }
  }
  return undefined;
}

function extractJsonArrayPrefix(text) {
  if (!text.startsWith("[")) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]" && --depth === 0) return text.slice(0, index + 1);
  }
  return undefined;
}

function extractLegacySegments(blob) {
  const segments = [];
  let cursor = blob.indexOf(LEGACY_TOOL_SEARCH_ACTIVATION_MARKER);
  while (cursor >= 0) {
    const rest = blob.slice(cursor + LEGACY_TOOL_SEARCH_ACTIVATION_MARKER.length);
    const end = rest.search(/["\\\n]/);
    segments.push(end < 0 ? rest : rest.slice(0, end));
    cursor = blob.indexOf(LEGACY_TOOL_SEARCH_ACTIVATION_MARKER, cursor + LEGACY_TOOL_SEARCH_ACTIVATION_MARKER.length);
  }
  return segments;
}

function isActivationIdentity(value) {
  return typeof value === "object" && value !== null &&
    typeof value.name === "string" && value.name.length > 0 &&
    typeof value.registrationId === "string" && value.registrationId.length > 0;
}
