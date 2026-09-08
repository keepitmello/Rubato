# Source map and freshness policy

This skill was synthesized from official Anthropic material available on 2026-08-02.

## Corpus layers

### Tier A: current operational guidance

Load first. This includes current model prompting guides, general prompting best practices, thinking and effort docs, tool-use docs, context and memory docs, Agent Skills guidance, Claude Code guidance, and evaluation docs.

### Tier B: model-specific evidence

Use for model deltas and regression cases. This includes release pages, migration guides, published product system prompts, and current system cards.

### Tier C: engineering practice

Use for harness design: effective agents, context engineering, multi-agent research, long-running harnesses, tool design, Agent SDK patterns, and agent evaluations.

### Tier D: research interpretation

Use to derive hypotheses and tests, not to fill the always-loaded system prompt. This includes J-space/global workspace, chain-of-thought faithfulness, introspection, persona research, constitutions, values, and model-written evaluations.

### Tier E: examples and legacy teaching material

Cookbooks, courses, the interactive prompt tutorial, old long-context experiments, and the older think-tool article remain useful for examples. Check model IDs and API assumptions before copying code or prompt text.

## Included source files

- `sources/platform-docs-relevant.csv`: prompt-relevant pages selected from the complete Platform index
- `sources/claude-code-docs-relevant.csv`: prompt- and harness-relevant Claude Code pages
- `sources/research-engineering.csv`: official Anthropic research and engineering posts with operational notes
- `sources/system-cards.csv`: current Claude 5-family system cards and how to use them
- `sources/anthropic-platform-llms.txt`: complete official Platform index snapshot
- `sources/claude-code-llms.txt`: complete official Claude Code index snapshot

## Freshness rule

Refresh before relying on exact model IDs, effort levels, thinking defaults, beta headers, availability, pricing, limits, or release behavior. The conceptual common core changes more slowly; model deltas and API details change quickly.

Run:

```bash
python scripts/refresh_official_indexes.py --out-dir sources/refreshed
python scripts/lint_skill.py .
```

The refresh script downloads official indexes and reports new prompt-relevant URLs. It does not automatically rewrite the skill; review changes before merging them.
