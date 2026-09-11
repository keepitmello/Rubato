# Model migration review

## Baseline

- Old model:
- New model:
- Old prompt version:
- Minimal new-model prompt version:
- Tool/harness versions:

## Instruction inventory

| Instruction | Type | Evidence it is still needed | Decision |
|---|---|---|---|
| | common requirement / old workaround / preference / security / temporary | | remove / retain / test |

## API and runtime differences

- Thinking default:
- Effort support:
- Sampling fields:
- Output limits/tokenizer:
- Assistant prefill:
- Stop reasons/fallback:
- Tool features:
- Host limitations:

## Regression results

| Dimension | Old | Minimal new | Tuned new | Notes |
|---|---:|---:|---:|---|
| Correctness | | | | |
| Tool success | | | | |
| Completion honesty | | | | |
| Latency | | | | |
| Cost | | | | |
| Verbosity | | | | |
| Clarification rate | | | | |
| Security | | | | |
| Korean behavior | | | | |

## Decision

- Ship criteria:
- Rollback condition:
- Known limitations:
