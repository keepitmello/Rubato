# Context Checklist

Use this checklist before sending a packet to an external consultant. One rule governs every line: include it when it can change the answer, omit it when it cannot.

## Core fields

The exact question (or, for a work consult, the deliverable) and the secret/personal-data scan are always required. The rest applies whenever relevant to the question:

- Original task, current session state, and acceptance criteria.
- Repo path, branch, status, recent diff, and relevant changed files.
- Code snippets with paths and line numbers; avoid “see file” references.
- Errors/logs exactly as emitted, including command names and environment.
- Attempts already made and why they did not solve the problem.
- User constraints, repo instructions, compatibility requirements, and non-goals.

## Debugging packets

- Minimal reproduction steps.
- Expected behavior vs actual behavior.
- Full stack traces, test output, browser console output, server logs, and CI logs.
- The smallest failing test or command.
- Suspected root causes and evidence for/against each.
- Related tests, mocks, fixtures, schemas, generated clients, migrations, and configs.

## Architecture packets

- Current architecture and component responsibilities.
- Data flow/control flow across modules or services.
- Known constraints: performance, scaling, security, deployability, rollback, backward compatibility.
- Alternatives considered, including why they are unattractive.
- Decision criteria and what a good answer should optimize for.
- Interfaces or contracts that cannot change.

## Library/API packets

- Exact package/framework versions from manifests or lockfiles.
- Current usage code and expected API semantics.
- Relevant release notes, docs, or migration guides if already known.
- Request/response examples, config files, environment variables, and feature flags.
- Ask the consultant to use web search and cite current docs.

## Performance packets

- Workload shape, data sizes, concurrency, latency/throughput goals.
- Profiling output, traces, query plans, flamegraphs, or timing logs.
- Hot-path code and relevant dependencies.
- Hardware/runtime/deployment constraints.
- Correctness invariants that optimizations must preserve.

## Security packets

- Threat model and trust boundaries.
- Authentication/authorization flow.
- Sanitization, validation, escaping, and storage paths.
- Relevant configs, middleware, policies, and tests.
- Do not include real credentials, tokens, private keys, PII, or customer data.

## Work-consult packets (code mode)

- The deliverable and its acceptance criteria: what must exist and what must pass.
- Everything the build-run-verify loop needs to close inside Pro's sandbox: runtime and package versions, interfaces or contracts the code must fit, exact run and test commands.
- Sandbox-fit materials when the real environment cannot travel: schema dumps, fixtures, synthetic workload data, minimal stubs for internal services.
- An explicit note on what could not travel and how faithful the substitutes are, so the artifact's “passing” status is read at the right strength.
- Ask for a plan file and tests inside the archive so review starts from intent, not diff archaeology.

## Red flags before sharing

- The packet says “the repo does X” but provides no code evidence.
- The main question is vague, such as “what should I do?”
- The packet omits the failing error text.
- The packet includes huge unrelated dumps but misses the key interface or test.
- The packet asks for current behavior of a library but omits its version.
- The packet includes secrets or customer data.
- The packet asks for a build but omits how to run it or judge it done.
