import test from "node:test";
import assert from "node:assert/strict";
import { installContextNotes } from "../../src/extensions/context-notes.mjs";
import { fakeSession, Type } from "../helpers/context-notes-fake.mjs";
import { assertSessionReady } from "../../src/context-notes/engine-gate.mjs";

async function setup(t) {
  const f=fakeSession(t); f.addMessage("user","Perform the experiment");
  const api=await installContextNotes(f.pi,{enabled:true,Type,requireEngine:false}); t.after(()=>api.close());
  await f.dispatch("session_start");
  const call=(name,params={},id=name)=>f.tools.get(name).execute(id,params,undefined,undefined,f.ctx);
  return {...f,api,call};
}
test("all nine history/note operations plus window controls are registered",async(t)=>{
  const f=await setup(t); assert.equal(f.tools.size,11);
  for(const name of ["notes_write_file","notes_append_to_file","new_context"]) assert.equal(f.tools.get(name).executionMode,"sequential");
  assert.equal(f.tools.get("history_read_item").executionMode,"parallel");
  for(const tool of f.tools.values()) assert.equal(tool.exposure,"search");
});
test("registered tools save, search, recover notes and transition in the same session",async(t)=>{
  const f=await setup(t); const session=f.manager.getSessionId();
  await f.call("notes_write_file",{path:"active.md",text:"CacheControl original"});
  const found=JSON.parse((await f.call("notes_search_contents",{query:"CacheControl"})).content[0].text);
  assert.equal(found.files[0].path,"active.md");
  await f.call("new_context"); await f.dispatch("turn_end");
  assert.equal(f.manager.getSessionId(),session);
  const read=JSON.parse((await f.call("notes_read_file",{path:"active.md"})).content[0].text);
  assert.equal(read.text,"CacheControl original");
  const c=f.api.getController(f.ctx);
  assert.ok(c.store.diagnostics().some(e=>e.event==="tool_completed"));
  assert.ok(!JSON.stringify(c.store.diagnostics()).includes("CacheControl original"));
});
test("stable guidance is added once after role prompt handler",async(t)=>{
  const f=await setup(t);
  const [a]=await f.dispatch("before_agent_start",{systemPrompt:"ROLE PROMPT"});
  const [b]=await f.dispatch("before_agent_start",{systemPrompt:a.systemPrompt});
  assert.equal(a.systemPrompt,b.systemPrompt); assert.ok(a.systemPrompt.startsWith("ROLE PROMPT"));
});
test("manual compaction and tree summary blocked, normal tree navigation allowed",async(t)=>{
  const f=await setup(t);
  assert.equal((await f.dispatch("session_before_compact"))[0].cancel,true);
  assert.equal((await f.dispatch("session_before_tree",{preparation:{userWantsSummary:true}}))[0].cancel,true);
  assert.equal((await f.dispatch("session_before_tree",{preparation:{userWantsSummary:false}}))[0],undefined);
});
test("rewinding before initialization recreates a consistent initial window",async(t)=>{
  const f=await setup(t); const c=f.api.getController(f.ctx); const first=c.window.windowId;
  await f.call("notes_write_file",{path:"later.md",text:"future"});
  const user=f.entries.find(e=>e.type==="message"); f.rewind(user.id);
  await f.dispatch("session_tree");
  assert.equal(c.window.windowId,first); assert.equal(c.store.noteVersions.size,0);
  const ref=c.prepareContext({messages:f.build().messages},f.ctx).messages;
  assert.ok(JSON.stringify(ref).includes(first));
  assert.equal(c.store.readItem({window_id:first,item_id:user.id}).content,"Perform the experiment");
});
test("shutdown removes the provider admission registration",async(t)=>{
  const f=await setup(t); const previous=process.env.RUBATO_CONTEXT_MODE; process.env.RUBATO_CONTEXT_MODE="history-notes";
  try {
    assert.doesNotThrow(()=>assertSessionReady(f.manager));
    await f.dispatch("session_shutdown"); assert.throws(()=>assertSessionReady(f.manager),/준비되지/);
  } finally { if(previous===undefined)delete process.env.RUBATO_CONTEXT_MODE;else process.env.RUBATO_CONTEXT_MODE=previous; }
});
test("summary mode registers tools but they refuse to act",async(t)=>{
  const f=fakeSession(t);
  const api=await installContextNotes(f.pi,{enabled:false,Type,requireEngine:false}); t.after(()=>api.close());
  assert.equal(f.tools.size,11);
  await assert.rejects(f.tools.get("new_context").execute("id",{},undefined,undefined,f.ctx),/요약 모드/);
  assert.equal((await f.dispatch("session_before_compact"))[0],undefined);
});

test("admission failure aborts the agent even when a hook dispatcher catches errors",async(t)=>{
  const f=await setup(t);const old=process.env.RUBATO_CONTEXT_MODE;process.env.RUBATO_CONTEXT_MODE="history-notes";
  try {
    f.addMessage("user","a".repeat(150000));
    f.api.getController(f.ctx).refresh(f.ctx,true);
    assert.throws(()=>assertSessionReady(f.manager,f.build().messages));
    assert.ok(f.abort.signal.aborted);
  }finally{if(old===undefined)delete process.env.RUBATO_CONTEXT_MODE;else process.env.RUBATO_CONTEXT_MODE=old;}
});

test("history can explicitly reattach an original image as a native image result",async(t)=>{
  const f=await setup(t);const image={type:"image",mimeType:"image/png",data:"aGVsbG8="};
  const item=f.addMessage("user",[{type:"text",text:"screenshot"},image]);
  const c=f.api.getController(f.ctx);
  const result=await f.call("history_read_item",{window_id:c.window.windowId,item_id:item.id,include_image:true});
  assert.deepEqual(result.content[1],image);
  assert.equal(result.content[0].type,"text");
});
