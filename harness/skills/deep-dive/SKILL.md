---
name: deep-dive
description: "Use when the user asks for a deep-dive (딥다이브, 깊은 조사) into evidence, or a consequential decision turns on conflicting or missing evidence a quick lookup won't settle. Not for code walkthroughs, ordinary research or fact checks."
---

# Deep-dive

A stepwise research round for a decision that matters. The user decides. The round gives them decision material they can trust, and a conclusion only when they ask for one.

## Default path

Open the question → collect in parallel strands → recheck what the decision leans on against the originals → curate → independent judgment, when wanted → the user's choice.

Any step can be the stop: report there, and let the user say whether to go on. Loop back when a step exposes a gap.

## What capable models skip unless told

- Every brief and collector prompt carries the user's own words, the facts they set, and the options they already rejected, with the reasons.
- Current candidates and explanations are hypotheses. Keeping the current approach is a valid outcome.
- A collector in its own session, such as a browser agent, reads only the text it receives. Paste the context and the collection rules into its prompt; a file path is not enough.
- Seed each strand with the names you already know (authors, papers, projects, threads) as leads it may correct.
- Curated material interprets the evidence but recommends nothing. End with:
  - the strongest findings, with the conditions that bound them
  - the premises that were checked
  - the evidence that conflicts
  - the gaps
  - the choices that depend on the user's taste or experience

  Recommend when the user asks for a conclusion.

## Cases

Read the one closest to your run.

- `cases/photo-map.md`: the origin run. A UI question was widened, six strands ran, a claim was corrected on recheck, and a split judgment went to the user as mock-ups to decide by seeing.
- `cases/skill-catalog.md`: a harness-policy question run as an evidence handoff that stopped at the digest.
- `cases/brief-contrast.md`: one request briefed with and without the moves above.

Aside and Outpost keep their own skills for how to run them.
