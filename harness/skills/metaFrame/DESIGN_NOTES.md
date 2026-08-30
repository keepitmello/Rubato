# Open Frame v3 design notes

## Design decision

This revision returns to the central idea of Open Frame: give a capable model a useful orientation and enough room to choose its own reasoning path. It does not try to encode a complete metacognitive controller.

The previous v3 correctly introduced user clarification, external evidence, and fresh context, but turned them into an explicit routing system and surrounded the skill with an evaluation harness. That structure risked teaching the model to perform the framework rather than attend to the task.

The rebuilt v3 keeps those three openings while removing the taxonomy around them.

## How Claude Prompting Lab shaped the revision

The attached Claude Prompting Lab repeatedly favors a small common core, affirmative target behavior, reasons for important constraints, and high-level reasoning guidance over hand-written chains of thought. It also recommends starting from the current model's default behavior, adding instructions only when observed failures justify them, and using progressive disclosure so the main skill remains concise.

Those principles produced five concrete choices:

1. **Manual invocation** — timing belongs to the user because Open Frame is not useful on every task.
2. **A short core** — `SKILL.md` contains the posture and the few openings that can change action; examples and fresh-context details stay optional.
3. **No forced reasoning sequence** — user questions, external probes, and independent context are possibilities rather than stages or labels to output.
4. **Purpose with epistemic restraint** — the result the work should create matters, but unstated purposes and human motives remain provisional.
5. **Externalized learning** — drafts, tools, evidence, and fresh contexts can update the problem representation without turning visible self-critique into a universal loop.

## Why fresh context remains optional

A clean context can reduce anchoring from the current transcript, especially after the main agent has invested in an explanation. It does not create a different base model and does not make its output authoritative. The skill therefore treats fresh context as one way to open the space, not as a required verifier or a source of votes.

The independent context receives raw task information and evidence rather than the coordinator's theory. Its result is useful when it exposes a materially different choice or a way to distinguish competing interpretations.

## Why clarification is narrow

The model should ask when a meaningful branch depends on information only the user can supply. It should not interview the user to remove every uncertainty. Safe, reversible, already delegated choices can proceed under a stated provisional assumption; facts available from tools or artifacts should be inspected rather than offloaded to the user.

## No formal evaluation package

This version intentionally omits scores, pass thresholds, large synthetic case sets, and a release gate. The skill has not earned that machinery through observed use.

Future changes should start from concrete transcripts where the skill caused a meaningful improvement or a recognizable failure. A few real examples are more valuable at this stage than a speculative benchmark designed by the same author as the prompt.

## Intended limit

Open Frame can help a model use latent understanding more flexibly. It cannot add world knowledge, human understanding, or representational capacity that the base model does not possess. A stronger model may interpret the same posture more deeply; a weaker model may produce only the language of reframing.
