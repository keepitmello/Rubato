# Worked example: should an agent harness limit its skill catalog?

A real run from 2026-10-25, shortened. The topic is incidental; the shape is the point. Read only the part you need.

## The question as opened

Rubato lists every installed skill's name and description in every session (43 skills, about 17 KB, measured with the real renderer). A proposal had measured the catalog and left the size limit undecided. Five ways forward were held as hypotheses, including "no limit": a total byte cap, a per-description limit, grouping or router skills, search-based lazy listing, or keeping things as they are. Binding facts went in with their sources: the tools had already moved behind search, which took the first request from 27.7k tokens (20.1k of them tool definitions) to 12.1k. A 12/12 description-only routing check was passed along as a proxy, not as a runtime measurement.

## Paths by unresolved question

Four strands ran in parallel: research literature, vendors and harnesses, practitioners' measurements, and cost and caching with adjacent fields. The owner also fetched primary documents directly, such as changelogs, papers and docs, while the strands ran. One strand prompt opened like this:

> Your strand question: In published research (2023-2026), how do LLM tool/skill/API selection accuracy, wrong-selection rates, and adherence to other instructions change as (a) the number of candidate tools … grows and (b) the length or wording of each description changes? … Where do results NOT degrade?
>
> Leads (starting points, not boundaries): RAG-MCP; MCP-Zero; … positional or description bias in tool selection …; instruction-density studies …
>
> Pay special attention to: the actual sizes tested, the models, whether description length itself was varied, and any study finding little or no degradation.

The shared collection contract was pasted verbatim into every strand prompt, because a browser session cannot read a local file.

## Claims kept with their conditions

- A 2026 experiment with three frontier models found 1,296 of 1,296 runs correct from 5 to 100 distinct tools. The digest kept the limits beside the result: the tasks were short and clear, and with 36 runs per cell the 95% lower bound is about 90%. A drop of a few points would not show.
- An enterprise catalog study (arXiv 2606.17519) reported routing F1 on under-specified requests falling from 58.2% at 51 tools to 42.1% at 584 tools, driven by recall. Requests that named the tool stayed above 90% at every size. The decisive condition is overlap between candidates and how explicit the request is, not count alone.
- Claude Code cut skill listing descriptions to 250 characters, then raised the cap to 1,536 about two and a half weeks later. The owner's first draft said it "reverted" the cut. That was corrected on reread: a cap still exists.
- No harness published how its budget was chosen. The digest recorded this as a gap in public records, not as proof that the budgets are arbitrary.

## Where it stopped

The run was an evidence handoff, so it carried interpretation per option but no recommendation. Collection stopped when the remaining gaps could not be closed by more searching. No public study varied skill count and length while scoring correct activation, needless activation and adherence to unrelated instructions in the same runs. The next observation that could change the decision is local: a blind runtime comparison of the current catalog against one or more variants, using a fixed set of should-use, borderline and should-not-use requests, run on the models in actual use, after checking the harness for false zeros.

Records were kept next to the digest: prompts as sent, raw and final returns, re-fetched originals, and local measurements. Each claim was marked as rechecked by the owner or reported by a collector.
