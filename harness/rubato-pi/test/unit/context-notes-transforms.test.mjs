import test from "node:test";
import assert from "node:assert/strict";
import { applyContextNotesTransforms as apply, contextNotesTarget } from "../../src/transforms/core-context-notes.mjs";
import { initialWindow, encodeBootstrap } from "../../src/context-notes/protocol.mjs";

const base="file:///repo/node_modules/@code-yeongyu/senpi/dist/core/";
const sources={
  settings:['settings-manager.js',`export class SettingsManager { getCompactionSettings() { return {enabled:true,idleCompactionEnabled:true}; } }`],
  messages:['messages.js',`export function createCompactionSummaryMessage(summary, tokensBefore, timestamp, details) { return {role:"compactionSummary",summary,tokensBefore,timestamp,details}; }`],
  session:['agent-session.js',`export class AgentSession { async _executeCompaction(request) { const compactionEntryId = this.sessionManager.appendCompaction(); return compactionEntryId; } async _enforceFinalProviderAdmission(messages) { return messages; } }`],
  lane:['extensions/builtin/compaction/lane-policy.js',`export function laneRejectionReason(model) { return "legacy"; } export function laneAllowsManualCompaction(model, reason) { return true; } export function lane() {return {disablesSenpiCompaction(context) { return false; } };}`],
  pipeline:['extensions/builtin/compaction/context-pipeline.js',`function stripCursorThinking(m) {return m;} function repairOrphanedToolResults(m) {return m;} function convertToLlm(m) {return m;} export function buildCompactionContext(input) { throw new Error("PRUNE"); }`],
};
const load=async(src)=>import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}#${Math.random()}`);

test("critical source transforms are idempotent and drift is fatal",()=>{
  for(const [part,[path,source]] of Object.entries(sources)) {
    const result=apply(base+path,source,{enabled:true});
    assert.ok(result.includes(`rubato-history-notes-transform-v2:${part}`));
    assert.equal(apply(base+path,result,{enabled:true}),result);
    assert.throws(()=>apply(base+path,"unrecognized engine",{enabled:true}));
  }
  assert.equal(apply("file:///other.js","keep"),"keep");
});
test("normal summary runs bypass critical patches but retain the saved-window mode check",()=>{
  const [path,source]=sources.settings; assert.equal(apply(base+path,source,{enabled:false}),source);
  assert.ok(apply(base+"messages.js",sources.messages[1],{enabled:false}).includes("notesAwareSummaryMessage"));
});
test("transformed executable settings disable all builtin summary variants",async()=>{
  const old=process.env.RUBATO_CONTEXT_MODE; process.env.RUBATO_CONTEXT_MODE="history-notes";
  try {
    const module=await load(apply(base+sources.settings[0],sources.settings[1],{enabled:true}));
    assert.deepEqual(new module.SettingsManager().getCompactionSettings(),{enabled:false,idleCompactionEnabled:false,speculativeEnabled:false,restorationEnabled:false});
    process.env.RUBATO_CONTEXT_MODE="summary";
    assert.equal(new module.SettingsManager().getCompactionSettings().enabled,true);
  }finally{if(old===undefined)delete process.env.RUBATO_CONTEXT_MODE;else process.env.RUBATO_CONTEXT_MODE=old;}
});
test("transformed executable messages send metadata in new mode and reject wrong-mode resume",async()=>{
  const old=process.env.RUBATO_CONTEXT_MODE;process.env.RUBATO_CONTEXT_MODE="history-notes";
  try {
    const module=await load(apply(base+sources.messages[0],sources.messages[1],{enabled:true}));
    const encoded=encodeBootstrap(initialWindow());
    const msg=module.createCompactionSummaryMessage(encoded,123,"2026-01-01",{});
    assert.equal(msg.role,"user"); assert.equal(msg.summary,undefined);
    process.env.RUBATO_CONTEXT_MODE="summary";
    assert.throws(()=>module.createCompactionSummaryMessage(encoded,123,"2026-01-01",{}),/새 세션/);
    assert.equal(module.createCompactionSummaryMessage("legacy",123,"2026-01-01",{}).role,"compactionSummary");
  }finally{if(old===undefined)delete process.env.RUBATO_CONTEXT_MODE;else process.env.RUBATO_CONTEXT_MODE=old;}
});
test("transformed executable session refuses both missing companion and normal summaries",async()=>{
  const old=process.env.RUBATO_CONTEXT_MODE;process.env.RUBATO_CONTEXT_MODE="history-notes";
  try {
    const module=await load(apply(base+sources.session[0],sources.session[1],{enabled:true}));
    const session=new module.AgentSession();session.sessionManager={getSessionId:()=>"missing-session"};
    await assert.rejects(session._enforceFinalProviderAdmission([]),/준비되지/);
    await assert.rejects(session._executeCompaction({}),/요약 압축/);
  }finally{if(old===undefined)delete process.env.RUBATO_CONTEXT_MODE;else process.env.RUBATO_CONTEXT_MODE=old;}
});
test("Anthropic server support predicate is disabled only in new mode",async()=>{
  const old=process.env.RUBATO_CONTEXT_MODE;process.env.RUBATO_CONTEXT_MODE="history-notes";
  try {
    const url="file:///repo/harness/rubato-pi/src/anthropic-server-compaction.mjs";
    assert.equal(contextNotesTarget(url),"anthropic");
    const module=await load(apply(url,'export function supportsAnthropicServerCompaction(model) {return true;}',{enabled:true}));
    assert.equal(module.supportsAnthropicServerCompaction({}),false);
    process.env.RUBATO_CONTEXT_MODE="summary"; assert.equal(module.supportsAnthropicServerCompaction({}),true);
  }finally{if(old===undefined)delete process.env.RUBATO_CONTEXT_MODE;else process.env.RUBATO_CONTEXT_MODE=old;}
});

test("transformed session checks again after async work immediately before disk commit", async (t) => {
  const old = process.env.RUBATO_CONTEXT_MODE; process.env.RUBATO_CONTEXT_MODE = "history-notes";
  const { fakeSession } = await import("../helpers/context-notes-fake.mjs");
  const { ContextNotesController } = await import("../../src/context-notes/controller.mjs");
  const f = fakeSession(t); f.addMessage("user", "initial scope");
  const c = new ContextNotesController(f.pi, f.ctx, { requireEngine: false });
  const source = `export class AgentSession {
    async _executeCompaction(request) {
      await this.beforeCommit();
      const compactionEntryId = this.sessionManager.appendCompaction(request.precomputed.summary,
        request.precomputed.firstKeptEntryId, request.precomputed.tokensBefore, request.precomputed.details);
      return compactionEntryId;
    }
    async _enforceFinalProviderAdmission(messages) { return messages; }
  }`;
  try {
    const module = await load(apply(base + "agent-session.js", source, { enabled: true }));
    const session = new module.AgentSession(); session.sessionManager = f.manager;
    session.beforeCommit = async () => { await Promise.resolve(); f.addMessage("user", "changed scope"); };
    f.ctx.applyCompaction = async precomputed => { await session._executeCompaction({ precomputed }); return { applied: true }; };
    c.writeNote({ path: "active.md", text: "initial checkpoint" }, f.ctx);
    await assert.rejects(c.roll(f.ctx));
    assert.equal(f.entries.filter(e => e.type === "compaction").length, 0);
    assert.equal(c.lastUser, f.entries.findLast(e => e.message?.role === "user").id);
  } finally {
    c.close(); if (old === undefined) delete process.env.RUBATO_CONTEXT_MODE; else process.env.RUBATO_CONTEXT_MODE = old;
  }
});
