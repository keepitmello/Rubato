---
name: find-skills
description: "Find an existing skill or research new skills when the user asks to discover or extend capabilities. Not a prerequisite for ordinary coding, review, or debugging."
---

# Find Skills

Start from the capability the user asked to find, not a domain keyword in an
ordinary task. "Help me review this change" is a review request, not a skill search.

## Existing skills first

Check the current available skill list and local installed skills. Read the
closest candidate only when its actual scope or workflow is unclear. Prefer a
suitable existing capability over adding another router or overlapping package.
Respect disabled skills; finding their files is not permission to invoke them.

## External discovery when needed

When the user wants new skills or an external catalog search, use an available
discovery tool or the current skill installer's supported source. Keep search
terms generic unless sharing private project details was authorized.
Report a few relevant candidates with source links, their fit, and whether they
are already installed. Do not guess package names or copy stale CLI commands.

A lookup does not authorize installation or a global update. Install only when
requested, through `skill-installer` when available. If no suitable skill exists,
say so; an ordinary task can still be handled without installing a skill.
