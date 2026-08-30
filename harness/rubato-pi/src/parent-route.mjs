// Mirrors the pin's completion router. compacting must buffer, not drop.
export function routeCompletion(parentState) {
  switch (parentState) {
    case "idle":
      return { kind: "wake" };
    case "streaming":
      return { kind: "deliver_streaming" };
    case "compacting":
      return { kind: "buffer", reason: "compacting" };
    case "session_switching":
      return { kind: "buffer", reason: "session_switching" };
    case "session_shutdown":
      return { kind: "buffer", reason: "session_shutdown" };
    default:
      throw new Error(`Unexpected parent state: ${parentState}`);
  }
}
