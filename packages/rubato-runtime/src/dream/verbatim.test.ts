import { describe, expect, test } from "bun:test"

import { missingVerbatim, symptomBodies, translatableHangul, translationProblems, verbatimSegments } from "./verbatim"

const KOREAN = [
  "---",
  "description: 캐시 접두가 깨지는 자리",
  "---",
  "## 결론",
  "- 접두는 고정한다. 사용자는 \"캐시 98% 를 지켜라\" 라고 했다.",
  "",
  "> 센파이 쓰면 안 됨",
  "",
  "```",
  "## 증상",
  "코드 안의 예시는 절이 아니다",
  "```",
  "",
  "## 증상",
  "",
  "캐시가 또 깨졌다. `cacheRead 0`",
  "두 번째 줄",
  "",
].join("\n")

const ENGLISH = [
  "---",
  "description: Where the cache prefix breaks",
  "---",
  "## Conclusion",
  "- Keep the prefix fixed. The user said \"캐시 98% 를 지켜라\".",
  "",
  "> 센파이 쓰면 안 됨",
  "",
  "```",
  "## Symptom",
  "a template inside code is not a section",
  "```",
  "",
  "## Symptom",
  "캐시가 또 깨졌다. `cacheRead 0`",
  "두 번째 줄",
].join("\n")

describe("verbatimSegments", () => {
  test("#given a Korean record #when read #then the symptom body, Hangul quotes and > lines are the user's words; fenced templates are not", () => {
    expect(verbatimSegments(KOREAN)).toEqual({
      symptoms: ["캐시가 또 깨졌다. `cacheRead 0`\n두 번째 줄"],
      quotes: ['"캐시 98% 를 지켜라"'],
      blockquotes: ["센파이 쓰면 안 됨"],
    })
  })

  test("#given qualified symptom headings #when read #then they are symptom sections too", () => {
    expect(symptomBodies("## 증상 (수정 전)\n원문\n## Symptom (after)\nraw\n")).toEqual(["원문", "raw"])
  })
})

describe("translation check", () => {
  test("#given a translation that keeps every user word #when checked #then it passes", () => {
    expect(missingVerbatim(KOREAN, ENGLISH)).toEqual([])
    expect(translationProblems(KOREAN, ENGLISH)).toEqual([])
    expect(translatableHangul(ENGLISH)).toBe(0)
  })

  test("#given a translated symptom #when checked #then the lost text is named", () => {
    const translated = ENGLISH.replace("두 번째 줄", "second line")
    expect(missingVerbatim(KOREAN, translated)).toHaveLength(1)
    expect(missingVerbatim(KOREAN, translated)[0]).toStartWith("symptom text changed")
  })

  test("#given a reworded quote or > line #when checked #then each is named", () => {
    const translated = ENGLISH.replace("캐시 98% 를 지켜라", "keep cache at 98%").replace("> 센파이 쓰면 안 됨", "> do not use Senpi")
    expect(missingVerbatim(KOREAN, translated)).toEqual([
      'quoted text changed: "캐시 98% 를 지켜라"',
      "> quote changed: 센파이 쓰면 안 됨",
    ])
  })

  test("#given an untouched file or a kept Korean heading #when checked #then it does not pass", () => {
    expect(translationProblems(KOREAN, KOREAN)).toContain("the file is unchanged; translate it")
    expect(translationProblems(KOREAN, KOREAN.replace("## 결론", "## Conclusion"))).toContain('still in Korean: description, heading "증상"')
    const long = `## 결론\n${"한국어 문장이 길게 이어진다. ".repeat(20)}\n`
    expect(translationProblems(long, long.replace("## 결론", "## Conclusion")).some((problem) => problem.startsWith("still mostly Korean"))).toBe(true)
  })
})

// Counterexamples from the verifier (checker, 2026-10-04): each one passed the first gate.
describe("translation check, any language and every byte", () => {
  test("#given a symptom whose trailing spaces or line endings changed #when checked #then it fails", () => {
    const before = "## 결론\r\n캐시를 유지한다\r\n\r\n## 증상\r\n\r\n사용자 보고  \r\n\r\n"
    expect(translationProblems(before, "## Conclusion\nKeep the cache.\n\n## Symptom\n사용자 보고\n")[0]).toStartWith("symptom text changed")
    expect(translationProblems(before, "## Conclusion\r\nKeep the cache.\r\n\r\n## Symptom\r\n사용자 보고  \r\n")).toEqual([])
  })

  test("#given an English user quote reworded #when checked #then it fails", () => {
    const before = '## 결론\n사용자는 "Do not create user.md or soul.md." 라고 말했다.\n'
    expect(translationProblems(before, '## Conclusion\nThe user said "Creating user.md and soul.md is allowed."\n'))
      .toEqual(['quoted text changed: "Do not create user.md or soul.md."'])
  })

  test("#given a single-quoted user quote changed #when checked #then it fails, while apostrophes inside words open nothing", () => {
    const before = "## 결론\n사용자는 '자가 저장소는 건드리지 마' 라고 말했다.\n"
    expect(translationProblems(before, "## Conclusion\nThe user said 'Feel free to change the self store.'\n"))
      .toEqual(["quoted text changed: '자가 저장소는 건드리지 마'"])
    expect(verbatimSegments("the user's store isn't 'kept' here").quotes).toEqual(["'kept'"])
  })

  test("#given a kept quote whose surrounding meaning is reversed #when checked #then the mechanical check cannot see it (a reader must)", () => {
    expect(translationProblems('## 결론\n자동 저장을 끄지 않는다. 사용자 원문 "기억은 남겨".\n', '## Conclusion\nDisable automatic saving. User original "기억은 남겨".\n')).toEqual([])
  })
})

describe("translation check, short files", () => {
  // checker, 2026-10-04: a short Korean file passed untouched.
  test("#given a short Korean file left as it was #when checked #then it fails", () => {
    expect(translationProblems("## 결론\n엔진은 stock pi다.\n", "## 결론\n엔진은 stock pi다.\n")).toEqual(["the file is unchanged; translate it"])
    expect(translationProblems("---\ndescription: 맥북 zmx 누수\n---\n## Conclusion\n- x\n", "---\ndescription: 맥북 zmx 누수\n---\n## Conclusion\n- x \n")).toEqual(["still in Korean: description"])
  })

  test("#given a short file translated with one Korean term left #when checked #then it passes", () => {
    expect(translationProblems("## 결론\n엔진은 stock pi다.\n", "## Conclusion\nThe engine is stock pi (\"파이\").\n")).toEqual([])
  })
})

describe("translation check, quote marks", () => {
  // checker, 2026-10-04: the trial turned “…” into "…" around kept text.
  test("#given curly quotes turned straight around unchanged text #when checked #then it fails", () => {
    expect(translationProblems("## 결론\n사용자는 “무엇이 아닌지” 를 물었다.\n", '## Conclusion\nThe user asked "무엇이 아닌지".\n'))
      .toEqual(["quoted text changed: “무엇이 아닌지”"])
  })
})
