# Team patterns

*Lead.* Small shapes to staff into. Outcomes and communication paths matter more than role names. Re-form only when the work itself changes.

## 1. Single outcome owner

The default when one deep context can carry the work efficiently.

- owner: investigation, implementation, retries, local debugging, local verification
- no resident verifier unless risk justifies one

A team skill may still be active while only one owner is spawned; do not invent parallelism to fill roles.

## 2. Owner-verifier pair

The economical shape for one bounded but material task.

- owner: owns the outcome end to end
- verifier: independently checks acceptance and realistic failure paths

Use when the change is high-risk, acceptance is ambiguous, or a second model's blind spots are worth the cost.

## 3. Adaptive delivery squad

- owner A: one independent layer or module outcome
- owner B: another independent layer or module outcome
- optional verifier: integration, runtime, and acceptance evidence

Fits frontend/backend, service/migration, or other work with a real interface. Interface changes are negotiated directly between owners.

## 4. Competing-hypothesis cell

- two or three owners: distinct root-cause hypotheses or evidence lenses
- optional evidence integrator or verifier

Each owner proposes evidence that would refute their own and competing hypotheses. The lead does not choose a cause before reproduction evidence narrows it.

Once the cause narrows, retire surplus investigators. The owner with the deepest verified context normally continues through the fix and local verification. Split or transfer only when the remaining implementation is a clean, substantial outcome whose execution advantage exceeds the handoff cost.

## 5. Discovery council

- two or three researchers, architects, or critics with genuinely different evidence sources or perspectives
- lead: removes duplication and keeps the decision question alive
- optional verifier: source coverage and contradiction checks

If product framing was selected but is not settled, the council produces evidence for that process. It does not silently settle the frame.

## 6. Review swarm

- non-overlapping lenses such as security, performance, test coverage, or product alignment
- one synthesis owner only if severity calibration is genuinely needed

For an easy change, one focused fresh reviewer is better than a swarm.

## Re-forming the team

Re-form when:

- the phase creates a genuinely new outcome boundary
- a material pivot invalidates assumptions in existing contexts
- one owner's boundary splits into independent outcomes
- file or state contention removes the value of parallel writers
- the approved model becomes unavailable or mismatched to the remaining bottleneck

Do not re-form merely because investigation turned into implementation. Ownership continuity is the default.
