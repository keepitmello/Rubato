/** Host types for Rubato-owned codemode copies. Stock Pi SDK, not @code-yeongyu/senpi. */
export type ExtensionContext = {
  readonly cwd?: string
  readonly sessionId?: string
  readonly hasUI?: boolean
  readonly [key: string]: unknown
}
