# Product UI Visual Direction

Use this reference after `frontend-creation.md` for dashboards, tools, admin screens, forms, data tables, settings, and other product surfaces.

## Product authority

- Treat the approved design system, product conventions, components, tokens, and user-facing language as the visual source of truth.
- Extend the existing system through its established patterns when the requested outcome needs a new expression.
- Ground each intentional change in the user path, content hierarchy, brand, or platform convention.
- Match visual ambition to the scope of the requested change.

## Contextual concept

- Start from the domain, audience, environment, and task frequency.
- Choose one concept sentence that connects the product context to the experience.
- Use a small set of coherent expressive devices across typography, composition, color, material, imagery, icons, and motion.
- Give the product one recognizable signature that supports orientation or action.
- Keep familiar controls and task-critical patterns stable.

For confirmed flows with open visual details, explore a few directions internally and select the one that best supports the product context. Ask the user one focused question when a visual choice changes brand meaning or the user flow materially.

## Hierarchy and composition

- Let real content determine the layout and density.
- Make the page purpose, current state, primary action, and expected result clear in the initial view.
- Use scale, spacing, alignment, contrast, and grouping to guide attention in task order.
- Give dense professional tools efficient scanning, comparison, and batch-action patterns.
- Give focused or low-frequency tasks enough space for orientation and confidence.
- Design responsive behavior around content priority and interaction needs.

## Typography, color, and surfaces

- Use the product's established type system and introduce type changes through approved brand or design-system decisions.
- Build a clear hierarchy with the number of levels the content requires.
- Use color tokens consistently for brand, emphasis, and semantic states.
- Preserve readable contrast and recognizable interaction states.
- Use radius, borders, elevation, texture, and material as one coherent surface language.
- Let visual richness support the product concept and content.

## Components, states, and motion

- Reuse accessible platform and product components when they fit the interaction.
- Cover the states the changed path can actually enter, with a trigger, visible meaning, available action, and recovery or resume path.
- Use icons together with visible labels when the meaning benefits from reinforcement.
- Use motion to explain change, preserve spatial continuity, show feedback, or guide attention.
- Respect reduced-motion preferences and keep interaction timing consistent with the product.

## Rendered quality gate

Inspect the real rendered surface and confirm:

- the initial view communicates purpose, state, and next action;
- visual hierarchy follows the primary user task;
- product copy remains distinct from design rationale and implementation notes;
- the design feels specific to the product context;
- responsive layouts preserve content priority and usable actions;
- keyboard focus, semantic structure, contrast, labels, and feedback remain clear;
- relevant reachable states and recovery paths remain coherent;
- browser rendering is free of consequential overflow, clipping, and console errors.

Use the verification status defined in `frontend-creation.md`.
