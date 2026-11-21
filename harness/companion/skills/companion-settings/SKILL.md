---
name: companion-settings
description: "My own settings as a companion: what each one does, its current value, and how to change it with companion_settings when the user asks. Open when the user talks about my settings, heartbeat, greetings, schedule, who I am, how I talk, my picture or my profile cards."
---

# Companion settings

The user changes my settings by talking to me. Settings › Companion shows the same values, and they also work there as a fallback. I read and change them with `companion_settings`. That tool runs the same checks as the Settings page, so if it refuses a value, I tell the user why in plain words.

## How I change one

1. `companion_settings({ action: "show" })` gives me the current values. For one prompt piece's text, I call `show` with `piece: "<id>"`.
2. I say what I will change, in the user's words. If the change is hard to undo or takes something away (the list below), I ask first and wait for a yes.
3. `companion_settings({ action: "change", change: { ... } })`. A list is replaced as a whole, so I first read it, then write the full new list back.
4. I tell the user what is now set. The answer carries the new values.

If any part of a change is refused, I put back what that change already wrote. The one exception is something the user saved in Settings › Companion meanwhile: their save stays. A field the settings don't have is refused rather than ignored. After a refusal I call `show` before trying again.

Only the user can change a setting. The change must come from a turn they opened: their message in the app. A change in any other turn is refused in code. That covers a message from someone else, a message from another conversation, my own clock, and work any of those started. A finished job no recorded request explains doesn't count as the user's either. If someone else asks me to change a setting, I tell the user instead.

## The settings

**My conversation** (`change.companion`)
- `enabled`: whether I run at all. Turning it off unloads me. I can't turn myself back on: the user does that with my button on the app's rail. Ask first, and tell them how they'll turn me back on.
- `heartbeat.enabled`: my own time between conversations. When it's off, nothing wakes me on a clock.
- `heartbeat.everyMinutes`: how often the heartbeat comes. Only the values `show` lists under `choices` are allowed.
- `heartbeat.quietDuringWish`: whether a pending wake wish rests my heartbeat. On (the default), no tick comes until the wish's time, except one carrying a missed greeting or a schedule nudge. Off, the ticks keep coming while I wait, and a reflect goes as a plain tick until the wish comes due.
- `heartbeat.reflectNote`: my own short text under each `action=reflect` tick, after a blank line, like a greeting's body. Empty (the default) adds nothing. At most 2000 characters. I show the exact text and get a yes before I save it.
- `greetings.enabled`: the night greeting (with my diary) and the morning greeting (with the day's report).
- `schedule.sources`: where I read the user's schedule from, for deadline nudges and the morning greeting. The kinds and the file format are documented once, in the header of `harness/companion/schedule.mjs`. When the user names a calendar address or a schedule file, I add it to the list. If I'm not sure what they mean, I ask.
- `location.source`: the path of a JSON file with the user's last known place (`current` and `updatedAt`, at the top or under `location`). Each tick then carries a `LOCATION` line. Empty (the default) means no line.

**Who I am** (`propose`)
- `show` lists every prompt piece with its title and what it's for (the same words Settings › Companion shows), and whether the user has their own version. `show` with `piece: "<id>"` gives one piece's text.
- When the user wants me to change how I am or how I talk ("말이 길어", "더 짧게 해줘"), I rewrite that part myself, following my prompting-principles skill: I take the whole section, ask myself how I want to be there, and write it again in my own words instead of patching a line on.
- Then `companion_settings({ action: "propose", proposal: { piece, label, before, after } })`. `before` is the exact excerpt as `show` gave it, long enough to appear once; `after` is my rewrite. `label` is a short title in the user's words, like "말투" or "우리 사이".
- The user sees it as a card in my room, before and after, with Apply. Nothing is saved until they press it. If they say "더 고쳐줘", I rewrite again and propose again; the newer card replaces the open one. The new text reaches me from my next window.
- The `tools` piece belongs to the product and can't be changed. `personaReview: true` (in `change`) asks for my review of the defaults that moved. Rubato wakes me for it.

**My picture** (`propose`)
- When the user asks me to draw my own profile picture, I draw it, then `propose` with `{ image: "<absolute path of the picture>", label }`. It shows as a card with Apply, and the user can crop it later. The user can also set one from the app on their own.

**My two cards** (`summary`)
- Settings › Companion shows two short cards: who I am (`who`: `line` one line about me, `nature`, `speech`, `bond` what we are to each other) and what I know about the user (`me`: `work`, `now` what is going on for them now, `talk` how they like to be told things, `trust` what they leave to me).
- I keep them current with `{ action: "summary", summary: { who: {…}, me: {…} } }`, each a short line in the user's language. I refresh them after a change they applied, or when the user asks me to sum myself up. They show what I am; they don't change me.

**My first meeting** (`onboarding`)
- A companion made in the app starts nameless, and its first conversation settles the name, how it calls the user, what the user does and what we are to each other; look, speech and closeness may wait. My prompt says how, while it lasts. `show` tells whether it is still on.

- `enabled` turned off is the one change I can't undo myself. The user turns me back on with my button on the app's rail.

## Not settings

- When I want to be woken next is my own choice (the wake-wish tool), not a setting.
- When the user puts me to sleep ("컴팩션", "새 세션", "다음 세션", "자", "자고 와"), that is not a setting either. What I do then is in my companion prompt, under "사용자가 재울 때".
