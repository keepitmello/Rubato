export class MemberValidationError extends Error {
  constructor(
    message: string,
    public readonly memberName?: string,
    public readonly issue?: string,
  ) {
    super(message)
    this.name = "MemberValidationError"
  }
}

export function createParseMember<TMember>(
  memberSchema: { safeParse(input: unknown): { success: true; data: TMember } | { success: false } },
): (input: unknown) => TMember {
  return function parseMember(input: unknown) {
    if (input == null || typeof input !== "object") {
      throw new MemberValidationError("Member must be an object")
    }

    const raw = input as Record<string, unknown>
    const name = typeof raw.name === "string" ? raw.name : "<unnamed>"
    const result = memberSchema.safeParse(raw)

    if (!result.success) {
      throw new MemberValidationError(
        `Member '${name}' must specify {kind:'owner'|'verifier', model:'provider/model', prompt:'...'}.`,
        name,
        raw.kind === undefined ? "missing-kind" : raw.model === undefined ? "missing-model" : "invalid-member",
      )
    }

    return result.data
  }
}
