---
name: "aside"
version: 4
description: "Use when research quality depends on broad, fresh, high-recall evidence collection, or for any browser automation."
---

# Aside browser

Aside is an AI browser. Inside Aside, there is an intelligent agent designed to handle complex tasks across user's credentials, cookies, browsing history, and various websites the user uses.
Use it when the main quality bottleneck is breadth, recall or freshness. Hand all browser automation to Aside. Write JavaScript only when the user named Playwright or asked you to attach to a specific tab and run code. Do not mix both in one request.

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

### Hand it off, collect the result

Start each task as its own background shell session (Bash `run_in_background: true`), one task per session; independent tasks can run side by side. Do not background it inside a foreground command (`&`, `nohup`, a subshell): the CLI dies with that terminal.

Then do other work or end the turn. The harness reports when the session exits, and the final answer is in its output (`bash_output`). Do not poll in between: no `sleep` loops, no `aside session list` checks, no output-size watchers. Such a background session also keeps a subagent's run open until it exits and wakes it with the result; a process hidden with `&` or a persistent monitor does not, and the subagent returns before Aside has answered.

Aside logs in when a site is logged out and clears security checks and CAPTCHAs itself. Do not write "do not log in" or "do not enter credentials" into the task, and do not fall back to public pages because a login wall appeared. Restrict only the write actions the user did not ask for (submitting, messaging, posting, paying).

If the process exits without a final answer or the session is `interrupted`/`terminated`, recover the
same session. Do not start a second session.

```bash
aside session resume <id> "Continue and return the final evidence"
```

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

```bash
aside repl "…"
```

MCP `repl` takes `{ title, code }`. Timeout is 120s. No `import`/`require`. Print with `console.log()`.

`page` starts unset. `listBrowserTabs()`, then `attachActiveBrowserTab()` or `attachBrowserTab(targetId)`. `openTab(url)` only if nothing relevant is open.

`snapshot(page)` returns `{ tree, diff }`. Click with `page.locator('e12')`, never as CSS. A new snapshot invalidates old refs. Print `tree` first, then `diff`. Fall back to `annotatedScreenshot(page)` when the tree is not enough.
