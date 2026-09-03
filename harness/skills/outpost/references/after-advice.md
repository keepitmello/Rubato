# After Advice Workflow

Use this after receiving a response from the external consultant.

1. Confirm that the response answers the attached packet, then extract concrete claims.
2. Verify each claim against repository facts, docs, tests, or current web sources if needed.
3. Classify recommendations:
   - Apply now
   - Investigate with a small experiment
   - Reject because it conflicts with repo constraints
   - Needs more context or follow-up
4. Make the smallest safe change first.
5. Run the relevant tests and commands.
6. Summarize:
   - the question and thread id
   - what advice was used
   - what was changed
   - what was rejected and why
   - test results
   - remaining risks and uncertainty

Do not treat the consultant as authoritative when its assumptions conflict with
the codebase. Repo facts, user constraints, and passing tests win.

## After Code Artifacts

When ChatGPT returns a zip through code mode:

1. Verify the archive opens and passes an integrity check.
2. Inspect its contents and diff manually after unpacking into a temporary directory.
3. Apply only the parts that fit the repo and user scope.
4. Run the relevant local tests before reporting completion.

Never apply a generated zip wholesale without review.
