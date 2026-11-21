// The profile's sentences in the phone's language (CompanionProfileScreen): what the companion
// calls the person, since when they are together, and a copy line with the name filled in. Pure,
// so tests read it; the caller passes the language (copy.ts phoneLocale).

/** Whether a Korean word ends in a final consonant (받침), which picks 이라고 over 라고. */
export function hasFinalConsonant(word: string): boolean {
  const code = word.trim().codePointAt(word.trim().length - 1) ?? 0;
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
}

/** "나를 오빠라고 불러" / "Calls you 오빠": what the companion calls the person, as its profile says it. */
export function callsUserLine(value: string, locale: string): string {
  if (!locale.toLowerCase().startsWith("ko")) return `Calls you ${value}`;
  return `나를 ${value}${hasFinalConsonant(value) ? "이라고" : "라고"} 불러`;
}

/** "10월 20일부터 함께" / "Together since Oct 20". */
export function sinceLine(iso: string, locale: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const date = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(at);
  return locale.toLowerCase().startsWith("ko") ? `${date}부터 함께` : `Together since ${date}`;
}

/** A copy line with `{name}` filled in. */
export const withName = (line: string, name: string) => line.replaceAll("{name}", name);
