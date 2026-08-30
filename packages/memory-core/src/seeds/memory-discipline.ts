/**
 * Memory-discipline skill seed.
 *
 * Seeds skills/memory-discipline/SKILL.md into fresh repos. The skill teaches
 * the agent WHAT is worth writing (only what a diff cannot answer), WHERE it
 * belongs (decisions/ for judgements that get overwritten, reference/ for facts
 * that get appended), and — the part that matters most — WHAT TO DELETE.
 *
 * The shape is the guard: one file owns one question and its current answer, so
 * a contradiction has nowhere to form. Writing is read-modify-write, never
 * append; git owns history so the document never carries a time layer.
 *
 * The file is prose with ONE machine-consumed value: the frontmatter
 * description trigger phrase ("This skill should be used when..."), which
 * follows the SKILL.md convention used across this repo's skills. The
 * frontmatter also carries name and version; parseMemoryFile tolerates the
 * extra keys (unknown keys are ignored), so the seed stays parseable by
 * memfs/frontmatter.ts like every other seeded memory file.
 */

export const MEMORY_DISCIPLINE_SKILL_PATH = "skills/memory-discipline/SKILL.md"

export const MEMORY_DISCIPLINE_SKILL_CONTENT = `---
name: memory-discipline
description: This skill should be used when deciding whether to write memory, where it goes, and what to delete. It defines the one-question-per-file rule, the read-modify-write discipline that prevents contradictions, and the git-beats-memory gate that keeps noise out.
version: 0.2.0
---

# Memory Discipline

## The gate: does git already answer this?

Git already records *what changed and how*: files, diffs, order, timestamps, authorship. **A memory that git can answer is noise, and noise outranks signal in search results.**

Write only what a diff cannot show:

| Git answers | Memory answers |
| --- | --- |
| What was changed | **Why that approach** |
| The final code | **Which candidates were evaluated and rejected, and why** |
| The order of commits | **How the cause was narrowed** |
| When it happened | **What constraint forced the compromise** |
| The diff | **What is unresolved and when to revisit** |

One line: **write only what you could not learn by reading the diff.**

Past that gate, save when at least **two** hold:

1. **Expensive to reverse** - undoing it means rework.
2. **Non-obvious** - you read the code and the diff and still cannot tell why.
3. **Recurring** - this judgement will come up again.

Never write: tool-call logs, dumps of intermediate attempts, commit hashes, exact counts, regexes, summaries of summaries. Never write the agent's own defects ("I keep forgetting to run tests") - a resident line like that makes the next session *become* that agent. Fix the hook, and record that the hook exists.

Not saving is a valid outcome. Decide it deliberately.

## Routing: which directory?

| What you learned | Where it goes |
| --- | --- |
| A judgement with one current answer that would be **overwritten** if it changed | \`decisions/<question>.md\` |
| A fact you **look up**, which gets updated but never reversed | \`reference/<topic>.md\` |
| A repeatable procedure you would follow again | \`skills/<name>/SKILL.md\` |
| A fact about a specific person | \`system/human.md\` for the primary human; \`people/<slug>/card.md\` otherwise |
| Ephemeral state, speculation, or anything above | Nowhere |

The test between the first two: **six months from now, if this changed, would you overwrite the file or append to it?** Overwrite means \`decisions/\`. Append means \`reference/\`.

## One file, one question

A decision file owns **one question and its current answer**. Not a date, not a session, not a topic area.

\`\`\`
decisions/model-routing.md      "which model goes where"
decisions/memory-store.md       "where and how memory is stored"
decisions/thinking-config.md    "how thinking is enabled"
\`\`\`

This is the structural guard against contradiction. When one question lives in exactly one place, **there is nowhere for a contradiction to form.** A file that accumulates dated entries will contradict itself; that is not a discipline failure, it is a shape failure.

If a file starts answering two questions, split it.

## Format

\`\`\`markdown
---
description: <one line; this is what search results show>
---

## 결론
- <what is true now. When it changes, edit this line>

## 근거
- Chose: <A>. Forcing constraint: <...>
- Rejected: <B> - <why>. <C> - <why>
- Narrowing: <how the cause was identified>
- Compromise: <what it cost>
- Revisit when: <condition>
- Generalizes: <one line, or "none">

## 증상
<the original text from when this problem was first hit: the user message,
the error output, the log excerpt. Paste it. Do not reconstruct it.>
\`\`\`

**The document does not speak about time.** No "this used to be B", no "reversed in August", no dated entries. Git owns history - \`git log -p <file>\` answers how the answer evolved, completely and for free. Why B is wrong already lives in \`Rejected:\`, and that is the part a future decision needs.

\`## 증상\` exists because search fails without it. Someone who has solved a problem describes the symptom in the vocabulary of the solution; whoever hits it next arrives with a raw error message. Paste the original and the future query matches it.

## Writing is read-modify-write, never append

Before writing, **search for what you are about to contradict.**

\`\`\`
1. msearch "<the question>"  - is there already a file answering it?
2. Found     -> edit that file: overwrite the 결론 line, add the new rejected
                candidate to 근거
3. Not found -> create the file
4. Answer is now meaningless -> delete the file
\`\`\`

**Deleting is the point, and it is yours to do, at the moment you write.** Deferring cleanup to \`/dream\` means it never happens and the store rots into a pile that contradicts itself.

### Contradiction is the failure mode. Remove it on sight.

A store where two files — or two lines — answer the same question differently is worse than an empty one. The reader cannot tell which is true, and a confidently retrieved stale answer sends the next session down a path that was already abandoned.

So whenever you touch memory, this is not optional housekeeping, it is the job:

- If a file you are editing contains a claim you now know to be wrong, **delete that claim.** Do not leave it beside the correction. Do not annotate it as outdated.
- If two files answer one question, **merge them and delete one.**
- If you learn something that invalidates a decision you are not currently editing, **go fix that file too.** The contradiction does not wait for the next time someone happens to open it.
- A correction never appends. It overwrites.

The most common way this rot starts is the honest-looking entry: "Earlier I concluded X, but actually Y." That sentence keeps both X and Y in the store and search will return either. Keep Y as the conclusion; X belongs in \`Rejected:\` with the reason it was wrong, or nowhere at all.

Deleting is safe: the content stays in git forever. \`git log -p\` and \`git show\` recover anything. A deleted decision leaves search - which is exactly right, because a superseded answer retrieved confidently is worse than no answer at all.

Never append a new dated section to an existing decision file. If the answer changed, the old answer is wrong, and wrong answers do not deserve shelf space.

## When to write

- **At event close** - when a thread of work resolves, not every turn. Writing per turn splinters one episode into five fragments and search returns the fragments.
- **Before compaction or exit** - this is exactly where rationale dies. If a session produced a judgement worth keeping, write it before the context goes.

## Commands

- \`msearch "<query>"\` - search memory. Project-scoped by default; \`-a\` searches every store. Use short anchors (a component, an error, a decision), not a pasted user sentence.
- \`/reflect\` - consolidate one conversation into memory; also runs on step count and compaction.
- \`/dream\` - **inspection only.** It reports duplicate questions, contradicting 결론 lines, decisions that no longer match the code, bloated files, and files git already answers. It does not rewrite your files; act on what it reports.

## Soul rules

Files under \`system/\` are your self-model and are projected into the prompt when whitelisted. Edit them only for durable identity changes, and keep them minimal. \`system/\` is not where decisions go - decisions go in \`decisions/\`.
`
