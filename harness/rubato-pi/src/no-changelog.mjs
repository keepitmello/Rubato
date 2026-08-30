export function noChangelogRegisterHref() {
  return new URL("./no-changelog-register.mjs", import.meta.url).href;
}

// 부모가 물려준 NODE_OPTIONS 에 다른 체크아웃의 등록이 들어 있을 수 있다.
// rubato 안에서 rubato 를 띄우면 늘 그렇고, 그 경로가 옮겨졌거나 지워졌으면
// 자식 node 가 ERR_MODULE_NOT_FOUND 로 죽는다 — 하네스를 다른 레포로 옮겼을 때
// 실제로 겪었다. 그래서 "이미 있으면 둔다"가 아니라 남의 등록을 걷어내고
// 이 체크아웃 것으로 갈아끼운다.
export function withNoChangelog(env) {
  const href = noChangelogRegisterHref();
  const flag = `--import=${href}`;
  const prev = env.NODE_OPTIONS ?? "";
  const kept = prev
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.includes("no-changelog-register"))
    .join(" ");
  if (prev.includes(href)) return { ...env, NODE_OPTIONS: prev };
  return { ...env, NODE_OPTIONS: kept ? `${kept} ${flag}` : flag };
}

export function stripChangelog(source, url = "") {
  let next = source;
  if (url.includes("slash-commands.js") || url === "") {
    next = next.replace(
      '\n    { name: "changelog", description: "Show changelog entries" },',
      "",
    );
  }
  if (url.includes("interactive-mode.js") || url === "") {
    next = next.replace(
      `\n            if (text === "/changelog") {\n                this.handleChangelogCommand();\n                this.editor.setText("");\n                return;\n            }`,
      "",
    );
    next = next.replace("getChangelogForDisplay() {", "getChangelogForDisplay() { return undefined;");
    next = next.replace("handleChangelogCommand() {", "handleChangelogCommand() { return;");
  }
  if (url.includes("settings-selector.js") || url === "") {
    next = next.replace(
      `\n            {\n                id: "collapse-changelog",\n                label: "Collapse changelog",\n                description: "Show condensed changelog after updates",\n                currentValue: config.collapseChangelog ? "true" : "false",\n                values: ["true", "false"],\n            },`,
      "",
    );
    next = next.replace(
      `\n                case "collapse-changelog":\n                    callbacks.onCollapseChangelogChange(newValue === "true");\n                    break;`,
      "",
    );
  }
  return next;
}
