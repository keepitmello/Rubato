export const OUTPUT_FAMILIES = {
  rubato: {
    main: "rubato.js",
    task: "rubato-task.js",
    member: "rubato-member.js",
    memoryMcp: "rubato-memory-mcp.js",
    supervisor: "memory-run-supervisor.mjs",
  },
}

export const TASK_RUNTIME_SPECIFIER = "#rubato-task-runtime"

export function outputFamilyFromMain() {
  return "rubato"
}

export function familySiblingNames() {
  return { ...OUTPUT_FAMILIES.rubato }
}

export function familyBuildDefines() {
  return {
    RUBATO_MEMBER_BUNDLE: OUTPUT_FAMILIES.rubato.member,
    RUBATO_MEMORY_MCP_BUNDLE: OUTPUT_FAMILIES.rubato.memoryMcp,
  }
}
