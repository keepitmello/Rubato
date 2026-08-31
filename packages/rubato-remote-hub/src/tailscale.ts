import type { CommandRunner } from "./zmx.js"

export async function configureTailscaleServe(runner: CommandRunner, tailscalePath: string, port: number): Promise<void> {
  if (!Number.isSafeInteger(port) || port < 7314 || port > 7399) throw new RangeError("invalid Rubato Remote port")
  await runner.run(tailscalePath, ["serve", "--bg", "--set-path=/rubato", `http://127.0.0.1:${port}`], { timeoutMs: 30_000 })
}

export async function tailscalePairingBaseUrl(runner: CommandRunner, tailscalePath: string): Promise<string> {
  const { stdout } = await runner.run(tailscalePath, ["status", "--json"], { timeoutMs: 10_000 })
  const parsed = JSON.parse(stdout) as unknown
  if (!isRecord(parsed) || !isRecord(parsed["Self"]) || typeof parsed["Self"]["DNSName"] !== "string") throw new Error("Tailscale DNS name is unavailable")
  const dnsName = parsed["Self"]["DNSName"].replace(/\.$/, "")
  if (!/^[A-Za-z0-9.-]+$/.test(dnsName) || !dnsName.includes(".")) throw new Error("Tailscale DNS name is invalid")
  return `https://${dnsName}/rubato/`
}

export function tailscaleGrantExample(ownerLogin: string, machineName: string): string {
  return JSON.stringify({
    grants: [{ src: [`user:${ownerLogin}`], dst: [`${machineName}:443`], ip: ["tcp:443"] }],
  }, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
