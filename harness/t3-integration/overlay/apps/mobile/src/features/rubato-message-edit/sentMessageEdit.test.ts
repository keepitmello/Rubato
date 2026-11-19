import { Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The Mac, the thread store and the drafts are stand-ins: the edit's own rules are under test.
const calls = vi.hoisted(() => ({ posts: [] as Array<[string, string, Record<string, unknown>]>, reverts: [] as unknown[] }));
const messagesAtom = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../companions/rubatoHttp", () => ({
  postRubato: vi.fn(async (_environmentId: string, route: string, action: string, body: Record<string, unknown>) => {
    calls.posts.push([route, action, body]);
    if (route === "/rubato/message-rewind") return { turnCount: 2, checkpointId: "cp-2", scopeId: "scope" };
    if (route === "/rubato/companion-room") dropMessage(body.messageId as string);
    return {};
  }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: vi.fn(async (_registry: unknown, _command: unknown, value: { input: { turnCount: number } }) => {
    calls.reverts.push(value.input);
    setTimeout(() => dropMessage("m2"), 5);
    return { _tag: "Success", value: undefined };
  }),
}));
vi.mock("../../state/threads", () => {
  const atom = Atom.make<{ projection: { messages: Array<{ id: string }> } } | null>(null).pipe(Atom.keepAlive);
  messagesAtom.current = atom;
  return { environmentThreadDetails: { threadAtom: () => atom }, threadEnvironment: { revertCheckpoint: {} } };
});
const drafts = vi.hoisted(() => new Map<string, string>());
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: (key: string) => ({ text: drafts.get(key) ?? "" }),
  setComposerDraftText: (key: string, text: string) => drafts.set(key, text),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { beginSentMessageEdit, cancelSentMessageEdit, getSentMessageEdit, rewindBeforeSend } from "./sentMessageEdit";

type ThreadAtom = Atom.Writable<{ projection: { messages: Array<{ id: string }> } } | null>;
const thread = () => messagesAtom.current as ThreadAtom;
function setMessages(ids: string[]) {
  appAtomRegistry.set(thread(), { projection: { messages: ids.map((id) => ({ id })) } });
}
function dropMessage(id: string) {
  const current = appAtomRegistry.get(thread());
  setMessages((current?.projection.messages ?? []).map((message) => message.id).filter((other) => other !== id));
}
const KEY = "env:thread";
const target = { threadKey: KEY, environmentId: "env" as never, threadId: "thread" as never };

describe("editing a sent message", () => {
  beforeEach(() => {
    calls.posts.length = 0;
    calls.reverts.length = 0;
    drafts.clear();
    cancelSentMessageEdit(KEY);
    setMessages(["m1", "m2", "m3"]);
  });

  it("puts the message's words in the composer and gives the draft back on cancel", () => {
    drafts.set(KEY, "half-written");
    beginSentMessageEdit(KEY, { id: "m2" as never, text: "see [notes.md](t3-context://v1/mention/c1) again" }, false);
    expect(drafts.get(KEY)).toBe("see notes.md again");
    cancelSentMessageEdit(KEY);
    expect(drafts.get(KEY)).toBe("half-written");
    expect(getSentMessageEdit(KEY)).toBe(null);
  });

  it("rewinds a thread to the checkpoint the Mac names, and sends only once the message is gone", async () => {
    beginSentMessageEdit(KEY, { id: "m2" as never, text: "first" }, false);
    await rewindBeforeSend({ ...target, busy: false });
    expect(calls.posts).toEqual([["/rubato/message-rewind", "target", { threadId: "thread", messageId: "m2" }]]);
    expect(calls.reverts).toMatchObject([{ checkpointId: "cp-2", scopeId: "scope", turnCount: 2, restoreFiles: false }]);
    expect(appAtomRegistry.get(thread())?.projection.messages.map((message) => message.id)).toEqual(["m1", "m3"]);
    expect(getSentMessageEdit(KEY)).toBe(null);
  });

  it("rewinds a companion's room by the message itself", async () => {
    beginSentMessageEdit(KEY, { id: "m3" as never, text: "hi" }, true);
    await rewindBeforeSend({ ...target, busy: false });
    expect(calls.posts).toEqual([["/rubato/companion-room", "rewind", { threadId: "thread", messageId: "m3" }]]);
    expect(calls.reverts).toEqual([]);
  });

  it("does not rewind while a turn runs, and keeps the edit to send again", async () => {
    beginSentMessageEdit(KEY, { id: "m2" as never, text: "first" }, true);
    await expect(rewindBeforeSend({ ...target, busy: true })).rejects.toThrow(/still working/);
    expect(calls.posts).toEqual([]);
    expect(getSentMessageEdit(KEY)?.messageId).toBe("m2");
  });

  it("sends as usual when nothing is being edited", async () => {
    await rewindBeforeSend({ ...target, busy: true });
    expect(calls.posts).toEqual([]);
  });
});
