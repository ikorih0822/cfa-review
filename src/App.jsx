import { useState, useEffect, useCallback, useRef } from "react";

const CFA_TOPICS = ["Ethics & Professional Standards","Quantitative Methods","Economics","Financial Statement Analysis","Corporate Issuers","Equity Investments","Fixed Income","Derivatives","Alternative Investments","Portfolio Management","Wealth Planning"];
const DIFFICULTY = ["Easy","Medium","Hard"];

const BLANK_Q = { id:null, topic:CFA_TOPICS[0], difficulty:"Medium", questionEN:"", choices:["","",""], choicesJA:["","",""], correctIndex:0, explanationEN:"", questionJA:"", explanationJA:"", keyPoints:"", relatedIds:[], attemptCount:0, wrongCount:0, lastAttempted:null, srInterval:1, srEaseFactor:2.5, srRepetitions:0, srNextReview:null };
const BLANK_NOTE = { id:null, title:"", content:"", relatedIds:[], createdAt:null, updatedAt:null };

// ── SM-2 ──────────────────────────────────────────────────────────────────────
function sm2Update(q, correct) {
  const quality = correct ? 4 : 0;
  let { srInterval, srEaseFactor, srRepetitions } = q;
  if (quality < 3) { srRepetitions=0; srInterval=1; }
  else { if(srRepetitions===0)srInterval=1; else if(srRepetitions===1)srInterval=3; else srInterval=Math.round(srInterval*srEaseFactor); srRepetitions+=1; }
  srEaseFactor = Math.max(1.3, srEaseFactor+0.1-(5-quality)*(0.08+(5-quality)*0.02));
  const next = new Date(); next.setDate(next.getDate()+srInterval);
  return { srInterval, srEaseFactor, srRepetitions, srNextReview: next.toISOString().split("T")[0] };
}
function isDueToday(q) { if(!q.srNextReview)return true; return q.srNextReview<=new Date().toISOString().split("T")[0]; }
function daysUntil(q) { if(!q.srNextReview)return 0; const t=new Date();t.setHours(0,0,0,0);const n=new Date(q.srNextReview);n.setHours(0,0,0,0);return Math.round((n-t)/86400000); }
function reviewLabel(q) { if(!q.srNextReview)return{label:"未学習",color:"#7a8a9a"}; const d=daysUntil(q); if(d<0)return{label:`${Math.abs(d)}日超過`,color:"#e05a5a"}; if(d===0)return{label:"今日",color:"#4aad8b"}; if(d===1)return{label:"明日",color:"#c4a050"}; return{label:`${d}日後`,color:"#6b9fd4"}; }

// ── Storage ───────────────────────────────────────────────────────────────────
const LS = {
  getQ: () => {
    try {
      const legacy = localStorage.getItem("cfa:questions");
      const current = localStorage.getItem("cfa:q");
      if (legacy && !current) {
        localStorage.setItem("cfa:q", legacy);
        return JSON.parse(legacy);
      }
      return current ? JSON.parse(current) : [];
    } catch { return []; }
  },
  setQ: qs => { try { localStorage.setItem("cfa:q", JSON.stringify(qs)); } catch {} },
  getN: () => { try { const r = localStorage.getItem("cfa:notes"); return r ? JSON.parse(r) : []; } catch { return []; } },
  setN: ns => { try { localStorage.setItem("cfa:notes", JSON.stringify(ns)); } catch {} },
  getKey: () => localStorage.getItem("cfa:apikey") || "",
  setKey: k => localStorage.setItem("cfa:apikey", k),
};

// ── Translation ───────────────────────────────────────────────────────────────
function splitChunks(t,max=400){if(t.length<=max)return[t];const r=[];let s=t;while(s.length>max){let c=s.lastIndexOf(". ",max);if(c<50)c=s.lastIndexOf(" ",max);if(c<50)c=max;r.push(s.slice(0,c+1).trim());s=s.slice(c+1).trim();}if(s)r.push(s);return r;}
async function gtrans(text){const u=`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=${encodeURIComponent(text)}`;const r=await fetch(u);if(!r.ok)throw new Error(`${r.status}`);const d=await r.json();return d[0].map(s=>s[0]).join("");}
async function mymem(text){const u=`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ja`;const r=await fetch(u);const d=await r.json();if(Number(d.responseStatus)===200)return d.responseData.translatedText;throw new Error("mymemory failed");}
async function translateEN2JA(text){if(!text.trim())return"";const chunks=splitChunks(text);const res=[];for(const c of chunks){let t;try{t=await gtrans(c)}catch{try{t=await mymem(c)}catch(e){throw new Error("翻訳サービスに接続できませんでした");}}res.push(t);if(chunks.length>1)await new Promise(r=>setTimeout(r,300));}return res.join(" ");}

// ── Claude AI ─────────────────────────────────────────────────────────────────
async function askClaude(apiKey, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
    body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages})
  });
  if(!res.ok){const e=await res.json();throw new Error(e.error?.message||`HTTP ${res.status}`);}
  const d=await res.json();
  return d.content.map(b=>b.text||"").join("");
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const Ic = {
  home:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  list:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  plus:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  play:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  edit:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  trash:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>,
  check:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>,
  xmark:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  eye:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  eyeOff:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  flag:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>,
  back:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polyline points="15 18 9 12 15 6"/></svg>,
  bell:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>,
  cal:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  repeat:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>,
  chat:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>,
  note:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  link:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
  send:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
  settings:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
};

// ── Styles ────────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2,10);
const diffColor = d => d==="Hard"?"#e05a5a":d==="Medium"?"#d4a34a":"#4aad8b";
const S = {
  app:{fontFamily:"'Georgia','Times New Roman',serif",background:"#0d1b2e",minHeight:"100vh",color:"#e8e0d0",display:"flex",flexDirection:"column",maxWidth:680,margin:"0 auto",position:"relative"},
  header:{background:"linear-gradient(135deg,#0a1628,#14263d)",borderBottom:"1px solid rgba(196,160,80,0.3)",padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100},
  content:{flex:1,padding:"16px 16px 80px",overflowY:"auto"},
  nav:{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:680,background:"linear-gradient(180deg,rgba(10,22,40,0.97),#080f1c)",borderTop:"1px solid rgba(196,160,80,0.25)",display:"flex",justifyContent:"space-around",padding:"6px 0 10px",backdropFilter:"blur(12px)",zIndex:100},
  navBtn:a=>({display:"flex",flexDirection:"column",alignItems:"center",gap:2,background:"none",border:"none",cursor:"pointer",color:a?"#c4a050":"#5a6a7a",fontSize:9,letterSpacing:"0.08em",padding:"4px 8px",transition:"color 0.2s",textTransform:"uppercase",position:"relative"}),
  card:{background:"linear-gradient(135deg,#131f30,#0f1a28)",border:"1px solid rgba(196,160,80,0.2)",borderRadius:8,padding:16,marginBottom:12},
  btn:v=>{const base={padding:v==="sm"?"5px 12px":"10px 20px",borderRadius:4,border:"none",cursor:"pointer",fontSize:v==="sm"?11:14,fontFamily:"'Georgia',serif",letterSpacing:"0.05em",fontWeight:"bold",transition:"all 0.15s"};if(v==="primary"||v==="sm")return{...base,background:"linear-gradient(135deg,#c4a050,#a8852e)",color:"#0a1628"};if(v==="ghost")return{...base,background:"transparent",color:"#c4a050",border:"1px solid rgba(196,160,80,0.4)"};if(v==="danger")return{...base,background:"#c0392b",color:"#fff"};if(v==="teal")return{...base,background:"linear-gradient(135deg,#2a8a6a,#1e6e52)",color:"#fff"};if(v==="blue")return{...base,background:"linear-gradient(135deg,#2a5a9a,#1e4070)",color:"#fff"};return{...base,background:"rgba(196,160,80,0.1)",color:"#c4a050",border:"1px solid rgba(196,160,80,0.3)"};},
  input:{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(196,160,80,0.25)",borderRadius:4,padding:"8px 12px",color:"#e8e0d0",fontFamily:"'Georgia',serif",fontSize:14,width:"100%",boxSizing:"border-box",outline:"none",marginBottom:12},
  textarea:{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(196,160,80,0.25)",borderRadius:4,padding:"8px 12px",color:"#e8e0d0",fontFamily:"'Georgia',serif",fontSize:14,width:"100%",boxSizing:"border-box",outline:"none",resize:"vertical",minHeight:80,marginBottom:12},
  label:{display:"block",fontSize:11,letterSpacing:"0.12em",color:"#c4a050",textTransform:"uppercase",marginBottom:5},
  sectionTitle:{fontSize:11,letterSpacing:"0.2em",color:"#c4a050",textTransform:"uppercase",marginBottom:12,borderBottom:"1px solid rgba(196,160,80,0.2)",paddingBottom:6},
  tag:c=>({display:"inline-block",padding:"2px 8px",borderRadius:3,border:`1px solid ${c||"#c4a050"}40`,color:c||"#c4a050",fontSize:10,letterSpacing:"0.08em",textTransform:"uppercase",background:`${c||"#c4a050"}18`}),
  choiceBtn:st=>({display:"flex",alignItems:"center",gap:10,width:"100%",textAlign:"left",padding:"12px 14px",borderRadius:4,marginBottom:8,transition:"all 0.2s",fontFamily:"'Georgia',serif",fontSize:14,lineHeight:1.5,border:`1px solid ${st==="correct"?"#4aad8b":st==="wrong"?"#e05a5a":st==="reveal-correct"?"#4aad8b":"rgba(196,160,80,0.2)"}`,background:st==="correct"?"rgba(74,173,139,0.12)":st==="wrong"?"rgba(224,90,90,0.12)":st==="reveal-correct"?"rgba(74,173,139,0.08)":"rgba(255,255,255,0.03)",color:st==="correct"?"#4aad8b":st==="wrong"?"#e05a5a":st==="reveal-correct"?"#4aad8b":"#e8e0d0",cursor:(st==="correct"||st==="wrong"||st==="reveal-correct")?"default":"pointer"}),
};

// ── SRBadge ───────────────────────────────────────────────────────────────────
function SRBadge({q}){const rl=reviewLabel(q);return(<span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 7px",borderRadius:3,border:`1px solid ${rl.color}40`,color:rl.color,fontSize:10,background:`${rl.color}18`,letterSpacing:"0.06em"}}><Ic.cal/>{rl.label}</span>);}

// ── TranslateBtn ──────────────────────────────────────────────────────────────
function TranslateBtn({loading,onClick}){return(<button onClick={onClick} disabled={loading} style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 10px",borderRadius:4,border:"1px solid rgba(100,180,220,0.4)",background:"rgba(100,180,220,0.1)",color:loading?"#5a8aaa":"#80c8e8",cursor:loading?"not-allowed":"pointer",fontSize:11,whiteSpace:"nowrap"}}>{loading?<><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span> ...</>:<>🌐 翻訳</>}</button>);}

// ── RelatedQuestionPicker ─────────────────────────────────────────────────────
function RelatedQuestionPicker({questions, selected, onChange, currentId}){
  const [search,setSearch]=useState("");
  const pool=questions.filter(q=>q.id!==currentId&&(search===""||q.questionEN.toLowerCase().includes(search.toLowerCase())||q.topic.toLowerCase().includes(search.toLowerCase())));
  return(
    <div>
      <input value={search} onChange={e=>setSearch(e.target.value)} style={{...S.input,marginBottom:8,fontSize:12}} placeholder="問題文・分野で検索..."/>
      <div style={{maxHeight:180,overflowY:"auto",border:"1px solid rgba(196,160,80,0.15)",borderRadius:4}}>
        {pool.length===0&&<div style={{padding:"12px",fontSize:12,color:"#5a6a7a",textAlign:"center"}}>該当なし</div>}
        {pool.map(q=>{
          const isSel=selected.includes(q.id);
          return(
            <div key={q.id} onClick={()=>onChange(isSel?selected.filter(i=>i!==q.id):[...selected,q.id])} style={{padding:"8px 12px",cursor:"pointer",background:isSel?"rgba(196,160,80,0.1)":"transparent",borderBottom:"1px solid rgba(255,255,255,0.04)",display:"flex",gap:8,alignItems:"flex-start"}}>
              <span style={{color:isSel?"#c4a050":"#3a4a5a",fontSize:14,flexShrink:0,marginTop:1}}>{isSel?"☑":"☐"}</span>
              <div>
                <div style={{fontSize:10,color:"#7a8a9a",marginBottom:2}}>{q.topic} · {q.difficulty}</div>
                <div style={{fontSize:12,color:isSel?"#c8bfaf":"#8a9ab0",lineHeight:1.4}}>{q.questionEN.slice(0,80)}…</div>
              </div>
            </div>
          );
        })}
      </div>
      {selected.length>0&&<div style={{fontSize:11,color:"#c4a050",marginTop:6}}>{selected.length}問 選択中</div>}
    </div>
  );
}

// ── AiChat ────────────────────────────────────────────────────────────────────
function AiChat({question, apiKey, onOpenSettings}){
  const [msgs,setMsgs]=useState([]);
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  const [open,setOpen]=useState(false);
  const bottomRef=useRef(null);

  useEffect(()=>{if(bottomRef.current)bottomRef.current.scrollIntoView({behavior:"smooth"});},[msgs]);

  async function send(){
    if(!input.trim()||loading)return;
    if(!apiKey){onOpenSettings();return;}
    const userMsg=input.trim();
    setInput("");setError(null);
    const context=`You are a CFA exam tutor. The student is reviewing this question:\n\nQuestion: ${question.questionEN}\n\nCorrect Answer: ${question.choices[question.correctIndex]}\n\nExplanation: ${question.explanationEN}\n\nAnswer the student's question concisely in the same language they use (Japanese or English).`;
    const history=[...msgs,{role:"user",content:userMsg}];
    setMsgs(history);setLoading(true);
    try{
      const allMsgs=history.length===1?[{role:"user",content:`${context}\n\nStudent's question: ${userMsg}`}]:[{role:"user",content:`${context}\n\nStudent's question: ${history[0].content}`},...history.slice(1)];
      const reply=await askClaude(apiKey,allMsgs);
      setMsgs(prev=>[...prev,{role:"assistant",content:reply}]);
    }catch(e){setError(e.message);}finally{setLoading(false);}
  }

  if(!open)return(
    <button onClick={()=>setOpen(true)} style={{...S.btn("blue"),display:"flex",alignItems:"center",gap:6,marginBottom:10,fontSize:12,padding:"7px 14px"}}>
      <Ic.chat/> AIに追加質問する
    </button>
  );

  return(
    <div style={{...S.card,borderColor:"rgba(100,140,200,0.3)",marginBottom:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:10,color:"#6b9fd4",letterSpacing:"0.15em"}}>AI TUTOR</div>
        <button onClick={()=>setOpen(false)} style={{...S.btn("ghost"),padding:"2px 8px",fontSize:11}}>閉じる</button>
      </div>
      {!apiKey&&(
        <div style={{fontSize:12,color:"#8a9ab0",marginBottom:8,lineHeight:1.6}}>
          AI機能を使うにはAnthropicのAPIキーが必要です。
          <button onClick={onOpenSettings} style={{color:"#6b9fd4",background:"none",border:"none",cursor:"pointer",textDecoration:"underline",fontSize:12,fontFamily:"Georgia"}}>設定で入力する →</button>
        </div>
      )}
      <div style={{maxHeight:200,overflowY:"auto",marginBottom:10}}>
        {msgs.length===0&&<div style={{fontSize:12,color:"#5a6a7a",padding:"8px 0"}}>この問題について何でも質問できます。日本語でもOKです。</div>}
        {msgs.map((m,i)=>(
          <div key={i} style={{marginBottom:8,display:"flex",gap:8,alignItems:"flex-start"}}>
            <span style={{fontSize:11,color:m.role==="user"?"#c4a050":"#6b9fd4",minWidth:28,flexShrink:0}}>{m.role==="user"?"You":"AI"}</span>
            <div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.6,flex:1,whiteSpace:"pre-wrap"}}>{m.content}</div>
          </div>
        ))}
        {loading&&<div style={{fontSize:12,color:"#5a6a7a",padding:"4px 0"}}>⟳ 考え中...</div>}
        {error&&<div style={{fontSize:12,color:"#e05a5a",marginTop:4}}>⚠️ {error}</div>}
        <div ref={bottomRef}/>
      </div>
      <div style={{display:"flex",gap:6}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}} style={{...S.input,marginBottom:0,flex:1,fontSize:13}} placeholder="質問を入力...（Enter送信）"/>
        <button onClick={send} disabled={loading||!input.trim()} style={{...S.btn("blue"),padding:"8px 12px",opacity:loading||!input.trim()?0.4:1}}><Ic.send/></button>
      </div>
    </div>
  );
}

// ── SettingsModal ─────────────────────────────────────────────────────────────
function SettingsModal({open,onClose}){
  const [key,setKey]=useState(LS.getKey());
  if(!open)return null;
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{...S.card,maxWidth:440,width:"100%",marginBottom:0}}>
        <div style={{fontSize:14,color:"#c4a050",marginBottom:16}}>⚙️ 設定</div>
        <label style={S.label}>Anthropic APIキー（AI追加質問機能用）</label>
        <input type="password" value={key} onChange={e=>setKey(e.target.value)} style={S.input} placeholder="sk-ant-..."/>
        <div style={{fontSize:11,color:"#5a6a7a",lineHeight:1.7,marginBottom:14}}>
          APIキーは<a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{color:"#6b9fd4"}}>console.anthropic.com</a>で取得できます。このデバイスのブラウザ（localStorage）にのみ保存されます。
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>{LS.setKey(key);onClose();}} style={{...S.btn("primary"),flex:1}}>保存</button>
          <button onClick={onClose} style={{...S.btn("ghost"),flex:1}}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({questions,notes,setPage,setPracticeMode}){
  const total=questions.length;
  const dueCount=questions.filter(isDueToday).length;
  const overdue=questions.filter(q=>q.srNextReview&&q.srNextReview<new Date().toISOString().split("T")[0]).length;
  const topicCounts={};questions.forEach(q=>{topicCounts[q.topic]=(topicCounts[q.topic]||0)+1;});
  const forecast=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()+i);const ds=d.toISOString().split("T")[0];return{label:i===0?"今日":i===1?"明日":`${d.getMonth()+1}/${d.getDate()}`,count:questions.filter(q=>q.srNextReview===ds).length,isToday:i===0};});
  const maxF=Math.max(...forecast.map(f=>f.count),1);
  return(
    <div>
      {dueCount>0&&(<div onClick={()=>{setPracticeMode("due");setPage("practice");}} style={{...S.card,borderColor:"#4aad8b80",background:"linear-gradient(135deg,#0e2420,#0b1c17)",cursor:"pointer",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div><div style={{fontSize:10,color:"#4aad8b",letterSpacing:"0.15em",marginBottom:4}}>TODAY'S REVIEW</div><div style={{fontSize:22,fontWeight:"bold",color:"#4aad8b"}}>{dueCount} <span style={{fontSize:14,color:"#3a8a6a"}}>問が復習期限</span></div>{overdue>0&&<div style={{fontSize:11,color:"#e05a5a",marginTop:2}}>うち {overdue} 問は期限超過</div>}</div>
        <button style={{...S.btn("teal"),padding:"10px 14px",fontSize:12,display:"flex",alignItems:"center",gap:5}}><Ic.repeat/>今すぐ復習</button>
      </div>)}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:14}}>
        {[{label:"登録問題",value:total,accent:"#c4a050"},{label:"復習期限",value:dueCount,accent:"#4aad8b"},{label:"未学習",value:questions.filter(q=>!q.srNextReview).length,accent:"#7a8a9a"},{label:"ノート",value:notes.length,accent:"#9b8fd4"}].map(s=>(
          <div key={s.label} style={{...S.card,textAlign:"center",padding:"10px 6px"}}><div style={{fontSize:22,fontWeight:"bold",color:s.accent}}>{s.value}</div><div style={{fontSize:9,color:"#7a8a9a",letterSpacing:"0.08em",marginTop:2}}>{s.label}</div></div>
        ))}
      </div>
      {total>0&&(<div style={{...S.card,marginBottom:14}}>
        <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:10,display:"flex",alignItems:"center",gap:6}}><Ic.cal/>今後7日間の復習予定</div>
        <div style={{display:"flex",gap:6,alignItems:"flex-end",height:56}}>
          {forecast.map((f,i)=>(<div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}><div style={{fontSize:10,color:"#5a6a7a"}}>{f.count>0?f.count:""}</div><div style={{width:"100%",borderRadius:"3px 3px 0 0",transition:"height 0.3s",height:f.count>0?`${Math.max((f.count/maxF)*38,5)}px`:"2px",background:f.isToday?(f.count>0?"#4aad8b":"rgba(74,173,139,0.2)"):f.count>0?"#c4a05070":"rgba(255,255,255,0.06)"}}/><div style={{fontSize:9,color:f.isToday?"#c4a050":"#5a6a7a"}}>{f.label}</div></div>))}
        </div>
      </div>)}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <button style={{...S.btn("primary"),padding:"13px",display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontSize:13}} onClick={()=>{setPracticeMode("all");setPage("practice");}}><Ic.play/>全問演習</button>
        <button style={{...S.btn("ghost"),padding:"13px",display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontSize:13}} onClick={()=>setPage("add")}><Ic.plus/>問題を登録</button>
      </div>
      {total>0&&(<div><div style={S.sectionTitle}>分野別 登録数</div>{Object.entries(topicCounts).sort((a,b)=>b[1]-a[1]).map(([topic,count])=>(<div key={topic} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}><div style={{flex:1,fontSize:12,color:"#b0c0cc"}}>{topic}</div><div style={{fontSize:12,color:"#c4a050",minWidth:24,textAlign:"right"}}>{count}</div><div style={{width:80,height:4,background:"rgba(255,255,255,0.08)",borderRadius:2}}><div style={{width:`${(count/total)*100}%`,height:"100%",background:"#c4a050",borderRadius:2}}/></div></div>))}</div>)}
      {total===0&&(<div style={{...S.card,textAlign:"center",padding:40}}><div style={{fontSize:32,marginBottom:12}}>📖</div><div style={{color:"#7a8a9a",fontSize:14,lineHeight:1.7}}>まずは復習したい問題を登録しましょう。</div><button style={{...S.btn("primary"),marginTop:16}} onClick={()=>setPage("add")}>最初の問題を登録する</button></div>)}
    </div>
  );
}

// ── QuestionList ──────────────────────────────────────────────────────────────
function QuestionList({questions,setPage,setEditQ,deleteQ,startSingleQ}){
  const [filterTopic,setFilterTopic]=useState("All");
  const [filterDiff,setFilterDiff]=useState("All");
  const [filterSR,setFilterSR]=useState("All");
  const [expandedId,setExpandedId]=useState(null);
  const dueCount=questions.filter(isDueToday).length;
  const filtered=questions.filter(q=>(filterTopic==="All"||q.topic===filterTopic)&&(filterDiff==="All"||q.difficulty===filterDiff)&&(filterSR==="All"||(filterSR==="Due"&&isDueToday(q))||(filterSR==="Upcoming"&&!isDueToday(q)&&q.srNextReview))).sort((a,b)=>{if(isDueToday(a)&&!isDueToday(b))return -1;if(!isDueToday(a)&&isDueToday(b))return 1;if(a.srNextReview&&b.srNextReview)return a.srNextReview.localeCompare(b.srNextReview);return 0;});
  const topics=["All",...CFA_TOPICS.filter(t=>questions.some(q=>q.topic===t))];
  return(
    <div>
      <div style={{display:"flex",gap:6,marginBottom:10}}>
        {[["All","全て"],["Due",`期限 ${dueCount}`],["Upcoming","予定あり"]].map(([val,label])=>(<button key={val} onClick={()=>setFilterSR(val)} style={{...S.btn(filterSR===val?"primary":"ghost"),padding:"5px 12px",fontSize:11}}>{label}</button>))}
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
        {["All","Easy","Medium","Hard"].map(d=>(<button key={d} onClick={()=>setFilterDiff(d)} style={{...S.btn(filterDiff===d?"primary":"ghost"),padding:"4px 10px",fontSize:11}}>{d==="All"?"全難易度":d}</button>))}
      </div>
      <select value={filterTopic} onChange={e=>setFilterTopic(e.target.value)} style={{...S.input,marginBottom:8,fontSize:12}}>
        {topics.map(t=><option key={t} value={t} style={{background:"#0d1b2e"}}>{t==="All"?"全分野":t}</option>)}
      </select>
      <div style={{fontSize:11,color:"#5a6a7a",marginBottom:10}}>{filtered.length} 問</div>
      {filtered.length===0&&<div style={{...S.card,textAlign:"center",padding:30,color:"#5a6a7a"}}>該当する問題がありません</div>}
      {filtered.map(q=>{
        const isOpen=expandedId===q.id;
        const acc=q.attemptCount>0?Math.round(((q.attemptCount-q.wrongCount)/q.attemptCount)*100):null;
        const rl=reviewLabel(q);
        return(
          <div key={q.id} style={{...S.card,borderColor:isDueToday(q)?"rgba(74,173,139,0.35)":"rgba(196,160,80,0.2)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
              <div style={{flex:1,cursor:"pointer"}} onClick={()=>setExpandedId(isOpen?null:q.id)}>
                <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:6}}>
                  <span style={S.tag()}>{q.topic.split(" ").slice(0,2).join(" ")}</span>
                  <span style={S.tag(diffColor(q.difficulty))}>{q.difficulty}</span>
                  <SRBadge q={q}/>
                  {acc!==null&&<span style={S.tag("#6b9fd4")}>正答率 {acc}%</span>}
                </div>
                <div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.5}}>{q.questionEN.slice(0,100)}{q.questionEN.length>100?"…":""}</div>
                {q.srRepetitions>0&&<div style={{fontSize:11,color:"#4a6a5a",marginTop:4}}>✓ {q.srRepetitions}回連続正解 · 間隔 {q.srInterval}日</div>}
              </div>
              <div style={{display:"flex",gap:5,flexShrink:0}}>
                <button onClick={()=>startSingleQ(q.id)} style={{...S.btn("teal"),padding:"6px 8px"}} title="この問題に挑戦"><Ic.play/></button>
                <button onClick={()=>{setEditQ(q);setPage("add");}} style={{...S.btn("ghost"),padding:"6px 8px"}}><Ic.edit/></button>
                <button onClick={()=>{if(confirm("削除しますか？"))deleteQ(q.id);}} style={{...S.btn("danger"),padding:"6px 8px"}}><Ic.trash/></button>
              </div>
            </div>
            {isOpen&&(
              <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(196,160,80,0.15)"}}>
                <div style={{background:"rgba(74,173,139,0.06)",border:"1px solid rgba(74,173,139,0.2)",borderRadius:4,padding:"8px 12px",marginBottom:10}}>
                  <div style={{fontSize:10,color:"#4aad8b",letterSpacing:"0.1em",marginBottom:4}}>🔁 間隔反復ステータス</div>
                  <div style={{display:"flex",gap:16,fontSize:12,color:"#8ab0a0",flexWrap:"wrap"}}>
                    <span>次回: <strong style={{color:rl.color}}>{rl.label}</strong></span>
                    <span>間隔: <strong style={{color:"#c4a050"}}>{q.srInterval}日</strong></span>
                    <span>連続正解: <strong style={{color:"#6b9fd4"}}>{q.srRepetitions}回</strong></span>
                  </div>
                </div>
                {q.questionJA&&<div style={{fontSize:13,color:"#8a9ab0",lineHeight:1.6,marginBottom:10}}><span style={{color:"#c4a050",fontSize:10}}>【日本語訳】</span><br/>{q.questionJA}</div>}
                {q.relatedIds?.length>0&&<div style={{fontSize:11,color:"#9b8fd4",marginBottom:6}}>🔗 関連問題 {q.relatedIds.length}件</div>}
                {q.keyPoints&&(<div style={{background:"rgba(196,160,80,0.06)",border:"1px solid rgba(196,160,80,0.2)",borderRadius:4,padding:"8px 12px"}}><div style={{fontSize:10,color:"#c4a050",marginBottom:4}}>📌 覚えるべきポイント</div><div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.6}}>{q.keyPoints}</div></div>)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Practice ──────────────────────────────────────────────────────────────────
function Practice({questions,updateQ,initialMode,singleQId,clearSingleQ,apiKey,onOpenSettings}){
  const [filterTopic,setFilterTopic]=useState("All");
  const [srMode,setSrMode]=useState(initialMode||"due");
  const [queue,setQueue]=useState(null);
  const [qIdx,setQIdx]=useState(0);
  const [selected,setSelected]=useState(null);
  const [revealed,setRevealed]=useState(false);
  const [showJA,setShowJA]=useState(false);
  const [showChoicesJA,setShowChoicesJA]=useState(false);
  const [showKP,setShowKP]=useState(false);
  const [sessionResults,setSessionResults]=useState([]);

  // auto-start single question mode
  useEffect(()=>{
    if(singleQId){
      const q=questions.find(x=>x.id===singleQId);
      if(q){setQueue([q]);setQIdx(0);setSelected(null);setRevealed(false);setShowJA(false);setShowChoicesJA(false);setShowKP(false);setSessionResults([]);}
    }
  },[singleQId]);

  const topics=["All",...CFA_TOPICS.filter(t=>questions.some(q=>q.topic===t))];
  const getPool=()=>{let p=questions.filter(q=>filterTopic==="All"||q.topic===filterTopic);if(srMode==="due")p=p.filter(isDueToday);return p;};

  function startSession(){
    const pool=getPool();if(!pool.length)return;
    const sorted=[...pool].sort((a,b)=>daysUntil(a)-daysUntil(b));
    setQueue(sorted);setQIdx(0);setSelected(null);setRevealed(false);setShowJA(false);setShowChoicesJA(false);setShowKP(false);setSessionResults([]);
  }

  function handleChoice(idx){
    if(selected!==null)return;
    setSelected(idx);
    const q=queue[qIdx];const correct=idx===q.correctIndex;
    const sr=sm2Update(q,correct);
    const updated={...q,attemptCount:q.attemptCount+1,wrongCount:q.wrongCount+(correct?0:1),lastAttempted:new Date().toISOString(),...sr};
    updateQ(updated);setQueue(prev=>prev.map((x,i)=>i===qIdx?updated:x));
    setSessionResults(prev=>[...prev,{id:q.id,correct,srInterval:sr.srInterval,questionEN:q.questionEN}]);
  }

  function next(){
    if(qIdx+1>=queue.length){setQueue(null);if(singleQId)clearSingleQ();return;}
    setQIdx(i=>i+1);setSelected(null);setRevealed(false);setShowJA(false);setShowChoicesJA(false);setShowKP(false);
  }

  function handleBack(){setQueue(null);if(singleQId)clearSingleQ();}

  // ── Config screen ──
  if(!queue){
    const pool=getPool();const doneCount=sessionResults.length;const correctCount=sessionResults.filter(r=>r.correct).length;
    return(
      <div>
        {doneCount>0&&(<div style={{...S.card,borderColor:"rgba(74,173,139,0.3)",marginBottom:16}}>
          <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:10}}>SESSION RESULT</div>
          <div style={{display:"flex",gap:20,alignItems:"flex-end",marginBottom:14}}>
            <div><div style={{fontSize:32,fontWeight:"bold",color:"#4aad8b"}}>{correctCount}<span style={{fontSize:18,color:"#3a8a6a"}}>/{doneCount}</span></div><div style={{fontSize:11,color:"#5a7a6a"}}>正解数</div></div>
            <div><div style={{fontSize:28,fontWeight:"bold",color:"#c4a050"}}>{doneCount>0?Math.round((correctCount/doneCount)*100):0}%</div><div style={{fontSize:11,color:"#7a6a4a"}}>正答率</div></div>
          </div>
          <div style={{maxHeight:180,overflowY:"auto"}}>
            {sessionResults.map((r,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,fontSize:12}}><span style={{color:r.correct?"#4aad8b":"#e05a5a",minWidth:16}}>{r.correct?"✓":"✗"}</span><span style={{flex:1,color:"#8a9ab0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.questionEN.slice(0,55)}…</span><span style={{color:"#5a7a8a",fontSize:11,minWidth:52,textAlign:"right"}}>次回 {r.srInterval}日後</span></div>))}
          </div>
        </div>)}
        <div style={S.sectionTitle}>演習設定</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
          {[["due","🔁 復習期限の問題","SM-2で今日が期限の問題"],["all","📚 全問から演習","全問題からランダム"]].map(([mode,title,desc])=>(<button key={mode} onClick={()=>setSrMode(mode)} style={{background:srMode===mode?"rgba(196,160,80,0.12)":"rgba(255,255,255,0.02)",border:`1px solid ${srMode===mode?"rgba(196,160,80,0.5)":"rgba(196,160,80,0.15)"}`,borderRadius:6,padding:"12px 10px",cursor:"pointer",textAlign:"left"}}><div style={{fontSize:13,color:srMode===mode?"#c4a050":"#8a9ab0",marginBottom:4}}>{title}</div><div style={{fontSize:10,color:"#5a6a7a"}}>{desc}</div></button>))}
        </div>
        <label style={S.label}>分野を選択</label>
        <select value={filterTopic} onChange={e=>setFilterTopic(e.target.value)} style={S.input}>{topics.map(t=><option key={t} value={t} style={{background:"#0d1b2e"}}>{t==="All"?"全分野":t}</option>)}</select>
        <div style={{fontSize:12,color:pool.length===0?"#e05a5a":"#4aad8b",marginBottom:14}}>{srMode==="due"?`今日の復習: ${pool.length} 問`:`対象: ${pool.length} 問`}</div>
        {pool.length===0&&srMode==="due"&&(<div style={{...S.card,textAlign:"center",padding:20,borderColor:"rgba(74,173,139,0.3)",marginBottom:14}}><div style={{fontSize:24,marginBottom:8}}>🎉</div><div style={{color:"#4aad8b",fontSize:14}}>今日の復習は完了しています！</div></div>)}
        <button disabled={pool.length===0} onClick={startSession} style={{...S.btn("primary"),width:"100%",padding:14,fontSize:15,opacity:pool.length===0?0.4:1}}>演習を開始する →</button>
      </div>
    );
  }

  const q=queue[qIdx];const answered=selected!==null;
  const labels=["A","B","C","D","E"];
  const choiceState=idx=>{if(!answered)return"default";if(idx===q.correctIndex&&idx===selected)return"correct";if(idx===selected&&idx!==q.correctIndex)return"wrong";if(idx===q.correctIndex)return"reveal-correct";return"default";};
  const lastResult=sessionResults[sessionResults.length-1];
  const relatedQs=(q.relatedIds||[]).map(id=>questions.find(x=>x.id===id)).filter(Boolean);

  return(
    <div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
        <button onClick={handleBack} style={{...S.btn("ghost"),padding:"4px 8px"}}><Ic.back/></button>
        <div style={{flex:1,height:4,background:"rgba(255,255,255,0.08)",borderRadius:2}}><div style={{width:`${(qIdx/queue.length)*100}%`,height:"100%",background:"#c4a050",borderRadius:2,transition:"width 0.3s"}}/></div>
        <div style={{fontSize:11,color:"#7a8a9a",minWidth:48,textAlign:"right"}}>{qIdx+1} / {queue.length}</div>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
        <span style={S.tag()}>{q.topic}</span><span style={S.tag(diffColor(q.difficulty))}>{q.difficulty}</span><SRBadge q={q}/>
      </div>
      <div style={{...S.card,borderColor:"rgba(196,160,80,0.35)",marginBottom:10}}>
        <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:8}}>QUESTION</div>
        <div style={{fontSize:15,lineHeight:1.7,color:"#f0e8d8"}}>{q.questionEN}</div>
        {q.questionJA&&(<div style={{marginTop:10}}><button onClick={()=>setShowJA(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,display:"flex",alignItems:"center",gap:5}}>{showJA?<Ic.eyeOff/>:<Ic.eye/>} 日本語訳</button>{showJA&&<div style={{marginTop:8,padding:"10px 12px",background:"rgba(100,130,160,0.08)",borderRadius:4,border:"1px solid rgba(100,130,160,0.2)",fontSize:13,color:"#98afc0",lineHeight:1.7}}>{q.questionJA}</div>}</div>)}
      </div>
      {q.choices.some((_,i)=>(q.choicesJA||[])[i]?.trim())&&(<div style={{marginBottom:6}}><button onClick={()=>setShowChoicesJA(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,display:"flex",alignItems:"center",gap:5}}>{showChoicesJA?<Ic.eyeOff/>:<Ic.eye/>} 選択肢の日本語訳</button></div>)}
      <div style={{marginBottom:10}}>
        {q.choices.filter(c=>c.trim()).map((choice,idx)=>{const jaText=(q.choicesJA||[])[idx];return(<button key={idx} style={S.choiceBtn(choiceState(idx))} onClick={()=>handleChoice(idx)}><div style={{flex:1}}><div style={{display:"flex",alignItems:"flex-start",gap:8}}><span style={{fontWeight:"bold",minWidth:20,opacity:0.7,flexShrink:0}}>{labels[idx]}.</span><span style={{lineHeight:1.5}}>{choice}</span></div>{showChoicesJA&&jaText&&<div style={{marginTop:4,marginLeft:28,fontSize:12,color:"#7a8a9a",lineHeight:1.5}}>{jaText}</div>}</div>{choiceState(idx)==="correct"&&<span style={{marginLeft:"auto",flexShrink:0}}><Ic.check/></span>}{choiceState(idx)==="wrong"&&<span style={{marginLeft:"auto",flexShrink:0}}><Ic.xmark/></span>}{choiceState(idx)==="reveal-correct"&&<span style={{marginLeft:"auto",flexShrink:0}}><Ic.check/></span>}</button>);})}
      </div>
      {answered&&(
        <div>
          {lastResult&&(<div style={{...S.card,borderColor:lastResult.correct?"rgba(74,173,139,0.4)":"rgba(224,90,90,0.3)",background:lastResult.correct?"rgba(74,173,139,0.06)":"rgba(224,90,90,0.06)",marginBottom:10,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:22}}>{lastResult.correct?"✓":"✗"}</span><div><div style={{fontSize:13,color:lastResult.correct?"#4aad8b":"#e05a5a",fontWeight:"bold"}}>{lastResult.correct?"正解！":"不正解"}</div><div style={{fontSize:11,color:"#7a8a9a"}}>次回: <strong style={{color:"#c4a050"}}>{lastResult.srInterval}日後</strong>{lastResult.correct?(lastResult.srInterval>=14?" 🚀":lastResult.srInterval>=7?" 👍":" 📖"):" — リセット"}</div></div></div>)}
          <div style={{...S.card,marginBottom:8}}>
            <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:8}}>EXPLANATION</div>
            <div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.7}}>{q.explanationEN}</div>
            {q.explanationJA&&(<div style={{marginTop:10}}><button onClick={()=>setRevealed(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,display:"flex",alignItems:"center",gap:5}}>{revealed?<Ic.eyeOff/>:<Ic.eye/>} 日本語解説</button>{revealed&&<div style={{marginTop:8,padding:"10px 12px",background:"rgba(100,130,160,0.08)",borderRadius:4,border:"1px solid rgba(100,130,160,0.2)",fontSize:13,color:"#98afc0",lineHeight:1.7}}>{q.explanationJA}</div>}</div>)}
          </div>
          {q.keyPoints&&(<div style={{marginBottom:10}}><button onClick={()=>setShowKP(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,display:"flex",alignItems:"center",gap:5}}><Ic.flag/> 覚えるべきポイント</button>{showKP&&<div style={{marginTop:8,padding:"12px",background:"rgba(196,160,80,0.06)",borderRadius:4,border:"1px solid rgba(196,160,80,0.25)",fontSize:13,color:"#d4c08a",lineHeight:1.7}}>📌 {q.keyPoints}</div>}</div>)}
          {/* Related Questions */}
          {relatedQs.length>0&&(<div style={{...S.card,borderColor:"rgba(155,143,212,0.3)",marginBottom:10}}><div style={{fontSize:10,color:"#9b8fd4",letterSpacing:"0.15em",marginBottom:8,display:"flex",alignItems:"center",gap:5}}><Ic.link/> 関連問題</div>{relatedQs.map(rq=>(<div key={rq.id} style={{marginBottom:6,padding:"8px 10px",background:"rgba(155,143,212,0.06)",borderRadius:4,border:"1px solid rgba(155,143,212,0.15)"}}><div style={{display:"flex",gap:6,marginBottom:4}}><span style={S.tag("#9b8fd4")}>{rq.topic.split(" ").slice(0,2).join(" ")}</span><span style={S.tag(diffColor(rq.difficulty))}>{rq.difficulty}</span></div><div style={{fontSize:12,color:"#a0b0c0",lineHeight:1.5}}>{rq.questionEN.slice(0,100)}…</div></div>))}</div>)}
          {/* AI Chat */}
          <AiChat question={q} apiKey={apiKey} onOpenSettings={onOpenSettings}/>
          <button style={{...S.btn("primary"),width:"100%",padding:12}} onClick={next}>{qIdx+1>=queue.length?"結果を見る":"次の問題 →"}</button>
        </div>
      )}
    </div>
  );
}

// ── NoteList ──────────────────────────────────────────────────────────────────
function NoteList({notes,questions,setPage,setEditNote,deleteNote}){
  const [search,setSearch]=useState("");
  const filtered=notes.filter(n=>search===""||n.title.includes(search)||n.content.includes(search));
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:11,color:"#5a6a7a"}}>{notes.length} ノート</div>
        <button onClick={()=>{setEditNote(null);setPage("note-edit");}} style={{...S.btn("primary"),padding:"7px 14px",fontSize:12,display:"flex",alignItems:"center",gap:5}}><Ic.plus/> 新規ノート</button>
      </div>
      <input value={search} onChange={e=>setSearch(e.target.value)} style={{...S.input,marginBottom:12,fontSize:12}} placeholder="ノートを検索..."/>
      {filtered.length===0&&<div style={{...S.card,textAlign:"center",padding:30,color:"#5a6a7a"}}>{notes.length===0?"ノートはまだありません。「新規ノート」から作成できます。":"該当するノートがありません"}</div>}
      {filtered.map(note=>{
        const linkedQs=(note.relatedIds||[]).map(id=>questions.find(q=>q.id===id)).filter(Boolean);
        return(
          <div key={note.id} style={S.card}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
              <div style={{flex:1}}>
                <div style={{fontSize:15,color:"#f0e8d8",fontWeight:"bold",marginBottom:4}}>{note.title||"（タイトルなし）"}</div>
                <div style={{fontSize:12,color:"#7a8a9a",lineHeight:1.5,marginBottom:6}}>{note.content.slice(0,120)}{note.content.length>120?"…":""}</div>
                {linkedQs.length>0&&(<div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{linkedQs.map(q=><span key={q.id} style={{...S.tag("#9b8fd4"),display:"inline-flex",alignItems:"center",gap:3}}><Ic.link/>{q.topic.split(" ")[0]}</span>)}</div>)}
                <div style={{fontSize:10,color:"#4a5a6a",marginTop:6}}>{note.updatedAt?new Date(note.updatedAt).toLocaleDateString("ja-JP"):""}</div>
              </div>
              <div style={{display:"flex",gap:5,flexShrink:0}}>
                <button onClick={()=>{setEditNote(note);setPage("note-edit");}} style={{...S.btn("ghost"),padding:"6px 8px"}}><Ic.edit/></button>
                <button onClick={()=>{if(confirm("削除しますか？"))deleteNote(note.id);}} style={{...S.btn("danger"),padding:"6px 8px"}}><Ic.trash/></button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── NoteEditor ────────────────────────────────────────────────────────────────
function NoteEditor({editNote,setEditNote,addNote,updateNote,questions,setPage}){
  const [form,setForm]=useState(()=>editNote?{...editNote}:{...BLANK_NOTE,id:uid(),createdAt:new Date().toISOString()});
  const [showPicker,setShowPicker]=useState(false);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  function submit(){
    if(!form.title.trim()&&!form.content.trim())return alert("タイトルまたは内容を入力してください");
    const saved={...form,updatedAt:new Date().toISOString()};
    editNote?updateNote(saved):addNote(saved);
    setEditNote(null);setPage("notes");
  }
  const linkedQs=(form.relatedIds||[]).map(id=>questions.find(q=>q.id===id)).filter(Boolean);
  return(
    <div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button onClick={()=>{setEditNote(null);setPage("notes");}} style={{...S.btn("ghost"),padding:"6px 10px"}}><Ic.back/></button>
        <div style={{fontSize:14,color:"#c4a050",letterSpacing:"0.1em"}}>{editNote?"ノートを編集":"新規ノート"}</div>
      </div>
      <label style={S.label}>タイトル</label>
      <input value={form.title} onChange={e=>set("title",e.target.value)} style={S.input} placeholder="ノートのタイトル..."/>
      <label style={S.label}>内容</label>
      <textarea value={form.content} onChange={e=>set("content",e.target.value)} style={{...S.textarea,minHeight:200}} placeholder="まとめ・メモ・気づきなど自由に記述..."/>
      {/* Related Questions */}
      <div style={{borderTop:"1px solid rgba(196,160,80,0.15)",paddingTop:14,marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:10,color:"#9b8fd4",letterSpacing:"0.15em",display:"flex",alignItems:"center",gap:5}}><Ic.link/> 関連問題リンク</div>
          <button onClick={()=>setShowPicker(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,borderColor:"rgba(155,143,212,0.4)",color:"#9b8fd4"}}>{showPicker?"閉じる":"問題を紐づける"}</button>
        </div>
        {linkedQs.length>0&&(<div style={{marginBottom:10}}>{linkedQs.map(q=>(<div key={q.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,padding:"6px 10px",background:"rgba(155,143,212,0.06)",borderRadius:4,border:"1px solid rgba(155,143,212,0.15)"}}><div style={{flex:1}}><div style={{display:"flex",gap:4,marginBottom:2}}><span style={S.tag("#9b8fd4")}>{q.topic.split(" ").slice(0,2).join(" ")}</span></div><div style={{fontSize:12,color:"#a0b0c0"}}>{q.questionEN.slice(0,70)}…</div></div><button onClick={()=>set("relatedIds",(form.relatedIds||[]).filter(i=>i!==q.id))} style={{...S.btn("danger"),padding:"4px 7px",fontSize:11}}>×</button></div>))}</div>)}
        {showPicker&&<RelatedQuestionPicker questions={questions} selected={form.relatedIds||[]} onChange={ids=>set("relatedIds",ids)} currentId={form.id}/>}
      </div>
      <button style={{...S.btn("primary"),width:"100%",padding:14,fontSize:15}} onClick={submit}>{editNote?"変更を保存する":"ノートを保存する"}</button>
    </div>
  );
}

// ── AddQuestion ───────────────────────────────────────────────────────────────
function AddQuestion({editQ,setEditQ,addQ,updateQ,questions,setPage}){
  const [form,setForm]=useState(()=>editQ?{...editQ,relatedIds:editQ.relatedIds||[]}:{...BLANK_Q,id:uid()});
  const [translating,setTranslating]=useState({});
  const [transError,setTransError]=useState(null);
  const [showRelated,setShowRelated]=useState(false);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const setChoice=(idx,val)=>setForm(f=>{const c=[...f.choices];c[idx]=val;return{...f,choices:c};});
  const setChoiceJA=(idx,val)=>setForm(f=>{const c=[...(f.choicesJA||[])];c[idx]=val;return{...f,choicesJA:c};});
  const addChoice=()=>setForm(f=>({...f,choices:[...f.choices,""],choicesJA:[...(f.choicesJA||[]),""],}));
  const removeChoice=idx=>setForm(f=>({...f,choices:f.choices.filter((_,i)=>i!==idx),choicesJA:(f.choicesJA||[]).filter((_,i)=>i!==idx),correctIndex:f.correctIndex>=idx&&f.correctIndex>0?f.correctIndex-1:f.correctIndex}));
  async function translateField(text,targetKey){if(!text.trim())return;setTranslating(t=>({...t,[targetKey]:true}));setTransError(null);try{const r=await translateEN2JA(text);set(targetKey,r);}catch(e){setTransError("翻訳失敗: "+e.message);}finally{setTranslating(t=>({...t,[targetKey]:false}));}}
  async function translateChoiceJA(idx){const text=form.choices[idx];if(!text.trim())return;const key=`cJA_${idx}`;setTranslating(t=>({...t,[key]:true}));setTransError(null);try{const r=await translateEN2JA(text);setChoiceJA(idx,r);}catch(e){setTransError("翻訳失敗: "+e.message);}finally{setTranslating(t=>({...t,[key]:false}));}}
  async function translateAll(){setTransError(null);const tasks=[];if(form.questionEN.trim()&&!form.questionJA.trim())tasks.push(translateField(form.questionEN,"questionJA"));if(form.explanationEN.trim()&&!form.explanationJA.trim())tasks.push(translateField(form.explanationEN,"explanationJA"));form.choices.forEach((c,i)=>{if(c.trim()&&!(form.choicesJA||[])[i]?.trim())tasks.push(translateChoiceJA(i));});for(const t of tasks)await t;}
  function submit(){if(!form.questionEN.trim())return alert("問題文（英語）を入力してください");if(form.choices.filter(c=>c.trim()).length<2)return alert("選択肢を2つ以上入力してください");editQ?updateQ(form):addQ(form);setEditQ(null);setPage("list");}
  const labels=["A","B","C","D","E"];const anyTranslating=Object.values(translating).some(Boolean);
  const canTranslateAll=(form.questionEN.trim()&&!form.questionJA.trim())||(form.explanationEN.trim()&&!form.explanationJA.trim())||form.choices.some((c,i)=>c.trim()&&!(form.choicesJA||[])[i]?.trim());
  const linkedQs=(form.relatedIds||[]).map(id=>questions.find(q=>q.id===id)).filter(Boolean);
  return(
    <div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button onClick={()=>{setEditQ(null);setPage("list");}} style={{...S.btn("ghost"),padding:"6px 10px"}}><Ic.back/></button>
        <div style={{fontSize:14,color:"#c4a050",letterSpacing:"0.1em"}}>{editQ?"問題を編集":"新しい問題を登録"}</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:10,marginBottom:4}}>
        <div><label style={S.label}>分野 *</label><select value={form.topic} onChange={e=>set("topic",e.target.value)} style={S.input}>{CFA_TOPICS.map(t=><option key={t} value={t} style={{background:"#0d1b2e"}}>{t}</option>)}</select></div>
        <div><label style={S.label}>難易度</label><select value={form.difficulty} onChange={e=>set("difficulty",e.target.value)} style={{...S.input,width:100}}>{DIFFICULTY.map(d=><option key={d} value={d} style={{background:"#0d1b2e"}}>{d}</option>)}</select></div>
      </div>
      <label style={S.label}>問題文（英語） *</label>
      <textarea value={form.questionEN} onChange={e=>set("questionEN",e.target.value)} style={{...S.textarea,minHeight:100}} placeholder="Enter the question text in English..."/>
      <label style={S.label}>選択肢 * （正解をクリックして選択）</label>
      {form.choices.map((choice,idx)=>{const jaVal=(form.choicesJA||[])[idx]||"";const isTrans=!!translating[`cJA_${idx}`];return(<div key={idx} style={{marginBottom:12}}><div style={{display:"flex",gap:6,alignItems:"flex-start",marginBottom:4}}><button onClick={()=>set("correctIndex",idx)} style={{minWidth:32,height:36,borderRadius:4,border:`2px solid ${form.correctIndex===idx?"#4aad8b":"rgba(196,160,80,0.3)"}`,background:form.correctIndex===idx?"rgba(74,173,139,0.2)":"transparent",color:form.correctIndex===idx?"#4aad8b":"#5a6a7a",cursor:"pointer",fontSize:12,fontWeight:"bold",display:"flex",alignItems:"center",justifyContent:"center"}}>{labels[idx]}</button><input value={choice} onChange={e=>setChoice(idx,e.target.value)} style={{...S.input,marginBottom:0,flex:1}} placeholder={`Choice ${labels[idx]} (English)`}/>{form.choices.length>2&&<button onClick={()=>removeChoice(idx)} style={{...S.btn("danger"),padding:"6px 8px",minWidth:32,height:36}}><Ic.trash/></button>}</div><div style={{display:"flex",gap:6,alignItems:"center",paddingLeft:38}}><input value={jaVal} onChange={e=>setChoiceJA(idx,e.target.value)} style={{...S.input,marginBottom:0,flex:1,fontSize:13,borderColor:jaVal?"rgba(100,180,220,0.3)":"rgba(196,160,80,0.15)"}} placeholder={`選択肢 ${labels[idx]} の日本語訳`}/>{choice.trim()&&<TranslateBtn loading={isTrans} onClick={()=>translateChoiceJA(idx)}/>}</div></div>);})}
      {form.choices.length<5&&<button onClick={addChoice} style={{...S.btn("ghost"),fontSize:12,marginBottom:14}}>+ 選択肢を追加</button>}
      <label style={S.label}>解説（英語）</label>
      <textarea value={form.explanationEN} onChange={e=>set("explanationEN",e.target.value)} style={S.textarea} placeholder="Explanation in English..."/>
      <div style={{borderTop:"1px solid rgba(196,160,80,0.15)",paddingTop:14,marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em"}}>日本語セクション</div>
        {canTranslateAll&&<button onClick={translateAll} disabled={anyTranslating} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"6px 14px",borderRadius:4,border:"1px solid rgba(100,180,220,0.5)",background:anyTranslating?"rgba(100,180,220,0.05)":"rgba(100,180,220,0.15)",color:anyTranslating?"#5a8aaa":"#80c8e8",cursor:anyTranslating?"not-allowed":"pointer",fontSize:12,fontWeight:"bold"}}>{anyTranslating?<><span style={{display:"inline-block",animation:"spin 1s linear infinite"}}>⟳</span> 翻訳中...</>:<>🌐 まとめて自動翻訳</>}</button>}
      </div>
      {transError&&<div style={{background:"rgba(224,90,90,0.1)",border:"1px solid rgba(224,90,90,0.3)",borderRadius:4,padding:"8px 12px",marginBottom:12,fontSize:12,color:"#e08a8a"}}>⚠️ {transError}</div>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}><label style={{...S.label,marginBottom:0}}>問題文（日本語訳）</label><TranslateBtn loading={!!translating.questionJA} onClick={()=>translateField(form.questionEN,"questionJA")}/></div>
      <textarea value={form.questionJA} onChange={e=>set("questionJA",e.target.value)} style={{...S.textarea,borderColor:form.questionJA?"rgba(100,180,220,0.3)":"rgba(196,160,80,0.25)"}} placeholder="問題の日本語訳を入力..."/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}><label style={{...S.label,marginBottom:0}}>解説（日本語）</label><TranslateBtn loading={!!translating.explanationJA} onClick={()=>translateField(form.explanationEN,"explanationJA")}/></div>
      <textarea value={form.explanationJA} onChange={e=>set("explanationJA",e.target.value)} style={{...S.textarea,borderColor:form.explanationJA?"rgba(100,180,220,0.3)":"rgba(196,160,80,0.25)"}} placeholder="解説の日本語訳を入力..."/>
      <label style={S.label}>📌 覚えるべきポイント</label>
      <textarea value={form.keyPoints} onChange={e=>set("keyPoints",e.target.value)} style={{...S.textarea,borderColor:"rgba(196,160,80,0.4)"}} placeholder="試験に向けて覚えておくべきポイント..."/>
      {/* Related Questions */}
      <div style={{borderTop:"1px solid rgba(196,160,80,0.15)",paddingTop:14,marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:10,color:"#9b8fd4",letterSpacing:"0.15em",display:"flex",alignItems:"center",gap:5}}><Ic.link/> 関連問題リンク</div>
          <button onClick={()=>setShowRelated(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,borderColor:"rgba(155,143,212,0.4)",color:"#9b8fd4"}}>{showRelated?"閉じる":"問題を紐づける"}</button>
        </div>
        {linkedQs.length>0&&<div style={{fontSize:11,color:"#9b8fd4",marginBottom:8}}>{linkedQs.map(q=><span key={q.id} style={{...S.tag("#9b8fd4"),marginRight:4,marginBottom:4,display:"inline-flex",alignItems:"center",gap:3}}><Ic.link/>{q.questionEN.slice(0,30)}…</span>)}</div>}
        {showRelated&&<RelatedQuestionPicker questions={questions} selected={form.relatedIds||[]} onChange={ids=>set("relatedIds",ids)} currentId={form.id}/>}
      </div>
      <button style={{...S.btn("primary"),width:"100%",padding:14,fontSize:15}} onClick={submit}>{editQ?"変更を保存する":"問題を登録する"}</button>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App(){
  const [questions,setQuestions]=useState([]);
  const [notes,setNotes]=useState([]);
  const [page,setPage]=useState("home");
  const [editQ,setEditQ]=useState(null);
  const [editNote,setEditNote]=useState(null);
  const [loaded,setLoaded]=useState(false);
  const [practiceMode,setPracticeMode]=useState("due");
  const [singleQId,setSingleQId]=useState(null);
  const [showSettings,setShowSettings]=useState(false);
  const [apiKey,setApiKeyState]=useState(LS.getKey());

  useEffect(()=>{setQuestions(LS.getQ());setNotes(LS.getN());setLoaded(true);},[]);

  const persistQ=useCallback(qs=>{setQuestions(qs);LS.setQ(qs);},[]);
  const persistN=useCallback(ns=>{setNotes(ns);LS.setN(ns);},[]);

  const addQ=q=>persistQ([...questions,q]);
  const updateQ=q=>persistQ(questions.map(x=>x.id===q.id?q:x));
  const deleteQ=id=>persistQ(questions.filter(q=>q.id!==id));
  const addNote=n=>persistN([...notes,n]);
  const updateNote=n=>persistN(notes.map(x=>x.id===n.id?n:x));
  const deleteNote=id=>persistN(notes.filter(n=>n.id!==id));

  function startSingleQ(id){setSingleQId(id);setPracticeMode("all");setPage("practice");}
  function clearSingleQ(){setSingleQId(null);}

  function handleSettingsClose(){setApiKeyState(LS.getKey());setShowSettings(false);}

  const dueCount=questions.filter(isDueToday).length;

  if(!loaded)return(<div style={{...S.app,alignItems:"center",justifyContent:"center"}}><div style={{color:"#c4a050",letterSpacing:"0.2em",fontSize:12}}>LOADING...</div></div>);

  const navItems=[
    {key:"home",label:"Home",icon:Ic.home},
    {key:"list",label:"一覧",icon:Ic.list},
    {key:"add",label:"登録",icon:Ic.plus},
    {key:"practice",label:"演習",icon:Ic.play},
    {key:"notes",label:"ノート",icon:Ic.note},
  ];

  const showNav=page!=="add"&&page!=="note-edit";

  return(
    <div style={S.app}>
      <SettingsModal open={showSettings} onClose={handleSettingsClose}/>
      <div style={S.header}>
        <div style={{display:"flex",flexDirection:"column",gap:1}}>
          <div style={{fontSize:11,letterSpacing:"0.25em",color:"#c4a050",textTransform:"uppercase"}}>CFA® Review</div>
          <div style={{fontSize:15,fontWeight:"bold",color:"#f0e8d8",letterSpacing:"0.05em"}}>My Question Bank</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {dueCount>0&&(<div onClick={()=>{setPracticeMode("due");setPage("practice");}} style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",background:"rgba(74,173,139,0.12)",border:"1px solid rgba(74,173,139,0.3)",borderRadius:4,padding:"3px 9px"}}><Ic.bell/><span style={{fontSize:11,color:"#4aad8b"}}>{dueCount}問</span></div>)}
          <button onClick={()=>setShowSettings(true)} style={{background:"none",border:"none",cursor:"pointer",color:"#5a6a7a",padding:4,display:"flex",alignItems:"center"}}><Ic.settings/></button>
        </div>
      </div>
      <div style={S.content}>
        {page==="home"&&<Dashboard questions={questions} notes={notes} setPage={setPage} setPracticeMode={setPracticeMode}/>}
        {page==="list"&&<QuestionList questions={questions} setPage={setPage} setEditQ={setEditQ} deleteQ={deleteQ} startSingleQ={startSingleQ}/>}
        {page==="add"&&<AddQuestion editQ={editQ} setEditQ={setEditQ} addQ={addQ} updateQ={updateQ} questions={questions} setPage={setPage}/>}
        {page==="practice"&&<Practice questions={questions} updateQ={updateQ} initialMode={practiceMode} singleQId={singleQId} clearSingleQ={clearSingleQ} apiKey={apiKey} onOpenSettings={()=>setShowSettings(true)}/>}
        {page==="notes"&&<NoteList notes={notes} questions={questions} setPage={setPage} setEditNote={setEditNote} deleteNote={deleteNote}/>}
        {page==="note-edit"&&<NoteEditor editNote={editNote} setEditNote={setEditNote} addNote={addNote} updateNote={updateNote} questions={questions} setPage={setPage}/>}
      </div>
      {showNav&&(<div style={S.nav}>
        {navItems.map(item=>(<button key={item.key} style={S.navBtn(page===item.key||( item.key==="notes"&&page==="note-edit"))} onClick={()=>{setEditQ(null);setSingleQId(null);setPage(item.key);}}>
          <item.icon/>{item.label}
          {item.key==="practice"&&dueCount>0&&(<span style={{position:"absolute",top:0,right:4,background:"#4aad8b",color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center"}}>{dueCount}</span>)}
        </button>))}
      </div>)}
    </div>
  );
}
