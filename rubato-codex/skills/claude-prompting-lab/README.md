# Claude Prompting Lab

A model-aware Anthropic prompting skill synthesized from current official documentation, Claude 5-family model guides, system cards, Claude Code and Agent SDK docs, engineering posts, research papers, cookbooks, courses, and the official Agent Skills repositories.

Snapshot: 2026-08-02

## What it does

- Designs and reviews system, user, and tool prompts
- Migrates prompts between Claude model generations
- Chooses effort, context, memory, tools, and orchestration before wordsmithing
- Converts Anthropic research such as J-space, CoT faithfulness, persona work, and constitutional AI into bounded operational rules
- Produces evaluation suites and regression gates
- Separates probabilistic prompt guidance from deterministic security and runtime controls

## Package structure

- `SKILL.md`: concise router and common workflow
- `references/`: model deltas and topic-specific guidance
- `templates/`: prompt brief, delivery, migration, and eval templates
- `tests/`: starter trigger and behavior evaluations
- `scripts/`: linter and official-index refresher
- `sources/`: full official docs indexes and curated manifests

## Installation

For a local Claude Code setup, place the folder in the appropriate skills directory for your configuration. For the Skills API or Managed Agents, upload the packaged archive. The archive contains one top-level directory whose name matches the `name` field in `SKILL.md`.

## Validate

```bash
python scripts/lint_skill.py .
```

## Refresh sources

```bash
python scripts/refresh_official_indexes.py --out-dir sources/refreshed
```

Review diffs before changing model-specific guidance. Exact API fields, limits, model availability, and effort behavior are the fastest-moving parts.
