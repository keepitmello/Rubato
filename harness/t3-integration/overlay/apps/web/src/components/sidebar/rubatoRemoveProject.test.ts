import { describe, expect, it } from "vite-plus/test";

import { createUiTranslator, type UiDictionary } from "../../rubatoI18n";
import korean from "../../rubatoI18n.ko.json";
import { removeProjectConfirmLines } from "./rubatoRemoveProject";

describe("removeProjectConfirmLines", () => {
  it("names the threads it deletes and keeps the files on disk", () => {
    const lines = removeProjectConfirmLines({ name: "E2", paths: ["/tmp/a/E2"], threadCount: 3 });
    expect(lines[0]).toBe('Remove project "E2" and delete its 3 threads?');
    expect(lines).toContain("Path: /tmp/a/E2");
    expect(lines).toContain("This removes only the project entries, not the files on disk.");
    expect(lines.at(-1)).toBe("This action cannot be undone.");
  });

  it("asks without a thread count when the project has none, and lists every checkout", () => {
    const lines = removeProjectConfirmLines({ name: "E2", paths: ["/a", "/b"], threadCount: 0 });
    expect(lines[0]).toBe('Remove project "E2"?');
    expect(lines.filter((line) => line.startsWith("Path: "))).toEqual(["Path: /a", "Path: /b"]);
    expect(removeProjectConfirmLines({ name: "E2", paths: [], threadCount: 1 })[0]).toBe(
      'Remove project "E2" and delete its 1 thread?',
    );
  });

  it("reads in Korean line by line", () => {
    const translator = createUiTranslator(korean as unknown as UiDictionary);
    const lines = [
      ...removeProjectConfirmLines({ name: "E2", paths: ["/tmp/a/E2"], threadCount: 3 }),
      ...removeProjectConfirmLines({ name: "jamin", paths: [], threadCount: 1 }),
      ...removeProjectConfirmLines({ name: "loop", paths: [], threadCount: 0 }),
    ];
    expect(lines.map((line) => translator.lookup(line))).toEqual([
      '"E2" 프로젝트를 제거하고 스레드 3개를 삭제할까요?',
      "경로: /tmp/a/E2",
      "그 스레드와 아카이브된 스레드의 대화 기록이 영구히 지워집니다.",
      "프로젝트 항목만 제거하고 디스크의 파일은 그대로 둡니다.",
      "이 작업은 되돌릴 수 없습니다.",
      '"jamin" 프로젝트를 제거하고 스레드 1개를 삭제할까요?',
      "그 스레드와 아카이브된 스레드의 대화 기록이 영구히 지워집니다.",
      "프로젝트 항목만 제거하고 디스크의 파일은 그대로 둡니다.",
      "이 작업은 되돌릴 수 없습니다.",
      '"loop" 프로젝트를 제거할까요?',
      "아카이브된 대화 기록도 영구히 지워집니다.",
      "프로젝트 항목만 제거하고 디스크의 파일은 그대로 둡니다.",
      "이 작업은 되돌릴 수 없습니다.",
    ]);
  });
});
