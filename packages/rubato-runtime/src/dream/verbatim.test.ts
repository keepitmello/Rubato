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
      quotes: ["캐시 98% 를 지켜라"],
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
      "quoted text changed: 캐시 98% 를 지켜라",
      "> quote changed: 센파이 쓰면 안 됨",
    ])
  })

  test("#given an untouched file or a kept Korean heading #when checked #then it does not pass", () => {
    expect(translationProblems(KOREAN, KOREAN)).toContain("`## 증상` is still there; it becomes `## Symptom`")
    const long = `## 결론\n${"한국어 문장이 길게 이어진다. ".repeat(20)}\n`
    expect(translationProblems(long, long).some((problem) => problem.startsWith("still mostly Korean"))).toBe(true)
  })
})
