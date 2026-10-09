# metaframe v4

metaframe is a skill for deciding again whether to keep or change the current approach when observations contradict the current explanation or local fixes keep breaking each other. The model may load it at that signal, and you can invoke it yourself. It is meant to improve the use of capability already present in the model, not to replace the model with a decision system.

## What this version keeps

- the user's request and explicit boundaries as the center of gravity;
- the first framing as provisional only when another view could change the action;
- direct action when the task is already clear;
- focused clarification when only the user knows the decisive preference or goal;
- sources, tests, prototypes, and observations as ways for reality to answer back;
- an optional fresh context when the current conversation may be anchoring the view;
- a return to concrete work rather than visible metacognitive performance.

## What this version removes

- `direct / ask / probe / scout` as an explicit routing taxonomy;
- scoring rubrics, pass thresholds, contrast-case suites, and speculative release gates;
- mandatory blind-brief templates and detailed scout protocols;
- scripts whose main purpose was to validate the evaluation package rather than the skill's behavior.

## Install

The canonical copy lives in the shared skill store:

```text
~/.agents/skills/metaframe/
```

Each CLI (`~/.claude/skills/`, `~/.codex/skills/`, `~/.grok/skills/`) symlinks to it. For a project-local install, copy into `.claude/skills/metaframe/`.

The model loads it when its description matches the situation. You can also invoke it manually:

```text
/metaframe
```

or pass the task as an argument:

```text
/metaframe Review this product decision before implementation.
```

Once loaded, the skill text remains in that session, so use a new session or clear the context before unrelated work when you want a clean baseline. If it starts interrupting ordinary tasks, add `disable-model-invocation: true` back to the frontmatter to make it manual-only.

## Package shape

```text
metaframe/
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
