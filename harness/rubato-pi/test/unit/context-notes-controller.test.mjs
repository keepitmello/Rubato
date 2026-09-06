import test from "node:test";
import assert from "node:assert/strict";
import { ContextNotesController } from "../../src/context-notes/controller.mjs";
import { contextNotesConfig } from "../../src/context-notes/config.mjs";
import { NOTE_ENTRY, SOURCE, messageText } from "../../src/context-notes/protocol.mjs";
import { fakeSession } from "../helpers/context-notes-fake.mjs";

function setup(t) {
  const f=fakeSession(t); f.addMessage("user", "Fix the cache. Preserve the public API.");
  const c=new ContextNotesController(f.pi,f.ctx,{ requireEngine:false,
    config:contextNotesConfig({ RUBATO_CONTEXT_WINDOW_TOKENS:"12000" }) });
  t.after(()=>c.close());
  return {...f,c};
}
const save=(f,text="Goal: fix cache. Next: run tests. Original requirement in history.")=>f.c.writeNote({path:"work.md",text},f.ctx,{operationId:"save1"});

test("new_context schedules at tool boundary; new active input has only hints", async(t)=>{
  const f=setup(t); const old=f.c.window.windowId;
  const original=f.c.store.branch.find(e=>e.type==="message");
  const raw=JSON.stringify(original); save(f,"PRIVATE CHECKPOINT BODY");
  f.c.requestWindow(f.ctx);
  assert.equal(f.c.window.windowId,old);
  f.addMessage("toolResult","result from the last tool in the group",{toolName:"new_context",toolCallId:"n1"});
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,1); assert.notEqual(f.c.window.windowId,old);
  const active=f.build().messages;
  assert.equal(active.length,1); assert.equal(active[0].role,"user");
  const text=messageText(active[0]); assert.ok(text.includes("work.md"));
  assert.ok(!text.includes("PRIVATE CHECKPOINT BODY")); assert.ok(!text.includes("Fix the cache"));
  assert.equal(JSON.stringify(f.entries.find(e=>e.id===original.id)),raw);
  assert.ok(f.c.store.readItem({window_id:old,item_id:original.id}).content.includes("Fix the cache"));
  assert.equal(f.c.store.listItems({query:"last tool"},true).items.length,1);
  assert.equal(f.c.store.noteText("work.md"),"PRIVATE CHECKPOINT BODY");
  assert.equal(f.c.store.diagnostics().filter(e=>e.event==="transition_committed").length,1);
});
test("window reset requires a checkpoint and cannot silently use a summary", async(t)=>{
  const f=setup(t); const old=f.c.window.windowId;
  assert.throws(()=>f.c.requestWindow(f.ctx),/노트/);
  await assert.rejects(f.c.roll(f.ctx),/노트/);
  assert.equal(f.c.window.windowId,old); assert.equal(f.entries.filter(e=>e.type==="compaction").length,0);
});
test("new user request after checkpoint vetoes a queued transition", async(t)=>{
  const f=setup(t); save(f); f.c.requestWindow(f.ctx); const old=f.c.window.windowId;
  f.addMessage("user","Also preserve browser login");
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.windowId,old); assert.ok(f.abort.signal.aborted); assert.ok(f.c.paused);
});
test("user input racing with prepare is not discarded", async(t)=>{
  const f=setup(t); save(f); const append=f.pi.appendEntry;
  f.pi.appendEntry=(type,data)=>{append(type,data); if(type.includes("prepare")) f.addMessage("user","RACING INPUT");};
  await assert.rejects(f.c.roll(f.ctx),/바뀌/);
  assert.ok(f.build().messages.some(m=>messageText(m).includes("RACING INPUT")));
  assert.equal(f.c.window.number,0);
});
test("engine rejects stale apply without advancing window", async(t)=>{
  const f=setup(t); save(f); const old=f.c.window.windowId;
  f.ctx.applyCompaction=async()=>({applied:false,reason:"stale"});
  await assert.rejects(f.c.roll(f.ctx),/stale/);
  assert.equal(f.c.window.windowId,old); assert.ok(f.c.store.noteText("work.md"));
  assert.ok(f.build().messages.some(m=>messageText(m).includes("Fix the cache")));
});
test("post-commit hook rejection does not cause duplicate reset", async(t)=>{
  const f=setup(t); save(f); const apply=f.ctx.applyCompaction;
  f.ctx.applyCompaction=async(...args)=>{await apply(...args);return {applied:false,reason:"post-hook"};};
  await assert.rejects(f.c.roll(f.ctx),/후처리/);
  assert.ok(f.c.fatal); assert.throws(()=>f.c.admit([]),/후처리/);
  await assert.rejects(f.c.roll(f.ctx),/후처리/);
  assert.equal(f.c.window.number,1); assert.equal(f.entries.filter(e=>e.type==="compaction").length,1);
});
test("cancellation between tool request and boundary preserves current window", async(t)=>{
  const f=setup(t); save(f); f.c.requestWindow(f.ctx);
  const cancel=new AbortController(); cancel.abort(); f.ctx.signal=cancel.signal;
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,0); assert.equal(f.c.pending,null);
});
test("cancelled write/transition never reports success", async(t)=>{
  const f=setup(t); const signal=AbortSignal.abort();
  assert.throws(()=>f.c.writeNote({path:"a",text:"b"},f.ctx,{signal}));
  save(f); f.ctx.signal=signal;
  await assert.rejects(f.c.roll(f.ctx)); assert.equal(f.c.window.number,0);
});
test("oversized live context stops explicitly, without deletion or summary", async(t)=>{
  const f=setup(t); const large="a".repeat(40000); f.addMessage("toolResult",large,{toolName:"read"});
  f.c.refresh(f.ctx); assert.throws(()=>f.c.admit(f.build().messages),/한도/);
  await f.c.turnEnd({},f.ctx); assert.equal(f.c.window.number,0);
  assert.equal(f.c.store.listItems({role:"tool"}).items[0].total_chars,large.length);
});
test("budget limit requests one checkpoint turn and rolls after the note is saved", async(t)=>{
  const f=setup(t); f.addMessage("toolResult","a".repeat(40000),{toolName:"read"});
  f.c.refresh(f.ctx); await f.c.turnEnd({},f.ctx);
  assert.equal(f.sent.length,1); assert.equal(f.c.paused,null);
  assert.doesNotThrow(()=>f.c.admit(f.build().messages));
  save(f); await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.c.pending,null);
});
test("manual new-context can recover after the budget gate stopped a user request", async(t)=>{
  const f=setup(t); f.addMessage("toolResult","a".repeat(40000),{toolName:"read"});
  f.c.refresh(f.ctx); assert.throws(()=>f.c.admit(f.build().messages),/한도/);
  assert.equal((await f.c.manual(f.ctx)).requested,true);
  assert.equal(f.sent.length,1);
  assert.doesNotThrow(()=>f.c.admit(f.build().messages));
});
test("near-limit request includes warning and stable, readable source IDs", (t)=>{
  const f=setup(t); f.addMessage("toolResult","a".repeat(19000),{toolName:"read",toolCallId:"r1"});
  const input=f.build().messages; const snapshot=JSON.stringify(input);
  const {messages}=f.c.prepareContext({messages:input},f.ctx);
  assert.equal(JSON.stringify(input),snapshot);
  assert.ok(messages.some(m=>messageText(m).includes("context_window_reminder")));
  assert.ok(messages.some(m=>messageText(m).includes("[history: window_id=")));
  assert.equal(messageText(messages[0]),f.c.bootstrap);
});
test("large notes enforce UTF-8 byte limit and append is exact", (t)=>{
  const f=setup(t);
  assert.throws(()=>save(f,"가".repeat(333334)),/1,000,000/);
  save(f,"A");
  const first=f.c.writeNote({path:"work.md",text:"B"},f.ctx,{append:true,operationId:"append1"});
  const repeated=f.c.writeNote({path:"work.md",text:"B"},f.ctx,{append:true,operationId:"append1"});
  assert.equal(f.c.store.noteText("work.md"),"AB"); assert.equal(first.revision_id,repeated.revision_id);
});
test("failed journal flush refuses success and prevents a reset", async(t)=>{
  const f=setup(t); f.c.flushJournal=()=>{throw new Error("disk failure");};
  assert.throws(()=>save(f),/disk failure/);
  await assert.rejects(f.c.roll(f.ctx),/disk failure/); assert.equal(f.c.window.number,0);
});
test("resume recovers window and checkpoint from persisted journal", async(t)=>{
  const f=setup(t); save(f); await f.c.roll(f.ctx); const id=f.c.window.windowId; f.c.close();
  const next=new ContextNotesController(f.pi,f.ctx,{requireEngine:false});
  try { assert.equal(next.window.windowId,id); assert.ok(next.store.noteText("work.md")); }
  finally { next.close(); }
});
test("manual command uses the same model via a queued checkpoint request", async(t)=>{
  const f=setup(t); const outcome=await f.c.manual(f.ctx);
  assert.equal(outcome.requested,true); assert.equal(f.sent.length,1);
  assert.equal(f.sent[0][1].triggerTurn,true); assert.equal(f.sent[0][1].deliverAs,"steer");
  assert.equal(f.c.window.number,0);
});
test("manual checkpoint turn rolls after saving a note even below the budget", async(t)=>{
  const f=setup(t); await f.c.manual(f.ctx); save(f); await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.c.checkpointRequested,false);
});
test("checkpoint permission closes if its dedicated turn does not save a note", async(t)=>{
  const f=setup(t); await f.c.manual(f.ctx);
  f.addMessage("assistant","continued without checkpoint");
  await f.c.turnEnd({},f.ctx);
  assert.match(f.c.paused,/작업 노트를 저장하지 않았/);
  assert.equal(f.c.checkpointRequested,false); assert.equal(f.c.window.number,0);
});
test("checkpoint turn never consumes the provider safety reserve", async(t)=>{
  const f=setup(t); f.addMessage("toolResult","a".repeat(90000),{toolName:"read"});
  f.c.refresh(f.ctx);
  await assert.rejects(f.c.manual(f.ctx),/안전하게 실행할 여유/);
  assert.equal(f.sent.length,0); assert.equal(f.c.checkpointRequested,false);
});
test("reasoning payloads do not inflate the experiment budget", (t)=>{
  const f=setup(t);
  f.addMessage("assistant",[{type:"reasoning",encrypted:"x".repeat(80000)}]);
  f.c.refresh(f.ctx);
  assert.doesNotThrow(()=>f.c.admit(f.build().messages));
});
test("engine sample wins over a larger byte estimate for the experiment gate", (t)=>{
  const f=setup(t); f.addMessage("toolResult","a".repeat(40000),{toolName:"read"});
  f.ctx.getContextUsage=()=>({tokens:1000});
  f.c.refresh(f.ctx); f.c.hasSample=true;
  assert.doesNotThrow(()=>f.c.admit(f.build().messages));
  assert.equal(f.c.usage(f.build().messages).tokens,1000);
});
test("admit over the experiment budget starts a checkpoint turn instead of dead-ending", (t)=>{
  const f=setup(t); f.addMessage("toolResult","a".repeat(40000),{toolName:"read"});
  f.c.refresh(f.ctx);
  assert.throws(()=>f.c.admit(f.build().messages),/체크포인트/);
  assert.equal(f.c.checkpointRequested,true); assert.equal(f.sent.length,1);
  assert.doesNotThrow(()=>f.c.admit(f.build().messages));
});
test("turn end remains idle while no model context window is available", async(t)=>{
  const f=setup(t); f.ctx.model={}; f.c.refresh(f.ctx);
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.paused,null); assert.equal(f.sent.length,0);
});
test("SDK-owned remote conversation is refused for a notes experiment", (t)=>{
  const f=setup(t); f.ctx.model={...f.ctx.model,provider:"claude-sdk-oauth"}; f.c.refresh(f.ctx);
  assert.throws(()=>f.c.admit(),/외부 실행기/);
});

test("engine mirror trimming cannot hide prior original history or rewrite IDs",async(t)=>{
  const f=setup(t);save(f);const old=f.c.window.windowId;
  const user=f.entries.find(e=>e.type==="message");
  const originalApply=f.ctx.applyCompaction;
  f.ctx.applyCompaction=async(...args)=>{
    const result=await originalApply(...args);
    // Simulate the documented Senpi mirror optimization: getBranch returns a
    // rewired subset, while getEntries retains the original persisted graph.
    f.manager.getBranch=()=>f.branch().filter(e=>e.type!=="message").map((e,i,a)=>({...e,parentId:i?a[i-1].id:null}));
    return result;
  };
  await f.c.roll(f.ctx);
  assert.equal(f.c.store.readItem({window_id:old,item_id:user.id}).content,"Fix the cache. Preserve the public API.");
  assert.equal(f.c.lastUser,user.id);
  assert.equal(f.c.window.number,1);
});
