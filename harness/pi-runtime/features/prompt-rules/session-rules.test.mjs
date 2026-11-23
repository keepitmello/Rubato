import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRolePromptExtension, USER_RULES_ENTRY_TYPE } from "./role-prompt.mjs";
import { createStockChildRolePromptExtension } from "../child-runtime/role-prompt-extension.mjs";

test("lead, teammate and child pin confirmed descriptions, including the absence of any choice", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rubato-role-rules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, RUBATO_MEMORY_HOME: root,
    RUBATO_ROLE_PROMPT_MODULE: new URL("../../../rubato-pi/src/system-prompt.mjs", import.meta.url).href,
    RUBATO_ROLE_CONTRACT_MODULE: new URL("../../../rubato-pi/src/role-contract.mjs", import.meta.url).href };
  const cli = fileURLToPath(new URL("../../../../packages/rubato-runtime/src/user-memory/cli.ts", import.meta.url));
  const repo = join(root, "agents/user.shared/repo");
  mkdirSync(join(repo, "preferences"), { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=r", "-c", "user.email=r@r", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  const path = "preferences/testing.md", line = "Show test results to explain which checks passed.";
  writeFileSync(join(repo, path), `---\ndescription: ${line}\n---\n## Evidence\n- HIDDEN_EVIDENCE`);
  writeFileSync(join(repo, "preferences/other.md"), "---\ndescription: UNCHOSEN_RULE\n---\n");
  git("add", "-A"); git("commit", "-qm", "rules");
  const choose = (action) => execFileSync("bun", [cli, "rule", action, path, git("rev-parse", `HEAD:${path}`)], { env });
  const boot = async (role, entries, reason = "startup") => {
    const handlers = {}, ctx = { cwd: root, sessionManager: { getBranch: () => entries, getSessionId: () => "id" } };
    await (role === "lead" ? createRolePromptExtension : createStockChildRolePromptExtension)({ env: { ...env, RUBATO_PI_ROLE: role } })({
      on(name, fn) { handlers[name] = fn; },
      appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    });
    await handlers.session_start({ reason }, ctx);
    return async () => (await handlers.system_prompt({ systemPrompt: "BASE" }, ctx)).systemPrompt;
  };
  for (const role of ["lead", "owner", "agent"]) {
    const none = [], blank = await boot(role, none);
    choose("load"); // changed even before this session's first turn
    const empty = await blank();
    assert.ok(!empty.includes(line));
    assert.ok(none.some((entry) => entry.customType === USER_RULES_ENTRY_TYPE && entry.data.value === ""));
    assert.equal(await (await boot(role, none, "resume"))(), empty);
    const selected = [], fresh = await boot(role, selected), first = await fresh();
    assert.ok(first.includes(line)); assert.doesNotMatch(first, /UNCHOSEN_RULE|HIDDEN_EVIDENCE/);
    choose("remove");
    assert.equal(await fresh(), first);
    assert.equal(await (await boot(role, selected, "resume"))(), first);
    assert.equal(await (await boot(role, selected, "reload"))(), first);
    assert.ok(!(await (await boot(role, []))()).includes(line));
  }
  choose("load");
  const legacy = await boot("lead", [{ type: "message", message: { role: "assistant" } }], "resume");
  assert.ok(!(await legacy()).includes(line));
});
