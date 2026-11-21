import { describe, expect, it } from "vite-plus/test";
import { markdownForNativeParsing } from "./markdownDocument";
import { markdownWithLiteralSingleTildes } from "./rubatoSingleTilde";

describe("markdownWithLiteralSingleTildes", () => {
  it("keeps a range written with ~ a tilde", () => {
    expect(markdownWithLiteralSingleTildes("0.9~2.3분이었어. 그 사이 5~11턴을 썼어.")).toBe(
      "0.9\\~2.3분이었어. 그 사이 5\\~11턴을 썼어.",
    );
    expect(markdownWithLiteralSingleTildes("약 ~3분, (~5분) 걸려")).toBe("약 \\~3분, (\\~5분) 걸려");
  });

  it("leaves ~~double~~, code, fences and URLs alone", () => {
    const markdown = [
      "~~struck~~ and `a~b` in code",
      "",
      "```sh",
      "cd ~/x",
      "```",
      "",
      "~~~",
      "fenced ~ here",
      "~~~",
      "",
      "see https://host/~user and <https://host/~me> or [home](https://host/~you)",
      "already \\~escaped",
    ].join("\n");
    expect(markdownWithLiteralSingleTildes(markdown)).toBe(markdown);
  });

  it("runs in the phone's native parsing path", () => {
    expect(markdownForNativeParsing("1~2")).toBe("1\\~2");
  });

  it("escapes tildes in table cells and list items", () => {
    expect(markdownWithLiteralSingleTildes("| a | b |\n|---|---|\n| 1~2 | ~/x |\n\n- 3~4")).toBe(
      "| a | b |\n|---|---|\n| 1\\~2 | \\~/x |\n\n- 3\\~4",
    );
  });
});
