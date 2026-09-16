type JsonRecord = Record<string, unknown>

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function omitEmptyStringFields(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== ""))
}

function getMemberName(value: unknown): string | undefined {
  return isJsonRecord(value) && typeof value.name === "string" ? value.name : undefined
}

function normalizeNameStem(value: string): string {
  const normalizedStem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return normalizedStem.length > 0 ? normalizedStem : "member"
}

function deriveMemberNameStem(member: JsonRecord): string {
  if (typeof member.model === "string") {
    return normalizeNameStem(member.model.slice(member.model.indexOf("/") + 1))
  }

  return "member"
}

function assignGeneratedMemberNames(rawMembers: unknown[]): unknown[] {
  const usedNames = new Set<string>()

  return rawMembers.map((member) => {
    if (!isJsonRecord(member)) {
      return member
    }

    const rawName = getMemberName(member)
    const stem = rawName === undefined ? deriveMemberNameStem(member) : normalizeNameStem(rawName)
    let generatedName = rawName === undefined ? `${stem}-1` : stem
    let suffix = rawName === undefined ? 1 : 2
    while (usedNames.has(generatedName)) {
      generatedName = `${stem}-${suffix}`
      suffix += 1
    }

    usedNames.add(generatedName)
    return { ...member, name: generatedName }
  })
}

function normalizeInlineMember(member: JsonRecord): JsonRecord {
  return omitEmptyStringFields(member)
}

export function normalizeTeamSpecInput(raw: unknown): unknown {
  if (!isJsonRecord(raw)) {
    return raw
  }

  const normalizedSpec = omitEmptyStringFields(raw)
  if (typeof normalizedSpec.name === "string") {
    normalizedSpec.name = normalizeNameStem(normalizedSpec.name)
  }

  const rawMembers = raw.members
  if (Array.isArray(rawMembers)) {
    let normalizedMembers = rawMembers.map((member) => isJsonRecord(member) ? normalizeInlineMember(member) : member)

    normalizedMembers = assignGeneratedMemberNames(normalizedMembers)


    normalizedSpec.members = normalizedMembers
  }

  return normalizedSpec
}
