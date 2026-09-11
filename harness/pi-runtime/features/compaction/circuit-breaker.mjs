export const FAILURE_TRIP_THRESHOLD = 3;
export const COOLDOWN_MS = 60_000;
export function recordSuccess(state) {
    return { ...state, consecutiveFailures: 0, trippedAt: null };
}
export function recordFailure(state, now, opts) {
    let working = state;
    if (working.trippedAt !== null && now >= working.trippedAt + COOLDOWN_MS) {
        working = { ...working, consecutiveFailures: 0, trippedAt: null };
    }
    const next = {
        ...working,
        consecutiveFailures: working.consecutiveFailures + 1,
    };
    if (next.consecutiveFailures >= FAILURE_TRIP_THRESHOLD && next.trippedAt === null) {
        next.trippedAt = now;
        opts?.onTrip?.({
            tripped: true,
            failureCount: next.consecutiveFailures,
            trippedAt: now,
            reason: opts.route ?? "threshold",
        });
    }
    return next;
}
export function isTripped(state, now) {
    return state.trippedAt !== null && now < state.trippedAt + COOLDOWN_MS;
}
export function shouldBypass(_state, opts) {
    if (opts?.manual === true)
        return true;
    if (opts?.reason === "manual")
        return true;
    return false;
}
