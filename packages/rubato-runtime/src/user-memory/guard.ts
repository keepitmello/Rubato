// The last check before anything lands in the user store: nothing the user forgot comes back. It runs
// under the store's writer lock against the store as it is at that moment, so a dream or a request that
// started before the forget is judged by the forget. A forgotten claim may come back only on evidence
// newer than the forget: the user said it again.

import { listRecords } from "./records"
import { matchedTerms, type Ledger } from "./ledger"
import type { Git } from "../dream/runner"

export interface Resurrection {
  readonly path: string
  readonly what: string
  readonly terms: readonly string[]
}

/**
 * Records on `branch` that carry a forgotten claim the store at `main` does not carry, unless one of
 * `newerEvidence` (things the user said after that forget) carries it too.
 */
export async function resurrections(
  git: Git,
  repo: string,
  branch: string,
  main: string,
  ledger: Ledger,
  newerEvidence: readonly { readonly text: string; readonly at?: string }[],
): Promise<Resurrection[]> {
  if (ledger.forgotten.length === 0) return []
  const [incoming, current] = await Promise.all([listRecords(git, repo, branch), listRecords(git, repo, main)])
  const found: Resurrection[] = []
  for (const entry of ledger.forgotten) {
    const forgotAt = Date.parse(entry.at)
    const inCurrent = current.some((record) => matchedTerms(record.text, entry).length > 0)
    if (inCurrent) continue
    const saidAgain = newerEvidence.some((evidence) => {
      const at = evidence.at === undefined ? Number.NaN : Date.parse(evidence.at)
      return Number.isFinite(at) && at > forgotAt && matchedTerms(evidence.text, entry).length > 0
    })
    if (saidAgain) continue
    for (const record of incoming) {
      const terms = matchedTerms(record.text, entry)
      if (terms.length > 0) found.push({ path: record.path, what: entry.what, terms })
    }
  }
  return found
}
