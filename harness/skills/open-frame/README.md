# Open Frame v3

Open Frame is a manually invoked Claude Code skill for opening a small amount of problem space before committing to a frame. It is meant to improve the use of capability already present in the model, not to replace the model with a decision system.

## What this version keeps

- the user's request and explicit boundaries as the center of gravity;
- the first framing as provisional only when another view could change the action;
- direct action when the task is already clear;
- focused clarification when only the user knows the decisive preference or goal;
- sources, tests, prototypes, and observations as ways for reality to answer back;
- an optional fresh context when the current conversation may be anchoring the view;
- a return to concrete work rather than visible metacognitive performance.

## What this version removes

- automatic invocation;
- `direct / ask / probe / scout` as an explicit routing taxonomy;
- scoring rubrics, pass thresholds, contrast-case suites, and speculative release gates;
- mandatory blind-brief templates and detailed scout protocols;
- scripts whose main purpose was to validate the evaluation package rather than the skill's behavior.

## Install

The canonical copy lives in the shared skill store:

```text
~/.agents/skills/open-frame/
```

Each CLI (`~/.claude/skills/`, `~/.codex/skills/`, `~/.grok/skills/`) symlinks to it. For a project-local install, copy into `.claude/skills/open-frame/`.

Invoke it manually:

```text
/open-frame
```

or pass the task as an argument:

```text
/open-frame Review this product decision before implementation.
```

`disable-model-invocation: true` keeps the skill out of Claude's context until you invoke it. Once invoked, the skill text remains in that session, so use a new session or clear the context before unrelated work when you want a clean baseline.

## Package shape

```text
open-frame/
├── SKILL.md
├── README.md
├── DESIGN_NOTES.md
├── HISTORY.md
├── metadata/version.txt
└── references/
    ├── CALIBRATION.md
    └── FRESH_CONTEXT.md
```

The two reference files are optional. The core skill tells Claude to read them only when they would add signal.
