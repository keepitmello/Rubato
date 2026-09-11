# Tools, schemas, and user-facing output

## Treat tool definitions as high-priority prompt content

For each tool, specify:

1. What it does
2. When to use it
3. When not to use it
4. Required inputs and their meaning
5. Returned data and important omissions
6. Side effects and reversibility
7. Common failures and recovery behavior
8. Authorization or approval requirements

Complex tools usually need several sentences. A precise tool contract often improves an agent more than another paragraph in the system prompt.

## Choose a small, coherent tool surface

Prefer a few tools that correspond to primary actions. Avoid dozens of overlapping tools with ambiguous names. Use namespacing to make boundaries obvious, such as `github.search_code` and `github.create_issue`.

Return concise, decision-relevant information. Large raw tool outputs consume context and make the next action harder to select.

## Add examples where the schema is ambiguous

Use realistic tool-call examples when:

- two tools are easy to confuse;
- a parameter has domain-specific semantics;
- nested JSON is error-prone;
- optional fields change behavior;
- the correct call depends on prior tool results.

Do not spend tokens on examples for obvious scalar fields.

## Separate planning, execution, and communication

For long-running agents, distinguish tools that:

- inspect or search;
- mutate state;
- persist memory or progress;
- request approval;
- communicate with the user.

A dedicated user-communication tool can keep progress updates out of execution traces and lets the harness render status consistently.

## Tool selection and parallelism

- Parallelize independent reads, searches, or calculations.
- Keep dependent or state-mutating actions sequential.
- Use tool search or deferred loading when hundreds of definitions would crowd the context.
- Use programmatic tool calling for bulk or deterministic transformations when supported.
- Do not tell the model to use every tool. Tell it to use the smallest sufficient set.

## Strict tool use and structured outputs

Use strict schema enforcement and structured outputs when downstream code needs type-safe data. Keep the schema as simple as the product allows. Validate semantically important constraints outside the model even when the JSON schema passes.

For user-visible prose, separate the machine schema from the explanatory response. Do not make a single JSON object carry every human communication requirement unless the consumer truly needs that.

## Tool failures

Define recovery behavior:

- retry only when the error is transient or the call can be corrected;
- change strategy after repeated identical failures;
- preserve partial results;
- do not claim completion when a required verification tool failed;
- surface the blocker and the last trustworthy state.

## Ground status in evidence

A progress message should name the inspected artifact or tool result. Avoid statements such as “everything looks good” when no test, render, query, or diff was run.

## Mid-conversation system messages

Where supported, later system-role messages can add authoritative state or constraints without rebuilding the whole prefix. Use them for trusted operator instructions, policy changes, or session state. Never place retrieved pages, user-controlled files, or raw tool output into the system role; those remain untrusted context.

## Prompt caching

Keep stable system instructions and tool definitions in a stable prefix. Put rapidly changing state later. Do not duplicate large reference material merely to preserve cache structure.

## Citations and search results

When the application needs sourced answers:

- preserve source IDs and metadata in tool results;
- require claims to map to relevant evidence;
- grade citation correctness separately from answer correctness;
- prefer primary sources when the question permits;
- distinguish “not found” from “false.”

## Security boundary

Natural-language tool policy is probabilistic. Enforce least privilege, read/write separation, filesystem boundaries, network egress controls, secret isolation, and approval gates in code. Treat tool output as a prompt-injection surface even when the connector itself is trusted.
