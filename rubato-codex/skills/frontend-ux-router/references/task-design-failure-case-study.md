# Frontend UX Task Design Failure Case Study and Prevention Playbook

## Table of contents

1. [Purpose](#purpose)
2. [Executive summary](#executive-summary)
3. [Incident context](#incident-context)
4. [What the user actually needed](#what-the-user-actually-needed)
5. [Failure timeline](#failure-timeline)
6. [Root-cause analysis](#root-cause-analysis)
7. [Why the attempted fixes still failed](#why-the-attempted-fixes-still-failed)
8. [The correct task model](#the-correct-task-model)
9. [General prevention principles](#general-prevention-principles)
10. [Copy and terminology rules](#copy-and-terminology-rules)
11. [Frontend creation workflow](#frontend-creation-workflow)
12. [Rendered verification protocol](#rendered-verification-protocol)
13. [Stop-and-redesign triggers](#stop-and-redesign-triggers)
14. [Review checklist](#review-checklist)
15. [How to use this in a skill](#how-to-use-this-in-a-skill)
16. [Condensed rules for SKILL.md](#condensed-rules-for-skillmd)
17. [Non-goals and nuance](#non-goals-and-nuance)

## Purpose

This document is a reusable reference for agents creating or redesigning frontend
interfaces. It records a real failure in which the implementation was technically
functional but the user could not understand the task. The failure was not primarily
visual. It came from designing around the system's data model instead of the user's
decision process.

Use this reference when:

- a new review, labeling, moderation, comparison, or decision screen is being built;
- a UI exposes model output, generated evidence, diagnostics, or internal categories;
- audio, video, animation, charts, timelines, or other synchronized media are involved;
- a user says the page is confusing, asks what to do, or needs repeated verbal coaching;
- an agent is tempted to solve comprehension problems by adding legends, tooltips, or
  explanatory paragraphs;
- a skill needs a concrete failure case for task-first frontend design.

This is intentionally more detailed than a SKILL.md should be. Keep core procedural
rules in SKILL.md and load this document as a reference when task comprehension,
review surfaces, unfamiliar evidence, or interaction design are material risks.

## Executive summary

The failed interface asked a user to review whether detected music events corresponded
to official rhythm-game chart actions. The implementation began with four internal
analysis labels, a fixed sample of 42 cases, colored timeline markers, and synthetic
confirmation sounds. It assumed the user could infer what those encodings meant.

The user could not answer because the page did not present the real decision in a
familiar form. The relevant chart was initially absent, then shown as a static view,
then displayed separately from the question. The audio and chart did not move together
until the user explicitly pointed out the problem. Repeated copy changes and smaller
batches reduced surface friction but did not fix the task model.

The durable lesson is:

> Start frontend work from the user's evidence-action-result path. Never start from the
> available fields, model outputs, audit labels, or internal taxonomy.

The completion standard is not “the components render” or “the build passes.” The agent
must walk the rendered path from entry through action, synchronized feedback, decision,
recovery, resume, and completion at both target and narrow viewports.

## Incident context

### Product context

The product analyzes music and official Arcaea charts. A research pipeline had classified
relationships between detected music events and chart actions into internal groups:

- a detected music event and chart action appear to correspond;
- a detected event appears not to be charted;
- a chart action appears without a detected event;
- timing evidence is ambiguous.

The research process needed a small amount of human judgment before these automatic
relationships could be trusted downstream.

### User context

The user understood music and Arcaea charts, but was not expected to understand the
analysis pipeline's category names, event identifiers, confidence semantics, or synthetic
cue scheme. The user's useful judgment was perceptual and concrete:

- Did the note that just crossed the judgment line fit the sound that was heard?
- Was there a visible note corresponding to the sound at the emphasized moment?
- Was the placement musically aligned, shifted, unrelated, or unclear?

### Implementation context

The system had:

- original local audio;
- detected event timestamps;
- official chart action timestamps;
- a Three.js chart viewer;
- a fixed 42-item review sample;
- answer persistence and resume behavior.

The availability of those fields encouraged a data-first screen. That was the first
mistake. Available data is an implementation input, not an information architecture.

## What the user actually needed

The complete task could have been stated before coding:

> Play a short piece of the original music together with the official moving chart.
> Emphasize one moment. Ask whether the note visible at that moment fits the music.
> Let the user answer in familiar language or say they are unsure.

The user did not need to know:

- which detector produced the timestamp;
- whether the pipeline called the case select, omit, insert, or ambiguous;
- why a sample was pre-registered;
- which artifact would store the answer;
- which color represented which internal entity;
- why two synthetic tones had different pitches;
- how the answer would affect an allow-list or downstream model.

Those details were relevant to researchers and developers, not to task completion.

## Failure timeline

### Stage 1: Data-first review screen

The first screen exposed all 42 cases and organized them around internal relationship
types. It presented timeline markers and reason-specific answer choices.

Why it looked reasonable to the implementer:

- the sample was fixed and auditable;
- every internal case had a matching question;
- detailed choices preserved research meaning;
- save and resume behavior worked.

Why it failed for the user:

- the user did not know what a “chart action” was in this interface;
- the user could not see which part of the chart was being discussed;
- the page asked for a semantic judgment using only timestamps and labels;
- 42 visible tasks created immediate workload pressure before the first task was understood.

### Stage 2: Explanatory copy

The interface added sentences explaining that the user should compare a music candidate
with a chart action and decide whether they represented the same event.

Why it failed:

- it explained the system's abstraction instead of presenting the evidence;
- “music candidate,” “chart action,” “same event,” and “automatic abstention” remained
  concepts the user had to learn;
- prose became a substitute for interaction design;
- the user still could not see the chart section.

### Stage 3: Smaller batch

The visible workload was reduced from 42 items to six items at a time.

Why it helped:

- the screen looked less overwhelming;
- progress became locally bounded.

Why it did not solve the problem:

- workload and comprehension are different dimensions;
- six incomprehensible tasks are still incomprehensible;
- the first task still required decoding internal signals.

### Stage 4: Chart context as counts and ticks

The screen added nearby chart-action ticks, note counts, and note-type labels.

Why it failed:

- the user's evidence was the actual chart motion and note placement;
- counts and ticks summarized the chart instead of showing it;
- a summary forced the user to reconstruct spatial and rhythmic context mentally;
- technical context increased visual noise without answering the user's question.

### Stage 5: Static embedded 3D chart

The real Three.js chart was embedded at the relevant timestamp.

Why it looked like a major fix:

- the native evidence finally appeared;
- the relevant song and chart section loaded correctly;
- the user could see actual notes rather than a textual summary.

Why it still failed:

- the original audio played while the chart remained static;
- the task depended on temporal correspondence, so a static chart was not the evidence;
- the implementation verified that the iframe loaded, not that the experience worked;
- the user had to point out that music and chart must move together.

### Stage 6: Synchronized chart plus private cue language

The chart was synchronized with playback. The UI used red and blue markers and high and
low synthetic beeps to identify detected-event and chart-action times.

Why it looked reasonable:

- two timestamps could be distinguished precisely;
- the colors matched the timeline;
- separate beeps made close timestamps audible;
- synchronization could be measured.

Why it failed:

- “red sound” was not a real sound or a familiar product concept;
- “blue alert” was an artificial cue invented by the implementation;
- the user was forced to learn a private encoding before making the real judgment;
- the page contained the evidence but wrapped it in a second decoding task;
- the main question could fall below the chart at narrower viewports.

### Stage 7: Task-first simplification

The correct direction was to remove the private cue language from the default path:

- one button to play original audio and moving chart together;
- one neutral emphasis at the moment being judged;
- the question visible beside the evidence;
- answers in ordinary musical language;
- advanced diagnostics absent from the primary task.

This was not merely a visual cleanup. It changed the user's mental task from “decode two
system signals and infer their relationship” to “watch and listen, then judge whether the
note fits the music.”

## Root-cause analysis

### 1. Internal-ontology leakage

The screen mirrored pipeline categories. This is common when engineers map database fields
or model outputs directly to UI sections.

Failure signature:

- labels are accurate to the implementation but unfamiliar to the user;
- the interface requires a glossary;
- questions contain nouns that appear in schemas, logs, or research documents;
- the user must understand how the system reached a case before answering it.

Correction:

- translate every internal category into the concrete decision the user can make;
- keep internal labels in stored data, developer tools, and verification reports;
- allow different internal categories to share the same user-facing task when the user's
  evidence and action are the same.

### 2. Private encoding burden

The implementation invented colors and sounds to distinguish internal signals.

Failure signature:

- the task needs a legend before the primary action makes sense;
- a color or tone has no familiar domain meaning;
- the user must remember mappings while watching fast-changing evidence;
- the encoding adds another comparison instead of reducing one.

Correction:

- prefer native product evidence;
- use a neutral emphasis for “this is the moment to judge” when identity is not needed;
- introduce encoding only when the distinction itself is necessary for the user's decision;
- keep any unavoidable encoding spatially adjacent, persistent, and immediately testable.

### 3. Evidence substitution

The UI used counts, labels, and timeline ticks where the real chart was required.

Failure signature:

- the page describes what the user would understand better by seeing or hearing;
- summaries replace spatial, temporal, or visual evidence;
- the user must imagine a state that the product can render directly.

Correction:

- show evidence in its native medium;
- use the actual chart for chart judgment, actual audio for music judgment, and synchronized
  playback for timing judgment;
- treat summaries as secondary orientation, not primary evidence.

### 4. Component verification instead of experience verification

The iframe loaded and displayed a chart, so the implementation appeared complete. The
actual user action required synchronized movement, which had not been tested.

Failure signature:

- verification checks DOM presence, API success, or screenshots only;
- dependent media are tested separately;
- the claimed behavior contains verbs such as play, follow, update, sync, resume, or recover,
  but the test only checks the initial render.

Correction:

- verify verbs as state transitions;
- measure synchronization when timing matters;
- exercise play, pause, seek, loop reset, item change, interruption, and resume;
- record actual observed deltas rather than saying the views “look aligned.”

### 5. Workload mistaken for usability

The 42-item batch was reduced to six, but the task remained unclear.

Failure signature:

- reducing count is treated as the main UX fix;
- progress looks friendlier but the first item still needs coaching;
- completion rate is optimized before task comprehension.

Correction:

- first make one item self-explanatory;
- then set batch size according to fatigue, session duration, and evidence quality;
- test the first item before optimizing the queue.

### 6. Evidence-action separation

At some viewport widths, the chart and the question could not be seen together.

Failure signature:

- users must scroll after observing transient evidence;
- answer controls appear below a long visualization;
- responsive layouts preserve component order but break the decision loop;
- the user must remember a fast event while moving to another region.

Correction:

- co-locate evidence, question, and action in the working viewport;
- design responsive behavior around the task, not named device breakpoints;
- keep the decision card beside the evidence when width allows;
- when stacking is unavoidable, preserve playback and decision context without covering evidence.

### 7. Reactive patching

Each user complaint triggered a local fix: explain the term, reduce the batch, add chart
context, embed the chart, synchronize it, then remove arbitrary cues.

Failure signature:

- multiple patches explain the same interaction;
- each fix reveals a more fundamental missing step;
- visible copy grows while confidence falls;
- the agent keeps the original information architecture because code already exists.

Correction:

- stop after the first fundamental comprehension failure;
- return to the actor-evidence-action-result path;
- be willing to discard implemented UI structure;
- preserve data contracts when useful, but do not preserve a failed mental model.

## Why the attempted fixes still failed

### “The terminology is technically correct”

Technical correctness does not make a term user-facing. A label can be perfectly accurate
to a model and still be unusable because the user neither needs nor recognizes it.

### “A legend explains the colors”

A legend is not free. It creates a memory task. If the user must continuously translate
red to detector event and blue to chart action while listening to music and watching motion,
the interface has increased cognitive load.

### “The confirmation beep makes timing precise”

A synthetic beep can help an expert diagnostic tool, but it changes the audio evidence and
introduces another object to interpret. It should not be the default when the user can judge
the native synchronized experience directly.

### “The question explains what to compare”

Explanation cannot repair absent or incorrectly presented evidence. If the chart is missing,
static, or off-screen, a clearer sentence does not make the task valid.

### “Only six items are visible now”

Smaller batches reduce fatigue. They do not make an unfamiliar judgment understandable.

### “The screenshot looks complete”

A screenshot cannot prove playback, synchronization, looping, seeking, save feedback, undo,
or resume. Interfaces with temporal behavior need temporal verification.

### “The controls are hidden behind progressive disclosure”

Hiding unnecessary controls is useful only after the primary task is correct. Progressive
disclosure cannot rescue a wrong task model; it merely hides parts of it.

## The correct task model

### Reusable path card

Before composing components, complete this card:

```md
- Actor:
- Situation and entry:
- Goal in the actor's own words:
- Evidence required to decide:
- Primary action:
- Visible result:
- Uncertainty action:
- Mistake recovery:
- Interruption and resume:
- Completion and next step:
- Starting route and fixture:
- Target viewport:
- Materially narrower viewport:
```

### Filled example from this incident

```md
- Actor: a chart reviewer who understands music and Arcaea play, not detector internals
- Situation and entry: opens a short local review session with no previous answers
- Goal: decide whether one official note fits the music at an emphasized moment
- Evidence required to decide: original audio and the real official chart moving together
- Primary action: play the short synchronized section
- Visible result: the chart advances with audio and one neutral cue marks the judgment moment
- Uncertainty action: choose "잘 모르겠어요"
- Mistake recovery: clear or replace the saved answer
- Interruption and resume: reopen at the first unvisited item without losing answers
- Completion and next step: finish the current small batch and stop without being pushed onward
- Starting route and fixture: the real local review route with an unanswered fixed item
- Target viewport: desktop working width
- Materially narrower viewport: the user's actual narrow browser width
```

### First-view comprehension test

An unfamiliar user must answer these from the rendered initial view without coaching:

1. What am I doing here?
2. What must I look at, listen to, or compare?
3. What is the primary next action?
4. What will happen after I take it?

If any answer requires an internal noun, hidden control, legend, developer explanation, or
memory of another screen, the design fails.

## General prevention principles

### Start with the user's verb

Use verbs such as compare, choose, correct, listen, confirm, retry, or continue. Do not start
with entities such as run, candidate, proxy, record, artifact, confidence, or detector.

### Present native evidence

Use the medium in which the user can genuinely decide:

- chart judgment -> real chart;
- music judgment -> original audio;
- timing judgment -> synchronized audio and motion;
- visual comparison -> both states visible together;
- text editing -> the actual editable text and result;
- moderation -> the real content and applicable policy evidence.

### Co-locate the decision loop

Keep these together:

1. orientation;
2. current evidence;
3. current question;
4. available answers;
5. visible save or result state.

Do not make the user carry transient evidence across scrolling, tabs, dialogs, or panels.

### Keep the default path minimal

The initial task surface should contain only prerequisites for the primary action. Put
diagnostics, raw data, alternative modes, and research detail behind a deliberate secondary
entry or outside the user workflow.

### Make uncertainty legitimate

If evidence can be genuinely ambiguous, provide a plain uncertainty action. Do not force a
guess or disguise uncertainty as an internal status such as abstention or pending.

### Separate workload design from comprehension design

First prove one task is understandable. Then choose batch size, pagination, progress,
shortcuts, and session duration.

### Verify relationships, not just components

When the product claim contains a relationship, test the relationship:

- audio follows chart;
- preview reflects selection;
- total updates after edit;
- error preserves input;
- resume restores the last state;
- button changes the visible result.

## Copy and terminology rules

### Allowed purposes for visible copy

Every visible string should do at least one of these:

- orient the user to the current task;
- describe what is currently visible or audible;
- state the action the user can take;
- explain what just happened;
- provide recovery or continuation.

### Copy that belongs elsewhere

Keep these out of the primary UI:

- implementation rationale;
- research methodology;
- model categories and confidence semantics;
- storage paths and schema names;
- repository and commit behavior;
- prompt interpretation;
- internal lifecycle state;
- developer troubleshooting detail.

### Comment-like copy test

Read the string as a first-time user. Remove or rewrite it if it sounds like:

- a code comment;
- an experiment note;
- a schema field label;
- an analyst explanation;
- a commit message;
- a condensed specification fragment.

### Transformation examples

| Internal or confusing copy | Better user-facing direction |
|---|---|
| `자동 판단을 보류한 것이 맞나요?` | Ask about the visible evidence: `이 소리를 따라가는 노트가 있었나요?` |
| `채보 행동` | Use the familiar object: `노트` or `공식 채보` |
| `음악 후보` | Refer to the heard moment or omit the label entirely |
| `빨간 표시의 소리` | Use one neutral emphasis such as `지금`, if emphasis is necessary |
| `고정 표본 42개` | Show a bounded current session only after one item is understandable |
| `판정 저장됨` | `답을 저장했습니다.` |
| `pending` or `abstain` | `잘 모르겠어요` or `나중에 다시 볼게요` |
| `현재 채보 행동의 noteKinds` | Show the actual chart note |

Do not mechanically apply the right-hand phrases. The correct copy depends on visible
evidence and the product's domain language.

## Frontend creation workflow

### Phase 1: Frame before coding

1. Complete the path card.
2. Identify the native evidence.
3. State the primary action in one sentence.
4. Define the success signal.
5. List uncertainty, error, interruption, resume, and completion states.
6. Name target and narrow viewports from real usage, not generic device labels.

Do not proceed if the task cannot be stated without internal terminology.

### Phase 2: Compose content hierarchy

Arrange the initial view in this order:

1. purpose;
2. current state;
3. evidence;
4. primary action;
5. expected result;
6. decision and recovery.

Use realistic content before choosing cards, tabs, badges, sidebars, or other components.

### Phase 3: Prototype the interaction

Before connecting the full backend:

- render one realistic task item;
- perform the primary action;
- show the resulting state transition;
- verify evidence and action remain together;
- test the first-view comprehension questions.

Do not build the full queue until one item works.

### Phase 4: Bind real data

Map internal data to the user task at the boundary. Preserve internal detail in stored data
without exposing it as information architecture. Add runtime validation at trust boundaries.

### Phase 5: Implement reachable states

For each relevant state, record:

```md
State -> Trigger -> Visible meaning -> Available action -> Recovery or resume
```

Typical states include loading, ready, playing, paused, saved, unsure, save error, empty,
completed batch, and resumed session.

### Phase 6: Responsive task design

Do not only resize components. At each viewport verify:

- evidence and question remain visible together when required;
- the primary action remains obvious;
- controls do not wrap into an unintended hierarchy;
- transient evidence is not separated from answers;
- sticky or fixed regions do not cover content;
- progress does not dominate the task;
- text remains complete natural language.

### Phase 7: Render and walk

Use the real route, real starting state, and real media. Complete the full path before
reporting done.

## Rendered verification protocol

### Required path walkthrough

1. Enter at the realistic route with an unanswered item.
2. Confirm the initial view passes the four comprehension questions.
3. Trigger the primary action using the actual control.
4. Observe all dependent media and state changes.
5. Make a normal decision and verify visible save feedback.
6. Undo or change the decision.
7. Exercise the uncertainty action.
8. Reload and verify resume behavior.
9. Trigger a relevant failure and verify recovery without losing safe user input.
10. Complete the current unit of work and verify the next step is explicit but not forced.

### Temporal and synchronized interfaces

For audio, animation, video, charts, or playback:

- measure synchronization deltas;
- test play and pause;
- test manual seeking;
- test loop or end reset;
- test item changes while paused and while playing;
- verify stale messages cannot drive the wrong item;
- verify hidden secondary media do not produce duplicate sound;
- inspect at normal and reduced-motion settings when motion is optional.

### Viewport checks

Inspect:

- the actual target viewport;
- a materially narrower viewport based on the user environment;
- horizontal overflow;
- below-the-fold separation of evidence and action;
- clipping, wrapping, and sticky collisions;
- zoom or device-pixel-ratio effects when relevant.

### Accessibility checks

Verify:

- semantic structure and accessible names;
- logical focus order;
- keyboard activation;
- visible focus;
- readable contrast;
- status changes exposed appropriately;
- hidden diagnostics are genuinely absent from the accessibility tree;
- the task does not rely on color or sound alone.

### Evidence log template

```md
- Route:
- Starting state:
- Target viewport:
- Narrow viewport:
- Primary action performed:
- Visible feedback:
- Decision saved:
- Undo or change:
- Uncertainty path:
- Reload and resume:
- Failure and recovery:
- Keyboard and focus:
- Browser errors:
- Synchronization measurement:
- Overflow or clipping:
- Screenshots or traces:
- Remaining risk:
```

## Stop-and-redesign triggers

Stop local patching and return to the path card when any one of these occurs:

- the user asks what they are supposed to do;
- the task needs verbal coaching from the agent;
- the primary action makes sense only after reading a legend;
- the user must learn an internal category to answer;
- the user must decode arbitrary colors, icons, tones, or abbreviations;
- the real evidence is replaced by prose, counts, logs, or metadata;
- evidence and answer controls cannot be seen together;
- related audio, animation, chart, preview, or state does not update together;
- the same interaction receives multiple explanatory copy patches;
- reducing batch size is being used as a substitute for task clarity;
- the user has to identify the next obvious missing step;
- a successful build or screenshot is being used as proof of an interactive behavior.

Response procedure:

1. Acknowledge the structural failure directly.
2. Stop adding tooltips, legends, or paragraphs.
3. Restate the user's task in one sentence.
4. Identify the native evidence.
5. Remove internal concepts from the default path.
6. Recompose evidence, action, and result.
7. Walk the full rendered path again.

## Review checklist

### Task and mental model

- [ ] The actor and situation are explicit.
- [ ] The goal is written in the user's language.
- [ ] The task can be explained in one sentence without internal nouns.
- [ ] One realistic item is understandable before queue mechanics are introduced.

### Evidence

- [ ] The real decision evidence is shown in its native medium.
- [ ] Temporal evidence moves together.
- [ ] Evidence is not replaced by summaries or metadata.
- [ ] The emphasized moment or object is perceptible without a private code.

### Interaction

- [ ] One primary action is visually dominant.
- [ ] The expected result is apparent.
- [ ] Evidence, question, and answer are co-located.
- [ ] Uncertainty is a legitimate action.
- [ ] Undo, error recovery, resume, and completion are reachable.

### Copy

- [ ] Every visible string serves orientation, action, feedback, recovery, or resume.
- [ ] No schema, model, storage, prompt, or repository language leaks into the task.
- [ ] No copy reads like a code comment or experiment note.
- [ ] Labels are complete natural phrases in the user's language.

### Responsive and accessible behavior

- [ ] Target and narrow viewports preserve the decision loop.
- [ ] There is no horizontal overflow or hidden primary action.
- [ ] Keyboard order and focus are logical and visible.
- [ ] Meaning does not rely on color or sound alone.

### Verification

- [ ] The real route and realistic starting state were used.
- [ ] The primary action was performed, not inferred from the DOM.
- [ ] Dynamic relationships were measured or directly observed.
- [ ] Normal, uncertain, recovery, resume, and completion paths were walked.
- [ ] Browser errors and stale state were checked.
- [ ] Screenshots or traces cover the flow, not only one component.

## How to use this in a skill

### Recommended placement

Use this document as a reference such as:

```text
frontend-skill/
├── SKILL.md
└── references/
    └── task-design-failure-case-study.md
```

Do not copy the entire incident into SKILL.md. The main skill should contain the mandatory
workflow and stop conditions. Load this reference when:

- the task is a review or labeling interface;
- unfamiliar evidence or model output is visible;
- the user reports confusion;
- the interface synchronizes multiple media;
- an agent needs concrete examples of deceptive “technically complete” states.

### What belongs in SKILL.md

- start from the affected user path;
- complete the path card;
- use native evidence;
- pass the first-view comprehension gate;
- co-locate evidence and action;
- walk the rendered path;
- stop and redesign on comprehension failure;
- report verification evidence.

### What belongs in this reference

- the full failure timeline;
- why each attempted fix was insufficient;
- root-cause patterns;
- copy transformations;
- detailed verification protocol;
- extended checklists and examples.

### Suggested routing sentence

Add a direct link from SKILL.md such as:

> For review surfaces, unfamiliar model evidence, synchronized media, repeated user
> confusion, or interfaces that need legends before the primary action makes sense,
> read `references/task-design-failure-case-study.md` before implementation.

## Condensed rules for SKILL.md

The following compact rules can be adapted into a frontend skill:

1. Start from the affected user path and complete the actor, situation, goal, evidence,
   action, result, recovery, resume, and viewport card before composing UI.
2. Make the rendered initial view answer what the task is, what evidence matters, what
   action comes next, and what result follows without verbal coaching.
3. Show decision evidence in its native medium and keep evidence, question, and action in
   one working view.
4. Keep internal taxonomy, model semantics, storage detail, and implementation rationale
   out of user-facing copy.
5. Do not invent a private color, icon, or sound language unless the distinction is necessary,
   immediately perceivable, and reduces cognitive work.
6. Prove dynamic relationships by walking and measuring play, synchronization, update,
   feedback, recovery, resume, and completion behavior.
7. Inspect the real target viewport and a materially narrower viewport.
8. If the user asks what to do, needs a legend before acting, or has to point out an obvious
   missing step, stop patching copy and redesign from the path card.

## Non-goals and nuance

### This is not a ban on color, sound, legends, or advanced controls

Use them when they map to familiar domain meaning, are accessible, and reduce effort. The
failure was arbitrary encoding in the primary task, not the existence of encoding itself.

### This is not a demand that every screen fit without scrolling

Long content can scroll. The requirement is that transient evidence and the action that
depends on it are not separated in a way that forces memory or loses context.

### This is not a ban on technical tools

Expert diagnostic screens may expose raw signals and internal categories when the intended
actor understands them and needs them. Confirm the actor rather than assuming every user is
an expert in the implementation.

### This is not solved by minimalism alone

A sparse interface can still omit necessary evidence. Remove irrelevant complexity while
keeping all prerequisites for a valid decision visible.

### This is not only a copy problem

Clear language cannot compensate for absent evidence, broken synchronization, unreachable
states, or a wrong mental model. Treat copy as part of the interaction, not as a repair layer.

## Final durable lesson

Frontend implementation is not the act of placing available data on a screen. It is the act
of arranging real evidence, a comprehensible action, visible feedback, and recovery so that a
user can complete a goal without learning the implementation first.

When the user has to teach the agent the next obvious step, the frontend is not ready. Stop,
return to the path, and redesign the task rather than adding another explanation.
