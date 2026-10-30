---
name: "aside"
version: 4
description: "Use when research quality depends on broad, fresh, high-recall evidence collection, or when a task has to happen in the user's browser: logged-in sites, forms, carts and checkout."
---

# Aside browser

Aside is an AI browser. Inside Aside, there is an intelligent agent designed to handle complex tasks across user's credentials, cookies, browsing history, and various websites the user uses.
Use it when the main quality bottleneck is breadth, recall, freshness, or direct browser interaction. Skip JavaScript unless the user named Playwright or asked you to attach to a specific tab and run code. Do not mix both in one request.

`aside --help` and `aside <command> --help` print current flags and examples.

## Run the task to Aside

Give Aside the whole browser-bound outcome. It plans the steps and controls the browser. When its evidence will feed later analysis, require source links, dates, quotations, contradictions, and collection gaps. Plain text only.

Start Aside Browser before running CLI commands. (Use `aside -h` to see how.)

### Start a task

Omit `-m`. The model comes from Aside settings Task models, not from `aside guide`.
`--effort` is thinking level, not the model.

`aside guide` and `aside exec --help` print `-m openai/gpt-5.6-sol` as a generic
example. That model is not on this account. Do not copy it.

```bash
aside "Find flights from SF to Tokyo for next weekend"
aside --effort high "Research quarterly earnings"
aside --effort ultrabrowse "Research this deeply"
aside --account u1 "Check unread Slack notifications"
aside --permission full-access "Install the CLI from the project README"
aside "https://example.com"
```

Use `-m <provider/model>` only when the user names a different model that exists
on this account.
Never pass `openai/gpt-5.6-sol` or `cursor/gpt-5.6-sol`.

After running the task, watch the run and give the user a status update around every 60 seconds.
If the process exits or the session is `interrupted`/`terminated`, recover the
same session. Do not start a second session.

```bash
aside session resume <id> "Continue and return the final evidence"
```

### Stop points and approvals

When a flow has a step that cannot be undone, such as a payment, a submit or a send, write the stop point into the task. Aside stops there, leaves the tab open and reports what is on screen. When approval arrives, continue the same session with the one step left.

```bash
aside "Buy example.ai on Spaceship for 2 years with the saved card. Stop on the card's 3DS screen without pressing its final confirm button. Report the total, the term and any approval code on screen, verbatim."
# after approval
aside session resume <id> "Press the final confirm button on the 3DS screen, then report the order result and the expiry date"
```

Ask for the values you have to pass on (prices, codes, order numbers) verbatim in the report. Name tabs Aside should leave alone and the tab to bring back to the front when it finishes.

### Control sessions

```bash
aside session resume <id>
aside session resume <id> "Continue the search"
aside session steer <id> "Switch to Google Flights"
aside session queue <id> "Export the final list to CSV"
aside session stop <id>
aside session archive <id>
aside session delete <id>
```

Resume with a prompt argument runs a single turn. Resume without a prompt opens an interactive session with `>`, `/session`, and `/exit`.

`steer` redirects a running turn. `queue` schedules instructions after the current step. Both commands print `ok` and exit.

`aside session list` includes sessions that were not saved to the chat list.

### Persistence

Sessions stay off the chat list by default. `aside settings save-sessions true` keeps them there.
`aside settings set-default-profile u1` makes later CLI commands use that profile. One-shot override: `--account u1`.

## Memory

Aside continuously distills the user's browsing into plain-Markdown memory. Recall it before asking the user about prior context:

```bash
aside memory search "<query>" --json
aside memory list --json
aside memory show MEMORY.md
aside memory path
```

Never edit memory files yourself. If the user wants Aside to remember something, run it through `aside exec`. Over `aside mcp`, prefer the `memory_search` tool.

## Skills

Check for an Aside skill before driving a site through `snapshot()` by hand:

```bash
aside skills list
aside skills show <name>
```

Read the matching skill first, then follow it. Tell the user which Aside skill you are using and for what.

## Remote hosts

```bash
aside host list
aside exec --host <id-or-name> "..."
aside repl --host <id-or-name>
aside host use <host>
```

Same Aside account, Remote Control enabled on the host. `aside login` once; afterwards remote hosts work even when Aside is not running locally.

## Drive the browser with JavaScript

Open this path when the user named Playwright, asked for a snapshot/locator script, or told you to attach to a given tab and run JS. Aside stays out.

A stop point, an approval wait, a precise click or a value read off the screen does not open this path. The Aside session flow above covers them.

```bash
aside repl "…"
```

MCP `repl` takes `{ title, code }`. Timeout is 120s. No `import`/`require`. Print with `console.log()`.

`page` starts unset. `listBrowserTabs()`, then `attachActiveBrowserTab()` or `attachBrowserTab(targetId)`. `openTab(url)` only if nothing relevant is open.

`snapshot(page)` returns `{ tree, diff }`. Click with `page.locator('e12')`, never as CSS. A new snapshot invalidates old refs. Print `tree` first, then `diff`. Fall back to `annotatedScreenshot(page)` when the tree is not enough.
