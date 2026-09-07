export function isUsableCursorTaskArgs(args) {
    if (!args || typeof args !== "object" || Array.isArray(args))
        return false;
    const rec = args;
    return Boolean(rec.category ||
        rec.subagent_type ||
        (typeof rec.prompt === "string" && rec.prompt.trim()) ||
        (Array.isArray(rec.tasks) && rec.tasks.length > 0));
}
export function keepUsableCursorTaskArgs(previous, next) {
    if (isUsableCursorTaskArgs(next))
        return next;
    if (isUsableCursorTaskArgs(previous))
        return previous;
    return next;
}
//# sourceMappingURL=cursor-task-args.js.map