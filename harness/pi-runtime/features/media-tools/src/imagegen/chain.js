/**
 * Edit chains live in the session itself: every successful image tool result records its saved
 * path and the requests that led to it. Continuing reads the latest such result on the current
 * branch, so a chain survives restarts and follows /tree navigation without separate state.
 */
export const CHAIN_LIMIT = 6;

export function nextChain(previous, turn) {
    return [...previous, turn].slice(-CHAIN_LIMIT);
}

export function latestImageResult(sessionManager, toolNames) {
    const branch = sessionManager?.getBranch?.() ?? [];
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const message = branch[index]?.type === "message" ? branch[index].message : undefined;
        if (message?.role !== "toolResult" || !toolNames.includes(message.toolName))
            continue;
        const details = message.details;
        if (typeof details?.absolutePath === "string" && Array.isArray(details.chain))
            return details;
    }
    return undefined;
}
