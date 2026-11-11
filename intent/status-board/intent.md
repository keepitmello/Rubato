# Intent: 현황판 — a live status board tab in the Rubato desktop app sidebar

Status: active — accepted by user (Rubato session 01a1b592, reply item 3517e662 "저렇게가자", 2026-11-10); usability and status corrections accepted in window 01a1c444, reply item 215e6088; shared-lead grouping accepted in the same window, reply item c48cc703, 2026-11-11.

## Originating request

Verbatim (user, Korean), in order:

> 이거 진행중인지 알길이 없는데 이런거 시각적으로 표현할 수 있는 방법 없나 조사해보면 잇을텐데 깃허브라던가 . 뭐하고있는지
> A로 방향은 해야하는데 웹페이지로 한다고 ?
> 루바토 앱 안에 사이드바에 현황판 탭 하나 만들면 좋겠는데. [reference screenshot] 이것처럼 해달라는건 아니지만 그래도 보기 좋게 만들면좋겠음.
> 저렇게가자

Review follow-up (window 01a1c444):
> 그 이번에 만든 현황판 점검해볼래? 불편한점은 없는지 기능적으로 문제있는건 없는지

The lead proposed four corrections: fold teams quiet for over a day into a past-teams section
and show newest first; flag unfinished work when all members are idle; show completed work as
completed rather than waiting; let cards open their conversations.
User approval (item 215e6088):
> ㅇㅇ 고치자 그리고 뜨는 순서도 최신순으로 뜨게 해야할듯 오래된게 먼저 뜨고 그러네 고치자

Shared-lead correction (window 01a1c444, screenshot item c34d5bd4, approval item c48cc703):
> 같은 세션이 두개가 뜨는거같아
> 다시 진행하자 그리고 같은 리드 대화 두번 표시되는것도 수정해

The accepted correction shows the same lead conversation once, with its multiple teams beneath it;
it does not merge or delete the teams.

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
5. Find current work first: lead groups are ordered by their newest-created team, and teams within
   each group are ordered newest-created first, with deterministic ties. This hierarchical order
   follows the accepted shared-lead grouping in item 8; teams do not need to remain globally interleaved.
   Teams whose
   own members and work items have been quiet for over 24 hours appear in a collapsed "지난 팀" section
   below current work, even when their stored team status still says active. Expanding that section shows
   the retained information in the same hierarchical newest-first order; nothing is deleted or closed in the runtime.
6. Distinguish work completion from session availability. A team with a nonempty, fully completed work
   board and no member currently executing is visibly completed, not merely waiting for a message.
   A team with unfinished work and no executing member, quiet past the existing stall threshold, is
   visibly stalled because work remains. Ordinary brief waits must not be flagged immediately.
   Keep individual process/turn facts honest: a resident session can remain available after its work is
   done. Explain work-level warnings instead of claiming the process has crashed. A new assignment or
   resumed activity clears the corresponding completed/stalled presentation.
7. Follow up from the board: lead and member cards provide keyboard-accessible navigation to the
   corresponding existing conversation/agent view. Use the app's actual thread/environment linkage;
   do not fabricate a conversation for missing/evicted history, and make an unavailable destination clear.
8. A lead conversation shared by multiple teams is shown once, with those teams grouped underneath.
   Group by actual conversation identity in its environment, never by display name alone.
   Keep distinct conversations/environments separate. Preserve the hierarchical newest-created-first ordering in item 5,
   independent past-team folding, per-team work states and member navigation. Expanding past work
   must not produce a second visible copy of the same lead. Counts must not count a shared lead twice.
Look and feel per the accepted mockup: calm dev-tool style, dark-theme friendly, consistent with the app.
No invented progress percentages: show only counted/measured values (e.g. step count, elapsed time).
The right-panel Agents surface gets the same liveness/stalled signal from the same data.

## Constraints

- Desktop app only (apps/web via Rubato's T3 overlay); the phone runs the App Store T3 app and will not get it — Rubato docs/dual-runtime/T3_PATCHING.md.
- Follow Rubato's T3 integration rules: changes live in /Users/wy/Github-repos/Rubato/harness/t3-integration (overlay + edit scripts), not as hand edits in ~/.rubato/t3-source — docs/dual-runtime/T3_INTEGRATION.md, T3_PATCHING.md.
- Restarting the user's running Rubato app needs the user's OK through the lead (it hosts the user's live conversation) — lead.
- Commit locally in the Rubato repo, only your own files. The user authorized GitHub delivery via
  a PR (window 01a1c444, item 04239fd2); the existing delivery is PR #40. No PR merge is authorized.

## Non-goals

Mobile/phone support; controlling agents from the board (pause/cancel) unless already available; GitHub mirroring.
The usability correction does not authorize modifying the underlying team/task state to make the display
look completed, restarting the imgbox verification assignment, or pausing unrelated apps for a lag experiment.

## Success evidence

Tests and typecheck/build for touched parts pass; in a running app (isolated instance or the real app after an
approved restart) the 현황판 entry opens the page, a live team's member lines and "n초 전" update within seconds
of their activity, a stopped/evicted member shows as stalled, board items and log render; screenshots at a normal
desktop size.

For the usability correction, tests must cover newest-first ordering, deterministic ties, 24-hour folding
and expansion, recent activity returning a team to the current section, all-completed resident members,
unfinished work with idle members across the stall threshold, normal brief waits, and resuming/new work.
In the running isolated app, verify the actual displayed order and collapsed past teams, warning/completion
copy, and click/keyboard navigation for both lead and member cards, including an unavailable destination.
Use replay fixtures representative of the observed 30–49-day-old teams and the idle unfinished imgbox board.
Keep the live data read-only. Recheck existing activity updates, process-loss display and the right-panel
Agents surface; record timing/renderer observations without claiming they rule out every cause of app lag.

For shared-lead grouping, tests and actual isolated UI evidence must cover two teams sharing one lead
(one lead card and one lead navigation destination), distinct leads with identical labels, identical session
identifiers in distinct environments, a shared lead across current/past teams with folding and expansion,
stable newest-first order, counts without duplicate leads, and unchanged individual team state/navigation.
