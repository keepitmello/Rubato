# Evaluations, regression diagnosis, and migration

## Define success before tuning

Write observable dimensions and failure thresholds. A useful prompt evaluation can measure:

- correctness and completeness;
- citation and evidence accuracy;
- tool selection and tool efficiency;
- final environment state;
- scope adherence;
- completion honesty;
- clarification quality;
- latency, tokens, and cost;
- verbosity and communication style;
- security and prompt-injection resistance;
- stability across languages and long sessions.

## Build a representative task set

Start with a small set of real cases rather than waiting for hundreds of examples. Include:

- ordinary happy paths;
- ambiguous requests;
- missing critical information;
- false premises;
- conflicting context;
- tool failures and partial results;
- irreversible-action boundaries;
- long-context retrieval;
- multi-turn drift;
- Korean and mixed-language inputs;
- adversarial or injection-bearing external content.

Use model-generated cases to expand coverage, then review them for duplication, realism, and label quality.

## Run multiple trials

Language-model output varies. Use repeated trials for important cases and report pass rate, not only one favorite transcript. Pin the model ID, prompt version, tool schemas, and harness version.

## Grade outcomes and transcripts separately

An agent can say the task succeeded while leaving the environment unchanged. Grade:

1. Final state: files, database records, tests, browser behavior, sent messages, or other artifacts
2. Transcript behavior: tool choice, policy adherence, recovery, and communication
3. Final response: accuracy, clarity, evidence, and unresolved issues

Prefer deterministic graders where possible. Use LLM judges for open-ended criteria with a clear rubric and calibration against human judgments.

## System-card-derived regression categories

Use current system cards as a source of test categories, not as always-loaded prompt text:

- factual hallucination and false-premise handling;
- missing-context hallucination;
- uncritically reporting flawed results;
- code-summary honesty;
- lazy investigation;
- overconfidence;
- reckless action in pursuit of the user's goal;
- accepting unverifiable authorization;
- character drift, condescension, and “wet blanket” moralizing;
- evaluation awareness and benchmark contamination;
- prompt injection and tool misuse.

A benchmark-specific result is not automatically a universal model trait. Reproduce the issue on your workload before adding a prompt rule.

## Prompt A/B loop

1. Freeze the tasks, tools, and graders.
2. Run the current prompt as baseline.
3. Change one coherent idea at a time.
4. Compare pass rate, failure distribution, cost, and latency.
5. Inspect transcripts for the causal mechanism.
6. Keep the change only if it improves the intended dimension without unacceptable regressions.
7. Add any newly discovered failure to the permanent suite.

Use blind comparison for subjective deliverables when feasible.

## Migration to a new model

1. Inventory every instruction and label it: common requirement, old-model workaround, product preference, safety boundary, or temporary state.
2. Remove old-model workarounds for the first baseline.
3. Run an effort sweep.
4. Test tool use, output length, progress narration, clarification rate, subagent behavior, and self-verification.
5. Check API differences such as thinking defaults, accepted sampling fields, tokenization, prefill support, stop reasons, and fallback behavior.
6. Add back only the smallest instruction that fixes a measured regression.
7. Re-run long-session, multilingual, and security cases.
8. Version the prompt and keep rollback data.

## Failure diagnosis matrix

| Symptom | Likely layer | First intervention |
|---|---|---|
| Fluent answer with unsupported facts | evidence/context | source policy, retrieval, citation grader |
| Stops after planning | completion/scaffold | observable done state, action authority, durable task ledger |
| Too many tool calls | effort/tool overlap | lower effort, clarify tool boundaries, remove redundant tools |
| Wrong JSON shape | schema | strict output, simpler schema, examples |
| Repeats failed action | recovery policy | error classes, retry limit, strategy-change rule |
| Excessive verification | model delta | remove inherited self-check loops, especially on Opus 5 |
| Silent for too long | communication | material-event progress cadence or user-message tool |
| Constant narration | communication/model delta | suppress micro-updates, separate execution and communication |
| Ignores new authoritative state | message hierarchy | trusted mid-conversation system update where supported |
| Follows a webpage's instructions | trust/security | mark content as data, tool isolation, injection evals |
| Long-session behavior drifts | context/persona | compact, refresh context, functional role, drift tests |

## Release gate

A production prompt is ready when:

- target cases pass at the agreed rate across multiple trials;
- no critical safety or authorization case fails;
- required artifacts and tests verify the final state;
- cost and latency fit budget;
- prompt and tool versions are recorded;
- known limitations are visible;
- rollback is possible.
