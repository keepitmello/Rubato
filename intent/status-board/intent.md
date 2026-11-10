# Intent: 현황판 — a live status board tab in the Rubato desktop app sidebar

Status: active — accepted by user (Rubato session 01a1b592, reply item 3517e662 "저렇게가자", 2026-11-10)

## Originating request

Verbatim (user, Korean), in order:

> 이거 진행중인지 알길이 없는데 이런거 시각적으로 표현할 수 있는 방법 없나 조사해보면 잇을텐데 깃허브라던가 . 뭐하고있는지
> A로 방향은 해야하는데 웹페이지로 한다고 ?
> 루바토 앱 안에 사이드바에 현황판 탭 하나 만들면 좋겠는데. [reference screenshot] 이것처럼 해달라는건 아니지만 그래도 보기 좋게 만들면좋겠음.
> 저렇게가자

Reference screenshot (style inspiration only, not a spec): /Users/wy/.rubato/t3-home/userdata/attachments/38889810-b07d-49d9-ab1c-72b281d43217-792e294f-c0b7-4386-8650-43688f8a46df.png
Accepted mockup (direction, AI-generated; text is illustrative): /Users/wy/Github-repos/generated-images/rubato-status-board-a.png

## Problem

While a team or subagents work, the user cannot tell whether they are actually progressing or what they are doing.
On 2026-11-10 two imgbox team members had been evicted for days while the board and team state still said
"claimed/running"; nobody noticed until the lead read their sessions. The existing right-panel Agents surface
(RubatoAgentsPanel.tsx) shows teams, members and the board, but not when each member last moved.

## Proposed outcome

In the Rubato desktop app, a "현황판" entry near the top of the left sidebar (with a live count badge) opens a
status board page that shows, per team and per standalone subagent:
1. Who is working: a flow from the lead to its members/subagents, each with model and role (owner/verifier/subagent).
2. What each is doing now: the member's latest progress narration line, updating within seconds.
3. Whether it is alive: time since its last activity ("12초 전"); after a stall threshold it turns into a visible
   stalled state; evicted/lost sessions must not read as working.
4. Where it has been: recent steps per member, the team's board items with status/owner, and a combined log at the bottom.
Look and feel per the accepted mockup: calm dev-tool style, dark-theme friendly, consistent with the app.
No invented progress percentages: show only counted/measured values (e.g. step count, elapsed time).
The right-panel Agents surface gets the same liveness/stalled signal from the same data.

## Constraints

- Desktop app only (apps/web via Rubato's T3 overlay); the phone runs the App Store T3 app and will not get it — Rubato docs/dual-runtime/T3_PATCHING.md.
- Follow Rubato's T3 integration rules: changes live in /Users/wy/Github-repos/Rubato/harness/t3-integration (overlay + edit scripts), not as hand edits in ~/.rubato/t3-source — docs/dual-runtime/T3_INTEGRATION.md, T3_PATCHING.md.
- Restarting the user's running Rubato app needs the user's OK through the lead (it hosts the user's live conversation) — lead.
- Commit locally in the Rubato repo, only your own files; no push — lead.

## Non-goals

Mobile/phone support; controlling agents from the board (pause/cancel) unless already available; GitHub mirroring.

## Success evidence

Tests and typecheck/build for touched parts pass; in a running app (isolated instance or the real app after an
approved restart) the 현황판 entry opens the page, a live team's member lines and "n초 전" update within seconds
of their activity, a stopped/evicted member shows as stalled, board items and log render; screenshots at a normal
desktop size.
