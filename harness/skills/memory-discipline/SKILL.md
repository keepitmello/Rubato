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

## Conclusion
- <what is true now; when it changes, edit this line>

## Rationale
- Chose / Rejected (with why) / Narrowing / Compromise / Revisit when / Generalizes

## Symptom
<the original text from when the problem was first hit: user message, error output. Paste it; do not reconstruct it.>
```

`## Symptom` exists for search: whoever hits the problem next arrives with the raw error, not with the solution's vocabulary.

## Language

Write memory in English, whatever language the session used: every role searches in English, and English costs fewer tokens on every read. The user's own words stay verbatim in their original language: the `## Symptom` text, and any quoted request, correction or constraint (in quotation marks or a `>` block). Never translate, trim or reword a quote; write the English around it.

## Current answer only

The file does not speak about time: no "this used to be B", no dated sections, no "outdated" markers, no contradiction comments. Git owns history (`git log -p <file>`). Why B was wrong belongs in `Rejected:`.

Writing is read-modify-write:

```
1. msearch "<the question>"   is a file already answering it?
2. found      -> edit it: overwrite Conclusion, add the rejected candidate to Rationale
3. not found  -> create it
4. meaningless now -> delete it
```

When you find a wrong claim, delete or rewrite it on the spot. When two files answer one question, merge them and delete one. When what you learned invalidates another file, fix that file too. Deleting is safe; git keeps everything.

## When to write

When a thread of work closes, not every turn: per-turn writes splinter one episode into fragments. The daily dream reads the day's sessions and catches what the session did not write.

## Commands

- `msearch "<query>"`: search this project's memory; `-a` searches every store. Query in English, the language the records are written in, with short anchors (a component, an error, a decision). A raw error or the user's own words also match, because `## Symptom` keeps them verbatim.
- `memory` and `memory_apply_patch`: how a session writes memory. Each change is committed with the `reason` you give, which is what `git log` shows later. Load them with `tool_search` when they are not active. A file written with a shell or a file tool is committed by the next writer under a generic message, so its reason is lost.
- `rubato dream [<store>]`: run the dream now. It writes what the sessions left out, resolves contradictions and duplicates in place, and updates the user file. A store written before memory moved to English is translated once on its next dream (`rubato dream --migrate <store>` runs it now); `harness/README.md` has the details.
