# Task Evidence Design

Use this reference when a user must inspect, compare, classify, approve, correct, or judge evidence before acting. It applies to review tools, moderation, labeling, forms with previews, generated results, calculations, media, charts, timelines, and other interfaces whose value depends on a relationship between evidence and action.

## Contents

- [Frame the decision](#frame-the-decision)
- [Present decision evidence](#present-decision-evidence)
- [Keep the decision loop together](#keep-the-decision-loop-together)
- [Use familiar encodings](#use-familiar-encodings)
- [Prototype one complete unit](#prototype-one-complete-unit)
- [Verify dynamic relationships](#verify-dynamic-relationships)
- [Preserve the loop across viewports](#preserve-the-loop-across-viewports)
- [Return to the task model](#return-to-the-task-model)
- [Completion evidence](#completion-evidence)

## Frame the decision

Complete the path card in `frontend-creation.md` before composing the interface. Give special attention to:

- the actor's goal in familiar language;
- the evidence required for a valid decision;
- the primary action and visible result;
- a legitimate uncertainty action;
- mistake recovery, interruption, resume, and completion.

When the required evidence, action consequence, or decision remains materially unclear, pause composition, ask the user one focused question, and wait for confirmation. Treat sending, publishing, charging, deleting, approving, reserving, committing, and undoing as explicit action consequences. Use the focused question as the complete response for that clarification turn.

Start from the user's verb: inspect, compare, choose, correct, approve, listen, retry, or continue. Map internal categories to the concrete judgment the actor can make.

## Present decision evidence

- Present evidence in the medium where the actor can genuinely decide.
- Use the actual editable object and its result for editing tasks.
- Show comparison states together when the decision depends on differences.
- Present source content together with the relevant policy or criteria for moderation and review.
- Present calculation inputs together with the resulting value and consequence.
- Present temporal evidence through synchronized source media and visualization when timing matters.
- Use summaries, counts, metadata, and diagnostics as orientation or secondary detail.
- Keep internal taxonomy, confidence semantics, storage fields, and pipeline categories in development and expert surfaces.

## Keep the decision loop together

Arrange the working view around:

1. task orientation;
2. current state;
3. decision evidence;
4. current question;
5. available actions;
6. visible feedback;
7. recovery or continuation.

- Keep transient evidence, the question, and its actions in one working context.
- Preserve playback, selection, comparison, or preview context when the layout stacks.
- Provide a plain uncertainty action when the evidence supports more than one interpretation.
- Provide undo, correction, retry, resume, and completion paths according to the task.
- Keep advanced diagnostics behind a deliberate expert entry while preserving primary-task prerequisites in the initial view.

## Use familiar encodings

- Use color, icons, sound, motion, and labels with familiar domain meaning.
- Use one neutral emphasis when the user needs to notice a moment or object.
- Introduce a distinct encoding when the distinction itself supports the user's decision.
- Keep each encoding adjacent to the evidence, persistent while needed, immediately understandable, and accessible through more than one sensory channel.
- Confirm through the rendered task that the encoding reduces cognitive work.

## Prototype one complete unit

- Render one realistic item, case, comparison, form, or decision before expanding the queue or batch.
- Perform the primary action and show its resulting state transition.
- Confirm that an unfamiliar reviewer understands the task and evidence from the initial view.
- Expand pagination, batch actions, progress, and shortcuts after the first unit works end to end.

## Verify dynamic relationships

Verify product verbs as observed state transitions:

| Relationship | Evidence |
|---|---|
| selection -> preview | selected input and rendered preview correspond |
| edit -> result | visible result reflects the current input |
| action -> feedback | action produces clear progress and final status |
| error -> recovery | safe input and context remain available for retry |
| save -> resume | reload restores the confirmed state |
| source media -> visualization | playback, seeking, and end state remain synchronized |
| item change -> context | evidence and actions move to the same current item |

For temporal interfaces, exercise play, pause, seeking, end or loop reset, item changes, interruptions, resume, stale events, and duplicate media behavior. Measure synchronization when timing quality affects the decision.

## Preserve the loop across viewports

- Inspect the real target viewport and a materially narrower viewport.
- Keep evidence, question, and action together when the decision depends on transient context.
- Preserve content priority, playback or selection context, and the primary action while stacking.
- Check overflow, wrapping, sticky collisions, zoom, and viewport-specific controls.
- Keep progress proportional to the task and secondary to the current decision.

## Return to the task model

Return to the path card when:

- the user asks what they are supposed to do;
- the task needs repeated verbal coaching;
- a legend or private encoding must be learned before acting;
- internal categories become prerequisites for a user decision;
- prose or metadata replaces evidence the product can present directly;
- evidence and action separate across the working view;
- related media, previews, calculations, totals, or states move independently;
- repeated explanatory copy changes leave the same task unclear;
- queue size or visual polish becomes the main response to a comprehension failure;
- the user identifies an obvious missing interaction step.

Restate the actor's goal, identify the native evidence, recompose the evidence-action-result loop, prototype one complete unit, and walk the rendered path again.

## Completion evidence

Record:

- route, fixture, target viewport, and narrow viewport;
- evidence presented and primary action performed;
- visible feedback and decision result;
- uncertainty, correction, recovery, resume, and completion paths;
- observed dynamic relationships and synchronization measurements;
- keyboard, focus, browser errors, overflow, screenshots, and traces.

Use the completion status defined in `frontend-creation.md`.
