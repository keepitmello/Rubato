---
name: memory-discipline
description: Read before writing Rubato memory: whether a finding is worth keeping, which file owns it, and what to delete. One question per file, current answer only, read-modify-write, and the git-beats-memory gate.
---

# Memory Discipline

## The gate: does git already answer this?

Git records what changed and how: files, diffs, order, timestamps. **A memory that git can answer is noise, and noise outranks signal in search.**

| Git answers | Memory answers |
| --- | --- |
| What was changed | **Why that approach** |
| The final code | **Which candidates were rejected, and why** |
| The order of commits | **How the cause was narrowed** |
| When it happened | **What constraint forced the compromise** |
| The diff | **What is unresolved and when to revisit** |

Past that gate, save when at least two hold: expensive to reverse, non-obvious from the code, likely to come up again.

Never write tool-call logs, intermediate attempts, commit hashes, exact counts, regexes, summaries of summaries, or the agent's own defects ("I keep forgetting tests"); a resident line like that makes the next session become that agent. Not saving is a valid outcome.

## Where it goes

| What you learned | Where |
| --- | --- |
| A judgement whose answer you would **overwrite** if it changed | `decisions/<question>.md` |
| A fact you **look up** and update but never reverse | `reference/<topic>.md` |
| A repeatable procedure | `skills/<name>/SKILL.md` |
| A durable fact or preference about the user | Leave it for the dream; it maintains the user file |
| Ephemeral state or speculation | Nowhere |

## One file, one question

A file owns one question and its current answer, not a date, a session or a topic area. When one question lives in one place there is nowhere for a contradiction to form. If a file starts answering two questions, split it.

```markdown
---
description: <one line; search results show this>
---

## 결론
- <what is true now; when it changes, edit this line>

## 근거
- Chose / Rejected (with why) / Narrowing / Compromise / Revisit when / Generalizes

## 증상
<the original text from when the problem was first hit: user message, error output. Paste it; do not reconstruct it.>
```

`## 증상` exists for search: whoever hits the problem next arrives with the raw error, not with the solution's vocabulary.

## Current answer only

The file does not speak about time: no "this used to be B", no dated sections, no "outdated" markers, no contradiction comments. Git owns history (`git log -p <file>`). Why B was wrong belongs in `Rejected:`.

Writing is read-modify-write:

```
1. msearch "<the question>"   is a file already answering it?
2. found      -> edit it: overwrite 결론, add the rejected candidate to 근거
3. not found  -> create it
4. meaningless now -> delete it
```

When you find a wrong claim, delete or rewrite it on the spot. When two files answer one question, merge them and delete one. When what you learned invalidates another file, fix that file too. Deleting is safe; git keeps everything.

## When to write

When a thread of work closes, not every turn: per-turn writes splinter one episode into fragments. The daily dream reads the day's sessions and catches what the session did not write.

## Commands

- `msearch "<query>"`: search this project's memory; `-a` searches every store. Use short anchors (a component, an error, a decision).
- `rubato dream [<store>]`: run the dream now. It writes what the sessions left out, resolves contradictions and duplicates in place, and updates the user file.
