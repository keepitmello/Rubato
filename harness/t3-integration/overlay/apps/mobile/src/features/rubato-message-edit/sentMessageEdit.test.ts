import { Atom } from "effect/reactivity";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface Projection {
  readonly messages: Array<{ id: string; runId: string | null }>;
  readonly runs: Array<{ id: string; status: string }>;
}

interface MockDraft {
  text: string;
  attachments: Array<{ id: string; type: string; name: string; mimeType: string; sizeBytes: number; fileUri?: string }>;
}

// The Mac, the thread store and the drafts are stand-ins: the edit's own rules are under test.
const calls = vi.hoisted(() => ({
  posts: [] as Array<[string, string, Record<string, unknown>]>,
  reverts: [] as unknown[],
  importing: [] as Array<[string, boolean]>,
  errors: [] as Array<[string, string]>,
  cleaned: [] as Array<readonly unknown[]>,
  appendModes: [] as Array<{ restore?: boolean; appendReference?: boolean }>,
  restore: vi.fn(
    async (_env: unknown, _att: unknown, _signal: AbortSignal): Promise<{
      attachments: MockDraft["attachments"];
      failedCount: number;
    }> => ({ attachments: [], failedCount: 0 }),
  ),
}));
const messagesAtom = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../companions/rubatoHttp", () => ({
  postRubato: vi.fn(async (_environmentId: string, route: string, action: string, body: Record<string, unknown>) => {
    calls.posts.push([route, action, body]);
    if (route === "/rubato/message-rewind") return { turnCount: 2, checkpointId: "cp-2", scopeId: "scope" };
    if (route === "/rubato/companion-room") rollBackFrom(body.messageId as string);
    return {};
  }),
}));
vi.mock("./restoreAttachments", () => ({
  restoreMessageAttachments: (...args: unknown[]) => (calls.restore as (...a: unknown[]) => unknown)(...args),
}));
vi.mock("../../lib/composerAttachmentPreviewRetention", () => ({
  retainComposerAttachmentFileForPreview: () => () => {},
}));
vi.mock("../../lib/composerImages", () => ({
  isFileBackedComposerAttachment: (attachment: { fileUri?: string }) => typeof attachment.fileUri === "string",
}));
vi.mock("../../state/thread-composer-error", () => ({
  setThreadComposerError: (key: string, message: string) => calls.errors.push([key, message]),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: vi.fn(async (_registry: unknown, _command: unknown, value: { input: { turnCount: number } }) => {
    calls.reverts.push(value.input);
    setTimeout(() => rollBackFrom("m2"), 5);
    return { _tag: "Success", value: undefined };
  }),
}));
vi.mock("../../state/threads", () => {
  const atom = Atom.make<{ projection: Projection } | null>(null).pipe(Atom.keepAlive);
  messagesAtom.current = atom;
  return { environmentThreadDetails: { threadAtom: () => atom }, threadEnvironment: { revertCheckpoint: {} } };
});
const drafts = vi.hoisted(() => new Map<string, MockDraft>());
const draftOf = (key: string): MockDraft => {
  let entry = drafts.get(key);
  if (!entry) {
    entry = { text: "", attachments: [] };
    drafts.set(key, entry);
  }
  return entry;
};
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: (key: string) => {
    const entry = draftOf(key);
    return { text: entry.text, attachments: [...entry.attachments] };
  },
  setComposerDraftText: (key: string, text: string) => {
    draftOf(key).text = text;
  },
  replaceComposerDraftAttachments: (key: string, attachments: MockDraft["attachments"]) => {
    draftOf(key).attachments = [...attachments];
  },
  appendComposerDraftAttachments: (
    key: string,
    attachments: MockDraft["attachments"],
    options?: { restore?: boolean; appendReference?: boolean },
  ) => {
    draftOf(key).attachments = [...draftOf(key).attachments, ...attachments];
    calls.appendModes.push(options ?? {});
    return 0;
  },
  setComposerContextImporting: (key: string, importing: boolean) => {
    calls.importing.push([key, importing]);
  },
  scheduleUnusedComposerAttachmentCleanup: (attachments: readonly unknown[]) => {
    calls.cleaned.push(attachments);
  },
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { beginSentMessageEdit, cancelSentMessageEdit, editableText, getSentMessageEdit, rewindBeforeSend } from "./sentMessageEdit";

type ThreadAtom = Atom.Writable<{ projection: Projection } | null>;
const thread = () => messagesAtom.current as ThreadAtom;
/** Each message opened a run of its own, named after it. */
function setMessages(ids: string[]) {
  appAtomRegistry.set(thread(), { projection: {
    messages: ids.map((id) => ({ id, runId: `run-${id}` })),
    runs: ids.map((id) => ({ id: `run-${id}`, status: "completed" })),
  } });
}
/**
 * What the Mac does on a rewind: the message and every later one stay in the records, their runs
 * rolled back (T3's revert and the companion room's alike).
 */
function rollBackFrom(id: string) {
  const projection = appAtomRegistry.get(thread())!.projection;
  const from = projection.messages.findIndex((message) => message.id === id);
  const gone = new Set(projection.messages.slice(from).map((message) => message.runId));
  appAtomRegistry.set(thread(), { projection: { ...projection,
    runs: projection.runs.map((run) => (gone.has(run.id) ? { ...run, status: "rolled_back" } : run)) } });
}
const liveMessages = () => {
  const projection = appAtomRegistry.get(thread())!.projection;
  return projection.messages.filter((message) => projection.runs.some((run) => run.id === message.runId && run.status !== "rolled_back"))
    .map((message) => message.id);
};
const KEY = "env:thread";
const target = { threadKey: KEY, environmentId: "env" as never, threadId: "thread" as never };

describe("editing a sent message", () => {
  beforeEach(() => {
    calls.posts.length = 0;
    calls.reverts.length = 0;
    calls.importing.length = 0;
    calls.errors.length = 0;
    calls.cleaned.length = 0;
    calls.appendModes.length = 0;
    calls.restore.mockReset();
    calls.restore.mockResolvedValue({ attachments: [], failedCount: 0 });
    drafts.clear();
    cancelSentMessageEdit(KEY);
    setMessages(["m1", "m2", "m3"]);
  });

  it("puts the message's words in the composer and gives the draft back on cancel", () => {
    const priorPhoto = { id: "prev-1", type: "image", name: "prev.png", mimeType: "image/png", sizeBytes: 10, fileUri: "file:///prev.png" };
    drafts.set(KEY, { text: "half-written", attachments: [priorPhoto] });
    beginSentMessageEdit(KEY, { id: "m2" as never, text: "see [notes.md](t3-context://v1/mention/c1) again" }, false);
    expect(draftOf(KEY).text).toBe("see notes.md again");
    expect(draftOf(KEY).attachments).toEqual([]);
    cancelSentMessageEdit(KEY);
    expect(draftOf(KEY).text).toBe("half-written");
    expect(draftOf(KEY).attachments).toEqual([priorPhoto]);
    expect(getSentMessageEdit(KEY)).toBe(null);
  });

  it("strips image/file context links and attachment-only placeholder text", () => {
    expect(editableText(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT)).toBe("");
    expect(editableText("![photo.jpg](t3-context://v1/image/c1) look here")).toBe("look here");
    expect(editableText("see [notes.md](t3-context://v1/mention/c1) and ![photo.jpg](t3-context://v1/image/c2)")).toBe(
      "see notes.md and",
    );
  });

  it("loads a photo turn's attachments into the composer and rewinds on send", async () => {
    const restoredPhoto = {
      id: "draft-photo-1",
      type: "image",
      name: "cat.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 42,
      fileUri: "file:///cat.jpg",
    };
    calls.restore.mockResolvedValueOnce({ attachments: [restoredPhoto], failedCount: 0 });

    beginSentMessageEdit(
      KEY,
      {
        id: "m3" as never,
        text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        attachments: [{ type: "image", id: "att-1", name: "cat.jpg", mimeType: "image/jpeg", sizeBytes: 42 } as never],
      },
      true,
      "env" as never,
    );
    expect(draftOf(KEY).text).toBe("");
    await vi.waitFor(() => expect(draftOf(KEY).attachments).toEqual([restoredPhoto]));
    expect(calls.appendModes).toEqual([{ restore: true }]);
    expect(calls.importing).toEqual([[KEY, true], [KEY, false]]);

    await rewindBeforeSend({ ...target, busy: false });
    expect(calls.posts).toEqual([["/rubato/companion-room", "rewind", { threadId: "thread", messageId: "m3" }]]);
    expect(liveMessages()).toEqual(["m1", "m2"]);
    expect(getSentMessageEdit(KEY)).toBe(null);
  });

  it("aborts in-flight attachment loading and restores the prior draft on cancel", async () => {
    let seenSignal: AbortSignal | undefined;
    let finish!: (value: { attachments: MockDraft["attachments"]; failedCount: number }) => void;
    calls.restore.mockImplementationOnce((_env: unknown, _att: unknown, signal: AbortSignal) => {
      seenSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });

    drafts.set(KEY, { text: "before", attachments: [] });
    beginSentMessageEdit(
      KEY,
      {
        id: "m2" as never,
        text: "",
        attachments: [{ type: "image", id: "att-1", name: "cat.jpg", mimeType: "image/jpeg", sizeBytes: 42 } as never],
      },
      false,
      "env" as never,
    );
    expect(calls.importing).toEqual([[KEY, true]]);

    cancelSentMessageEdit(KEY);
    expect(seenSignal?.aborted).toBe(true);
    expect(draftOf(KEY).text).toBe("before");
    expect(calls.importing).toEqual([[KEY, true], [KEY, false]]);

    finish({
      attachments: [{ id: "late", type: "image", name: "cat.jpg", mimeType: "image/jpeg", sizeBytes: 42 }],
      failedCount: 0,
    });
    await Promise.resolve();
    expect(draftOf(KEY).attachments).toEqual([]);
  });

  it("surfaces a non-blocking notice if an attachment fails to load and still allows rewinding", async () => {
    calls.restore.mockResolvedValueOnce({ attachments: [], failedCount: 1 });
    beginSentMessageEdit(
      KEY,
      {
        id: "m3" as never,
        text: "caption",
        attachments: [{ type: "image", id: "att-1", name: "gone.jpg", mimeType: "image/jpeg", sizeBytes: 42 } as never],
      },
      true,
      "env" as never,
    );
    await vi.waitFor(() => expect(calls.importing).toEqual([[KEY, true], [KEY, false]]));
    expect(calls.errors.length).toBe(1);

    await rewindBeforeSend({ ...target, busy: false });
    expect(calls.posts).toEqual([["/rubato/companion-room", "rewind", { threadId: "thread", messageId: "m3" }]]);
  });

  it("rewinds a thread to the checkpoint the Mac names, and sends only once the message is gone", async () => {
    beginSentMessageEdit(KEY, { id: "m2" as never, text: "first" }, false);
    await rewindBeforeSend({ ...target, busy: false });
    expect(calls.posts).toEqual([["/rubato/message-rewind", "target", { threadId: "thread", messageId: "m2" }]]);
    expect(calls.reverts).toMatchObject([{ checkpointId: "cp-2", scopeId: "scope", turnCount: 2, restoreFiles: false }]);
    expect(liveMessages()).toEqual(["m1"]);
    expect(getSentMessageEdit(KEY)).toBe(null);
  });

  it("rewinds a companion's room by the message itself", async () => {
    beginSentMessageEdit(KEY, { id: "m3" as never, text: "hi" }, true);
    await rewindBeforeSend({ ...target, busy: false });
    expect(calls.posts).toEqual([["/rubato/companion-room", "rewind", { threadId: "thread", messageId: "m3" }]]);
    expect(calls.reverts).toEqual([]);
    expect(liveMessages()).toEqual(["m1", "m2"]);
  });

  it("does not rewind a message the Mac already rolled back, and just sends", async () => {
    rollBackFrom("m3");
    beginSentMessageEdit(KEY, { id: "m3" as never, text: "again" }, true);
    await rewindBeforeSend({ ...target, busy: false });
    expect(calls.posts).toEqual([]);
    expect(getSentMessageEdit(KEY)).toBe(null);
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
