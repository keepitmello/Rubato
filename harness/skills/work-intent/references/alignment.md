# Evidence-first alignment

*Lead, when preparing a proposal or handling a material gap. This is decision guidance,
not a mandatory sequence of questions. The skill owns the policy; examples are illustrative.*

## Spend agent effort before user attention

Use already supplied facts and decisions first. Inspect the relevant sources needed to
understand the requested change: current code/config/tests, owning docs, logs and connected
records; use official current web sources for external behavior or trade-offs. You need
not browse for facts a local read settles, nor inspect every file before recommending.
A reachable source the user already supplied is something to read, not ask them to repeat.

Use focused discovery subagents when useful and authorized. Their brief names the fact to
resolve, read boundary, allowed disposable checks, budget and return evidence. No production
changes, continuing-owner team, or materially costly/unapproved model use is hidden in
"discovery". Existing allowed local tests or disposable experiments may verify a claim;
new commitments still need their normal authorization. No ask-before-every-read gate.

Stop when you have enough evidence to recommend a viable direction and a useful work cut.
Uncertainty that cannot alter the next decision can remain documented; do not research
indefinitely to manufacture certainty. Return an honest proposal or a narrow blocker at
budget, not another request for a full requirements interview.

## Classify a gap by who can settle it

| Gap | Next action |
|---|---|
| Discoverable fact | Inspect available evidence and record the result or the exact remaining unknown. |
| Local implementation judgment | Decide within accepted scope and verify; expose only consequential trade-offs. |
| Human preference, goal or commitment | Bring viable choices with a recommendation and practical consequences. |
| Required fact with unavailable access | Try relevant authorized alternatives; ask only for the missing access/fact if it truly blocks the proposal. |

A technical-sounding question may still belong to the user if it changes compatibility,
visible behavior, spending or retained data. Explain that consequence rather than making
the user choose an internal mechanism. Conversely, uncertainty alone does not make an
implementation choice the user's job. Never infer that a user approved a material change
merely because research suggests it would be beneficial.

An early question is exceptional: unavailable access or a genuine goal conflict makes
meaningful discovery or any honest proposal impossible. State what is missing, what you
already established and the one decision needed. Continue unaffected authorized work when
possible.

## Examples to adapt, not copy into every task

**Repository fact.** The user asks to improve sign-in reliability. The storage location,
expiry handling and existing tests are discoverable: inspect them. Do not begin with
"Where do you store tokens? Which files handle login?" Ask only if the needed system is
inaccessible and available sources cannot settle the relevant fact.

**Current external fact.** A change depends on whether a service supports an existing
format. Read the service's current official documentation and check local dependencies;
do not ask the user to research compatibility. Lack of access means unknown, not unsupported.

**Material preference.** Either keep old users signed in during a change or require them
to sign in again. Recommend the option supported by the user's goal and show that user
impact. Do not decide a forced sign-out is acceptable just
because it makes the implementation simpler.

**Method only.** Two internal modules could own a cache invalidation. Inspect the owning
cause, choose within the accepted contract and verify. No new human question or intent
revision is warranted merely because the file choice changed.

## Evidence basis and limits

The 2026 source review and dates live in the existing `docs/work-intent.md` in the Rubato
source repository, not in each work run. This workflow adapts information-value reasoning;
it does not implement a calibrated numerical VoI controller, prove that one approval is
universally optimal, or claim Anthropic uses this exact roster gate internally.
