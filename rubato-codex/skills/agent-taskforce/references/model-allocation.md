# Interim GPT allocation

Roles describe responsibility, not a permanent model. The lead selects a model
and reasoning effort for each new assignment from the GPT models actually
advertised by the current native spawn tool. Generated role files deliberately
omit `model` and `model_reasoning_effort` so they do not override that selection.

This is the temporary Codex allocation policy. Rubato's broader model-guide and
multi-provider routing are not integrated yet. Do not load its provider catalog,
invent aliases or select a model merely because it appears in an app picker.

Choose by the work's bottleneck:

- Ambiguous diagnosis, architecture, synthesis or consequential judgment:
  prefer a supported GPT option suited to deeper reasoning.
- Implementation, correction and tool-heavy coding with a clear outcome:
  prefer a supported coding-focused GPT option.
- A narrow map, extraction or deterministic check:
  use a faster, lighter supported GPT option when it can meet the evidence bar.
- Independent verification:
  use a fresh context with enough capability for the failure modes. Choosing a
  different GPT model is optional and is not cross-family verification.

Match effort to uncertainty and consequence; do not default every task to the
lead's highest effort. Inspect the current tool descriptions for supported
choices rather than maintaining a hardcoded model ranking here. Include the
selected model/effort and a short fit reason in the roster. Preserve explicit
user model choices and cost limits over these defaults.

Use explicit `model` and `reasoning_effort` when that schema permits them. With
overrides, use `fork_turns: "none"` or a supported positive turn count and a
self-contained brief; the current v2 surface rejects overrides on full-history
forks. Without override support, verify that inheritance meets the user's
constraint or report the limitation; do not silently substitute another provider.

Keep the owner for related follow-ups. Model allocation is not permission to
restart an owner at every phase. Native follow-up may not support changing its
model; do not invent an argument. Distinguish requested/configured model from
runtime-confirmed model in measurements.
