import test from "node:test";
import assert from "node:assert/strict";
import { ContextNotesController } from "../../src/context-notes/controller.mjs";
import { contextNotesConfig } from "../../src/context-notes/config.mjs";
import { CHECKPOINT_NOTE, NOTE_ENTRY, SOURCE, decodeBootstrap, messageText } from "../../src/context-notes/protocol.mjs";
import { fakeSession } from "../helpers/context-notes-fake.mjs";

function setup(t) {
  const f=fakeSession(t); f.addMessage("user", "Fix the cache. Preserve the public API.");
  const c=new ContextNotesController(f.pi,f.ctx,{ requireEngine:false,
    config:contextNotesConfig({ RUBATO_CONTEXT_WINDOW_TOKENS:"12000" }) });
  t.after(()=>c.close());
  return {...f,c};
}
const save=(f,text="Goal: fix cache. Next: run tests. Original requirement in history.")=>f.c.writeNote({path:CHECKPOINT_NOTE,text},f.ctx,{operationId:"save1"});

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
  const text=messageText(active[0]); assert.ok(text.includes(CHECKPOINT_NOTE));
  assert.ok(!text.includes("PRIVATE CHECKPOINT BODY")); assert.ok(!text.includes("Fix the cache"));
  assert.equal(JSON.stringify(f.entries.find(e=>e.id===original.id)),raw);
  assert.ok(f.c.store.readItem({window_id:old,item_id:original.id}).content.includes("Fix the cache"));
  assert.equal(f.c.store.listItems({query:"last tool"},true).items.length,1);
  assert.equal(f.c.store.noteText(CHECKPOINT_NOTE),"PRIVATE CHECKPOINT BODY");
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
  assert.equal(f.c.window.windowId,old); assert.ok(f.c.store.noteText(CHECKPOINT_NOTE));
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
  f.c.refresh(f.ctx); assert.doesNotThrow(()=>f.c.admit(f.build().messages));
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
  f.c.refresh(f.ctx); assert.doesNotThrow(()=>f.c.admit(f.build().messages));
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
  assert.ok(messages.some(m=>messageText(m).includes(`[history: item_id=`)));
  assert.equal(messageText(messages[0]),f.c.bootstrap);
});
test("large notes enforce UTF-8 byte limit and append is exact", (t)=>{
  const f=setup(t);
  assert.throws(()=>save(f,"가".repeat(333334)),/1,000,000/);
  save(f,"A");
  const first=f.c.writeNote({path:CHECKPOINT_NOTE,text:"B"},f.ctx,{append:true,operationId:"append1"});
  const repeated=f.c.writeNote({path:CHECKPOINT_NOTE,text:"B"},f.ctx,{append:true,operationId:"append1"});
  assert.equal(f.c.store.noteText(CHECKPOINT_NOTE),"AB"); assert.equal(first.revision_id,repeated.revision_id);
});
test("failed journal flush refuses success and prevents a reset", async(t)=>{
  const f=setup(t); f.c.flushJournal=()=>{throw new Error("disk failure");};
  assert.throws(()=>save(f),/disk failure/);
  await assert.rejects(f.c.roll(f.ctx),/disk failure/); assert.equal(f.c.window.number,0);
});
test("resume recovers window and checkpoint from persisted journal", async(t)=>{
  const f=setup(t); save(f); await f.c.roll(f.ctx); const id=f.c.window.windowId; f.c.close();
  const next=new ContextNotesController(f.pi,f.ctx,{requireEngine:false});
  try { assert.equal(next.window.windowId,id); assert.ok(next.store.noteText(CHECKPOINT_NOTE)); }
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
test("an incomplete checkpoint gets one repair turn before stopping", async(t)=>{
  const f=setup(t); await f.c.manual(f.ctx);
  f.append({type:"custom_message",...f.sent.at(-1)[0]});
  f.addMessage("assistant","continued without checkpoint");
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.abort.signal.aborted,false);
  assert.equal(f.c.checkpointRequested,true); assert.equal(f.sent.length,2);
  f.append({type:"custom_message",...f.sent.at(-1)[0]});
  f.addMessage("assistant","still no checkpoint");
  await f.c.turnEnd({},f.ctx);
  assert.match(f.c.paused,new RegExp(`최신 ${CHECKPOINT_NOTE}가 완성되지 않았`));
  assert.equal(f.abort.signal.aborted,true); assert.equal(f.sent.length,2);
  assert.equal(f.c.checkpointRequested,false); assert.equal(f.c.window.number,0);
});
test("a queued checkpoint is not retried before its own delivery", async(t)=>{
  const f=setup(t); await f.c.manual(f.ctx);
  f.append({type:"custom_message",customType:"unrelated-notification",content:"Keep working"});
  f.addMessage("assistant","has not received the checkpoint yet");
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.sent.length,1);
  assert.equal(f.c.checkpointRetried,false);
  assert.equal(f.abort.signal.aborted,false);
});
test("checkpoint turn never consumes the provider safety reserve", async(t)=>{
  const f=setup(t); f.addMessage("toolResult","a".repeat(120000),{toolName:"read"});
  f.c.refresh(f.ctx);
  // No checkpoint turn fits and no note covers the request: the cut carries the request.
  await f.c.manual(f.ctx);
  assert.equal(f.sent.length,0); assert.equal(f.c.checkpointRequested,false);
  assert.equal(f.c.window.number,1);
  assert.match(decodeBootstrap(f.c.bootstrap).hint,/Fix the cache\. Preserve the public API\./);
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
  f.c.refresh(f.ctx);
  assert.doesNotThrow(()=>f.c.admit(f.build().messages));
  assert.equal(f.c.usage().tokens,1000);
});
test("physical safety line follows the engine meter, not a larger payload estimate", (t)=>{
  const f=setup(t); f.addMessage("toolResult","a".repeat(90000),{toolName:"read"});
  f.ctx.getContextUsage=()=>({tokens:8000});
  f.c.refresh(f.ctx);
  assert.doesNotThrow(()=>f.c.admit(f.build().messages));
});
test("admit over the experiment budget starts a checkpoint turn instead of dead-ending", async(t)=>{
  const f=setup(t); f.addMessage("toolResult","a".repeat(40000),{toolName:"read"});
  f.c.refresh(f.ctx);
  assert.doesNotThrow(()=>f.c.admit(f.build().messages));
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.checkpointRequested,true); assert.equal(f.sent.length,1);
  assert.doesNotThrow(()=>f.c.admit(f.build().messages));
});
test("95 percent hard line asks for a checkpoint turn before it would cut with a stale note", async(t)=>{
  const f=setup(t); save(f);
  f.addMessage("toolResult","more work after the note",{toolName:"read"});
  f.ctx.getContextUsage=()=>({tokens:31000}); // past 95% (30,400) of the 32K window, below the physical limit
  f.c.refresh(f.ctx);
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,0); assert.equal(f.c.checkpointRequested,true); assert.equal(f.sent.length,1);
  // The rollover-only turn is ignored twice: only then the harness cuts with the stale note.
  f.append({type:"custom_message",...f.sent.at(-1)[0]}); f.addMessage("assistant","kept working");
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,0); assert.equal(f.sent.length,2);
  f.append({type:"custom_message",...f.sent.at(-1)[0]}); f.addMessage("assistant","still working");
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,1);
  assert.equal(f.c.store.diagnostics().filter(e=>e.event==="hard_rollover_stale_note").length,1);
});
test("a fresh note past the 90% target rolls at the turn boundary without another turn", async(t)=>{
  const f=setup(t);
  f.addMessage("toolResult","a".repeat(40000),{toolName:"read"});
  save(f); f.c.refresh(f.ctx);
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.sent.length,0);
});
// 2026-10-12, Astra: the checkpoint turn saved its notes, then searched for new_context (it
// starts inactive). That search counted as new work, the repair turn no longer fit, and the
// session stopped with "체크포인트 턴을 안전하게 실행할 여유도 남지 않았어요".
test("a checkpoint turn that searches for new_context after saving still rolls", async(t)=>{
  const f=setup(t);
  f.ctx.getContextUsage=()=>({tokens:31000}); // past the 95% hard line of the 32K window
  f.c.refresh(f.ctx);
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.checkpointRequested,true); assert.equal(f.sent.length,1);
  f.append({type:"custom_message",...f.sent.at(-1)[0]});
  save(f);
  f.addMessage("assistant",[{type:"toolCall",id:"search1",name:"tool_search",arguments:{query:"new_context"}}]);
  f.addMessage("toolResult","Activated: new_context",{toolName:"tool_search",toolCallId:"search1"});
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.sent.length,1);
});
test("past the physical window a stale note cuts instead of dead-ending, since no repair turn fits", async(t)=>{
  const f=setup(t);
  f.ctx.getContextUsage=()=>({tokens:31000});
  f.c.refresh(f.ctx);
  await f.c.turnEnd({},f.ctx);
  f.append({type:"custom_message",...f.sent.at(-1)[0]});
  save(f);
  f.addMessage("toolResult","more work after the note",{toolName:"read"});
  f.ctx.getContextUsage=()=>({tokens:32500}); // over the whole window: a repair turn cannot run
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.abort.signal.aborted,false); assert.equal(f.c.paused,null);
  assert.equal(f.c.store.diagnostics().filter(e=>e.event==="hard_rollover_stale_note").length,1);
});
// 2026-10-12 14:45, Astra at 255k of a 272k window (past 90%, under 95%): the note was saved
// in an eval that also read a file, so it read as stale; the repair turns failed and the run
// was aborted instead of handing the window over.
test("past the target line a failed repair turn cuts with the latest note instead of aborting", async(t)=>{
  const f=setup(t);
  f.ctx.getContextUsage=()=>({tokens:29500}); // past 90% (28,800), under 95% (30,400) of 32K
  f.c.refresh(f.ctx);
  await f.c.turnEnd({},f.ctx);
  f.append({type:"custom_message",...f.sent.at(-1)[0]});
  save(f); f.addMessage("toolResult","read during the save",{toolName:"read"});
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,0); assert.equal(f.sent.length,2);
  f.append({type:"custom_message",...f.sent.at(-1)[0]});
  f.addMessage("toolResult","read again",{toolName:"read"});
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.abort.signal.aborted,false);
});
test("past the target line /new-context opens the next window from a stale note", async(t)=>{
  const f=setup(t);
  save(f); f.addMessage("toolResult","read during the save",{toolName:"read"});
  f.ctx.getContextUsage=()=>({tokens:29500});
  f.c.refresh(f.ctx);
  await f.c.manual(f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.sent.length,0);
});
test("a new request that overflows the window before any note covers it still reaches a new window", async(t)=>{
  const f=setup(t);
  save(f);
  f.addMessage("user","Now rewrite question two around the payment work.");
  f.addMessage("toolResult","x",{toolName:"read"});
  f.ctx.getContextUsage=()=>({tokens:32500}); // over the whole 32K window
  f.c.refresh(f.ctx);
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.sent.length,0); assert.equal(f.abort.signal.aborted,false);
  const hint=decodeBootstrap(f.c.bootstrap).hint;
  assert.match(hint,/Now rewrite question two around the payment work\./);
  assert.match(hint,/history_list_items role=user/);
  assert.ok(hint.includes(`"${CHECKPOINT_NOTE}"`),"the earlier note is still listed");
});
test("past the target line a repair turn that writes no note at all still cuts", async(t)=>{
  const f=setup(t);
  f.ctx.getContextUsage=()=>({tokens:29500});
  f.c.refresh(f.ctx);
  await f.c.turnEnd({},f.ctx);
  for (let i=0;i<2;i+=1) {
    f.append({type:"custom_message",...f.sent.at(-1)[0]});
    f.addMessage("assistant","kept working without a note");
    await f.c.turnEnd({},f.ctx);
  }
  assert.equal(f.c.window.number,1); assert.equal(f.abort.signal.aborted,false);
  assert.match(decodeBootstrap(f.c.bootstrap).hint,/Fix the cache/);
});
test("a long request is cut to fit the window opening", async(t)=>{
  const f=setup(t);
  f.addMessage("user","가".repeat(3000));
  f.ctx.getContextUsage=()=>({tokens:32500});
  f.c.refresh(f.ctx);
  await f.c.manual(f.ctx);
  const hint=decodeBootstrap(f.c.bootstrap).hint;
  assert.ok(Buffer.byteLength(hint)<=4000); assert.match(hint,/가…/);
});
// The provider gate refuses a request that no longer fits. It used to abort the run, and
// turn_end skips an aborted run, so the session sat there until someone typed /new-context.
test("a request refused over the window ends the run as an error, cuts and carries on by itself", async(t)=>{
  const f=setup(t);
  save(f);
  f.addMessage("user","Now rewrite question two around the payment work.");
  f.addMessage("toolResult","a huge read",{toolName:"read"});
  f.ctx.getContextUsage=()=>({tokens:32500});
  f.c.refresh(f.ctx);
  // What the provider gate does (registerSessionGate in the controller).
  try { f.c.admit(f.build().messages); assert.fail("must refuse"); } catch (error) { f.c.fail(error); }
  assert.equal(f.abort.signal.aborted,false,"the run ends as an error, not an abort");
  await f.c.turnEnd({message:{stopReason:"error"}},f.ctx);
  assert.equal(f.c.window.number,1);
  assert.match(decodeBootstrap(f.c.bootstrap).hint,/Now rewrite question two/);
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0][0].customType,"rubato-context-continue");
  assert.equal(f.sent[0][1].triggerTurn,true);
});
test("a pending checkpoint turn that no longer fits is cut and carried on the same way", async(t)=>{
  const f=setup(t);
  f.ctx.getContextUsage=()=>({tokens:31000});
  f.c.refresh(f.ctx);
  await f.c.turnEnd({},f.ctx);
  assert.equal(f.c.checkpointRequested,true);
  f.append({type:"custom_message",...f.sent.at(-1)[0]});
  f.addMessage("toolResult","a huge read",{toolName:"read"});
  f.ctx.getContextUsage=()=>({tokens:32500}); f.c.refresh(f.ctx);
  await f.c.turnEnd({message:{stopReason:"error"}},f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.c.checkpointRequested,false);
  assert.equal(f.sent.at(-1)[0].customType,"rubato-context-continue");
});
test("a session already stopped over the window reopens from its notes with /new-context", async(t)=>{
  const f=setup(t);
  save(f);
  f.addMessage("assistant",[{type:"toolCall",id:"search1",name:"tool_search",arguments:{query:"new_context"}}]);
  f.addMessage("toolResult","Activated: new_context",{toolName:"tool_search",toolCallId:"search1"});
  // The stopped request left an empty aborted turn behind; it did no work.
  f.addMessage("assistant",[],{stopReason:"aborted",errorMessage:"체크포인트 턴을 안전하게 실행할 여유도 남지 않았어요."});
  f.ctx.getContextUsage=()=>({tokens:32500});
  f.c.refresh(f.ctx);
  assert.throws(()=>f.c.admit(f.build().messages),/새 창으로 넘어간/);
  await f.c.manual(f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.sent.length,0);
});
test("over the window, /new-context opens the next window even from a note that work came after", async(t)=>{
  const f=setup(t);
  save(f);
  f.addMessage("toolResult","more work after the note",{toolName:"read"});
  f.ctx.getContextUsage=()=>({tokens:32500});
  f.c.refresh(f.ctx);
  await f.c.manual(f.ctx);
  assert.equal(f.c.window.number,1); assert.equal(f.sent.length,0);
  assert.equal(f.c.store.diagnostics().filter(e=>e.event==="hard_rollover_stale_note").length,1);
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
test("a full disk stops turns only until space is back", (t)=>{
  const f=setup(t); const db=f.c.store.db;
  db.exec(`PRAGMA max_page_count=${db.prepare("PRAGMA page_count").get().page_count}`);
  const big=f.addMessage("user","x".repeat(200_000));
  assert.throws(()=>f.c.refresh(f.ctx),/database or disk is full/);
  assert.equal(f.c.fatal,null);
  assert.throws(()=>f.c.admit([]),/database or disk is full/);
  db.exec("PRAGMA max_page_count=1073741823");
  f.c.admit([]);
  assert.equal(f.c.storageFailure,null);
  assert.ok(f.c.store.listItems({ role:"user" }).items.some((item)=>item.item_id===big.id));
});
