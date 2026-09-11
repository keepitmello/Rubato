# Managed intent records

The helper is an optional, dependency-free Node CLI for projects adopting this record
format. Run it with the lead's canonical project root, never an inferred child worktree
or the installed skill directory. All reads and writes are local. Existing external
systems of record stay external; the helper does not import or overwrite their files.

Resolve the installed skill path from the runtime's skill list. In the examples below,
`HELPER` is that skill's absolute `scripts/intent.mjs` path and `PROJECT` is the canonical
workspace. `--home docs/intent` can reuse a chosen project-relative home instead of the
default `intent`. Carry that choice with the reference.

```sh
node "$HELPER" list --workspace "$PROJECT"
node "$HELPER" list --workspace "$PROJECT" --all
node "$HELPER" read --workspace "$PROJECT" --id document-authority
```

`list` is a live directory scan. It does not create the home or an index. It finds
stable IDs, not semantic duplicates: the lead still compares the requested outcome,
scope and originating source before creating anything. Multiple unrelated active
intents may coexist. There is no repository-global current-intent pointer.

Create a body file from the template in the existing scratch area, fill it, and use
it once. This scratch file is not another authority and may be removed after recording.

```sh
node "$HELPER" create --workspace "$PROJECT" --id document-authority \
  --source "user request / exact session or review reference" --body /path/to/body.md
node "$HELPER" activate --workspace "$PROJECT" --id document-authority \
  --expect '<sha256 returned by create/read>' --approval "actual human acceptance reference"
```

Use the newly returned `intent_ref` after activation. A caller supplies the approval
reference; the CLI records it but cannot authenticate the human or judge its sufficiency.
Never fabricate this value. For a new taskforce, cite the actual human reply accepting
both the concrete intent summary and roster; the earlier generic task request does not
approve a roster the user has not seen. Keep the proposal-message reference, its intent
revision and the matching roster in the existing mission. Do not put staffing into intent.
For non-team work, a precise current instruction may already cover the exact bounded change.
Resolve material outcome-blocking questions before activation. The CLI validates content
integrity and status, not the meaning of open questions or the scope of a human reply.

When the user accepts with a clear correction, incorporate that correction in the same
record before activation and cite that reply. No second yes is needed for an unambiguous
accepted variant. A newly unsettled material implication needs a delta confirmation.
Partial approval is not combined approval. Keep an unchanged already active intent as is;
wait for any newly proposed roster to be accepted without needlessly revising the intent.

```sh
node "$HELPER" check --workspace "$PROJECT" --id document-authority \
  --expect '<sha256 from the brief>' --active
node "$HELPER" revise --workspace "$PROJECT" --id document-authority \
  --expect '<current sha256>' --source 'human change request or reason' --body /path/to/revision.md
```

Revision preserves the originating `source`, records its reason in `revision_source`,
increments the revision number and clears approval, including after a completed
intent is reopened. Re-accept before dependent execution and propagate the new reference.
`check` rejects stale references and active records whose approved content was manually
edited. `read` still exposes such a record for recovery; use its current SHA with `revise`
to return to draft. A superseded intent cannot be revived: follow its replacement.
An unavailable source or failed check is not permission to make a replacement record.

```sh
node "$HELPER" close --workspace "$PROJECT" --id document-authority \
  --expect '<current sha256>' --status fulfilled --evidence 'accepted tests/artifacts/delivery reference'
node "$HELPER" index --workspace "$PROJECT"
node "$HELPER" index --workspace "$PROJECT" --write
```

Closure statuses are `fulfilled`, `abandoned`, `superseded`. Only an active intent may
be fulfilled. Supersession requires `--superseded-by` naming an existing active
replacement, plus the decision/evidence reference. A reason alone cannot prove a result;
the lead verifies the evidence. Closed records are historical; `list --all` includes them.

The generated index is navigation only, rebuilt from records, not a second status store.
Writing it is explicit and refuses to replace a handwritten index. Default searches
start from live draft/active records, then inspect history only when relevant.

The frontmatter uses scalar YAML (JSON-quoted strings), schema 1. Managed mutation
commands serialize cooperating writers with `.intent.lock`, check expected file hashes,
and replace files atomically. A writer crash may leave the lock: inspect ownership and
recover it explicitly rather than deleting it on a timer. Symlink homes and traversal
paths are rejected. These checks are cooperative local-file safeguards, not a permission
system or protection against a hostile concurrent filesystem writer. Git versioning and
commit permission remain the existing project's responsibility.
