# Design notes

## Shape

A short core and three cases. The core holds the default path with its stop points and the few moves that capable models skip unless told. The cases show the rest by example. General evidence-weighing advice is left out on purpose: models already weigh vendor benchmarks, repeated claims and dated sources well without it.

## How it got here

1. **Origin.** Extracted from one research round that its user judged far better than earlier ones (`cases/photo-map.md`).
2. **First draft.** Five ordered stages with quotas: strands, sources per strand, recheck counts.
3. **Outside review.** A GPT-6 Pro review, judged against the metaframe design and the original artifacts, removed the quotas and the source-format grading.
4. **Second run.** A different topic produced `cases/skill-catalog.md` and fixed three unclear points.
5. **Blind A/B.** A blind A/B against the official skills tree (Opus and Sol, real engine) showed where the skill changed behaviour:
   - first briefs that carried the user's words, rejected options with their reasons, and candidates held as hypotheses;
   - evidence handoffs without a recommendation.

   General evidence handling was mostly fine without it. The text was then cut down to those moves plus cases.

## Two decisions from the user

- **Stepwise.** The intent is a concrete, stepwise round. The steps stay visible as a default path, and any step can be the stop.
- **Conclusion on request.** The round ends with decision material. A recommendation comes only when the user asks for a conclusion. Choices that depend on the user's taste or experience go back to them, by comparison or by seeing.

## Revising

Add or replace a case when a real run teaches something the current cases do not show. Add a line to the core only for a move that models still skip after seeing the cases.
