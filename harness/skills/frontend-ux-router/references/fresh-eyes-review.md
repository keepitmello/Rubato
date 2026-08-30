# Fresh-Eyes Review Protocol

An independent comprehension check for frontend work. The reviewer simulates a first-time user who has never seen the brief, the code, or any explanation, and answers the comprehension questions from the rendered interface alone.

Two roles use this file:

- **Implementer**: prepares the packet (defined in `frontend-creation.md` §10) and requests the review. Never runs the review on their own work.
- **Dispatcher / reviewer**: runs the review with zero implementation context.

## Why the roles must be separate

The builder knows what every element means, so the builder cannot detect that an element is incomprehensible. Self-certified comprehension always passes. The entire value of this gate comes from the reviewer's ignorance — protect it.

## Contamination rules

The reviewer must receive ONLY:

1. one persona line (who the actor is, in product terms — e.g. "리듬게임을 아는 음악 검수자", never "a user reviewing detector output against chart actions");
2. screenshots of the rendered initial view at target and narrow viewports, or a live route/URL;
3. optionally, the post-primary-action screenshot when feedback is being judged.

The reviewer must NOT receive: the task brief, the path card, design rationale, internal terminology, the diff, or answers to their questions. If the reviewer asks "what is this supposed to be?", that is a FAIL finding, not a question to answer.

## Reviewer prompt (dispatch verbatim)

```text
You are a first-time user of this product. You are: {PERSONA_LINE}.
You have never seen this screen and nobody will explain it to you.
Look at the attached screenshot(s) (or open {ROUTE}) and answer using ONLY
what is visible:

1. What product or task is this?
2. What must you look at, listen to, or compare?
3. What is happening right now?
4. What would you click/do first, and why that element?
5. What do you expect to happen after that action?

Then report:
6. Every element (text, control, badge, color, icon) whose purpose you cannot
   explain — list each one.
7. Every visible string that reads like a code comment, schema field, status
   enum, or developer note — quote each one.
8. Anything you would need to be taught before you could act confidently.

Verdict:
- PASS: you answered 1–5 confidently from visible content alone, and lists
  6–8 are empty or trivial.
- FAIL: any of 1–5 was a guess, or any list contains a blocking item. State
  which question numbers failed and why.

Answer honestly as a stranger. Do not be charitable. A guess counts as a
failure even if it happens to be right.
```

## Grading

- **PASS** requires confident answers to all five questions AND no blocking items in lists 6–8. "I guessed and got lucky" is a FAIL.
- On **FAIL**, the reviewer's raw answers are the redesign input. The failed question numbers map to the path card: Q1–Q3 failures → evidence/orientation problems; Q4 → primary action hierarchy; Q5 → missing expected-result signal; list 7 items → copy rule violations.
- The implementer responds to a FAIL by returning to the path card (stop-and-redesign procedure in `frontend-creation.md`), not by explaining the answer to the reviewer or adding a tooltip for each confusion.
- One re-review after recomposition. A second FAIL on the same question means the task model itself is wrong — escalate to the user with both review transcripts.

## Dispatcher notes

- Any capable agent with vision can be the reviewer; a cheap fast model is fine — the reviewer needs perception, not implementation skill. In a meight environment, a one-shot `luna` dispatch with the prompt above and screenshot paths is sufficient.
- Run the reviewer in a fresh context (new worker/session). Never reuse the implementer's session or a session that saw the brief.
- When the screen's actor is an expert (diagnostic tools, admin consoles), set the persona line to that expert. The gate tests fit-to-actor, not universal simplicity.
- Attach the verdict and the reviewer's raw answers to the completion evidence. `VERIFIED` requires a PASS on record.
