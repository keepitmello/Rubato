#!/usr/bin/env python3
"""skill-picker — fx 카탈로그에 실을 스킬을 고르는 HTML을 만든다.

fx는 스킬 카탈로그를 16KB로 자른다(context_limits.zig, skill_catalog_bytes).
넘치면 뒤쪽이 통째로 빠지므로 무엇을 실을지 사람이 골라야 한다.

  python3 harness/scripts/skill-picker.py && open /tmp/skill-picker.html

사용 근거는 세션 로그의 실제 로드로 잡는다. 카탈로그 등재 문자열은 세션마다
전량 반복되므로 세면 전부 "사용 중"으로 보인다 — exec 인자로 SKILL.md를 읽은
것만 센다. 로그 스캔은 9.5GB라 몇 분 걸리고, 결과는 CACHE에 남겨 재사용한다.
"""
import json, os, re, subprocess, sys, time

CACHE = "/tmp/skill-picker-loads"
SESSIONS = os.path.expanduser("~/.codex/sessions")
PROJECTS = os.path.expanduser("~/.claude/projects")
LOAD_RE = r'"(cat|sed|head|Read|rg|less|bat)[^"]{0,140}skills/[a-z0-9_-]+/SKILL\.md'


def scan(out_path, *dirs):
    """exec 인자로 SKILL.md를 읽은 횟수를 스킬 이름별로 센다."""
    if os.path.exists(out_path):
        return
    dirs = [d for d in dirs if os.path.isdir(d)]
    if not dirs:
        open(out_path, "w").close()
        return
    print(f"scan {' '.join(dirs)} ...", file=sys.stderr)
    cmd = (f"grep -rohE {LOAD_RE!r} {' '.join(dirs)} 2>/dev/null"
           " | grep -oE 'skills/[a-z0-9_-]+/SKILL'"
           " | sed 's#skills/##;s#/SKILL##' | sort | uniq -c")
    open(out_path, "w").write(subprocess.run(["bash", "-c", cmd], capture_output=True, text=True).stdout)


def scan_claude(out_path):
    if os.path.exists(out_path):
        return
    cmd = (f"grep -roh '\"skill\": *\"[A-Za-z0-9:_-]*\"' {PROJECTS} 2>/dev/null"
           " | sed 's/.*\"skill\": *\"//;s/\"//' | sort | uniq -c")
    open(out_path, "w").write(subprocess.run(["bash", "-c", cmd], capture_output=True, text=True).stdout)


HOME=os.path.expanduser("~")
roots=[("fx managed",f"{HOME}/.fx/skills"),
       ("opencode",f"{HOME}/.config/opencode/skills"),
       ("codex",f"{HOME}/.codex/skills"),
       ("claude",f"{HOME}/.claude/skills"),
       ("agents",f"{HOME}/.agents/skills"),
       ("claw",f"{HOME}/.claw/skills")]

scan(CACHE + "-recent.txt", f"{SESSIONS}/2026/07", f"{SESSIONS}/2026/08")
scan(CACHE + "-all.txt", SESSIONS)
scan_claude(CACHE + "-claude.txt")


def counts(path):
    d={}
    if not os.path.exists(path): return d
    for line in open(path):
        line=line.strip()
        if not line: continue
        n,k=line.split(None,1)
        d[k]=int(n)
    return d
recent=counts(CACHE+"-recent.txt")
alltime=counts(CACHE+"-all.txt")
claude=counts(CACHE+"-claude.txt")

def fm(p):
    try: t=open(p,encoding='utf-8',errors='replace').read()
    except: return None
    if not t.startswith('---'): return None
    end=t.find('\n---',3)
    if end<0: return None
    head=t[3:end]
    out={}; key=None; buf=[]
    def flush():
        if key: out[key]=' '.join(x for x in buf if x).strip().strip('"\'').lstrip('>-| ').strip()
    for line in head.splitlines():
        m=re.match(r'^([A-Za-z_-]+):\s*(.*)$',line)
        if m:
            flush(); key=m.group(1); buf=[m.group(2)]
        elif line.strip():
            buf.append(line.strip())
    flush()
    return out

rows=[]; seen={}
for src,root in roots:
    if not os.path.isdir(root): continue
    for d in sorted(os.listdir(root)):
        if d.startswith('.'): continue
        p=os.path.join(root,d,'SKILL.md')
        if not os.path.isfile(p): continue
        meta=fm(p)
        if not meta or not meta.get('name'): continue
        name=meta['name']; desc=meta.get('description','')
        full=os.path.join(root,d)
        real=os.path.realpath(full)
        if name in seen:
            seen[name]['shadowed'].append(src)
            continue
        dl=min(len(desc.encode()),1024)
        row={'name':name,'desc':desc,'src':src,'path':full,'real':real,
             'link':os.path.islink(full),
             'bytes':97+len(name.encode())+dl+len(full.encode()),
             'recent':recent.get(d,0)+recent.get(name,0) if d!=name else recent.get(name,0),
             'all':alltime.get(d,0)+alltime.get(name,0) if d!=name else alltime.get(name,0),
             'claude':claude.get(name,0),
             'slash_only': meta.get('disable-model-invocation','')=='true',
             'mtime':time.strftime('%Y-%m-%d',time.localtime(os.path.getmtime(real if os.path.exists(real) else full))),
             'shadowed':[]}
        seen[name]=row; rows.append(row)

HDR=len("\n\nSkills provide specialized instructions and workflows for specific tasks.\nUse the skill tool to load a skill when a task matches its description.\nDo not assume a skill is loaded just because it is available. Load it first when it seems relevant.\n<available_skills>\n</available_skills>\n".encode())
data=json.dumps(rows,ensure_ascii=False)
tpl = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>fx 스킬 카탈로그 고르기</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#8a93a6;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--accent:#60a5fa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:10;background:var(--panel);border-bottom:1px solid var(--line);padding:14px 20px}
h1{margin:0 0 10px;font-size:16px;font-weight:600}
.bar{height:10px;background:#0b0d11;border-radius:5px;overflow:hidden;margin:8px 0 6px}
.bar>div{height:100%;transition:width .15s,background .15s}
.stat{font-variant-numeric:tabular-nums}
.stat b{font-size:18px}
.ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
button,select,input[type=text]{background:#1f242e;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer}
button:hover{border-color:var(--accent)}
input[type=text]{min-width:200px;cursor:text}
table{width:100%;border-collapse:collapse}
th{position:sticky;top:0;text-align:left;font-size:12px;color:var(--dim);font-weight:500;padding:8px 10px;background:var(--bg);border-bottom:1px solid var(--line);cursor:pointer;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid #1c202a;vertical-align:top}
tr.off{opacity:.4}
tr:hover td{background:#141821}
.name{font-weight:600;white-space:nowrap}
.desc{color:var(--dim);font-size:12.5px;max-width:640px}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tag{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:4px;border:1px solid var(--line);color:var(--dim);margin-left:6px;vertical-align:1px}
.tag.live{color:var(--ok);border-color:#1f4d33}
.tag.dead{color:var(--bad);border-color:#4d2020}
.tag.slash{color:var(--warn);border-color:#4d3f1f}
.path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#5c6577}
#panel{position:fixed;left:0;right:0;bottom:0;z-index:20;background:#0b0d11;border-top:1px solid var(--accent);box-shadow:0 -8px 24px #0008}
.phead{display:flex;justify-content:space-between;align-items:center;padding:8px 20px;border-bottom:1px solid var(--line);font-size:12px;color:var(--dim)}
#out{margin:0;padding:14px 20px;font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;color:#a9b3c6;max-height:45vh;overflow:auto}
.wrap{padding:0 20px 20px}
</style></head><body>
<header>
 <h1>fx 스킬 카탈로그 — 실을 것 고르기</h1>
 <div class="bar"><div id="fill"></div></div>
 <div class="stat"><b id="tot">0</b> / 16,384 B &nbsp;·&nbsp; 선택 <b id="cnt">0</b>개 <span id="verdict"></span></div>
 <div class="ctl">
  <input type="text" id="q" placeholder="이름·설명 검색">
  <button data-act="all">전체 선택</button>
  <button data-act="none">전체 해제</button>
  <button data-act="recent">최근 로드된 것만</button>
  <button data-act="any">한 번이라도 쓴 것만</button>
  <button data-act="fit">16KB에 맞게 자동(사용량 순)</button>
  <button data-act="cmd">해제한 것 옮기는 명령 만들기</button>
 </div>
</header>
<div class="wrap"><table id="t"><thead><tr>
 <th></th><th data-k="name">이름</th><th data-k="bytes" class="num">바이트</th>
 <th data-k="recent" class="num">최근(7·8월)</th><th data-k="all" class="num">전체</th>
 <th data-k="claude" class="num">Claude</th><th data-k="mtime">수정일</th><th data-k="src">위치</th><th>설명</th>
</tr></thead><tbody></tbody></table></div>
<div id="panel" hidden><div class="phead"><span>해제한 것을 옮기는 명령</span><span><button id="copy">복사</button> <button id="close">닫기</button></span></div><pre id="out"></pre></div>
<script>
const HDR=__HDR__, LIMIT=16384;
const rows=__DATA__;
rows.forEach((r,i)=>{r.i=i;r.on=true});
let sortK='bytes', sortDir=-1;
const tb=document.querySelector('#t tbody');
function render(){
 const q=document.getElementById('q').value.trim().toLowerCase();
 const list=rows.filter(r=>!q||r.name.toLowerCase().includes(q)||(r.desc||'').toLowerCase().includes(q));
 list.sort((a,b)=>{const x=a[sortK],y=b[sortK];return (typeof x==='number'?x-y:String(x).localeCompare(String(y)))*sortDir});
 tb.innerHTML=list.map(r=>{
  const live=r.recent>0?'<span class="tag live">최근</span>':'';
  const dead=(r.recent+r.all+r.claude)===0?'<span class="tag dead">기록 없음</span>':'';
  const slash=r.slash_only?'<span class="tag slash">슬래시 전용</span>':'';
  return `<tr class="${r.on?'':'off'}" data-i="${r.i}">
   <td><input type="checkbox" ${r.on?'checked':''} data-i="${r.i}"></td>
   <td class="name">${esc(r.name)}${live}${dead}${slash}</td>
   <td class="num">${r.bytes}</td><td class="num">${r.recent||''}</td>
   <td class="num">${r.all||''}</td><td class="num">${r.claude||''}</td>
   <td class="num">${r.mtime}</td><td><span class="path">${esc(r.src)}</span></td>
   <td class="desc">${esc((r.desc||'').slice(0,300))}</td></tr>`}).join('');
 total();
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function total(){
 const on=rows.filter(r=>r.on);
 const t=HDR+on.reduce((s,r)=>s+r.bytes,0);
 document.getElementById('tot').textContent=t.toLocaleString();
 document.getElementById('cnt').textContent=on.length;
 const pct=Math.min(100,t/LIMIT*100);
 const f=document.getElementById('fill');
 f.style.width=pct+'%';
 f.style.background=t>LIMIT?'var(--bad)':(t>LIMIT*0.9?'var(--warn)':'var(--ok)');
 document.getElementById('verdict').textContent=t>LIMIT?`· ${(t-LIMIT).toLocaleString()}B 초과 — 잘림`:`· ${(LIMIT-t).toLocaleString()}B 여유`;
}
tb.addEventListener('change',e=>{const i=+e.target.dataset.i;rows[i].on=e.target.checked;
 e.target.closest('tr').classList.toggle('off',!rows[i].on);total()});
document.getElementById('q').addEventListener('input',render);
document.querySelectorAll('th[data-k]').forEach(th=>th.addEventListener('click',()=>{
 const k=th.dataset.k; if(sortK===k)sortDir*=-1; else {sortK=k;sortDir=(k==='name'||k==='src'||k==='mtime')?1:-1;} render()}));
document.querySelector('.ctl').addEventListener('click',e=>{
 const a=e.target.dataset.act; if(!a)return;
 if(a==='all')rows.forEach(r=>r.on=true);
 if(a==='none')rows.forEach(r=>r.on=false);
 if(a==='recent')rows.forEach(r=>r.on=r.recent>0);
 if(a==='any')rows.forEach(r=>r.on=(r.recent+r.all+r.claude)>0);
 if(a==='fit'){
  const s=[...rows].sort((x,y)=>(y.recent*100+y.all+y.claude*50)-(x.recent*100+x.all+x.claude*50));
  let t=HDR; rows.forEach(r=>r.on=false);
  for(const r of s){ if(t+r.bytes<=LIMIT){r.on=true;t+=r.bytes} }
 }
 if(a==='cmd'){out();return}
 render();
});
function out(){
 const off=rows.filter(r=>!r.on);
 const panel=document.getElementById('panel'), pre=document.getElementById('out');
 panel.hidden=false;
 if(!off.length){pre.textContent='# 해제한 스킬이 없다.';return}
 // 같은 이름이 여러 루트에 있으면 전부 옮겨야 카탈로그에서 빠진다.
 const lines=['# 해제한 '+off.length+'개를 카탈로그 밖으로 옮긴다 (되돌리려면 반대로 mv)',
  ...off.flatMap(r=>{
   const root=r.path.replace(/\\/skills\\/[^/]+$/,'').split('/').pop();
   return ["mkdir -p ~/.skills-archive/"+root, "mv '"+r.path+"' ~/.skills-archive/"+root+"/"]})];
 pre.textContent=[...new Set(lines)].join('\\n');
}
document.getElementById('copy').addEventListener('click',async e=>{
 await navigator.clipboard.writeText(document.getElementById('out').textContent);
 e.target.textContent='복사됨'; setTimeout(()=>e.target.textContent='복사',1200);
});
document.getElementById('close').addEventListener('click',()=>{document.getElementById('panel').hidden=true});
render();
</script></body></html>"""
open('/tmp/skill-picker.html','w').write(tpl.replace('__HDR__',str(HDR)).replace('__DATA__',data))
print(f'{len(rows)} skills, {HDR+sum(r["bytes"] for r in rows)} bytes -> /tmp/skill-picker.html')
