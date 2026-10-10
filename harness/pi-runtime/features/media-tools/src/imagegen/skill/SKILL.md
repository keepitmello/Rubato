---
name: gpt-image-gen
description: MUST read before creating or editing images. Covers when to use image_create versus image_edit, prompt structure from subject to background, verbatim text rendering, how edits drift and how to hold them, anti-patterns, and the revised_prompt feedback loop.
---

# GPT Image Generation

How to write image prompts that come back right the first time, and how to fix them fast when they don't. Read this before your first image call.

## Which tool

Both tools run ChatGPT Images 2.5 on the user's OpenAI ChatGPT login and save a PNG.

- `image_create` makes a new image from text. It uses Flare, the fast tier, which suits drafts, explorations and everyday images.
- `image_edit` changes an image. It uses Sunburst, the precise-editing tier. Pass `images` to edit or reference specific files. Omit `images` to keep editing the last image made in this session; the earlier requests of that chain ride along so the edit keeps their intent.

A chain restarts whenever `image_create` runs or `image_edit` gets explicit `images`. If a tool says the ChatGPT login is missing, tell the user to run `/login` and choose OpenAI; there is no other credential path.

## Prompt crafting

This section is the core of the skill. gpt-image models reward detail, and the single most common failure mode is a one-line prompt.

Build each prompt from six parts, in this order:

1. Subject. Who or what, with concrete physical detail. "A middle-aged baker with flour on her forearms and a gray-streaked braid" beats "a baker".
2. Medium and style. One style, stated plainly: "35mm film photograph", "watercolor illustration", "flat vector poster". Pick one lane.
3. Composition and camera. Framing, angle, focal length or its visual equivalent. "Eye-level medium close-up, shallow depth of field, subject left of center".
4. Lighting and color. Direction, quality, palette. "Soft window light from the left, warm amber tones against deep shadow".
5. Mood. The emotional register: quiet, tense, celebratory, clinical.
6. Background. What sits behind the subject, and how much of it is in focus.

A good prompt reads as a short paragraph, not a list and not a lone sentence. If your prompt fits on one line, it is under-specified, and the model will fill the gaps with whatever it likes.

### Rendering text in the image

When the image must contain readable text (a sign, a label, a headline), put the exact string in double quotes and state the font style and placement:

A weathered wooden sign above the door reads "OPEN TIL LATE" in hand-painted white serif letters, centered, slightly faded.

Keep on-image text short. Long passages smear. If the layout matters, say where each string sits.

Small numbers, prices, scores and dense multilingual text still waver. When they must be exact, generate the image without them and overlay the text afterwards.

### Anti-patterns

- Contradictory instructions. "Photorealistic watercolor" or "minimalist scene packed with detail" forces the model to average two opposing goals, and you get neither.
- Element overcrowding. Every named object competes for pixels and attention. Past roughly five or six distinct elements, small ones get dropped or mangled. Cut before you add.
- Style-list collisions. "In the style of anime, oil painting, and pixel art" is three prompts in a trench coat. Choose one style per image and generate variants separately.

## Editing

Every edit redraws the whole image. "Keep everything else identical" is a request, not a constraint, so camera angle, color and small details can drift.

- Change one or two things per call. Several removals in one call make the model redraw freely.
- Repeat the preservation list on every call: same camera angle, same layout, same brightness, same faces. Saying it once at the start of a chain is not enough.
- Start from the cleanest base you have. A good intermediate result makes a better source than the original plus five changes.
- Long chains drift: colors darken or warm up, faces move after four or five steps. Counter it in the prompt ("preserve the original brightness, neutral skin tone"), or restart the chain from the original with `images`.
- With several input images, label their roles: "Image 1: the product photo. Image 2: the style reference." Say what transfers and what stays.
- When exact pixel preservation is required, prompting alone will not hold it. Edit, then composite only the changed region back onto the original.

### The revised_prompt loop

Both tools return a revised prompt: the prompt the image model actually used after its own rewrite. Always read it.

1. Diff it against your intent. Note what the model added, dropped, or reinterpreted.
2. Fold the delta into your next prompt explicitly. If the rewrite dropped "overcast sky", put "overcast sky, no direct sunlight" back with more weight. If it added something you dislike, name the exclusion ("no lens flare").
3. Regenerate. Treat each round as a conversation with the rewriter, not a fresh roll of the dice.

## Iteration workflow

- Generate one image first. Inspect the result against every clause of your prompt before spending more.
- Correct deviations by editing the prompt, not by hoping. Name what was wrong and what stays fixed.
- Make variants only after the prompt is proven. Ten variants of a bad prompt are ten bad images.
- Keep the full prompt text in the conversation. It is your reproducibility record: anyone can re-run the exact call later, and you can diff prompt versions when results drift.
