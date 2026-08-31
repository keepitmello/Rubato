import { isIP } from "node:net"

export interface RequestIdentityInput {
  readonly remoteAddress: string | undefined
  readonly headers: Headers
}

export interface VerifiedIdentity {
  readonly login: string
  readonly name?: string
  readonly profilePicture?: string
}

export interface IdentityVerifier {
  verify(input: RequestIdentityInput): Promise<VerifiedIdentity | null>
}

export class TailscaleServeIdentityVerifier implements IdentityVerifier {
  async verify(input: RequestIdentityInput): Promise<VerifiedIdentity | null> {
    if (!isLoopback(input.remoteAddress)) return null
    const login = normalizeLogin(input.headers.get("tailscale-user-login"))
    if (!login) return null
    const nameHeader = input.headers.get("tailscale-user-name")
    const picture = input.headers.get("tailscale-user-profile-pic")
    return {
      login,
      ...(nameHeader ? { name: decodeDisplayName(nameHeader) } : {}),
      ...(picture ? { profilePicture: picture } : {}),
    }
  }
}

export function normalizeLogin(login: string | null | undefined): string | null {
  const normalized = login?.normalize("NFKC").trim().toLowerCase()
  return normalized ? normalized : null
}

export function isOwner(identity: VerifiedIdentity | null, ownerLogin: string): boolean {
  return identity !== null && identity.login === normalizeLogin(ownerLogin)
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  const unwrapped = address.startsWith("::ffff:") ? address.slice(7) : address
  return unwrapped === "::1" || (isIP(unwrapped) === 4 && unwrapped.startsWith("127."))
}

function decodeDisplayName(value: string): string {
  const match = /^=\?utf-8\?b\?([^?]+)\?=$/i.exec(value)
  if (!match) return value
  try {
    return Buffer.from(match[1]!, "base64").toString("utf8")
  } catch {
    return value
  }
}
