# After Advice Workflow

Use this after receiving a response from the external consultant.

1. Extract concrete claims from the advice.
2. Verify each claim against repository facts, docs, tests, or current web sources if needed.
3. Classify recommendations:
   - Apply now
   - Investigate with a small experiment
   - Reject because it conflicts with repo constraints
   - Needs more context or follow-up
4. Make the smallest safe change first.
5. Run the relevant tests and commands.
6. Summarize:
   - what advice was used
   - what was changed
   - what was rejected and why
   - test results
   - remaining risks

Do not treat the consultant as authoritative when its assumptions conflict with the codebase. Repo facts, user constraints, and passing tests win.

## After Code Artifacts

When ChatGPT returns a zip through code mode:

1. Verify the archive opens and contains `PLAN.md` or `00_plan.md`.
2. Read the plan before looking at the code.
3. Inspect the diff manually after unpacking into a temporary directory.
4. Apply only the parts that fit the repo and user scope.
5. Run the relevant local tests before reporting completion.

Never apply a generated zip wholesale without review.
