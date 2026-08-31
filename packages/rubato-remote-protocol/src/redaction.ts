export const REDACTED_VALUE = "[REDACTED]" as const
export const CIRCULAR_VALUE = "[CIRCULAR]" as const

const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "launch token",
  "launchtoken",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretkey",
  "sessiontoken",
  "ticket",
  "token",
])

const KEY_VALUE_PATTERN = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|refresh[_-]?token|session[_-]?token|ticket)\b(\s*[=:]\s*)(["']?)[^\s,"';&]+\3/gi
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g
const TOKEN_PATTERN = /\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[._-]/g, "")
  if (normalized === "publickey" || normalized === "vapidpublickey") return false
  return SENSITIVE_KEYS.has(key.toLowerCase()) || SENSITIVE_KEYS.has(normalized) || /(?:password|passwd|secret|token|credential|privatekey)$/.test(normalized)
}

export function redactText(text: string): string {
  return text
    .replace(PRIVATE_KEY_PATTERN, REDACTED_VALUE)
    .replace(BEARER_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(KEY_VALUE_PATTERN, (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`)
    .replace(TOKEN_PATTERN, REDACTED_VALUE)
}

export function redactSecrets(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>())
}

function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value)
  if (value === null || typeof value !== "object") return value
  if (ancestors.has(value)) return CIRCULAR_VALUE
  ancestors.add(value)
  let result: unknown
  if (Array.isArray(value)) {
    result = value.map((member) => redactValue(member, ancestors))
  } else {
    const output: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactValue(member, ancestors)
    }
    result = output
  }
  ancestors.delete(value)
  return result
}
