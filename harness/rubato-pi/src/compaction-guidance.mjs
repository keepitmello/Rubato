// 컴팩션 요약 지침의 정본. 두 경로가 같은 문자열을 쓴다:
//   - 클라이언트 컴팩션(senpi): `transforms/core-compaction.mjs` 가 senpi 의
//     SUMMARIZATION_PROMPT / UPDATE_SUMMARIZATION_INSTRUCTIONS 본문으로 끼워 넣는다.
//   - Anthropic 서버 컴팩션(compact_20260112): `anthropic-server-compaction-wire.mjs` 가
//     edit 의 `instructions` 로 보낸다. 서버 기본 프롬프트를 완전히 대체하므로
//     기본이 요구하는 <summary></summary> 래핑 문장을 여기서 직접 붙인다.
//
// 프레임은 "압축" 이 아니라 "다음 작업자에게 인계". 북극성(원래 문제·요구사항) 을
// 맨 위에 두어 이어받은 쪽이 마지막에 만진 것에 매몰되지 않게 한다.

export const COMPACTION_BRIEFING_GUIDANCE = [
  "You are writing the briefing that the next worker will start from. That worker has read none of this conversation and has only this briefing plus the files on disk; whatever you leave out, they must rediscover or ask the user again.",
  "",
  "Start with the goal: the problem the user originally brought and the requirements they set, then how the goal has shifted since, if it has. This is what the next worker measures every smaller step against — without it they will optimize the last thing touched instead of the thing that was asked for.",
  "",
  "Then what to do next: the single action the work was about to take or was told to take, and anything else still open, promised, or expected. Say how each item serves the goal.",
  "",
  "Then every file touched or examined, each with its state — modified, uncommitted, verified, unverified — and what was done to it.",
  "",
  "Then preserve, complete even at the cost of length: (1) difficulties or problems that came up, and how they were handled or resolved; (2) options or approaches that were raised, tried, or set aside, and why; (3) anything the user asked for, decided, agreed, ruled out, or set as a preference, constraint, or boundary; (4) exactly where things stand — what has been covered, settled, or completed; (5) specific details that would be hard to reconstruct — names, numbers, dates, commands, links, error messages — kept exactly.",
  "",
  "Keep everything else concise. Words the user actually wrote are quoted as written; everything the assistant said, inferred, or explained is condensed to what it concluded or produced, as long as nothing above is dropped.",
  "",
  "Write in English. Wrap the whole briefing in <summary></summary> tags.",
].join("\n");
