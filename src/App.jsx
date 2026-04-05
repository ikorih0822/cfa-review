import { useState, useEffect, useCallback, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, signOut, GoogleAuthProvider, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc } from "firebase/firestore";

// ── Firebase ──────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyC-euKAW8FRPX-8WGEOIQFSgK9Yd4vSrrs",
  authDomain: "cfa-review.firebaseapp.com",
  projectId: "cfa-review",
  storageBucket: "cfa-review.firebasestorage.app",
  messagingSenderId: "864490102134",
  appId: "1:864490102134:web:b51b4a4e10f2d1b7a66e57",
};
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const provider = new GoogleAuthProvider();

async function fbLoadQuestions(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid, "data", "questions"));
    if (snap.exists()) return snap.data().list || [];
    // マイグレーション: localStorageに旧データがあればFirebaseに移行
    const legacy = localStorage.getItem("cfa:questions") || localStorage.getItem("cfa:q");
    if (legacy) {
      const qs = JSON.parse(legacy);
      await setDoc(doc(db, "users", uid, "data", "questions"), { list: qs });
      return qs;
    }
    return [];
  } catch { return []; }
}
async function fbSaveQuestions(uid, qs) {
  try { await setDoc(doc(db, "users", uid, "data", "questions"), { list: qs }); } catch(e) { console.error(e); }
}
async function fbLoadNotes(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid, "data", "notes"));
    return snap.exists() ? snap.data().list || [] : [];
  } catch { return []; }
}
async function fbSaveNotes(uid, ns) {
  try { await setDoc(doc(db, "users", uid, "data", "notes"), { list: ns }); } catch(e) { console.error(e); }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CFA_TOPICS = ["Ethics & Professional Standards","Quantitative Methods","Economics","Financial Statement Analysis","Corporate Issuers","Equity Investments","Fixed Income","Derivatives","Alternative Investments","Portfolio Management","Wealth Planning"];
const DIFFICULTY = ["Easy","Medium","Hard"];
function getTomorrow() { const d=new Date(); d.setDate(d.getDate()+1); return d.toISOString().split("T")[0]; }
const BLANK_Q = { id:null, topic:CFA_TOPICS[0], difficulty:"Medium", questionEN:"", choices:["","",""], choicesJA:["","",""], correctIndex:0, explanationEN:"", questionJA:"", explanationJA:"", keyPoints:"", relatedIds:[], attemptCount:0, wrongCount:0, lastAttempted:null, srInterval:1, srEaseFactor:2.5, srRepetitions:0, srNextReview:null, savedChats:[], tableData:null, vignetteText:"", questionImages:[], vignetteImages:[] };
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
function isDueToday(q) {
  if(!q.srNextReview) return false; // 未学習 = まだ期限なし（登録翌日から）
  return q.srNextReview<=new Date().toISOString().split("T")[0];
}
function daysUntil(q) { if(!q.srNextReview)return 0; const t=new Date();t.setHours(0,0,0,0);const n=new Date(q.srNextReview);n.setHours(0,0,0,0);return Math.round((n-t)/86400000); }
function reviewLabel(q) { if(!q.srNextReview)return{label:"明日",color:"#c4a050"}; const d=daysUntil(q); if(d<0)return{label:`${Math.abs(d)}日超過`,color:"#e05a5a"}; if(d===0)return{label:"今日",color:"#4aad8b"}; if(d===1)return{label:"明日",color:"#c4a050"}; return{label:`${d}日後`,color:"#6b9fd4"}; }

// ── Translation ───────────────────────────────────────────────────────────────
function splitChunks(t,max=400){if(t.length<=max)return[t];const r=[];let s=t;while(s.length>max){let c=s.lastIndexOf(". ",max);if(c<50)c=s.lastIndexOf(" ",max);if(c<50)c=max;r.push(s.slice(0,c+1).trim());s=s.slice(c+1).trim();}if(s)r.push(s);return r;}
async function gtrans(text){const u=`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=${encodeURIComponent(text)}`;const r=await fetch(u);if(!r.ok)throw new Error(`${r.status}`);const d=await r.json();return d[0].map(s=>s[0]).join("");}
async function mymem(text){const u=`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ja`;const r=await fetch(u);const d=await r.json();if(Number(d.responseStatus)===200)return d.responseData.translatedText;throw new Error("failed");}
async function translateEN2JA(text){if(!text.trim())return"";const chunks=splitChunks(text);const res=[];for(const c of chunks){let t;try{t=await gtrans(c)}catch{try{t=await mymem(c)}catch{throw new Error("翻訳サービスに接続できませんでした");}}res.push(t);if(chunks.length>1)await new Promise(r=>setTimeout(r,300));}return res.join(" ");}

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
const getApiKey = () => localStorage.getItem("cfa:apikey")||"";
const setApiKey = k => localStorage.setItem("cfa:apikey", k);

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
  logout:()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="17" height="17"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
};

// ── Styles ────────────────────────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const diffColor = d => d==="Hard"?"#e05a5a":d==="Medium"?"#d4a34a":"#4aad8b";
const S = {
  app:{fontFamily:"'Georgia','Times New Roman',serif",background:"#0d1b2e",minHeight:"100vh",color:"#e8e0d0",display:"flex",flexDirection:"column",maxWidth:680,margin:"0 auto",position:"relative"},
  header:{background:"linear-gradient(135deg,#0a1628,#14263d)",borderBottom:"1px solid rgba(196,160,80,0.3)",padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100},
  content:{flex:1,padding:"16px 16px 80px",overflowY:"auto"},
  nav:{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:680,background:"linear-gradient(180deg,rgba(10,22,40,0.97),#080f1c)",borderTop:"1px solid rgba(196,160,80,0.25)",display:"flex",justifyContent:"space-around",padding:"6px 0 10px",backdropFilter:"blur(12px)",zIndex:100},
  navBtn:a=>({display:"flex",flexDirection:"column",alignItems:"center",gap:2,background:"none",border:"none",cursor:"pointer",color:a?"#c4a050":"#5a6a7a",fontSize:9,letterSpacing:"0.08em",padding:"4px 8px",transition:"color 0.2s",textTransform:"uppercase",position:"relative"}),
  card:{background:"linear-gradient(135deg,#131f30,#0f1a28)",border:"1px solid rgba(196,160,80,0.2)",borderRadius:8,padding:16,marginBottom:12},
  btn:v=>{const base={padding:v==="sm"?"5px 12px":"10px 20px",borderRadius:4,border:"none",cursor:"pointer",fontSize:v==="sm"?11:14,fontFamily:"'Georgia',serif",letterSpacing:"0.05em",fontWeight:"bold",transition:"all 0.15s"};if(v==="primary"||v==="sm")return{...base,background:"linear-gradient(135deg,#c4a050,#a8852e)",color:"#0a1628"};if(v==="ghost")return{...base,background:"transparent",color:"#c4a050",border:"1px solid rgba(196,160,80,0.4)"};if(v==="danger")return{...base,background:"#c0392b",color:"#fff"};if(v==="teal")return{...base,background:"linear-gradient(135deg,#2a8a6a,#1e6e52)",color:"#fff"};if(v==="blue")return{...base,background:"linear-gradient(135deg,#2a5a9a,#1e4070)",color:"#fff"};if(v==="google")return{...base,background:"#fff",color:"#333",border:"1px solid #ddd",display:"flex",alignItems:"center",gap:10,padding:"12px 24px"};return{...base,background:"rgba(196,160,80,0.1)",color:"#c4a050",border:"1px solid rgba(196,160,80,0.3)"};},
  input:{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(196,160,80,0.25)",borderRadius:4,padding:"8px 12px",color:"#e8e0d0",fontFamily:"'Georgia',serif",fontSize:14,width:"100%",boxSizing:"border-box",outline:"none",marginBottom:12},
  textarea:{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(196,160,80,0.25)",borderRadius:4,padding:"8px 12px",color:"#e8e0d0",fontFamily:"'Georgia',serif",fontSize:14,width:"100%",boxSizing:"border-box",outline:"none",resize:"vertical",minHeight:80,marginBottom:12},
  label:{display:"block",fontSize:11,letterSpacing:"0.12em",color:"#c4a050",textTransform:"uppercase",marginBottom:5},
  sectionTitle:{fontSize:11,letterSpacing:"0.2em",color:"#c4a050",textTransform:"uppercase",marginBottom:12,borderBottom:"1px solid rgba(196,160,80,0.2)",paddingBottom:6},
  tag:c=>({display:"inline-block",padding:"2px 8px",borderRadius:3,border:`1px solid ${c||"#c4a050"}40`,color:c||"#c4a050",fontSize:10,letterSpacing:"0.08em",textTransform:"uppercase",background:`${c||"#c4a050"}18`}),
  choiceBtn:st=>({display:"flex",alignItems:"center",gap:10,width:"100%",textAlign:"left",padding:"12px 14px",borderRadius:4,marginBottom:8,transition:"all 0.2s",fontFamily:"'Georgia',serif",fontSize:14,lineHeight:1.5,border:`1px solid ${st==="correct"?"#4aad8b":st==="wrong"?"#e05a5a":st==="reveal-correct"?"#4aad8b":st==="selected"?"rgba(196,160,80,0.7)":"rgba(196,160,80,0.2)"}`,background:st==="correct"?"rgba(74,173,139,0.12)":st==="wrong"?"rgba(224,90,90,0.12)":st==="reveal-correct"?"rgba(74,173,139,0.08)":st==="selected"?"rgba(196,160,80,0.1)":"rgba(255,255,255,0.03)",color:st==="correct"?"#4aad8b":st==="wrong"?"#e05a5a":st==="reveal-correct"?"#4aad8b":st==="selected"?"#c4a050":"#e8e0d0",cursor:(st==="correct"||st==="wrong"||st==="reveal-correct")?"default":"pointer"}),
};

// ── Login Screen ──────────────────────────────────────────────────────────────
function LoginScreen({onLogin}){
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  async function handleLogin(){
    setLoading(true);setError(null);
    try{ await signInWithPopup(auth,provider); }
    catch(e){ setError("ログインに失敗しました。もう一度お試しください。");setLoading(false); }
  }
  return(
    <div style={{...S.app,alignItems:"center",justifyContent:"center",gap:0}}>
      <div style={{textAlign:"center",padding:"40px 24px",maxWidth:360,width:"100%"}}>
        <div style={{fontSize:11,letterSpacing:"0.3em",color:"#c4a050",textTransform:"uppercase",marginBottom:8}}>CFA® Review</div>
        <div style={{fontSize:26,fontWeight:"bold",color:"#f0e8d8",marginBottom:6}}>My Question Bank</div>
        <div style={{fontSize:13,color:"#5a6a7a",marginBottom:48,lineHeight:1.7}}>間隔反復 · 日本語対応 · 全デバイス同期</div>
        <button onClick={handleLogin} disabled={loading} style={{...S.btn("google"),width:"100%",justifyContent:"center",fontSize:14,opacity:loading?0.6:1}}>
          <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 002.38-5.88c0-.57-.05-.66-.15-1.18z"/><path fill="#34A853" d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2a4.8 4.8 0 01-7.18-2.54H1.83v2.07A8 8 0 008.98 17z"/><path fill="#FBBC05" d="M4.5 10.52a4.8 4.8 0 010-3.04V5.41H1.83a8 8 0 000 7.18l2.67-2.07z"/><path fill="#EA4335" d="M8.98 4.18c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 001.83 5.4L4.5 7.49a4.77 4.77 0 014.48-3.31z"/></svg>
          {loading?"ログイン中...":"Googleでログイン"}
        </button>
        {error&&<div style={{marginTop:16,fontSize:12,color:"#e05a5a"}}>{error}</div>}
        <div style={{marginTop:32,fontSize:11,color:"#3a4a5a",lineHeight:1.8}}>ログインするとデータがクラウドに保存され<br/>スマホ・PCどこからでも同期されます</div>
      </div>
    </div>
  );
}

// ── SRBadge / TranslateBtn ────────────────────────────────────────────────────
function SRBadge({q}){const rl=reviewLabel(q);return(<span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 7px",borderRadius:3,border:`1px solid ${rl.color}40`,color:rl.color,fontSize:10,background:`${rl.color}18`,letterSpacing:"0.06em"}}><Ic.cal/>{rl.label}</span>);}
function TranslateBtn({loading,onClick}){return(<button onClick={onClick} disabled={loading} style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 10px",borderRadius:4,border:"1px solid rgba(100,180,220,0.4)",background:"rgba(100,180,220,0.1)",color:loading?"#5a8aaa":"#80c8e8",cursor:loading?"not-allowed":"pointer",fontSize:11,whiteSpace:"nowrap"}}>{loading?<><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span> ...</>:<>🌐 翻訳</>}</button>);}

// ── RelatedQuestionPicker ─────────────────────────────────────────────────────
function RelatedQuestionPicker({questions,selected,onChange,currentId}){
  const [search,setSearch]=useState("");
  const pool=questions.filter(q=>q.id!==currentId&&(search===""||q.questionEN.toLowerCase().includes(search.toLowerCase())||q.topic.toLowerCase().includes(search.toLowerCase())));
  return(<div><input value={search} onChange={e=>setSearch(e.target.value)} style={{...S.input,marginBottom:8,fontSize:12}} placeholder="問題文・分野で検索..."/><div style={{maxHeight:180,overflowY:"auto",border:"1px solid rgba(196,160,80,0.15)",borderRadius:4}}>{pool.length===0&&<div style={{padding:"12px",fontSize:12,color:"#5a6a7a",textAlign:"center"}}>該当なし</div>}{pool.map(q=>{const isSel=selected.includes(q.id);return(<div key={q.id} onClick={()=>onChange(isSel?selected.filter(i=>i!==q.id):[...selected,q.id])} style={{padding:"8px 12px",cursor:"pointer",background:isSel?"rgba(196,160,80,0.1)":"transparent",borderBottom:"1px solid rgba(255,255,255,0.04)",display:"flex",gap:8,alignItems:"flex-start"}}><span style={{color:isSel?"#c4a050":"#3a4a5a",fontSize:14,flexShrink:0,marginTop:1}}>{isSel?"☑":"☐"}</span><div><div style={{fontSize:10,color:"#7a8a9a",marginBottom:2}}>{q.topic} · {q.difficulty}</div><div style={{fontSize:12,color:isSel?"#c8bfaf":"#8a9ab0",lineHeight:1.4}}>{q.questionEN.slice(0,80)}…</div></div></div>);})}</div>{selected.length>0&&<div style={{fontSize:11,color:"#c4a050",marginTop:6}}>{selected.length}問 選択中</div>}</div>);
}

// ── AiChat ────────────────────────────────────────────────────────────────────
function SavedChats({chats, onDelete}) {
  const [openIdx, setOpenIdx] = useState(null);
  if (!chats || chats.length === 0) return null;
  return (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:10,color:"#6b9fd4",letterSpacing:"0.15em",marginBottom:6,display:"flex",alignItems:"center",gap:5}}><Ic.chat/> 保存済みAI質問履歴</div>
      {chats.map((chat, ci) => (
        <div key={ci} style={{border:"1px solid rgba(100,140,200,0.2)",borderRadius:4,marginBottom:6,overflow:"hidden"}}>
          <div onClick={()=>setOpenIdx(openIdx===ci?null:ci)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",cursor:"pointer",background:"rgba(100,140,200,0.06)"}}>
            <div style={{fontSize:11,color:"#6b9fd4"}}>{new Date(chat.savedAt).toLocaleDateString("ja-JP")} · {chat.msgs.filter(m=>m.role==="user").length}問</div>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <span style={{fontSize:10,color:"#5a6a7a"}}>{openIdx===ci?"▲":"▼"}</span>
              <button onClick={e=>{e.stopPropagation();if(confirm("この履歴を削除しますか？"))onDelete(ci);}} style={{...S.btn("danger"),padding:"2px 6px",fontSize:10}}>×</button>
            </div>
          </div>
          {openIdx===ci && (
            <div style={{padding:"10px 12px",maxHeight:240,overflowY:"auto"}}>
              {chat.msgs.map((m,mi)=>(
                <div key={mi} style={{marginBottom:8,display:"flex",gap:8,alignItems:"flex-start"}}>
                  <span style={{fontSize:11,color:m.role==="user"?"#c4a050":"#6b9fd4",minWidth:28,flexShrink:0}}>{m.role==="user"?"You":"AI"}</span>
                  <div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.6,flex:1,whiteSpace:"pre-wrap"}}>{m.content}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AiChat({question, onOpenSettings, onSaveChat}) {
  const [msgs,setMsgs]=useState([]);
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  const [open,setOpen]=useState(false);
  const [saved,setSaved]=useState(false);
  const bottomRef=useRef(null);
  const apiKey=getApiKey();

  useEffect(()=>{if(bottomRef.current)bottomRef.current.scrollIntoView({behavior:"smooth"});},[msgs]);

  async function send() {
    if(!input.trim()||loading)return;
    if(!apiKey){onOpenSettings();return;}
    const userMsg=input.trim();setInput("");setError(null);setSaved(false);
    const context=`You are a CFA exam tutor. The student is reviewing this question:

Question: ${question.questionEN}

Correct Answer: ${question.choices[question.correctIndex]}

Explanation: ${question.explanationEN}

Answer concisely in the same language they use (Japanese or English).`;
    const history=[...msgs,{role:"user",content:userMsg}];
    setMsgs(history);setLoading(true);
    try {
      const allMsgs=history.length===1
        ?[{role:"user",content:`${context}

Student's question: ${userMsg}`}]
        :[{role:"user",content:`${context}

Student's question: ${history[0].content}`},...history.slice(1)];
      const reply=await askClaude(apiKey,allMsgs);
      setMsgs(prev=>[...prev,{role:"assistant",content:reply}]);
    } catch(e){setError(e.message);}
    finally{setLoading(false);}
  }

  function handleSave() {
    if(msgs.length===0)return;
    onSaveChat({msgs, savedAt: new Date().toISOString()});
    setSaved(true);
  }

  function handleClose() {
    setOpen(false);
    setMsgs([]);setInput("");setError(null);setSaved(false);
  }

  if(!open) return(
    <button onClick={()=>setOpen(true)} style={{...S.btn("blue"),display:"flex",alignItems:"center",gap:6,marginBottom:10,fontSize:12,padding:"7px 14px"}}>
      <Ic.chat/> AIに追加質問する
    </button>
  );

  return(
    <div style={{...S.card,borderColor:"rgba(100,140,200,0.3)",marginBottom:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:10,color:"#6b9fd4",letterSpacing:"0.15em"}}>AI TUTOR</div>
        <div style={{display:"flex",gap:6}}>
          {msgs.length>0&&(
            <button onClick={handleSave} disabled={saved} style={{...S.btn("ghost"),padding:"2px 10px",fontSize:11,borderColor:"rgba(100,140,200,0.4)",color:saved?"#4aad8b":"#6b9fd4",opacity:saved?0.7:1}}>
              {saved?"✓ 保存済":"💾 保存"}
            </button>
          )}
          <button onClick={handleClose} style={{...S.btn("ghost"),padding:"2px 8px",fontSize:11}}>閉じる</button>
        </div>
      </div>
      {!apiKey&&<div style={{fontSize:12,color:"#8a9ab0",marginBottom:8}}>APIキーが必要です。<button onClick={onOpenSettings} style={{color:"#6b9fd4",background:"none",border:"none",cursor:"pointer",textDecoration:"underline",fontSize:12}}>設定で入力 →</button></div>}
      <div style={{maxHeight:220,overflowY:"auto",marginBottom:10}}>
        {msgs.length===0&&<div style={{fontSize:12,color:"#5a6a7a",padding:"8px 0"}}>この問題について何でも質問できます（日本語OK）<br/><span style={{fontSize:11,color:"#4a5a6a"}}>💾 会話後に「保存」すると次回の解説に残ります</span></div>}
        {msgs.map((m,i)=>(
          <div key={i} style={{marginBottom:8,display:"flex",gap:8,alignItems:"flex-start"}}>
            <span style={{fontSize:11,color:m.role==="user"?"#c4a050":"#6b9fd4",minWidth:28,flexShrink:0}}>{m.role==="user"?"You":"AI"}</span>
            <div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.6,flex:1,whiteSpace:"pre-wrap"}}>{m.content}</div>
          </div>
        ))}
        {loading&&<div style={{fontSize:12,color:"#5a6a7a"}}>⟳ 考え中...</div>}
        {error&&<div style={{fontSize:12,color:"#e05a5a"}}>⚠️ {error}</div>}
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
function SettingsModal({open,onClose,user,onLogout}){
  const [key,setKey]=useState(getApiKey());
  if(!open)return null;
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}><div style={{...S.card,maxWidth:440,width:"100%",marginBottom:0}}><div style={{fontSize:14,color:"#c4a050",marginBottom:16}}>⚙️ 設定</div>{user&&<div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,padding:"10px 12px",background:"rgba(255,255,255,0.03)",borderRadius:6}}>{user.photoURL&&<img src={user.photoURL} width="32" height="32" style={{borderRadius:"50%"}}/>}<div><div style={{fontSize:13,color:"#e8e0d0"}}>{user.displayName}</div><div style={{fontSize:11,color:"#5a6a7a"}}>{user.email}</div></div><button onClick={onLogout} style={{...S.btn("ghost"),marginLeft:"auto",padding:"5px 10px",fontSize:11,display:"flex",alignItems:"center",gap:4}}><Ic.logout/>ログアウト</button></div>}<label style={S.label}>Anthropic APIキー（AI追加質問機能用）</label><input type="password" value={key} onChange={e=>setKey(e.target.value)} style={S.input} placeholder="sk-ant-..."/><div style={{fontSize:11,color:"#5a6a7a",lineHeight:1.7,marginBottom:14}}>APIキーは<a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{color:"#6b9fd4"}}>console.anthropic.com</a>で取得できます。このデバイスのみに保存されます。</div><div style={{display:"flex",gap:8}}><button onClick={()=>{setApiKey(key);onClose();}} style={{...S.btn("primary"),flex:1}}>保存</button><button onClick={onClose} style={{...S.btn("ghost"),flex:1}}>閉じる</button></div></div></div>);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({questions,notes,setPage,setPracticeMode}){
  const total=questions.length,dueCount=questions.filter(isDueToday).length,overdue=questions.filter(q=>q.srNextReview&&q.srNextReview<new Date().toISOString().split("T")[0]).length;
  const topicCounts={};questions.forEach(q=>{topicCounts[q.topic]=(topicCounts[q.topic]||0)+1;});
  const forecast=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()+i);const ds=d.toISOString().split("T")[0];return{label:i===0?"今日":i===1?"明日":`${d.getMonth()+1}/${d.getDate()}`,count:questions.filter(q=>q.srNextReview===ds).length,isToday:i===0};});
  const maxF=Math.max(...forecast.map(f=>f.count),1);
  return(<div>
    {dueCount>0&&<div onClick={()=>{setPracticeMode("due");setPage("practice");}} style={{...S.card,borderColor:"#4aad8b80",background:"linear-gradient(135deg,#0e2420,#0b1c17)",cursor:"pointer",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between"}}><div><div style={{fontSize:10,color:"#4aad8b",letterSpacing:"0.15em",marginBottom:4}}>TODAY'S REVIEW</div><div style={{fontSize:22,fontWeight:"bold",color:"#4aad8b"}}>{dueCount} <span style={{fontSize:14,color:"#3a8a6a"}}>問が復習期限</span></div>{overdue>0&&<div style={{fontSize:11,color:"#e05a5a",marginTop:2}}>うち {overdue} 問は期限超過</div>}</div><button style={{...S.btn("teal"),padding:"10px 14px",fontSize:12,display:"flex",alignItems:"center",gap:5}}><Ic.repeat/>今すぐ復習</button></div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:14}}>{[{label:"登録問題",value:total,accent:"#c4a050"},{label:"復習期限",value:dueCount,accent:"#4aad8b"},{label:"未学習",value:questions.filter(q=>!q.srNextReview).length,accent:"#7a8a9a"},{label:"ノート",value:notes.length,accent:"#9b8fd4"}].map(s=>(<div key={s.label} style={{...S.card,textAlign:"center",padding:"10px 6px"}}><div style={{fontSize:22,fontWeight:"bold",color:s.accent}}>{s.value}</div><div style={{fontSize:9,color:"#7a8a9a",letterSpacing:"0.08em",marginTop:2}}>{s.label}</div></div>))}</div>
    {total>0&&<div style={{...S.card,marginBottom:14}}><div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:10,display:"flex",alignItems:"center",gap:6}}><Ic.cal/>今後7日間の復習予定</div><div style={{display:"flex",gap:6,alignItems:"flex-end",height:56}}>{forecast.map((f,i)=>(<div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}><div style={{fontSize:10,color:"#5a6a7a"}}>{f.count>0?f.count:""}</div><div style={{width:"100%",borderRadius:"3px 3px 0 0",height:f.count>0?`${Math.max((f.count/maxF)*38,5)}px`:"2px",background:f.isToday?(f.count>0?"#4aad8b":"rgba(74,173,139,0.2)"):f.count>0?"#c4a05070":"rgba(255,255,255,0.06)"}}/><div style={{fontSize:9,color:f.isToday?"#c4a050":"#5a6a7a"}}>{f.label}</div></div>))}</div></div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}><button style={{...S.btn("primary"),padding:"13px",display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontSize:13}} onClick={()=>{setPracticeMode("all");setPage("practice");}}><Ic.play/>全問演習</button><button style={{...S.btn("ghost"),padding:"13px",display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontSize:13}} onClick={()=>setPage("add")}><Ic.plus/>問題を登録</button></div>
    {total>0&&<div><div style={S.sectionTitle}>分野別 登録数</div>{Object.entries(topicCounts).sort((a,b)=>b[1]-a[1]).map(([topic,count])=>(<div key={topic} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}><div style={{flex:1,fontSize:12,color:"#b0c0cc"}}>{topic}</div><div style={{fontSize:12,color:"#c4a050",minWidth:24,textAlign:"right"}}>{count}</div><div style={{width:80,height:4,background:"rgba(255,255,255,0.08)",borderRadius:2}}><div style={{width:`${(count/total)*100}%`,height:"100%",background:"#c4a050",borderRadius:2}}/></div></div>))}</div>}
    <button onClick={()=>setPage("history")} style={{...S.btn("ghost"),width:"100%",padding:"9px 14px",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:14,borderColor:"rgba(196,160,80,0.25)"}}>
      📊 解答履歴を見る
    </button>
    {total===0&&<div style={{...S.card,textAlign:"center",padding:40}}><div style={{fontSize:32,marginBottom:12}}>📖</div><div style={{color:"#7a8a9a",fontSize:14,lineHeight:1.7}}>まずは復習したい問題を登録しましょう。</div><button style={{...S.btn("primary"),marginTop:16}} onClick={()=>setPage("add")}>最初の問題を登録する</button></div>}
  </div>);
}

// ── QuestionList ──────────────────────────────────────────────────────────────
function QuestionList({questions,setPage,setEditQ,deleteQ,startSingleQ}){
  const [filterTopic,setFilterTopic]=useState("All");const [filterDiff,setFilterDiff]=useState("All");const [filterSR,setFilterSR]=useState("All");const [expandedId,setExpandedId]=useState(null);const [sortBy,setSortBy]=useState("sr");
  const dueCount=questions.filter(isDueToday).length;
  const filteredOrdered = (() => {
    const base = questions.filter(q =>
      (filterTopic==="All"||q.topic===filterTopic) &&
      (filterDiff==="All"||q.difficulty===filterDiff) &&
      (filterSR==="All"||(filterSR==="Due"&&isDueToday(q))||(filterSR==="Upcoming"&&!isDueToday(q)&&q.srNextReview))
    );
    if(sortBy==="date") return [...base].reverse(); // newest id = last added = highest index
    return [...base].sort((a,b)=>{
      if(isDueToday(a)&&!isDueToday(b))return -1;
      if(!isDueToday(a)&&isDueToday(b))return 1;
      if(a.srNextReview&&b.srNextReview)return a.srNextReview.localeCompare(b.srNextReview);
      return 0;
    });
  })();
  const topics=["All",...CFA_TOPICS.filter(t=>questions.some(q=>q.topic===t))];
  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
    <div style={{display:"flex",gap:6}}>{[["All","全て"],["Due",`期限 ${dueCount}`],["Upcoming","予定あり"]].map(([val,label])=>(<button key={val} onClick={()=>setFilterSR(val)} style={{...S.btn(filterSR===val?"primary":"ghost"),padding:"5px 12px",fontSize:11}}>{label}</button>))}</div>
    <div style={{display:"flex",gap:4,alignItems:"center"}}>
      <span style={{fontSize:10,color:"#5a6a7a"}}>並替:</span>
      {[["sr","復習順"],["date","登録順"]].map(([val,label])=>(<button key={val} onClick={()=>setSortBy(val)} style={{...S.btn(sortBy===val?"primary":"ghost"),padding:"4px 9px",fontSize:10}}>{label}</button>))}
    </div>
  </div>
    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>{["All","Easy","Medium","Hard"].map(d=>(<button key={d} onClick={()=>setFilterDiff(d)} style={{...S.btn(filterDiff===d?"primary":"ghost"),padding:"4px 10px",fontSize:11}}>{d==="All"?"全難易度":d}</button>))}</div>
    <select value={filterTopic} onChange={e=>setFilterTopic(e.target.value)} style={{...S.input,marginBottom:8,fontSize:12}}>{topics.map(t=><option key={t} value={t} style={{background:"#0d1b2e"}}>{t==="All"?"全分野":t}</option>)}</select>
    <div style={{fontSize:11,color:"#5a6a7a",marginBottom:10}}>{filteredOrdered.length} 問</div>
    {filteredOrdered.map(q=>{
      const isOpen=expandedId===q.id;const acc=q.attemptCount>0?Math.round(((q.attemptCount-q.wrongCount)/q.attemptCount)*100):null;const rl=reviewLabel(q);
      return(<div key={q.id} style={{...S.card,borderColor:isDueToday(q)?"rgba(74,173,139,0.35)":"rgba(196,160,80,0.2)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
          <div style={{flex:1,cursor:"pointer"}} onClick={()=>setExpandedId(isOpen?null:q.id)}>
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:6}}><span style={S.tag()}>{q.topic.split(" ").slice(0,2).join(" ")}</span><span style={S.tag(diffColor(q.difficulty))}>{q.difficulty}</span><SRBadge q={q}/>{acc!==null&&<span style={S.tag("#6b9fd4")}>正答率 {acc}%</span>}</div>
            <div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.5}}>{q.questionEN.slice(0,100)}{q.questionEN.length>100?"…":""}</div>
          </div>
          <div style={{display:"flex",gap:5,flexShrink:0}}>
            <button onClick={()=>startSingleQ(q.id)} style={{...S.btn("teal"),padding:"6px 8px"}} title="この問題に挑戦"><Ic.play/></button>
            <button onClick={()=>{setEditQ(q);setPage("add");}} style={{...S.btn("ghost"),padding:"6px 8px"}}><Ic.edit/></button>
            <button onClick={()=>{if(confirm("削除しますか？"))deleteQ(q.id);}} style={{...S.btn("danger"),padding:"6px 8px"}}><Ic.trash/></button>
          </div>
        </div>
        {isOpen&&<div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(196,160,80,0.15)"}}><div style={{background:"rgba(74,173,139,0.06)",border:"1px solid rgba(74,173,139,0.2)",borderRadius:4,padding:"8px 12px",marginBottom:10}}><div style={{fontSize:10,color:"#4aad8b",marginBottom:4}}>🔁 間隔反復ステータス</div><div style={{display:"flex",gap:16,fontSize:12,color:"#8ab0a0",flexWrap:"wrap"}}><span>次回: <strong style={{color:rl.color}}>{rl.label}</strong></span><span>間隔: <strong style={{color:"#c4a050"}}>{q.srInterval}日</strong></span><span>連続正解: <strong style={{color:"#6b9fd4"}}>{q.srRepetitions}回</strong></span></div></div>{q.questionJA&&<div style={{fontSize:13,color:"#8a9ab0",lineHeight:1.6,marginBottom:10}}><span style={{color:"#c4a050",fontSize:10}}>【日本語訳】</span><br/>{q.questionJA}</div>}{q.keyPoints&&<div style={{background:"rgba(196,160,80,0.06)",border:"1px solid rgba(196,160,80,0.2)",borderRadius:4,padding:"8px 12px"}}><div style={{fontSize:10,color:"#c4a050",marginBottom:4}}>📌 覚えるべきポイント</div><div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.6}}>{q.keyPoints}</div></div>}</div>}
      </div>);
    })}
  </div>);
}

// ── Practice ──────────────────────────────────────────────────────────────────

// ── VignettePanel ─────────────────────────────────────────────────────────────
// Split vignette text into segments: plain paragraphs and tab-separated table blocks
function splitVignetteSegments(text) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let buf = [];
  let inTable = false;

  const flush = () => {
    if (!buf.length) return;
    const content = buf.join('\n').trim();
    if (content) segments.push({ type: inTable ? 'table' : 'text', content });
    buf = [];
  };

  for (const line of lines) {
    const hasTab = line.includes('\t');
    if (hasTab !== inTable) { flush(); inTable = hasTab; }
    buf.push(line);
  }
  flush();
  return segments;
}

function VignettePanel({text, images}) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div style={{marginBottom:10,border:"1px solid rgba(100,140,200,0.3)",borderRadius:5,overflow:"hidden"}}>
      <button
        onClick={()=>setOpen(v=>!v)}
        style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",
          padding:"9px 12px",background:"rgba(100,130,160,0.1)",border:"none",cursor:"pointer",
          color:"#6b9fd4",fontSize:12,textAlign:"left"}}>
        <span style={{display:"flex",alignItems:"center",gap:6,letterSpacing:"0.08em"}}>
          <span style={{fontSize:13}}>📖</span> PASSAGE
        </span>
        <span style={{fontSize:11,color:"#4a6a8a"}}>{open?"▲ 閉じる":"▼ 開く"}</span>
      </button>
      {open && (
        <div style={{padding:"12px 14px",background:"rgba(100,130,160,0.06)",
          maxHeight:400,overflowY:"auto"}}>
          <QuestionContent text={text}/>
          <ImageDisplay images={images||[]}/>
        </div>
      )}
    </div>
  );
}

// ── VignetteGroupPractice ─────────────────────────────────────────────────────
// Shows all sub-questions with same vignetteText stacked vertically
// ── KeyPointsCard ─────────────────────────────────────────────────────────────
function KeyPointsCard({q, qi, updateQ}) {
  const [editing, setEditing] = useState(false);
  return (
    <div style={{background:"rgba(196,160,80,0.05)",border:"1px solid rgba(196,160,80,0.2)",borderRadius:5,padding:"10px 12px",marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <div style={{fontSize:11,color:"#c4a050",display:"flex",alignItems:"center",gap:5}}><Ic.flag/> 📌 覚えるべきポイント</div>
        <button onClick={()=>setEditing(v=>!v)} style={{...S.btn("ghost"),padding:"3px 9px",fontSize:11,borderColor:"rgba(196,160,80,0.3)"}}>
          {editing?"✓ 保存":"✏ 編集"}
        </button>
      </div>
      {editing
        ? <textarea value={q.keyPoints||""} onChange={e=>{updateQ({...q,keyPoints:e.target.value});}}
            style={{...S.textarea,minHeight:90,fontSize:13,marginBottom:0,borderColor:"rgba(196,160,80,0.35)"}}
            placeholder="覚えるべきポイントを入力..."/>
        : <div style={{fontSize:13,color:q.keyPoints?"#d4c08a":"#4a5a6a",lineHeight:1.7,whiteSpace:"pre-wrap",minHeight:32}}>
            {q.keyPoints||<span style={{fontStyle:"italic"}}>まだ入力されていません。「✏ 編集」から追加できます。</span>}
          </div>
      }
    </div>
  );
}

function VignetteGroupPractice({questions, vignetteText, onDone, updateQ, onOpenSettings}) {
  const allQs = questions.filter(q => q.vignetteText === vignetteText && q.choices.filter(c=>c.trim()).length >= 2);
  const vigImages = (allQs[0]?.vignetteImages)||[];

  // Separate due vs not-due sub-questions
  const dueQs    = allQs.filter(q => isDueToday(q));
  const notDueQs = allQs.filter(q => !isDueToday(q));

  const [answers, setAnswers] = useState(() => Array(allQs.length).fill(null));
  const [results,  setResults]  = useState(() => Array(allQs.length).fill(null));
  // Track which not-due questions are expanded for reference
  const [shownRef, setShownRef] = useState(() => new Set());
  const labels = ["A","B","C","D","E"];

  // "Done" when all DUE questions are confirmed
  const dueIndices = allQs.map((q,i) => isDueToday(q) ? i : -1).filter(i => i >= 0);
  const allDueConfirmed = dueIndices.length === 0 || dueIndices.every(i => answers[i]?.confirmed);

  function selectChoice(qi, dIdx) {
    if(answers[qi]?.confirmed) return;
    setAnswers(prev => prev.map((a,i) => i===qi ? {selected:dIdx, confirmed:false} : a));
  }

  function confirmAnswer(qi, countForSM2) {
    const q = allQs[qi];
    const order = q._choiceOrder || q.choices.map((_,i)=>i);
    const correctDIdx = order.indexOf(q.correctIndex);
    const correct = answers[qi]?.selected === correctDIdx;
    if(countForSM2) {
      const sr = sm2Update(q, correct);
      const updated = {...q, attemptCount:q.attemptCount+1, wrongCount:q.wrongCount+(correct?0:1),
        lastAttempted:new Date().toISOString(), ...sr};
      updateQ(updated);
      setResults(prev => prev.map((r,i) => i===qi ? {correct, srInterval:sr.srInterval} : r));
    } else {
      // Reference-only: just show result, no SM-2
      setResults(prev => prev.map((r,i) => i===qi ? {correct, srInterval:null, refOnly:true} : r));
    }
    setAnswers(prev => prev.map((a,i) => i===qi ? {...a, confirmed:true} : a));
  }

  const choiceState = (qi, dIdx) => {
    const a = answers[qi];
    const q = allQs[qi];
    const order = q._choiceOrder || q.choices.map((_,i)=>i);
    const correctDIdx = order.indexOf(q.correctIndex);
    if(!a?.confirmed) return a?.selected===dIdx ? "selected" : "default";
    if(dIdx===correctDIdx && dIdx===a.selected) return "correct";
    if(dIdx===a.selected && dIdx!==correctDIdx) return "wrong";
    if(dIdx===correctDIdx) return "reveal-correct";
    return "default";
  };

  function renderSubQ(q, qi, isDue) {
    const a = answers[qi];
    const r = results[qi];
    const order = q._choiceOrder || q.choices.map((_,i)=>i);
    const displayChoices = order.map(i => ({text:q.choices[i], origIdx:i}));
    return (
      <div key={q.id} style={{...S.card,
        borderColor: isDue ? "rgba(196,160,80,0.3)" : "rgba(100,140,180,0.2)",
        marginBottom:16,
        opacity: isDue ? 1 : 0.85}}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:10,color: isDue ? "#b0a0e0" : "#4a6a8a",letterSpacing:"0.15em"}}>
            小問 {qi+1}
            {!isDue && <span style={{marginLeft:6,background:"rgba(100,140,180,0.2)",borderRadius:3,padding:"1px 6px",fontSize:9,color:"#4a8aaa"}}>参照のみ（SM-2対象外）</span>}
          </div>
        </div>
        <QuestionContent text={q.questionEN}/>
        <ImageDisplay images={q.questionImages||[]}/>

        {/* Choices */}
        <div style={{marginTop:10,marginBottom:8}}>
          {displayChoices.map((ch,dIdx)=>(
            <button key={dIdx} style={S.choiceBtn(choiceState(qi,dIdx))} onClick={()=>selectChoice(qi,dIdx)}>
              <div style={{flex:1,display:"flex",alignItems:"flex-start",gap:8}}>
                <span style={{fontWeight:"bold",minWidth:20,opacity:0.7,flexShrink:0}}>{labels[dIdx]}.</span>
                <span style={{lineHeight:1.5}}>{ch.text}</span>
              </div>
              {choiceState(qi,dIdx)==="correct"&&<span style={{marginLeft:"auto"}}><Ic.check/></span>}
              {choiceState(qi,dIdx)==="wrong"&&<span style={{marginLeft:"auto"}}><Ic.xmark/></span>}
              {choiceState(qi,dIdx)==="reveal-correct"&&<span style={{marginLeft:"auto"}}><Ic.check/></span>}
            </button>
          ))}
        </div>

        {/* Confirm button */}
        {!a?.confirmed && a?.selected!=null && (
          <button onClick={()=>confirmAnswer(qi, isDue)}
            style={{...S.btn("primary"),width:"100%",padding:12,fontWeight:"bold",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            ✅ Confirm Answer
          </button>
        )}

        {/* Result */}
        {a?.confirmed && (<>
          <div style={{...S.card,
            borderColor: r?.correct ? "rgba(74,173,139,0.4)" : "rgba(224,90,90,0.3)",
            background: r?.correct ? "rgba(74,173,139,0.06)" : "rgba(224,90,90,0.06)",
            padding:"10px 14px",display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
            <span style={{fontSize:20}}>{r?.correct?"✓":"✗"}</span>
            <div>
              <div style={{fontSize:13,color:r?.correct?"#4aad8b":"#e05a5a",fontWeight:"bold"}}>
                {r?.correct?"正解！":"不正解"}
              </div>
              {r?.srInterval
                ? <div style={{fontSize:11,color:"#7a8a9a"}}>次回: <strong style={{color:"#c4a050"}}>{r.srInterval}日後</strong></div>
                : <div style={{fontSize:11,color:"#4a6a8a"}}>復習スケジュールには反映されません</div>
              }
            </div>
          </div>
          <div style={{...S.card,padding:"10px 14px",marginBottom:8}}>
            <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:6}}>EXPLANATION</div>
            <div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.7}}>{q.explanationEN}</div>
          </div>
          {isDue && <KeyPointsCard q={q} qi={qi} updateQ={updateQ}/>}
        </>)}
      </div>
    );
  }

  return (
    <div>
      <VignettePanel text={vignetteText} images={vigImages}/>

      {/* Progress */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontSize:11,color:"#b0a0e0"}}>
          📖 ビニエット演習
          <span style={{marginLeft:6,color:"#4aad8b"}}>復習対象 {dueQs.length}問</span>
          {notDueQs.length>0 && <span style={{marginLeft:6,color:"#4a6a8a"}}>/ 期限未到達 {notDueQs.length}問</span>}
        </div>
        <div style={{fontSize:11,color:"#5a6a7a"}}>
          {dueIndices.filter(i=>answers[i]?.confirmed).length} / {dueQs.length} 解答済
        </div>
      </div>

      {/* Due sub-questions */}
      {allQs.map((q, qi) => isDueToday(q) ? renderSubQ(q, qi, true) : null)}

      {/* Not-due sub-questions — collapsible reference section */}
      {notDueQs.length > 0 && (
        <div style={{marginTop:8,marginBottom:16}}>
          <button
            onClick={()=>setShownRef(s=>{const n=new Set(s);if(n.size>0){n.clear();}else{notDueQs.forEach(q=>{const i=allQs.indexOf(q);n.add(i);});} return n;})}
            style={{...S.btn("ghost"),width:"100%",padding:"8px 12px",fontSize:12,
              borderColor:"rgba(100,140,180,0.3)",color:"#4a8aaa",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <span>📋</span>
            {shownRef.size > 0 ? "参照問題を隠す" : `期限未到達の小問を参照する（${notDueQs.length}問）`}
          </button>
          {shownRef.size > 0 && allQs.map((q, qi) => !isDueToday(q) ? renderSubQ(q, qi, false) : null)}
        </div>
      )}

      {/* Done button — only when all DUE questions answered */}
      {allDueConfirmed && (
        <button onClick={onDone}
          style={{...S.btn("primary"),width:"100%",padding:14,fontSize:15,marginTop:8}}>
          演習を終了する →
        </button>
      )}
    </div>
  );
}


function Practice({questions,updateQ,initialMode,singleQId,clearSingleQ,onOpenSettings}){
  const [filterTopic,setFilterTopic]=useState("All");const [srMode,setSrMode]=useState(initialMode||"due");const [queue,setQueue]=useState(null);const [qIdx,setQIdx]=useState(0);const [selected,setSelected]=useState(null);const [confirmed,setConfirmed]=useState(false);const [revealed,setRevealed]=useState(false);const [showJA,setShowJA]=useState(false);const [showChoicesJA,setShowChoicesJA]=useState(false);const [showKP,setShowKP]=useState(false);const [editingKP,setEditingKP]=useState(false);const [sessionResults,setSessionResults]=useState([]);
  useEffect(()=>{if(singleQId){const q=questions.find(x=>x.id===singleQId);if(q){setQueue([q]);setQIdx(0);setSelected(null);setConfirmed(false);setRevealed(false);setShowJA(false);setShowChoicesJA(false);setShowKP(false);setEditingKP(false);setSessionResults([]);}}}, [singleQId]);
  const topics=["All",...CFA_TOPICS.filter(t=>questions.some(q=>q.topic===t))];
  const getPool=()=>{let p=questions.filter(q=>filterTopic==="All"||q.topic===filterTopic);if(srMode==="due")p=p.filter(isDueToday);return p;};
  function startSession(){
    const pool=getPool();if(!pool.length)return;
    // Deduplicate vignette groups: keep only 1 representative per vignetteText
    const seenVig=new Set();
    const deduped=pool.filter(q=>{
      if(!q.vignetteText)return true;
      if(seenVig.has(q.vignetteText))return false;
      seenVig.add(q.vignetteText);return true;
    });
    let sorted=[...deduped];
    if(srMode==="short"){sorted.sort((a,b)=>a.questionEN.length-b.questionEN.length);}
    else{sorted.sort((a,b)=>daysUntil(a)-daysUntil(b));sorted.sort(()=>Math.random()-0.5);}
    const withOrder=sorted.map(q=>{const n=q.choices.filter(c=>c.trim()).length;const order=[...Array(n).keys()].sort(()=>Math.random()-0.5);return{...q,_choiceOrder:order};});
    setQueue(withOrder);setQIdx(0);setSelected(null);setConfirmed(false);setRevealed(false);setShowJA(false);setShowChoicesJA(false);setShowKP(false);setEditingKP(false);setSessionResults([]);
  }
  function handleChoice(idx){if(confirmed)return;setSelected(idx);}function confirmAnswer(){if(selected===null||confirmed)return;setConfirmed(true);const q=queue[qIdx];const order=q._choiceOrder||q.choices.map((_,i)=>i);const correctDIdx=order.indexOf(q.correctIndex);const correct=selected===correctDIdx;const sr=sm2Update(q,correct);const updated={...q,attemptCount:q.attemptCount+1,wrongCount:q.wrongCount+(correct?0:1),lastAttempted:new Date().toISOString(),...sr};updateQ(updated);setQueue(prev=>prev.map((x,i)=>i===qIdx?updated:x));setSessionResults(prev=>[...prev,{id:q.id,correct,srInterval:sr.srInterval,questionEN:q.questionEN}]);}
  function next(){if(qIdx+1>=queue.length){setQueue(null);if(singleQId)clearSingleQ();return;}setQIdx(i=>i+1);setSelected(null);setConfirmed(false);setRevealed(false);setShowJA(false);setShowChoicesJA(false);setShowKP(false);setEditingKP(false);}
  function skip(){
    // Move current question to end of queue, advance without recording result
    setQueue(prev=>{const next=[...prev];const [skipped]=next.splice(qIdx,1);return [...next,skipped];});
    // qIdx stays the same — now points to what was next
    if(qIdx>=queue.length-1){setQueue(null);if(singleQId)clearSingleQ();return;}
    setSelected(null);setConfirmed(false);setRevealed(false);setShowJA(false);setShowChoicesJA(false);setShowKP(false);setEditingKP(false);
  }
  function handleBack(){setQueue(null);if(singleQId)clearSingleQ();}

  if(!queue){
    const pool=getPool();const doneCount=sessionResults.length;const correctCount=sessionResults.filter(r=>r.correct).length;
    return(<div>
      {doneCount>0&&<div style={{...S.card,borderColor:"rgba(74,173,139,0.3)",marginBottom:16}}><div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:10}}>SESSION RESULT</div><div style={{display:"flex",gap:20,alignItems:"flex-end",marginBottom:14}}><div><div style={{fontSize:32,fontWeight:"bold",color:"#4aad8b"}}>{correctCount}<span style={{fontSize:18,color:"#3a8a6a"}}>/{doneCount}</span></div><div style={{fontSize:11,color:"#5a7a6a"}}>正解数</div></div><div><div style={{fontSize:28,fontWeight:"bold",color:"#c4a050"}}>{Math.round((correctCount/doneCount)*100)}%</div><div style={{fontSize:11,color:"#7a6a4a"}}>正答率</div></div></div><div style={{maxHeight:180,overflowY:"auto"}}>{sessionResults.map((r,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,fontSize:12}}><span style={{color:r.correct?"#4aad8b":"#e05a5a",minWidth:16}}>{r.correct?"✓":"✗"}</span><span style={{flex:1,color:"#8a9ab0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.questionEN.slice(0,55)}…</span><span style={{color:"#5a7a8a",fontSize:11,minWidth:52,textAlign:"right"}}>次回 {r.srInterval}日後</span></div>))}</div></div>}
      <div style={S.sectionTitle}>演習設定</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>{[["due","🔁 復習期限","SM-2期限の問題"],["all","📚 全問演習","全問シャッフル"],["short","📝 短問優先","文章短め順"]].map(([mode,title,desc])=>(<button key={mode} onClick={()=>setSrMode(mode)} style={{background:srMode===mode?"rgba(196,160,80,0.12)":"rgba(255,255,255,0.02)",border:`1px solid ${srMode===mode?"rgba(196,160,80,0.5)":"rgba(196,160,80,0.15)"}`,borderRadius:6,padding:"10px 8px",cursor:"pointer",textAlign:"left"}}><div style={{fontSize:12,color:srMode===mode?"#c4a050":"#8a9ab0",marginBottom:3}}>{title}</div><div style={{fontSize:10,color:"#5a6a7a"}}>{desc}</div></button>))}</div>
      <label style={S.label}>分野を選択</label>
      <select value={filterTopic} onChange={e=>setFilterTopic(e.target.value)} style={S.input}>{topics.map(t=><option key={t} value={t} style={{background:"#0d1b2e"}}>{t==="All"?"全分野":t}</option>)}</select>
      <div style={{fontSize:12,color:pool.length===0?"#e05a5a":"#4aad8b",marginBottom:14}}>
        {(()=>{
          const seenV=new Set();
          const deduped=pool.filter(q=>{if(!q.vignetteText)return true;if(seenV.has(q.vignetteText))return false;seenV.add(q.vignetteText);return true;});
          const vigCount=[...seenV].length;
          const label=srMode==="due"?`今日の復習: ${deduped.length} 問`:srMode==="short"?`短問優先: ${deduped.length} 問 (文章短め順)`:`対象: ${deduped.length} 問`;
          return vigCount>0?`${label}（うち大問 ${vigCount} グループ）`:label;
        })()}
      </div>
      {pool.length===0&&srMode==="due"&&<div style={{...S.card,textAlign:"center",padding:20,borderColor:"rgba(74,173,139,0.3)",marginBottom:14}}><div style={{fontSize:24,marginBottom:8}}>🎉</div><div style={{color:"#4aad8b",fontSize:14}}>今日の復習は完了しています！</div></div>}
      <button disabled={pool.length===0} onClick={startSession} style={{...S.btn("primary"),width:"100%",padding:14,fontSize:15,opacity:pool.length===0?0.4:1}}>演習を開始する →</button>
    </div>);
  }

  const q=queue[qIdx];const answered=selected!==null;const labels=["A","B","C","D","E"];

  // Vignette group: if current q has vignetteText, show all siblings together
  if(q.vignetteText){
    return(
      <div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
          <button onClick={handleBack} style={{...S.btn("ghost"),padding:"4px 8px"}}><Ic.back/></button>
          <div style={{flex:1,fontSize:12,color:"#b0a0e0"}}>📖 ビニエット演習</div>
          <button onClick={skip} title="この問題をスキップして後回しにする"
            style={{...S.btn("ghost"),padding:"4px 9px",fontSize:11,color:"#5a6a7a",borderColor:"rgba(196,160,80,0.2)"}}>
            スキップ
          </button>
        </div>
        <VignetteGroupPractice
          questions={questions}
          vignetteText={q.vignetteText}
          updateQ={updateQ}
          onOpenSettings={onOpenSettings}
          onDone={()=>{ next(); }}
        />
      </div>
    );
  }

  const order=q._choiceOrder||q.choices.map((_,i)=>i);
  const displayChoices=order.map(i=>({text:q.choices[i],ja:(q.choicesJA||[])[i]||"",origIdx:i}));
  const correctDisplayIdx=order.indexOf(q.correctIndex);
  const choiceState=dIdx=>{if(!confirmed)return selected===dIdx?"selected":"default";if(dIdx===correctDisplayIdx&&dIdx===selected)return"correct";if(dIdx===selected&&dIdx!==correctDisplayIdx)return"wrong";if(dIdx===correctDisplayIdx)return"reveal-correct";return"default";};
  const lastResult=sessionResults[sessionResults.length-1];
  const relatedQs=(q.relatedIds||[]).map(id=>questions.find(x=>x.id===id)).filter(Boolean);
  return(<div>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
      <button onClick={handleBack} style={{...S.btn("ghost"),padding:"4px 8px"}}><Ic.back/></button>
      <div style={{flex:1,height:4,background:"rgba(255,255,255,0.08)",borderRadius:2}}>
        <div style={{width:`${(qIdx/queue.length)*100}%`,height:"100%",background:"#c4a050",borderRadius:2,transition:"width 0.3s"}}/>
      </div>
      <div style={{fontSize:11,color:"#7a8a9a",minWidth:40,textAlign:"right"}}>{qIdx+1} / {queue.length}</div>
      {!confirmed&&<button onClick={skip} title="この問題をスキップして後回しにする"
        style={{...S.btn("ghost"),padding:"4px 9px",fontSize:11,color:"#5a6a7a",borderColor:"rgba(196,160,80,0.2)"}}>
        スキップ
      </button>}
    </div>
    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}><span style={S.tag()}>{q.topic}</span><span style={S.tag(diffColor(q.difficulty))}>{q.difficulty}</span><SRBadge q={q}/></div>
    {q.vignetteText&&<VignettePanel text={q.vignetteText} images={q.vignetteImages||[]}/>}
    <div style={{...S.card,borderColor:"rgba(196,160,80,0.35)",marginBottom:10}}><div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:8}}>QUESTION</div><QuestionContent text={q.questionEN}/><ImageDisplay images={q.questionImages||[]}/>{q.questionJA&&<div style={{marginTop:10}}><button onClick={()=>setShowJA(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,display:"flex",alignItems:"center",gap:5}}>{showJA?<Ic.eyeOff/>:<Ic.eye/>} 日本語訳</button>{showJA&&<div style={{marginTop:8,padding:"10px 12px",background:"rgba(100,130,160,0.08)",borderRadius:4,border:"1px solid rgba(100,130,160,0.2)",fontSize:13,color:"#98afc0",lineHeight:1.7}}>{q.questionJA}</div>}</div>}</div>
    {q.choices.some((_,i)=>(q.choicesJA||[])[i]?.trim())&&<div style={{marginBottom:6}}><button onClick={()=>setShowChoicesJA(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,display:"flex",alignItems:"center",gap:5}}>{showChoicesJA?<Ic.eyeOff/>:<Ic.eye/>} 選択肢の日本語訳</button></div>}
    <div style={{marginBottom:10}}>{displayChoices.map((ch,dIdx)=>(<button key={dIdx} style={S.choiceBtn(choiceState(dIdx))} onClick={()=>handleChoice(dIdx)}><div style={{flex:1}}><div style={{display:"flex",alignItems:"flex-start",gap:8}}><span style={{fontWeight:"bold",minWidth:20,opacity:0.7,flexShrink:0}}>{labels[dIdx]}.</span><span style={{lineHeight:1.5}}>{ch.text}</span></div>{showChoicesJA&&ch.ja&&<div style={{marginTop:4,marginLeft:28,fontSize:12,color:"#7a8a9a",lineHeight:1.5}}>{ch.ja}</div>}</div>{choiceState(dIdx)==="correct"&&<span style={{marginLeft:"auto",flexShrink:0}}><Ic.check/></span>}{choiceState(dIdx)==="wrong"&&<span style={{marginLeft:"auto",flexShrink:0}}><Ic.xmark/></span>}{choiceState(dIdx)==="reveal-correct"&&<span style={{marginLeft:"auto",flexShrink:0}}><Ic.check/></span>}</button>))}</div>
    {answered&&!confirmed&&<div style={{marginBottom:10}}>
      <button onClick={confirmAnswer} style={{...S.btn("primary"),width:"100%",padding:14,fontSize:15,fontWeight:"bold",letterSpacing:"0.05em",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        ✅ Confirm Answer
      </button>
    </div>}
    {confirmed&&<div>
      {lastResult&&<div style={{...S.card,borderColor:lastResult.correct?"rgba(74,173,139,0.4)":"rgba(224,90,90,0.3)",background:lastResult.correct?"rgba(74,173,139,0.06)":"rgba(224,90,90,0.06)",marginBottom:10,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:22}}>{lastResult.correct?"✓":"✗"}</span><div><div style={{fontSize:13,color:lastResult.correct?"#4aad8b":"#e05a5a",fontWeight:"bold"}}>{lastResult.correct?"正解！":"不正解"}</div><div style={{fontSize:11,color:"#7a8a9a"}}>次回: <strong style={{color:"#c4a050"}}>{lastResult.srInterval}日後</strong></div></div></div>}
      <div style={{...S.card,marginBottom:8}}><div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:8}}>EXPLANATION</div><div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.7}}>{q.explanationEN}</div>{q.explanationJA&&<div style={{marginTop:10}}><button onClick={()=>setRevealed(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,display:"flex",alignItems:"center",gap:5}}>{revealed?<Ic.eyeOff/>:<Ic.eye/>} 日本語解説</button>{revealed&&<div style={{marginTop:8,padding:"10px 12px",background:"rgba(100,130,160,0.08)",borderRadius:4,border:"1px solid rgba(100,130,160,0.2)",fontSize:13,color:"#98afc0",lineHeight:1.7}}>{q.explanationJA}</div>}</div>}</div>
      <KeyPointsCard q={q} updateQ={q=>{updateQ(q);setQueue(prev=>prev.map((x,i)=>i===qIdx?q:x));}}/>
      {relatedQs.length>0&&<div style={{...S.card,borderColor:"rgba(155,143,212,0.3)",marginBottom:10}}><div style={{fontSize:10,color:"#9b8fd4",letterSpacing:"0.15em",marginBottom:8,display:"flex",alignItems:"center",gap:5}}><Ic.link/> 関連問題</div>{relatedQs.map(rq=>(<div key={rq.id} style={{marginBottom:6,padding:"8px 10px",background:"rgba(155,143,212,0.06)",borderRadius:4,border:"1px solid rgba(155,143,212,0.15)"}}><div style={{display:"flex",gap:6,marginBottom:4}}><span style={S.tag("#9b8fd4")}>{rq.topic.split(" ").slice(0,2).join(" ")}</span></div><div style={{fontSize:12,color:"#a0b0c0",lineHeight:1.5}}>{rq.questionEN.slice(0,100)}…</div></div>))}</div>}
      <SavedChats
        chats={q.savedChats||[]}
        onDelete={idx=>{
          const updated={...q,savedChats:(q.savedChats||[]).filter((_,i)=>i!==idx)};
          updateQ(updated);
          setQueue(prev=>prev.map((x,i)=>i===qIdx?updated:x));
        }}
      />
      <AiChat
        question={q}
        onOpenSettings={onOpenSettings}
        onSaveChat={chat=>{
          const updated={...q,savedChats:[...(q.savedChats||[]),chat]};
          updateQ(updated);
          setQueue(prev=>prev.map((x,i)=>i===qIdx?updated:x));
        }}
      />
      <button style={{...S.btn("primary"),width:"100%",padding:12}} onClick={next}>{qIdx+1>=queue.length?"結果を見る":"次の問題 →"}</button>
    </div>}
  </div>);
}

// ── NoteViewer ────────────────────────────────────────────────────────────────
function NoteViewer({note, questions, setPage, setEditNote}) {
  if (!note) return null;
  const linkedQs = (note.relatedIds||[]).map(id=>questions.find(q=>q.id===id)).filter(Boolean);
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button onClick={()=>setPage("notes")} style={{...S.btn("ghost"),padding:"6px 10px"}}><Ic.back/></button>
        <div style={{flex:1,fontSize:14,color:"#c4a050",letterSpacing:"0.05em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{note.title||"（タイトルなし）"}</div>
        <button onClick={()=>{setEditNote(note);setPage("note-edit");}} style={{...S.btn("ghost"),padding:"6px 10px",display:"flex",alignItems:"center",gap:5,fontSize:12}}>
          <Ic.edit/> 編集
        </button>
      </div>

      <div style={{...S.card,borderColor:"rgba(196,160,80,0.3)",marginBottom:12}}>
      <style>{`
        .note-body h3{color:#f0e8d8;font-size:18px;margin:8px 0 4px;font-family:Georgia}
        .note-body h5{color:#a0b0c0;font-size:11px;margin:4px 0;font-family:Georgia}
        .note-body ul{margin:4px 0;padding-left:20px}
        .note-body li{margin:2px 0;color:#d8d0c0}
        .note-body p{margin:4px 0;color:#d8d0c0}
        .note-body b,.note-body strong{color:#f0e8d8}
      `}</style>
        <div style={{fontSize:22,fontWeight:"bold",color:"#f0e8d8",lineHeight:1.4,marginBottom:8}}>{note.title||"（タイトルなし）"}</div>
        <div style={{fontSize:11,color:"#4a5a6a",marginBottom:16,display:"flex",gap:12}}>
          {note.createdAt && <span>作成: {new Date(note.createdAt).toLocaleDateString("ja-JP")}</span>}
          {note.updatedAt && note.updatedAt!==note.createdAt && <span>更新: {new Date(note.updatedAt).toLocaleDateString("ja-JP")}</span>}
        </div>
        <div style={{borderTop:"1px solid rgba(196,160,80,0.15)",paddingTop:14}}>
          {note.content
            ? <div
                style={{fontSize:14,color:"#d8d0c0",lineHeight:1.9}}
                className="note-body" dangerouslySetInnerHTML={{__html: note.content}}
              />
            : <span style={{color:"#4a5a6a",fontSize:13}}>内容がありません</span>
          }
        </div>
      </div>

      {linkedQs.length > 0 && (
        <div>
          <div style={S.sectionTitle}>紐づけた問題 ({linkedQs.length})</div>
          {linkedQs.map(q => (
            <div key={q.id} style={{...S.card,padding:"12px 14px",marginBottom:8}}>
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:6}}>
                <span style={S.tag()}>{q.topic.split(" ").slice(0,2).join(" ")}</span>
                <span style={S.tag(q.difficulty==="Hard"?"#e05a5a":q.difficulty==="Medium"?"#d4a34a":"#4aad8b")}>{q.difficulty}</span>
              </div>
              <div style={{fontSize:13,color:"#b0c0cc",lineHeight:1.5}}>{q.questionEN}</div>
              {q.explanationEN && (
                <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid rgba(196,160,80,0.1)",fontSize:12,color:"#7a8a9a",lineHeight:1.6}}>{q.explanationEN.slice(0,200)}{q.explanationEN.length>200?"…":""}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── NoteList / NoteEditor ─────────────────────────────────────────────────────
function NoteList({notes,questions,setPage,setEditNote,setViewNote,deleteNote}){
  const [search,setSearch]=useState("");
  const filtered=notes.filter(n=>search===""||n.title.includes(search)||n.content.includes(search));
  return(<div><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:11,color:"#5a6a7a"}}>{notes.length} ノート</div><button onClick={()=>{setEditNote(null);setPage("note-edit");}} style={{...S.btn("primary"),padding:"7px 14px",fontSize:12,display:"flex",alignItems:"center",gap:5}}><Ic.plus/> 新規ノート</button></div><input value={search} onChange={e=>setSearch(e.target.value)} style={{...S.input,marginBottom:12,fontSize:12}} placeholder="ノートを検索..."/>{filtered.length===0&&<div style={{...S.card,textAlign:"center",padding:30,color:"#5a6a7a"}}>{notes.length===0?"「新規ノート」から作成できます":"該当なし"}</div>}{filtered.map(note=>{const linkedQs=(note.relatedIds||[]).map(id=>questions.find(q=>q.id===id)).filter(Boolean);return(<div key={note.id} style={{...S.card,cursor:"pointer"}} onClick={()=>{setViewNote(note);setPage("note-view");}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:15,color:"#f0e8d8",fontWeight:"bold",marginBottom:4}}>{note.title||"（タイトルなし）"}</div>
            <div style={{fontSize:12,color:"#7a8a9a",lineHeight:1.5,marginBottom:6,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>{(note.content||"").replace(/<[^>]+>/g,"").slice(0,120)}{(note.content||"").replace(/<[^>]+>/g,"").length>120?"…":""}</div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              {linkedQs.length>0&&<div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{linkedQs.map(q=><span key={q.id} style={{...S.tag("#9b8fd4"),display:"inline-flex",alignItems:"center",gap:3}}><Ic.link/>{q.topic.split(" ")[0]}</span>)}</div>}
              {note.updatedAt&&<span style={{fontSize:10,color:"#3a4a5a"}}>{new Date(note.updatedAt).toLocaleDateString("ja-JP")}</span>}
            </div>
          </div>
          <div style={{display:"flex",gap:5,flexShrink:0}} onClick={e=>e.stopPropagation()}>
            <button onClick={()=>{setEditNote(note);setPage("note-edit");}} style={{...S.btn("ghost"),padding:"6px 8px"}}><Ic.edit/></button>
            <button onClick={()=>{if(confirm("削除しますか？"))deleteNote(note.id);}} style={{...S.btn("danger"),padding:"6px 8px"}}><Ic.trash/></button>
          </div>
        </div>
      </div>);})}</div>);
}

function NoteEditor({editNote,setEditNote,addNote,updateNote,questions,setPage}){
  const [form,setForm]=useState(()=>editNote?{...editNote}:{...BLANK_NOTE,id:uid(),createdAt:new Date().toISOString()});
  const [showPicker,setShowPicker]=useState(false);
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  function submit(){
    const plainText=(form.content||"").replace(/<[^>]+>/g,"").trim();
    if(!form.title.trim()&&!plainText)return alert("タイトルまたは内容を入力してください");
    const saved={...form,updatedAt:new Date().toISOString()};
    editNote?updateNote(saved):addNote(saved);setEditNote(null);setPage("notes");
  }
  const linkedQs=(form.relatedIds||[]).map(id=>questions.find(q=>q.id===id)).filter(Boolean);
  return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button onClick={()=>{setEditNote(null);setPage("notes");}} style={{...S.btn("ghost"),padding:"6px 10px"}}><Ic.back/></button>
        <div style={{fontSize:14,color:"#c4a050",letterSpacing:"0.1em"}}>{editNote?"ノートを編集":"新規ノート"}</div>
      </div>
      <label style={S.label}>タイトル</label>
      <input value={form.title} onChange={e=>set("title",e.target.value)} style={S.input} placeholder="ノートのタイトル..."/>
      <label style={S.label}>内容</label>
      <RichTextEditor value={form.content||""} onChange={html=>set("content",html)}/>
      <div style={{borderTop:"1px solid rgba(196,160,80,0.15)",paddingTop:14,marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:10,color:"#9b8fd4",letterSpacing:"0.15em",display:"flex",alignItems:"center",gap:5}}><Ic.link/> 関連問題リンク</div>
          <button onClick={()=>setShowPicker(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,borderColor:"rgba(155,143,212,0.4)",color:"#9b8fd4"}}>{showPicker?"閉じる":"問題を紐づける"}</button>
        </div>
        {linkedQs.length>0&&<div style={{marginBottom:10}}>{linkedQs.map(q=>(<div key={q.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,padding:"6px 10px",background:"rgba(155,143,212,0.06)",borderRadius:4,border:"1px solid rgba(155,143,212,0.15)"}}><div style={{flex:1}}><div style={{fontSize:12,color:"#a0b0c0"}}>{q.questionEN.slice(0,70)}…</div></div><button onClick={()=>set("relatedIds",(form.relatedIds||[]).filter(i=>i!==q.id))} style={{...S.btn("danger"),padding:"4px 7px",fontSize:11}}>×</button></div>))}</div>}
        {showPicker&&<RelatedQuestionPicker questions={questions} selected={form.relatedIds||[]} onChange={ids=>set("relatedIds",ids)} currentId={form.id}/>}
      </div>
      <button style={{...S.btn("primary"),width:"100%",padding:14,fontSize:15}} onClick={submit}>{editNote?"変更を保存する":"ノートを保存する"}</button>
    </div>
  );
}



// ── QuestionContent (auto-table from tab text) ────────────────────────────────
// Parses text into segments: plain text blocks and tab-delimited table blocks.
// Supports: text → table → text → table → ... (multiple tables or text after table)
function parseTabTable(text) {
  const lines = text.split(/\r?\n/);
  const isTabLine = l => l.includes('\t');

  // Quick check: any tabs at all?
  if (!lines.some(isTabLine)) return null;

  // Build segments: {type:'text'|'table', content}
  // A table block starts when we hit a tab line (possibly with a header line just before it)
  const segments = [];
  let i = 0;

  while (i < lines.length) {
    if (!isTabLine(lines[i])) {
      // Accumulate plain text lines — but peek ahead to see if the NEXT non-empty
      // line starts a table (then this line might be a header)
      let textBuf = [];
      while (i < lines.length && !isTabLine(lines[i])) {
        // Check if this non-tab line is immediately followed by a tab line (= column header)
        const nextTabIdx = lines.slice(i+1).findIndex(isTabLine);
        const nextTabAbsolute = nextTabIdx === -1 ? -1 : i + 1 + nextTabIdx;
        const linesBeforeNextTab = nextTabAbsolute === -1 ? Infinity :
          lines.slice(i+1, nextTabAbsolute).filter(l=>l.trim()).length;

        if (nextTabAbsolute !== -1 && linesBeforeNextTab === 0) {
          // This line is a header candidate (only whitespace between it and next tab line)
          // Check if it looks like column headers (multiple words / spaces / ideographic)
          const l = lines[i];
          if (/[　＀-￯]/.test(l) || /\S+\s{2,}\S/.test(l)) {
            // Flush text buf first
            if (textBuf.length) {
              const t = textBuf.join('\n').trim();
              if (t) segments.push({type:'text', content:t});
              textBuf = [];
            }
            // This line is the header; table starts next
            break;
          }
        }
        textBuf.push(lines[i]);
        i++;
      }
      if (textBuf.length) {
        const t = textBuf.join('\n').trim();
        if (t) segments.push({type:'text', content:t});
      }
    } else {
      // We're at a tab line — check one line back for header
      let headers = null;
      // Look at last pushed segment to see if its last line is a header candidate
      if (segments.length && segments[segments.length-1].type==='text') {
        const seg = segments[segments.length-1];
        const segLines = seg.content.split('\n');
        const lastLine = segLines[segLines.length-1];
        if (/[　＀-￯]/.test(lastLine) || /\S+\s{2,}\S/.test(lastLine)) {
          headers = lastLine.split(/[　]|\s{2,}/).map(h=>h.trim()).filter(h=>h);
          // Remove that last line from the text segment
          const remaining = segLines.slice(0,-1).join('\n').trim();
          if (remaining) seg.content = remaining;
          else segments.pop();
        }
      }

      // Collect tab block rows (stop when we get several consecutive non-tab lines that don't look like section headers)
      const tableLines = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isTabLine(l)) {
          tableLines.push(l);
          i++;
        } else if (!l.trim()) {
          // blank line — peek ahead to see if table continues
          const rest = lines.slice(i+1);
          const nextTab = rest.findIndex(isTabLine);
          const nonBlanksBeforeTab = nextTab === -1 ? Infinity :
            rest.slice(0, nextTab).filter(r=>r.trim()).length;
          if (nextTab !== -1 && nonBlanksBeforeTab <= 1) {
            tableLines.push(l); i++;
          } else break;
        } else {
          // Non-empty, non-tab line — section header or post-table text?
          // If the very next line is also non-tab, it's post-table text → stop table
          const nextIsTab = i+1 < lines.length && isTabLine(lines[i+1]);
          if (nextIsTab) {
            // treat as section header row
            tableLines.push(l); i++;
          } else {
            break; // end of table
          }
        }
      }

      // Parse collected tableLines into rows
      const cleanCells = l => l.split('\t').map(c=>c.trim()).filter(c=>c!=='');
      const tabRows = tableLines
        .map(l => isTabLine(l) ? {type:'data', cells:cleanCells(l)} : (l.trim() ? {type:'section', text:l.trim()} : null))
        .filter(Boolean);
      const maxCols = Math.max(
        ...tabRows.filter(r=>r.type==='data').map(r=>r.cells.length),
        headers ? headers.length+1 : 0
      );
      if (tabRows.length) segments.push({type:'table', headers, rows:tabRows, maxCols});
    }
  }

  return segments.length ? segments : null;
}

function QuestionContent({text, compact=false}) {
  if (!text) return null;
  const segments = parseTabTable(text);
  if (!segments) {
    return <div style={{fontSize:15,lineHeight:1.7,color:"#f0e8d8",whiteSpace:"pre-wrap"}}>{text}</div>;
  }
  return <div>{segments.map((seg,si) =>
    seg.type==='text'
      ? <div key={si} style={{fontSize:15,lineHeight:1.7,color:"#f0e8d8",whiteSpace:"pre-wrap",marginBottom:seg.content?8:0}}>{seg.content}</div>
      : <TableBlock key={si} seg={seg} compact={compact}/>
  )}</div>;
}

// Single table block with resizable columns
function TableBlock({seg, compact}) {
  const {headers, rows, maxCols} = seg;
  const nCols = headers && headers.length > 0 ? headers.length + 1 : maxCols;
  const [colWidths, setColWidths] = useState(() => Array(nCols).fill(compact ? 90 : 120));
  const [hoverCol, setHoverCol] = useState(null);
  const dragging = useRef(null);

  function onMouseDown(ci, e) {
    e.preventDefault();
    const startX = e.clientX, startW = colWidths[ci];
    dragging.current = {ci, startX, startW};
    const onMove = ev => {
      const delta = ev.clientX - dragging.current.startX;
      setColWidths(ws => ws.map((w,i) => i===dragging.current.ci ? Math.max(40, dragging.current.startW+delta) : w));
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function onTouchStart(ci, e) {
    const startX = e.touches[0].clientX, startW = colWidths[ci];
    const onMove = ev => {
      const delta = ev.touches[0].clientX - startX;
      setColWidths(ws => ws.map((w,i) => i===ci ? Math.max(40, startW+delta) : w));
    };
    const onEnd = () => { window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onEnd); };
    window.addEventListener('touchmove', onMove, {passive:true});
    window.addEventListener('touchend', onEnd);
  }

  const thBase = {background:"rgba(196,160,80,0.15)",border:"1px solid rgba(196,160,80,0.25)",color:"#c4a050",fontWeight:"bold",textAlign:"center",fontSize:11,position:"relative",padding:"5px 16px 5px 8px",wordBreak:"break-word",whiteSpace:"normal"};
  const td0 = {padding:"4px 8px",border:"1px solid rgba(196,160,80,0.15)",color:"#c4a050",background:"rgba(196,160,80,0.06)",fontSize:12,fontWeight:"bold",wordBreak:"break-word",whiteSpace:"normal",verticalAlign:"top"};
  const tdn = {padding:"4px 8px",border:"1px solid rgba(196,160,80,0.12)",color:"#c8bfaf",fontSize:12,textAlign:"right",wordBreak:"break-word",whiteSpace:"normal",verticalAlign:"top"};
  const tsec = {padding:"5px 8px",border:"1px solid rgba(196,160,80,0.12)",color:"#a89060",fontSize:11,fontWeight:"bold",background:"rgba(196,160,80,0.04)",letterSpacing:"0.05em",wordBreak:"break-word"};

  const resizer = (ci) => (
    <span onMouseDown={e=>onMouseDown(ci,e)} onTouchStart={e=>onTouchStart(ci,e)}
      onMouseEnter={()=>setHoverCol(ci)} onMouseLeave={()=>setHoverCol(null)}
      style={{position:"absolute",right:-4,top:0,bottom:0,width:8,cursor:"col-resize",
        zIndex:10,display:"flex",alignItems:"center",justifyContent:"center",userSelect:"none"}}>
      <span style={{width:3,height:"70%",borderRadius:2,
        background:hoverCol===ci?"#c4a050":"rgba(196,160,80,0.35)",transition:"background 0.15s"}}/>
    </span>
  );

  return (
    <div style={{overflowX:"auto",marginBottom:8}}>
      <div style={{fontSize:10,color:"#4a5a6a",marginBottom:4,display:"flex",alignItems:"center",gap:4}}>
        <span style={{opacity:0.7}}>⟺</span> 列の境界をドラッグして幅を変更できます
      </div>
      <table style={{borderCollapse:"collapse",fontSize:12,tableLayout:"fixed",width:"max-content",maxWidth:"100%"}}>
        <thead><tr>
          {Array.from({length:nCols}).map((_,ci)=>{
            const isHdr = headers && headers.length > 0;
            const label = isHdr ? (ci===0 ? "" : headers[ci-1]||"") : "";
            return (
              <th key={ci} style={{...thBase, width:colWidths[ci]||90, position:"relative",
                ...(isHdr?{}:{height:4,padding:0,background:"transparent",border:"none"})}}>
                {isHdr && label}{resizer(ci)}
              </th>
            );
          })}
        </tr></thead>
        <tbody>
          {rows.map((row,ri)=>{
            if(row.type==='section') return(
              <tr key={ri}><td colSpan={nCols} style={tsec}>{row.text}</td></tr>
            );
            return(
              <tr key={ri}>
                {row.cells.map((cell,ci)=>(
                  <td key={ci} style={{...(ci===0?td0:tdn), width:colWidths[ci]||90}}>{cell}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── RichTextEditor ────────────────────────────────────────────────────────────
const NOTE_COLORS = [
  {label:"デフォルト", color:"#d8d0c0"},
  {label:"金", color:"#c4a050"},
  {label:"青", color:"#6b9fd4"},
  {label:"緑", color:"#4aad8b"},
  {label:"赤", color:"#e05a5a"},
  {label:"紫", color:"#b0a0e0"},
];
const HIGHLIGHT_COLORS = [
  {label:"黄", color:"rgba(196,160,50,0.35)"},
  {label:"青", color:"rgba(100,160,220,0.3)"},
  {label:"緑", color:"rgba(74,173,139,0.3)"},
  {label:"赤", color:"rgba(224,90,90,0.3)"},
];

function RichTextEditor({value, onChange}) {
  const editorRef = useRef(null);
  const [showColors, setShowColors] = useState(false);
  const [showHighlight, setShowHighlight] = useState(false);
  const isInit = useRef(false);

  useEffect(()=>{
    if(editorRef.current && !isInit.current){
      editorRef.current.innerHTML = value || '';
      isInit.current = true;
    }
  },[]);

  function exec(cmd, val=null){
    editorRef.current.focus();
    document.execCommand(cmd, false, val);
    onChange(editorRef.current.innerHTML);
    setShowColors(false); setShowHighlight(false);
  }

  function handleInput(){ onChange(editorRef.current.innerHTML); }

  const toolBtn = (active) => ({
    padding:"5px 8px", borderRadius:3, border:"none", cursor:"pointer", fontSize:13,
    fontFamily:"Georgia", background:active?"rgba(196,160,80,0.25)":"rgba(255,255,255,0.05)",
    color:active?"#c4a050":"#a0b0c0", minWidth:28, textAlign:"center",
  });

  return (
    <div style={{marginBottom:12}}>
      {/* Toolbar */}
      <div style={{display:"flex",flexWrap:"wrap",gap:4,padding:"6px 8px",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(196,160,80,0.2)",borderBottom:"none",borderRadius:"4px 4px 0 0",alignItems:"center"}}>
        <button onMouseDown={e=>{e.preventDefault();exec("bold");}} style={{...toolBtn(false),fontWeight:"bold"}}>B</button>
        <button onMouseDown={e=>{e.preventDefault();exec("italic");}} style={{...toolBtn(false),fontStyle:"italic"}}>I</button>
        <button onMouseDown={e=>{e.preventDefault();exec("underline");}} style={{...toolBtn(false),textDecoration:"underline"}}>U</button>
        <div style={{width:1,height:18,background:"rgba(196,160,80,0.2)",margin:"0 2px"}}/>
        <button onMouseDown={e=>{e.preventDefault();exec("formatBlock","h3");}} style={{...toolBtn(false),fontSize:11}}>大</button>
        <button onMouseDown={e=>{e.preventDefault();exec("formatBlock","p");}} style={{...toolBtn(false),fontSize:11}}>標</button>
        <button onMouseDown={e=>{e.preventDefault();exec("formatBlock","h5");}} style={{...toolBtn(false),fontSize:11}}>小</button>
        <div style={{width:1,height:18,background:"rgba(196,160,80,0.2)",margin:"0 2px"}}/>
        <button onMouseDown={e=>{e.preventDefault();exec("insertUnorderedList");}} style={toolBtn(false)}>•</button>
        <div style={{width:1,height:18,background:"rgba(196,160,80,0.2)",margin:"0 2px"}}/>
        {/* Text color */}
        <div style={{position:"relative"}}>
          <button onMouseDown={e=>{e.preventDefault();setShowColors(v=>!v);setShowHighlight(false);}} style={{...toolBtn(showColors),fontSize:11}}>A色</button>
          {showColors&&(
            <div style={{position:"absolute",top:"100%",left:0,zIndex:50,background:"#131f30",border:"1px solid rgba(196,160,80,0.3)",borderRadius:4,padding:6,display:"flex",gap:4,flexWrap:"wrap",width:140}}>
              {NOTE_COLORS.map(c=>(
                <button key={c.color} onMouseDown={e=>{e.preventDefault();exec("foreColor",c.color);}} title={c.label}
                  style={{width:20,height:20,borderRadius:"50%",border:`2px solid ${c.color}`,background:c.color,cursor:"pointer"}}/>
              ))}
            </div>
          )}
        </div>
        {/* Highlight */}
        <div style={{position:"relative"}}>
          <button onMouseDown={e=>{e.preventDefault();setShowHighlight(v=>!v);setShowColors(false);}} style={{...toolBtn(showHighlight),fontSize:11}}>蛍光</button>
          {showHighlight&&(
            <div style={{position:"absolute",top:"100%",left:0,zIndex:50,background:"#131f30",border:"1px solid rgba(196,160,80,0.3)",borderRadius:4,padding:6,display:"flex",gap:4}}>
              {HIGHLIGHT_COLORS.map(c=>(
                <button key={c.color} onMouseDown={e=>{e.preventDefault();exec("hiliteColor",c.color);}} title={c.label}
                  style={{width:20,height:20,borderRadius:3,border:"1px solid rgba(255,255,255,0.2)",background:c.color,cursor:"pointer"}}/>
              ))}
            </div>
          )}
        </div>
      </div>
      {/* Editable area */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={handleInput}
        style={{
          minHeight:220, padding:"10px 12px",
          background:"rgba(255,255,255,0.04)",
          border:"1px solid rgba(196,160,80,0.25)",
          borderRadius:"0 0 4px 4px",
          color:"#d8d0c0", fontSize:14, lineHeight:1.8,
          outline:"none", fontFamily:"Georgia",
          overflowY:"auto",
        }}
      />
      <style>{`
        [contenteditable] h3{color:#f0e8d8;font-size:18px;margin:8px 0 4px}
        [contenteditable] h5{color:#a0b0c0;font-size:11px;margin:4px 0}
        [contenteditable] ul{margin:4px 0;padding-left:20px}
        [contenteditable] li{margin:2px 0}
        [contenteditable] p{margin:4px 0}
      `}</style>
    </div>
  );
}


// ── InlineTableEditor ─────────────────────────────────────────────────────────
// Converts questionEN (tab-separated format) ↔ visual grid editor
function tabTextToGrid(text) {
  // Reuse parseTabTable logic to build editable grid
  const lines = text.split(/\r?\n/);
  const isTabLine = l => l.includes('\t');
  const firstTabIdx = lines.findIndex(isTabLine);
  if (firstTabIdx === -1) return null;

  let questionText = '';
  let headers = [];
  if (firstTabIdx > 0) {
    const prevLine = lines[firstTabIdx - 1];
    if (/[　＀-￯]/.test(prevLine) || /\S+\s{2,}\S/.test(prevLine)) {
      headers = prevLine.split(/[　]|\s{2,}/).map(h=>h.trim()).filter(h=>h);
      questionText = lines.slice(0, firstTabIdx - 1).join('\n').trim();
    } else {
      questionText = lines.slice(0, firstTabIdx).join('\n').trim();
    }
  }

  const tableLines = lines.slice(firstTabIdx);
  const rows = tableLines.map(l => {
    if (!isTabLine(l)) return { type: 'section', text: l.trim() };
    return { type: 'data', cells: l.split('\t').map(c => c.trim()) };
  }).filter(r => r.type === 'data' || r.text);

  // Normalize all data rows to same column count
  const dataRows = rows.filter(r => r.type === 'data');
  const maxCols = Math.max(...dataRows.map(r => r.cells.length), headers.length > 0 ? headers.length + 1 : 0);
  rows.forEach(r => {
    if (r.type === 'data') {
      while (r.cells.length < maxCols) r.cells.push('');
    }
  });

  return { questionText, headers: headers.length > 0 ? ['', ...headers] : [], rows, maxCols };
}

function gridToTabText(questionText, headers, rows) {
  const parts = [];
  if (questionText.trim()) parts.push(questionText.trim());
  // Headers line (skip first empty label cell, join rest with spaces)
  if (headers.length > 1) {
    parts.push(headers.slice(1).join('  '));
  }
  rows.forEach(r => {
    if (r.type === 'note') {
      // Plain text block: surrounded by blank lines to break out of table
      parts.push('');  // blank line before
      if (r.text.trim()) parts.push(r.text);
      parts.push('');  // blank line after
    } else if (r.type === 'section') {
      if (r.text.trim()) parts.push(r.text);
    } else {
      parts.push(r.cells.join('\t'));
    }
  });
  return parts.join('\n');
}


// ── InlineTableEditor — segment-based direct editor ──────────────────────────
// Converts tab text ↔ list of editable segments matching the preview exactly

function textToSegments(text) {
  // Reuse parseTabTable which returns segments array or null
  const segs = parseTabTable(text);
  if (!segs) return [{type:'text', content: text}];
  return segs.map(s => {
    if (s.type === 'text') return {type:'text', content: s.content};
    // table segment: convert rows to editable format
    return {
      type: 'table',
      headers: s.headers || [],
      rows: s.rows.map(r => ({...r, cells: r.cells ? [...r.cells] : undefined})),
      maxCols: s.maxCols,
    };
  });
}

function segmentsToText(segments) {
  const parts = [];
  segments.forEach(seg => {
    if (seg.type === 'text') {
      if (seg.content.trim()) parts.push(seg.content);
    } else {
      // table
      if (seg.headers && seg.headers.length > 0) {
        parts.push(seg.headers.join('  '));
      }
      seg.rows.forEach(r => {
        if (r.type === 'section') { if (r.text.trim()) parts.push(r.text); }
        else if (r.type === 'note') { parts.push(''); if (r.text.trim()) parts.push(r.text); parts.push(''); }
        else { parts.push(r.cells.join('\t')); }
      });
    }
  });
  return parts.join('\n');
}

function InlineTableEditor({ value, onChange, hideLabelInside=false, minHeight=100, placeholderText=null, accentColor=null, textColor=null }) {
  const hasTable = value.includes('\t');
  const [mode, setMode] = useState(() => hasTable ? 'visual' : 'text');
  const [segments, setSegments] = useState(() => hasTable ? textToSegments(value) : null);

  // Sync when value changes externally (AI import)
  useEffect(() => {
    if (value.includes('\t') && mode === 'text') {
      setSegments(textToSegments(value));
      setMode('visual');
    }
  }, [value]);

  function updateSegments(newSegs) {
    setSegments(newSegs);
    onChange(segmentsToText(newSegs));
  }

  function switchToVisual() {
    if (value.includes('\t')) {
      setSegments(textToSegments(value));
    } else {
      // blank table
      setSegments([
        {type:'text', content: value},
        {type:'table', headers:[], rows:[
          {type:'data', cells:['','','']},
          {type:'data', cells:['','','']},
        ], maxCols:3},
      ]);
    }
    setMode('visual');
  }

  function switchToText() { setMode('text'); }

  // ── segment-level operations ──────────────────────────────────────────────

  function updateSeg(si, updated) {
    const next = segments.map((s,i) => i===si ? updated : s);
    updateSegments(next);
  }

  function setSegText(si, v) {
    updateSeg(si, {...segments[si], content: v});
  }

  // Convert a text segment to a section row in adjacent table
  function textToSectionRow(si, direction) {
    const text = segments[si].content.trim();
    const tableIdx = direction === 'prev'
      ? [...segments].slice(0, si).map((s,i)=>({s,i})).filter(x=>x.s.type==='table').slice(-1)[0]?.i
      : [...segments].slice(si+1).map((s,i)=>({s,i:si+1+i})).find(x=>x.s.type==='table')?.i;
    if (tableIdx == null) return;
    const tbl = segments[tableIdx];
    const newRow = {type:'section', text};
    const newRows = direction === 'prev'
      ? [...tbl.rows, newRow]
      : [newRow, ...tbl.rows];
    const newSegs = segments
      .map((s,i) => i===tableIdx ? {...tbl, rows: newRows} : s)
      .filter((_,i) => i !== si);
    updateSegments(newSegs);
  }

  // Convert a table section row to a standalone text segment
  function sectionRowToText(si, ri) {
    const tbl = segments[si];
    const row = tbl.rows[ri];
    const newRows = tbl.rows.filter((_,i) => i !== ri);
    const newTextSeg = {type:'text', content: row.text};
    const newSegs = [...segments];
    newSegs[si] = {...tbl, rows: newRows};
    newSegs.splice(si+1, 0, newTextSeg); // insert after table
    updateSegments(newSegs);
  }

  // Add row to table
  function addRowToTable(si, rowType) {
    const tbl = segments[si];
    const cols = tbl.maxCols || 3;
    let newRow;
    if (rowType==='data') newRow = {type:'data', cells:Array(cols).fill('')};
    else if (rowType==='section') newRow = {type:'section', text:''};
    else newRow = {type:'note', text:''};
    updateSeg(si, {...tbl, rows:[...tbl.rows, newRow]});
  }

  function updateTableRow(si, ri, updated) {
    const tbl = segments[si];
    const newRows = tbl.rows.map((r,i)=>i===ri ? updated : r);
    updateSeg(si, {...tbl, rows:newRows});
  }

  function removeTableRow(si, ri) {
    const tbl = segments[si];
    updateSeg(si, {...tbl, rows: tbl.rows.filter((_,i)=>i!==ri)});
  }

  function switchTableRowType(si, ri, newType) {
    const row = segments[si].rows[ri];
    let newRow;
    if (newType==='section') newRow = {type:'section', text: row.text || (row.cells||[]).join(' ')};
    else if (newType==='note') newRow = {type:'note', text: row.text || (row.cells||[]).join(' ')};
    else {
      const cols = segments[si].maxCols || 3;
      newRow = {type:'data', cells: row.text ? [row.text,...Array(cols-1).fill('')] : Array(cols).fill('')};
    }
    updateTableRow(si, ri, newRow);
  }

  function setTableCell(si, ri, ci, v) {
    const row = segments[si].rows[ri];
    const cells = [...row.cells];
    cells[ci] = v;
    updateTableRow(si, ri, {...row, cells});
  }

  function setTableHeader(si, ci, v) {
    const tbl = segments[si];
    const headers = [...tbl.headers];
    headers[ci] = v;
    updateSeg(si, {...tbl, headers});
  }

  function addCol(si) {
    const tbl = segments[si];
    updateSeg(si, {
      ...tbl,
      headers: tbl.headers.length ? [...tbl.headers, ''] : [],
      rows: tbl.rows.map(r => r.type==='data' ? {...r, cells:[...r.cells,'']} : r),
      maxCols: (tbl.maxCols||0)+1,
    });
  }

  function removeCol(si, ci) {
    const tbl = segments[si];
    if ((tbl.headers.length||0) <= 2 && tbl.maxCols <= 1) return;
    updateSeg(si, {
      ...tbl,
      headers: tbl.headers.filter((_,i)=>i!==ci),
      rows: tbl.rows.map(r => r.type==='data' ? {...r, cells:r.cells.filter((_,i)=>i!==ci)} : r),
      maxCols: (tbl.maxCols||1)-1,
    });
  }

  function addTextSegment(afterSi) {
    const newSegs = [...segments];
    newSegs.splice(afterSi+1, 0, {type:'text', content:''});
    updateSegments(newSegs);
  }

  function addTableSegment(afterSi) {
    const newSegs = [...segments];
    newSegs.splice(afterSi+1, 0, {type:'table', headers:[], rows:[
      {type:'data', cells:['','','']},
      {type:'data', cells:['','','']},
    ], maxCols:3});
    updateSegments(newSegs);
  }

  function removeSegment(si) {
    updateSegments(segments.filter((_,i)=>i!==si));
  }

  // ── styles ─────────────────────────────────────────────────────────────────
  const cellBase = {
    border:'1px solid rgba(196,160,80,0.2)', background:'rgba(255,255,255,0.04)',
    color:'#e8e0d0', fontFamily:'Georgia', fontSize:12, outline:'none',
    boxSizing:'border-box', width:'100%', padding:'4px 6px',
  };
  const segBtnRow = {display:'flex',gap:5,flexWrap:'wrap',marginTop:4};
  const microBtn = (color='#5a6a7a') => ({
    padding:'2px 7px', borderRadius:3, fontSize:10, border:`1px solid ${color}50`,
    background:'transparent', color, cursor:'pointer',
  });

  // ── text mode (no tabs) ─────────────────────────────────────────────────────
  if (mode === 'text') {
    return (
      <div>
        {!hideLabelInside && <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5}}>
          <label style={{...S.label,marginBottom:0}}>問題文（英語） *</label>
          <button onClick={switchToVisual} style={{...S.btn('ghost'),padding:'3px 10px',fontSize:11,borderColor:'rgba(100,200,160,0.4)',color:'#4aad8b'}}>
            🗂 表を編集する
          </button>
        </div>}
        {hideLabelInside && <div style={{display:'flex',justifyContent:'flex-end',marginBottom:5}}>
          <button onClick={switchToVisual} style={{...S.btn('ghost'),padding:'3px 10px',fontSize:11,borderColor:accentColor||'rgba(100,200,160,0.4)',color:'#4aad8b'}}>
            🗂 表を編集する
          </button>
        </div>}
        <textarea value={value} onChange={e=>onChange(e.target.value)}
          style={{...S.textarea, minHeight, ...(accentColor?{borderColor:accentColor}:{}), ...(textColor?{color:textColor}:{})}}
          placeholder={placeholderText || "Enter the question text in English...\n\n表がある場合：タブ区切りでそのままペーストすると自動で表として表示されます"}/>
      </div>
    );
  }

  // ── visual mode: segment editor ─────────────────────────────────────────────
  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        {!hideLabelInside && <label style={{...S.label,marginBottom:0}}>問題文（英語） *</label>}
        {hideLabelInside && <span/>}
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          <button onClick={()=>addTextSegment(-1)} style={{...microBtn('#6b9fd4'),border:'1px solid rgba(100,160,220,0.4)'}}>＋ 文章</button>
          <button onClick={()=>addTableSegment(-1)} style={{...microBtn('#4aad8b'),border:'1px solid rgba(74,173,139,0.4)'}}>＋ 表</button>
          <button onClick={switchToText} style={{...S.btn('ghost'),padding:'3px 9px',fontSize:11}}>✏ テキスト編集</button>
        </div>
      </div>

      {(segments||[]).map((seg, si) => {
        if (seg.type === 'text') {
          const hasPrevTable = si > 0 && segments[si-1].type === 'table';
          const hasNextTable = si < segments.length-1 && segments[si+1].type === 'table';
          return (
            <div key={si} style={{marginBottom:8,border:'1px solid rgba(100,160,220,0.25)',borderRadius:5,padding:8,background:'rgba(100,160,220,0.04)'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5}}>
                <span style={{fontSize:10,color:'#6b9fd4',letterSpacing:'0.1em'}}>📝 文章ブロック</span>
                <div style={{display:'flex',gap:4}}>
                  {hasPrevTable && <button onClick={()=>textToSectionRow(si,'prev')} style={microBtn('#c4a050')}>↑ 上の表の見出し行に変換</button>}
                  {hasNextTable && <button onClick={()=>textToSectionRow(si,'next')} style={microBtn('#c4a050')}>↓ 下の表の見出し行に変換</button>}
                  <button onClick={()=>addTableSegment(si)} style={microBtn('#4aad8b')}>＋ 表を追加</button>
                  <button onClick={()=>removeSegment(si)} style={microBtn('#e05a5a')}>✕</button>
                </div>
              </div>
              <textarea value={seg.content} onChange={e=>setSegText(si,e.target.value)}
                style={{...cellBase,width:'100%',minHeight:40,resize:'vertical',lineHeight:1.6}}
                placeholder="文章を入力..."/>
            </div>
          );
        }

        // table segment
        const tbl = seg;
        const nCols = tbl.headers.length > 0 ? tbl.headers.length : (tbl.maxCols||3);
        return (
          <div key={si} style={{marginBottom:8,border:'1px solid rgba(196,160,80,0.25)',borderRadius:5,padding:8,background:'rgba(196,160,80,0.03)'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
              <span style={{fontSize:10,color:'#c4a050',letterSpacing:'0.1em'}}>📊 表ブロック</span>
              <div style={{display:'flex',gap:4}}>
                <button onClick={()=>addTextSegment(si)} style={microBtn('#6b9fd4')}>＋ 文章を追加</button>
                <button onClick={()=>addTableSegment(si)} style={microBtn('#4aad8b')}>＋ 表を追加</button>
                <button onClick={()=>removeSegment(si)} style={microBtn('#e05a5a')}>✕</button>
              </div>
            </div>
            <div style={{overflowX:'auto'}}>
              <table style={{borderCollapse:'collapse',width:'100%'}}>
                {tbl.headers.length > 0 && (
                  <thead><tr>
                    {tbl.headers.map((h,ci)=>(
                      <th key={ci} style={{padding:'2px 3px',position:'relative',minWidth:70}}>
                        <input value={h} onChange={e=>setTableHeader(si,ci,e.target.value)}
                          style={{...cellBase,background:'rgba(196,160,80,0.12)',color:'#c4a050',fontWeight:'bold',textAlign:'center'}}
                          placeholder={ci===0?'':` 列${ci}`}/>
                        {ci>=1 && <button onClick={()=>removeCol(si,ci)} style={{position:'absolute',top:-5,right:-4,width:14,height:14,borderRadius:'50%',border:'none',background:'#c0392b',color:'#fff',fontSize:9,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>×</button>}
                      </th>
                    ))}
                    <th style={{width:24}}/>
                  </tr></thead>
                )}
                <tbody>
                  {tbl.rows.map((row,ri)=>{
                    if (row.type==='section') return (
                      <tr key={ri}>
                        <td colSpan={nCols} style={{padding:'2px 3px'}}>
                          <div style={{display:'flex',alignItems:'center',gap:4}}>
                            <span style={{fontSize:9,color:'#c4a050',minWidth:32}}>見出し</span>
                            <input value={row.text} onChange={e=>updateTableRow(si,ri,{...row,text:e.target.value})}
                              style={{...cellBase,background:'rgba(196,160,80,0.08)',color:'#c4a050',fontWeight:'bold',flex:1}}
                              placeholder="見出し行（表内）"/>
                            <button onClick={()=>sectionRowToText(si,ri)} style={microBtn('#6b9fd4')} title="文章ブロックとして切り出す">→文章</button>
                            <button onClick={()=>switchTableRowType(si,ri,'data')} style={microBtn('#5a6a7a')}>→行</button>
                            <button onClick={()=>removeTableRow(si,ri)} style={microBtn('#e05a5a')}>×</button>
                          </div>
                        </td>
                      </tr>
                    );
                    if (row.type==='note') return (
                      <tr key={ri}>
                        <td colSpan={nCols} style={{padding:'2px 3px'}}>
                          <div style={{display:'flex',alignItems:'flex-start',gap:4}}>
                            <span style={{fontSize:9,color:'#6b9fd4',minWidth:32,paddingTop:6}}>文章</span>
                            <textarea value={row.text} onChange={e=>updateTableRow(si,ri,{...row,text:e.target.value})}
                              style={{...cellBase,flex:1,minHeight:36,resize:'vertical',borderColor:'rgba(100,140,200,0.3)',color:'#8aafcc'}}/>
                            <button onClick={()=>switchTableRowType(si,ri,'section')} style={microBtn('#c4a050')} title="見出し行に変換">→見出し</button>
                            <button onClick={()=>removeTableRow(si,ri)} style={microBtn('#e05a5a')}>×</button>
                          </div>
                        </td>
                      </tr>
                    );
                    return (
                      <tr key={ri}>
                        {row.cells.map((cell,ci)=>(
                          <td key={ci} style={{padding:'2px 3px'}}>
                            <input value={cell} onChange={e=>setTableCell(si,ri,ci,e.target.value)}
                              style={{...cellBase,color:ci===0?'#c4a050':'#e8e0d0',background:ci===0?'rgba(196,160,80,0.06)':'rgba(255,255,255,0.04)',textAlign:ci===0?'left':'right'}}/>
                          </td>
                        ))}
                        <td style={{padding:'2px 3px',whiteSpace:'nowrap',verticalAlign:'middle'}}>
                          <button onClick={()=>switchTableRowType(si,ri,'section')} style={microBtn('#c4a050')} title="見出し行に変換">見出し</button>
                          {' '}
                          <button onClick={()=>removeTableRow(si,ri)} style={microBtn('#e05a5a')}>×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{display:'flex',gap:5,marginTop:6,flexWrap:'wrap'}}>
              <button onClick={()=>addRowToTable(si,'data')} style={{...S.btn('ghost'),padding:'3px 9px',fontSize:10}}>＋ 行</button>
              <button onClick={()=>addRowToTable(si,'section')} style={{...microBtn('#c4a050'),border:'1px solid rgba(196,160,80,0.3)'}}>＋ 見出し行（表内）</button>
              <button onClick={()=>addRowToTable(si,'note')} style={{...microBtn('#6b9fd4'),border:'1px solid rgba(100,140,200,0.3)'}}>＋ 文章（表外）</button>
              <button onClick={()=>addCol(si)} style={{...S.btn('ghost'),padding:'3px 9px',fontSize:10}}>＋ 列</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}


// ── ImageAttachment ───────────────────────────────────────────────────────────
// Converts File → base64 data URL
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Display images (read-only)
function ImageDisplay({images}) {
  const [lightbox, setLightbox] = useState(null);
  if (!images || images.length === 0) return null;
  return (
    <div style={{marginTop:8,marginBottom:4}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {images.map((src, i) => (
          <img key={i} src={src} alt={`image ${i+1}`}
            onClick={() => setLightbox(src)}
            style={{maxHeight:140,maxWidth:"100%",borderRadius:4,
              border:"1px solid rgba(196,160,80,0.3)",cursor:"zoom-in",objectFit:"contain",
              background:"rgba(0,0,0,0.3)"}}/>
        ))}
      </div>
      {lightbox && (
        <div onClick={()=>setLightbox(null)}
          style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",zIndex:500,
            display:"flex",alignItems:"center",justifyContent:"center",padding:16,cursor:"zoom-out"}}>
          <img src={lightbox} alt="preview"
            style={{maxWidth:"100%",maxHeight:"90vh",borderRadius:6,objectFit:"contain"}}/>
          <button onClick={()=>setLightbox(null)}
            style={{position:"absolute",top:16,right:16,background:"rgba(255,255,255,0.15)",
              border:"none",color:"#fff",borderRadius:"50%",width:36,height:36,fontSize:20,
              cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
        </div>
      )}
    </div>
  );
}

// Image uploader (edit mode)
function ImageUploader({images, onChange, label="画像"}) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(files) {
    const newImgs = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 3 * 1024 * 1024) { alert(`${file.name} は3MBを超えています`); continue; }
      const b64 = await fileToBase64(file);
      newImgs.push(b64);
    }
    if (newImgs.length) onChange([...(images||[]), ...newImgs]);
  }

  function removeImage(idx) {
    onChange((images||[]).filter((_,i) => i !== idx));
  }

  return (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
        📷 {label}の画像
      </div>
      {/* Existing images */}
      {(images||[]).length > 0 && (
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
          {images.map((src, i) => (
            <div key={i} style={{position:"relative",display:"inline-block"}}>
              <img src={src} alt="" style={{height:80,width:"auto",maxWidth:140,borderRadius:4,
                border:"1px solid rgba(196,160,80,0.3)",objectFit:"contain",background:"rgba(0,0,0,0.3)"}}/>
              <button onClick={()=>removeImage(i)}
                style={{position:"absolute",top:-6,right:-6,width:18,height:18,borderRadius:"50%",
                  border:"none",background:"#c0392b",color:"#fff",fontSize:11,cursor:"pointer",
                  display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>×</button>
            </div>
          ))}
        </div>
      )}
      {/* Drop zone */}
      <div
        onDragOver={e=>{e.preventDefault();setDragOver(true);}}
        onDragLeave={()=>setDragOver(false)}
        onDrop={e=>{e.preventDefault();setDragOver(false);handleFiles(e.dataTransfer.files);}}
        onClick={()=>inputRef.current?.click()}
        style={{border:`2px dashed ${dragOver?"#c4a050":"rgba(196,160,80,0.25)"}`,
          borderRadius:5,padding:"10px 14px",textAlign:"center",cursor:"pointer",
          background:dragOver?"rgba(196,160,80,0.08)":"rgba(255,255,255,0.02)",
          color:"#5a6a7a",fontSize:12,transition:"all 0.15s"}}>
        📎 クリックまたはドラッグで画像を追加（JPG・PNG・GIF、最大3MB）
      </div>
      <input ref={inputRef} type="file" accept="image/*" multiple style={{display:"none"}}
        onChange={e=>handleFiles(e.target.files)}/>
    </div>
  );
}

// ── Question Parser ───────────────────────────────────────────────────────────

// ── Vignette Parser ───────────────────────────────────────────────────────────
function isVignetteText(raw) {
  // Detect vignette: starts with "Vignette" OR has numbered sub-questions like "1Multiple Choice"
  return /^vignette\b/i.test(raw.trim()) || /^\d+Multiple Choice/m.test(raw);
}

function parseVignette(raw) {
  // Split off vignette passage from sub-questions
  // Sub-question boundary: line starting with digit(s) optionally followed by "Multiple Choice..."
  // or just a standalone number on its own line before a question
  const lines = raw.split(/\r?\n/);

  // Detect vignette header
  let vignetteLines = [];
  let subQuestionBlocks = [];
  let currentBlock = null;
  let passageEnded = false;

  // Sub-question start pattern: "1Multiple Choice1 point" or "1." or just "1\n" followed by a question
  const subQStartRe = /^(\d+)(Multiple Choice.*|\s*$)/i;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const lt = l.trim();

    // Skip "Vignette" header line itself
    if (i === 0 && /^vignette$/i.test(lt)) continue;

    const m = lt.match(/^(\d+)(Multiple Choice.*)?$/i);
    if (m && !passageEnded) {
      // Check next non-empty line looks like a question (not a choice A./B.)
      let nextNonEmpty = "";
      for (let j = i+1; j < lines.length; j++) {
        if (lines[j].trim()) { nextNonEmpty = lines[j].trim(); break; }
      }
      // If next line is not A./B./C. and not a marker, treat as sub-question start
      if (nextNonEmpty && !/^[A-E]\./i.test(nextNonEmpty)) {
        passageEnded = true;
        if (currentBlock) subQuestionBlocks.push(currentBlock);
        currentBlock = { num: parseInt(m[1]), lines: [] };
        continue;
      }
    }

    if (!passageEnded) {
      vignetteLines.push(l);
    } else if (currentBlock) {
      // Check if this line starts a NEW sub-question
      const nm = lt.match(/^(\d+)(Multiple Choice.*)?$/i);
      if (nm) {
        let nextNonEmpty = "";
        for (let j = i+1; j < lines.length; j++) {
          if (lines[j].trim()) { nextNonEmpty = lines[j].trim(); break; }
        }
        if (nextNonEmpty && !/^[A-E]\./i.test(nextNonEmpty)) {
          subQuestionBlocks.push(currentBlock);
          currentBlock = { num: parseInt(nm[1]), lines: [] };
          continue;
        }
      }
      currentBlock.lines.push(l);
    }
  }
  if (currentBlock) subQuestionBlocks.push(currentBlock);

  const vignetteText = vignetteLines.join("\n").trim();

  // Parse each sub-question block using existing parseQuestion
  const subQuestions = subQuestionBlocks.map(block => {
    const blockText = block.lines.join("\n");
    const parsed = parseQuestion(blockText);
    return { ...parsed, num: block.num };
  });

  return { vignetteText, subQuestions };
}

function parseQuestion(raw) {
  const lines = raw.split(/\r?\n/);
  const labels = ["A","B","C","D","E"];

  // Patterns — more specific ones must be checked BEFORE generic ones
  const choiceStartRe      = /^([A-E])\./i;
  // Per-choice feedback (new format): "Correct Answer Feedback:" / "Incorrect Answer Feedback:"
  const correctFeedbackRe  = /^correct answer feedback[:\s]*/i;
  const incorrectFeedbackRe= /^incorrect answer feedback[:\s]*/i;
  // Section markers (standalone): "Correct answer:" / "Incorrect answer:"
  const correctMarkerRe    = /^correct answer\s*:?\s*$/i;
  const incorrectMarkerRe  = /^incorrect answer\s*:?\s*$/i;
  // Generic "Correct Answer: B. text" (inline)
  const correctInlineRe    = /^correct answer[:\s]+[A-E]\./i;
  const feedbackRe         = /^(general )?feedback\s*$/i;

  let choiceStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (choiceStartRe.test(l) || correctMarkerRe.test(l) || incorrectMarkerRe.test(l) || correctInlineRe.test(l)) {
      choiceStartIdx = i; break;
    }
  }

  // Question text = everything before choices
  const questionLines = choiceStartIdx > 0 ? lines.slice(0, choiceStartIdx) : [];
  const questionEN = questionLines.map(l => l.trim()).filter(l => l).join("\n").trim();

  const choiceMap = {};
  let correctLetter = null;
  let explanationLines = [];
  let inFeedback = false;
  let pendingCorrect = false;
  let pendingIncorrect = false;
  let lastChoiceLetter = null; // track last seen choice for per-choice feedback

  const afterChoices = choiceStartIdx >= 0 ? lines.slice(choiceStartIdx) : lines;

  for (let i = 0; i < afterChoices.length; i++) {
    const l = afterChoices[i].trim();
    if (!l) continue;

    // General Feedback block (old format)
    if (feedbackRe.test(l)) { inFeedback = true; continue; }
    if (inFeedback) { explanationLines.push(l); continue; }

    // "Correct Answer Feedback: ..." → grab as explanation for the correct answer
    if (correctFeedbackRe.test(l)) {
      const text = l.replace(correctFeedbackRe, "").trim();
      if (text) explanationLines.push(text);
      continue;
    }

    // "Incorrect Answer Feedback: ..." → skip (wrong choice explanation)
    if (incorrectFeedbackRe.test(l)) continue;

    // "Correct Answer: B. text" (inline, old format)
    if (correctInlineRe.test(l)) {
      const rest = l.replace(/^correct answer[:\s]*/i, "").trim();
      const m = rest.match(/^([A-E])\.(.*)/i);
      if (m) {
        correctLetter = m[1].toUpperCase();
        const choiceText = m[2].trim();
        if (choiceText) choiceMap[correctLetter] = choiceText;
      }
      continue;
    }

    // "Correct answer:" standalone marker → next choice is correct
    if (correctMarkerRe.test(l)) { pendingCorrect = true; continue; }

    // "Incorrect answer:" standalone marker → next choice is incorrect
    if (incorrectMarkerRe.test(l)) { pendingIncorrect = true; continue; }

    // "Not Selected" - skip
    if (/^not selected$/i.test(l)) continue;

    // Choice line: "A. text"
    const cm = l.match(/^([A-E])\.(.*)/i);
    if (cm) {
      const letter = cm[1].toUpperCase();
      const text = cm[2].trim();
      // Only write if not already set (prevent duplicate entries like Q2/Q3 format where correct choice appears twice)
      if (text && !choiceMap[letter]) choiceMap[letter] = text;
      lastChoiceLetter = letter;
      if (pendingCorrect) { correctLetter = letter; pendingCorrect = false; }
      if (pendingIncorrect) { pendingIncorrect = false; }
      continue;
    }

    // Continuation text for a choice (e.g. multi-line choice)
    if (lastChoiceLetter && choiceMap[lastChoiceLetter] && !pendingCorrect && !pendingIncorrect) {
      // Only append if it doesn't look like a new section
      if (!/^[A-Z][A-Z\s]+:/.test(l)) {
        choiceMap[lastChoiceLetter] += " " + l;
      }
    }

    if (pendingCorrect) { pendingCorrect = false; }
    if (pendingIncorrect) { pendingIncorrect = false; }
  }

  const orderedLetters = labels.filter(l => choiceMap[l]);
  const choices = orderedLetters.map(l => choiceMap[l]);
  const correctIndex = correctLetter ? orderedLetters.indexOf(correctLetter) : 0;
  const explanationEN = explanationLines.join(" ").replace(/\s+/g, " ").trim();

  return {
    questionEN,
    choices: choices.length >= 2 ? choices : ["", "", ""],
    correctIndex: correctIndex >= 0 ? correctIndex : 0,
    explanationEN,
  };
}



// TableDisplay replaced by QuestionContent

// TableEditor replaced by inline table input
// ── GenerateKPBtn ─────────────────────────────────────────────────────────────
function GenerateKPBtn({question, onResult, disabled}) {
  const [loading, setLoading] = useState(false);

  async function generate() {
    const apiKey = getApiKey();
    if (!apiKey) {
      alert("AI機能を使うにはAnthropicのAPIキーが必要です。\n設定（⚙️）からAPIキーを入力してください。");
      return;
    }
    setLoading(true);
    const labels = ["A","B","C","D","E"];
    const correctChoice = question.choices[question.correctIndex];
    const prompt = `以下のCFA試験問題を分析して、覚えるべきポイントを日本語で出力してください。

【問題文】
${question.questionEN}

【正解】
${labels[question.correctIndex]}. ${correctChoice}

【解説】
${question.explanationEN}

【出力形式】
• で始まる箇条書き3〜5行
• 各行は1〜2文で簡潔に
• 試験で問われる核心概念・定義・数値・比較を優先
• 必要に応じて「覚え方」や「ひっかけ注意」も1行追加
• 余計な前置き・説明は不要。箇条書きのみ出力`;

    try {
      const reply = await askClaude(apiKey, [{role:"user", content: prompt}]);
      onResult(reply.trim());
    } catch(e) {
      alert("生成失敗: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button onClick={generate} disabled={disabled||loading} style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 12px",borderRadius:4,border:"1px solid rgba(155,143,212,0.5)",background:(disabled||loading)?"rgba(155,143,212,0.04)":"rgba(155,143,212,0.15)",color:(disabled||loading)?"#5a4a7a":"#b0a0e0",cursor:(disabled||loading)?"not-allowed":"pointer",fontSize:11,fontWeight:"bold",whiteSpace:"nowrap"}}>
      {loading?<><span style={{display:"inline-block",animation:"spin 1s linear infinite"}}>⟳</span> 生成中...</>:<>✨ AIで自動生成</>}
    </button>
  );
}

// ── QuickImport Modal ─────────────────────────────────────────────────────────
function QuickImportModal({open, onClose, onImport}) {
  const [rawText, setRawText] = useState("");
  const [parsed, setParsed] = useState(null);       // single question
  const [parsedVignette, setParsedVignette] = useState(null); // {vignetteText, subQuestions:[]}
  const [error, setError] = useState(null);
  const [useAI, setUseAI] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [editQ, setEditQ] = useState(false);

  const AI_PROMPT = (text) => `You are parsing a CFA exam question from raw copied text. Extract and return ONLY valid JSON (no markdown fences, no explanation).

Raw text:
---
${text}
---

Return this exact JSON structure:
{
  "questionEN": "...",
  "choices": ["choice A", "choice B", "choice C"],
  "correctIndex": 0,
  "explanationEN": "..."
}

Rules:
- questionEN: the question text. If it contains a table, format it as follows:
  * One line before the table with column headers separated by 2+ spaces (e.g. "Company A  Company B  Industry Average")
  * Each data row on its own line with cells separated by tab characters
  * Section headers (e.g. "ASSETS", "LIABILITIES AND SHAREHOLDERS' EQUITY") on their own line with no tabs
  * Example row: "Cash and cash equivalents\t5\t5\t7"
- choices: array of answer text only (no "A." prefix)
- correctIndex: 0-based index of the correct answer
- explanationEN: the explanation/feedback text`;

  async function handleParse() {
    if (!rawText.trim()) return;
    setError(null);

    if (useAI) {
      const apiKey = getApiKey();
      if (!apiKey) {
        setError("AIを使うにはAPIキーが必要です。設定（⚙️）から入力してください。");
        return;
      }
      setAiLoading(true);
      try {
        const reply = await askClaude(apiKey, [{role:"user", content: AI_PROMPT(rawText)}]);
        // Strip markdown fences if present
        const cleaned = reply.replace(/^```[a-z]*\n?/i,"").replace(/\n?```$/,"").trim();
        // Sanitize control characters inside JSON string values (tabs, carriage returns, etc.)
        const sanitized = cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")
          .replace(/\t/g, "\\t")
          .replace(/\r/g, "\\r");
        let data;
        try {
          data = JSON.parse(sanitized);
        } catch(parseErr) {
          // Last resort: ask Claude again with stricter instruction
          throw new Error("JSONの解析に失敗しました。テキストに特殊文字が含まれている可能性があります。(" + parseErr.message + ")");
        }
        if (!data.questionEN) throw new Error("questionENが取得できませんでした");
        if (!data.choices || data.choices.length < 2) throw new Error("選択肢が取得できませんでした");
        setParsed({
          questionEN: data.questionEN,
          choices: data.choices,
          correctIndex: typeof data.correctIndex === "number" ? data.correctIndex : 0,
          explanationEN: data.explanationEN || "",
        });
      } catch(e) {
        setError("AI解析エラー: " + e.message);
      } finally {
        setAiLoading(false);
      }
      return;
    }

    // Normal parse — detect vignette vs single question
    try {
      if (isVignetteText(rawText)) {
        const vResult = parseVignette(rawText);
        if (!vResult.vignetteText && vResult.subQuestions.length === 0) {
          setError("ビニエット形式を検出しましたが、小問を解析できませんでした。");
          return;
        }
        const valid = vResult.subQuestions.filter(q => q.questionEN && q.choices.filter(c=>c).length >= 2);
        if (valid.length === 0) { setError("小問の選択肢を検出できませんでした。"); return; }
        setParsedVignette({ vignetteText: vResult.vignetteText, subQuestions: valid });
      } else {
        const result = parseQuestion(rawText);
        if (!result.questionEN) { setError("問題文を検出できませんでした。"); return; }
        if (result.choices.filter(c=>c).length < 2) { setError("選択肢を2つ以上検出できませんでした。"); return; }
        setParsed(result);
      }
    } catch(e) {
      setError("解析エラー: " + e.message);
    }
  }

  function handleImport() {
    if (!parsed) return;
    onImport(parsed);
    setRawText(""); setParsed(null); setParsedVignette(null); setError(null); setEditQ(false); onClose();
  }

  function handleImportVignette() {
    if (!parsedVignette) return;
    onImport(null, parsedVignette);
    setRawText(""); setParsed(null); setParsedVignette(null); setError(null); setEditQ(false); onClose();
  }

  function handleClose() {
    setRawText(""); setParsed(null); setParsedVignette(null); setError(null); onClose();
  }

  if (!open) return null;
  const labels = ["A","B","C","D","E"];

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:200,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"16px",overflowY:"auto"}}>
      <div style={{...S.card,maxWidth:640,width:"100%",marginBottom:0,marginTop:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:13,color:"#c4a050",letterSpacing:"0.1em"}}>📋 テキストから問題を読み込む</div>
          <button onClick={handleClose} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:12}}>閉じる</button>
        </div>

        {/* ── Vignette multi-question preview ── */}
        {parsedVignette && !parsed && (<>
          <div style={{fontSize:11,color:"#b0a0e0",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
            📖 ビニエット形式を検出 — {parsedVignette.subQuestions.length}問
          </div>

          {/* Passage */}
          <div style={{background:"rgba(100,130,160,0.08)",border:"1px solid rgba(100,130,160,0.2)",borderRadius:4,padding:"10px 12px",marginBottom:12,fontSize:12,color:"#98afc0",lineHeight:1.7,maxHeight:160,overflowY:"auto",whiteSpace:"pre-wrap"}}>
            <div style={{fontSize:10,color:"#6b9fd4",letterSpacing:"0.1em",marginBottom:6}}>PASSAGE</div>
            {parsedVignette.vignetteText}
          </div>

          {/* Sub-questions summary */}
          {parsedVignette.subQuestions.map((sq,i) => (
            <div key={i} style={{...S.card,padding:"10px 12px",marginBottom:8,borderColor:"rgba(155,143,212,0.2)"}}>
              <div style={{fontSize:10,color:"#b0a0e0",marginBottom:4}}>小問 {sq.num || i+1}</div>
              <div style={{fontSize:13,color:"#c8bfaf",marginBottom:6,lineHeight:1.5}}>{sq.questionEN.slice(0,120)}{sq.questionEN.length>120?"…":""}</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {sq.choices.filter(c=>c).map((c,ci) => (
                  <span key={ci} style={{fontSize:11,padding:"2px 8px",borderRadius:3,
                    border:`1px solid ${ci===sq.correctIndex?"rgba(74,173,139,0.6)":"rgba(196,160,80,0.2)"}`,
                    background:ci===sq.correctIndex?"rgba(74,173,139,0.1)":"transparent",
                    color:ci===sq.correctIndex?"#4aad8b":"#7a8a9a"}}>
                    {labels[ci]}. {c.slice(0,40)}{c.length>40?"…":""}
                  </span>
                ))}
              </div>
            </div>
          ))}

          <div style={{display:"flex",gap:8,marginTop:4}}>
            <button onClick={()=>setParsedVignette(null)} style={{...S.btn("ghost"),flex:1}}>← やり直す</button>
            <button onClick={handleImportVignette} style={{...S.btn("primary"),flex:2,background:"linear-gradient(135deg,rgba(155,143,212,0.3),rgba(100,140,200,0.3))",borderColor:"rgba(155,143,212,0.5)"}}>
              📖 {parsedVignette.subQuestions.length}問をまとめて登録 →
            </button>
          </div>
        </>)}

        {!parsedVignette && !parsed ? (<>
          <div style={{fontSize:12,color:"#7a8a9a",lineHeight:1.7,marginBottom:10}}>
            問題文・選択肢・解説をまとめてコピペしてください。
          </div>
          <textarea
            value={rawText}
            onChange={e=>setRawText(e.target.value)}
            style={{...S.textarea, minHeight:220, fontSize:13}}
            placeholder={"問題文と選択肢・解説をここに貼り付け..."}
          />

          {/* AI checkbox */}
          <div
            onClick={()=>setUseAI(v=>!v)}
            style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:14,padding:"10px 12px",
              background:useAI?"rgba(155,143,212,0.1)":"rgba(255,255,255,0.03)",
              border:`1px solid ${useAI?"rgba(155,143,212,0.45)":"rgba(196,160,80,0.15)"}`,
              borderRadius:5,cursor:"pointer",userSelect:"none"}}>
            <div style={{width:18,height:18,borderRadius:3,border:`2px solid ${useAI?"#b0a0e0":"#4a5a6a"}`,
              background:useAI?"#b0a0e0":"transparent",display:"flex",alignItems:"center",
              justifyContent:"center",flexShrink:0,marginTop:1}}>
              {useAI && <span style={{color:"#0d1b2e",fontSize:13,fontWeight:"bold",lineHeight:1}}>✓</span>}
            </div>
            <div>
              <div style={{fontSize:13,color:useAI?"#b0a0e0":"#8a9ab0",fontWeight:"bold",marginBottom:2}}>
                ✨ AIで表を自動構造化する
              </div>
              <div style={{fontSize:11,color:"#5a6a7a",lineHeight:1.6}}>
                表を含む問題に有効。Claude APIが表をタブ区切り形式に変換し、演習中に整形表示されます。APIキーが必要です。
              </div>
            </div>
          </div>

          {error && <div style={{background:"rgba(224,90,90,0.1)",border:"1px solid rgba(224,90,90,0.3)",borderRadius:4,padding:"8px 12px",marginBottom:12,fontSize:12,color:"#e08a8a"}}>⚠️ {error}</div>}
          <button onClick={handleParse} disabled={!rawText.trim()||aiLoading}
            style={{...S.btn(useAI?"blue":"primary"),width:"100%",padding:12,opacity:(!rawText.trim()||aiLoading)?0.4:1,
              display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {aiLoading
              ? <><span style={{display:"inline-block",animation:"spin 1s linear infinite"}}>⟳</span> AI解析中...</>
              : useAI ? "✨ AIで解析する →" : "解析する →"
            }
          </button>
        </>) : null}

        {!parsedVignette && parsed && (<>
          <div style={{fontSize:11,color:useAI?"#b0a0e0":"#4aad8b",marginBottom:12,display:"flex",alignItems:"center",gap:6}}>
            {useAI?"✨ AI解析完了。":"✓ 解析完了。"}内容を確認してください。
          </div>

          <div style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.1em"}}>問題文</div>
              <button onClick={()=>setEditQ(v=>!v)} style={{...S.btn("ghost"),padding:"3px 9px",fontSize:11,borderColor:"rgba(196,160,80,0.3)"}}>
                {editQ?"✓ 確定":"✏ 編集"}
              </button>
            </div>
            {editQ
              ? <textarea
                  value={parsed.questionEN}
                  onChange={e=>setParsed(p=>({...p,questionEN:e.target.value}))}
                  style={{...S.textarea,minHeight:150,fontSize:12,marginBottom:0}}
                  placeholder="タブ区切りで表を入力できます"/>
              : <div style={{background:"rgba(255,255,255,0.04)",borderRadius:4,padding:"10px 12px",border:"1px solid rgba(196,160,80,0.2)"}}>
                  <QuestionContent text={parsed.questionEN}/>
                </div>
            }
          </div>

          <div style={{marginBottom:12}}>
            <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.1em",marginBottom:6}}>選択肢</div>
            {parsed.choices.filter(c=>c).map((c,i)=>(
              <div key={i} style={{display:"flex",gap:8,alignItems:"center",marginBottom:6,padding:"8px 10px",borderRadius:4,
                border:`1px solid ${i===parsed.correctIndex?"rgba(74,173,139,0.5)":"rgba(196,160,80,0.15)"}`,
                background:i===parsed.correctIndex?"rgba(74,173,139,0.08)":"rgba(255,255,255,0.02)"}}>
                <span style={{fontSize:12,fontWeight:"bold",color:i===parsed.correctIndex?"#4aad8b":"#5a6a7a",minWidth:20}}>{labels[i]}.</span>
                <span style={{fontSize:13,color:i===parsed.correctIndex?"#4aad8b":"#c8bfaf",flex:1,lineHeight:1.5}}>{c}</span>
                {i===parsed.correctIndex&&<span style={{fontSize:10,color:"#4aad8b"}}>✓ 正解</span>}
              </div>
            ))}
          </div>

          {parsed.explanationEN && (
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.1em",marginBottom:6}}>解説</div>
              <div style={{background:"rgba(255,255,255,0.04)",borderRadius:4,padding:"10px 12px",fontSize:13,color:"#c8bfaf",lineHeight:1.6,border:"1px solid rgba(196,160,80,0.2)"}}>{parsed.explanationEN}</div>
            </div>
          )}

          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>{setParsed(null);setParsedVignette(null);setEditQ(false);}} style={{...S.btn("ghost"),flex:1}}>← やり直す</button>
            <button onClick={handleImport} style={{...S.btn("primary"),flex:2}}>この内容で登録画面へ →</button>
          </div>
        </>)}
      </div>
    </div>
  );
}



// ── SimilarQuestionModal ──────────────────────────────────────────────────────
function SimilarQuestionModal({sourceQ, onClose, onSave}) {
  const [phase, setPhase] = useState("generating"); // generating | practice | done
  const [genQ, setGenQ] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [shuffleOrder, setShuffleOrder] = useState(null);
  const labels = ["A","B","C","D","E"];

  const PROMPT = `You are a CFA exam question writer. Create ONE new practice question similar to the one below, testing the same concept but with different numbers/companies/scenario. Return ONLY valid JSON (no markdown, no explanation).

Original question:
${sourceQ.questionEN}
Correct answer: ${sourceQ.choices[sourceQ.correctIndex]}
Explanation: ${sourceQ.explanationEN}

Return this exact JSON:
{
  "questionEN": "...",
  "choices": ["choice text A", "choice text B", "choice text C"],
  "correctIndex": 0,
  "explanationEN": "...",
  "keyPoints": "..."
}
Rules:
- choices: array of 3 answer texts (no A./B./C. prefix)
- correctIndex: 0-based index of correct answer
- keyPoints: 3-4 bullet points in Japanese starting with •
- If a table is needed: put column headers on one line separated by 2+ spaces, then each data row with tab-separated values`;

  useEffect(() => {
    const apiKey = getApiKey();
    if (!apiKey) { setError("APIキーが未設定です。設定から入力してください。"); setPhase("error"); return; }
    askClaude(apiKey, [{role:"user", content: PROMPT}])
      .then(reply => {
        const cleaned = reply.replace(/^```[a-z]*\n?/i,"").replace(/\n?```$/,"").trim()
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g," ").replace(/\t/g,"\\t").replace(/\r/g,"\\r");
        const data = JSON.parse(cleaned);
        if (!data.questionEN || !data.choices || data.choices.length < 2) throw new Error("生成データが不正です");
        const n = data.choices.length;
        const order = [...Array(n).keys()].sort(() => Math.random()-0.5);
        setShuffleOrder(order);
        setGenQ(data);
        setPhase("practice");
      })
      .catch(e => { setError("生成エラー: " + e.message); setPhase("error"); });
  }, []);

  function handleSave() {
    if (!genQ) return;
    onSave({
      ...BLANK_Q,
      id: uid(),
      topic: sourceQ.topic,
      difficulty: sourceQ.difficulty,
      questionEN: genQ.questionEN,
      choices: genQ.choices,
      correctIndex: genQ.correctIndex,
      explanationEN: genQ.explanationEN,
      keyPoints: genQ.keyPoints || "",
      relatedIds: [sourceQ.id],
      createdAt: new Date().toISOString(),
    });
    onClose();
  }

  const order = shuffleOrder || (genQ ? genQ.choices.map((_,i)=>i) : []);
  const correctDIdx = genQ ? order.indexOf(genQ.correctIndex) : -1;
  const choiceState = dIdx => {
    if (!confirmed) return selected===dIdx ? "selected" : "default";
    if (dIdx===correctDIdx && dIdx===selected) return "correct";
    if (dIdx===selected && dIdx!==correctDIdx) return "wrong";
    if (dIdx===correctDIdx) return "reveal-correct";
    return "default";
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:200,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"16px",overflowY:"auto"}}>
      <div style={{...S.card,maxWidth:600,width:"100%",marginTop:16,borderColor:"rgba(155,143,212,0.4)"}}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:13,color:"#b0a0e0",letterSpacing:"0.1em"}}>✨ AI類題</div>
          <button onClick={onClose} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:12}}>閉じる</button>
        </div>

        {phase==="generating" && (
          <div style={{textAlign:"center",padding:"30px 0"}}>
            <div style={{fontSize:24,marginBottom:12,animation:"spin 1.5s linear infinite",display:"inline-block"}}>⟳</div>
            <div style={{color:"#b0a0e0",fontSize:13}}>Claude が類題を生成中...</div>
          </div>
        )}

        {phase==="error" && (
          <div style={{background:"rgba(224,90,90,0.1)",border:"1px solid rgba(224,90,90,0.3)",borderRadius:4,padding:14,color:"#e08a8a",fontSize:13}}>
            ⚠️ {error}
          </div>
        )}

        {phase==="practice" && genQ && (<>
          <div style={{fontSize:10,color:"#b0a0e0",letterSpacing:"0.15em",marginBottom:6}}>AI生成問題 — {sourceQ.topic}</div>

          {/* Question */}
          <div style={{...S.card,borderColor:"rgba(155,143,212,0.3)",marginBottom:10}}>
            <QuestionContent text={genQ.questionEN}/>
          </div>

          {/* Choices */}
          <div style={{marginBottom:10}}>
            {order.map((origIdx, dIdx) => (
              <button key={dIdx} style={S.choiceBtn(choiceState(dIdx))} onClick={()=>{if(!confirmed)setSelected(dIdx);}}>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
                    <span style={{fontWeight:"bold",minWidth:20,opacity:0.7,flexShrink:0}}>{labels[dIdx]}.</span>
                    <span style={{lineHeight:1.5}}>{genQ.choices[origIdx]}</span>
                  </div>
                </div>
                {choiceState(dIdx)==="correct"&&<span style={{marginLeft:"auto"}}><Ic.check/></span>}
                {choiceState(dIdx)==="wrong"&&<span style={{marginLeft:"auto"}}><Ic.xmark/></span>}
                {choiceState(dIdx)==="reveal-correct"&&<span style={{marginLeft:"auto"}}><Ic.check/></span>}
              </button>
            ))}
          </div>

          {/* Confirm or result */}
          {!confirmed && selected!==null && (
            <button onClick={()=>setConfirmed(true)} style={{...S.btn("primary"),width:"100%",padding:13,marginBottom:10,fontWeight:"bold"}}>
              ✅ Confirm Answer
            </button>
          )}

          {confirmed && (<>
            <div style={{...S.card,borderColor:selected===correctDIdx?"rgba(74,173,139,0.4)":"rgba(224,90,90,0.3)",background:selected===correctDIdx?"rgba(74,173,139,0.06)":"rgba(224,90,90,0.06)",marginBottom:10,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:22}}>{selected===correctDIdx?"✓":"✗"}</span>
              <div style={{fontSize:13,color:selected===correctDIdx?"#4aad8b":"#e05a5a",fontWeight:"bold"}}>{selected===correctDIdx?"正解！":"不正解"}</div>
            </div>
            <div style={{...S.card,marginBottom:10}}>
              <div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em",marginBottom:6}}>EXPLANATION</div>
              <div style={{fontSize:13,color:"#c8bfaf",lineHeight:1.7}}>{genQ.explanationEN}</div>
            </div>
            {genQ.keyPoints && (
              <div style={{background:"rgba(196,160,80,0.05)",border:"1px solid rgba(196,160,80,0.2)",borderRadius:5,padding:"10px 12px",marginBottom:12}}>
                <div style={{fontSize:11,color:"#c4a050",marginBottom:4}}>📌 覚えるべきポイント</div>
                <div style={{fontSize:13,color:"#d4c08a",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{genQ.keyPoints}</div>
              </div>
            )}
            <button onClick={handleSave} style={{...S.btn("primary"),width:"100%",padding:13,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              💾 この問題を登録して保存する
            </button>
          </>)}
        </>)}
      </div>
    </div>
  );
}

// ── HistoryPage ───────────────────────────────────────────────────────────────
function HistoryPage({questions, setPage, startSingleQ, addQ, setEditQ}) {
  const [sortBy, setSortBy] = useState("date");   // date | wrong | topic
  const [filterTopic, setFilterTopic] = useState("All");
  const [similarSrc, setSimilarSrc] = useState(null);

  const attempted = questions.filter(q => q.attemptCount > 0);
  const topics = ["All", ...CFA_TOPICS.filter(t => attempted.some(q => q.topic === t))];

  const filtered = attempted
    .filter(q => filterTopic === "All" || q.topic === filterTopic)
    .sort((a, b) => {
      if (sortBy === "date")  return (b.lastAttempted||"").localeCompare(a.lastAttempted||"");
      if (sortBy === "wrong") {
        const ra = a.attemptCount ? (a.wrongCount / a.attemptCount) : 0;
        const rb = b.attemptCount ? (b.wrongCount / b.attemptCount) : 0;
        return rb - ra;
      }
      if (sortBy === "topic") return a.topic.localeCompare(b.topic);
      return 0;
    });

  const totalAttempts = attempted.reduce((s, q) => s + q.attemptCount, 0);
  const totalCorrect  = attempted.reduce((s, q) => s + (q.attemptCount - q.wrongCount), 0);
  const overallAcc    = totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : 0;

  return (
    <>
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button onClick={()=>setPage("home")} style={{...S.btn("ghost"),padding:"6px 10px"}}><Ic.back/></button>
        <div style={{fontSize:14,color:"#c4a050",letterSpacing:"0.1em"}}>📊 解答履歴</div>
      </div>

      {/* Summary card */}
      {attempted.length > 0 && (
        <div style={{...S.card,borderColor:"rgba(196,160,80,0.3)",marginBottom:14,display:"flex",gap:20,flexWrap:"wrap"}}>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:28,fontWeight:"bold",color:"#4aad8b"}}>{attempted.length}</div>
            <div style={{fontSize:11,color:"#5a7a6a"}}>挑戦済問題数</div>
          </div>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:28,fontWeight:"bold",color:"#c4a050"}}>{totalAttempts}</div>
            <div style={{fontSize:11,color:"#7a6a4a"}}>総解答回数</div>
          </div>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:28,fontWeight:"bold",color:overallAcc>=70?"#4aad8b":"#e05a5a"}}>{overallAcc}%</div>
            <div style={{fontSize:11,color:"#5a6a7a"}}>総合正答率</div>
          </div>
        </div>
      )}

      {/* Filters + Sort */}
      <div style={{marginBottom:10}}>
        <select value={filterTopic} onChange={e=>setFilterTopic(e.target.value)} style={{...S.input,marginBottom:8,fontSize:12}}>
          {topics.map(t=><option key={t} value={t} style={{background:"#0d1b2e"}}>{t==="All"?"全分野":t}</option>)}
        </select>
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
          {[["date","最近解いた順"],["wrong","間違い率順"],["topic","分野順"]].map(([val,label])=>(
            <button key={val} onClick={()=>setSortBy(val)}
              style={{...S.btn(sortBy===val?"primary":"ghost"),padding:"4px 11px",fontSize:11}}>{label}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <div style={{...S.card,textAlign:"center",padding:40,color:"#5a6a7a"}}>
          {attempted.length === 0 ? "まだ問題を解いていません" : "該当する問題がありません"}
        </div>
      )}

      {filtered.map(q => {
        const acc = q.attemptCount > 0 ? Math.round(((q.attemptCount - q.wrongCount) / q.attemptCount) * 100) : 0;
        const accColor = acc >= 80 ? "#4aad8b" : acc >= 50 ? "#c4a050" : "#e05a5a";
        const lastDate = q.lastAttempted ? new Date(q.lastAttempted).toLocaleDateString("ja-JP") : "—";
        return (
          <div key={q.id} style={{...S.card,marginBottom:8,padding:"12px 14px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:5}}>
                  <span style={S.tag()}>{q.topic.split(" ").slice(0,2).join(" ")}</span>
                  <span style={S.tag(q.difficulty==="Hard"?"#e05a5a":q.difficulty==="Medium"?"#d4a34a":"#4aad8b")}>{q.difficulty}</span>
                </div>
                <div style={{fontSize:13,color:"#b0c0cc",lineHeight:1.5,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",marginBottom:6}}>
                  {q.questionEN.replace(/	/g," ").slice(0,120)}{q.questionEN.length>120?"…":""}
                </div>
                <div style={{display:"flex",gap:14,fontSize:11,color:"#5a6a7a"}}>
                  <span>解答 <strong style={{color:"#c4a050"}}>{q.attemptCount}回</strong></span>
                  <span>正解 <strong style={{color:"#4aad8b"}}>{q.attemptCount - q.wrongCount}回</strong></span>
                  <span>不正解 <strong style={{color:"#e05a5a"}}>{q.wrongCount}回</strong></span>
                  <span>最終 <strong style={{color:"#7a9ab0"}}>{lastDate}</strong></span>
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,flexShrink:0}}>
                <div style={{fontSize:20,fontWeight:"bold",color:accColor}}>{acc}%</div>
                <div style={{fontSize:9,color:"#5a6a7a"}}>正答率</div>
                <button onClick={()=>startSingleQ(q.id)}
                  style={{...S.btn("ghost"),padding:"4px 8px",fontSize:10,marginTop:4}}>
                  解く
                </button>
                <button onClick={()=>{setEditQ(q);setPage("add");}}
                  style={{...S.btn("ghost"),padding:"4px 8px",fontSize:10,marginTop:2}}>
                  <Ic.edit/>
                </button>
                {q.attemptCount>=2 && acc<70 && (
                  <button onClick={()=>setSimilarSrc(q)}
                    style={{...S.btn("ghost"),padding:"4px 8px",fontSize:10,marginTop:4,borderColor:"rgba(155,143,212,0.5)",color:"#b0a0e0"}}>
                    類題
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
    {similarSrc && (
      <SimilarQuestionModal
        sourceQ={similarSrc}
        onClose={()=>setSimilarSrc(null)}
        onSave={q=>{addQ(q);setSimilarSrc(null);}}
      />
    )}
    </>
  );
}

// ── AddQuestion ───────────────────────────────────────────────────────────────
function AddQuestion({editQ,setEditQ,addQ,addQs,updateQ,questions,setPage}){
  const [form,setForm]=useState(()=>editQ?{...editQ,relatedIds:editQ.relatedIds||[]}:{...BLANK_Q,id:uid()});
  const [translating,setTranslating]=useState({});const [transError,setTransError]=useState(null);const [showRelated,setShowRelated]=useState(false);
  const [showImport,setShowImport]=useState(false);
  // Local vignette queue — avoids stale closure issues with App-level state
  const [vigQueue,setVigQueue]=useState(null); // {qs:[], idx:0}
  function applyParsed(parsed,vt=""){setForm(f=>({...f,questionEN:parsed.questionEN,choices:parsed.choices.length>=2?parsed.choices:["","",""],choicesJA:Array(parsed.choices.length).fill(""),correctIndex:parsed.correctIndex,explanationEN:parsed.explanationEN||"",vignetteText:vt||"",questionImages:f.questionImages||[],vignetteImages:f.vignetteImages||[]}));}
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const setChoice=(idx,val)=>setForm(f=>{const c=[...f.choices];c[idx]=val;return{...f,choices:c};});
  const setChoiceJA=(idx,val)=>setForm(f=>{const c=[...(f.choicesJA||[])];c[idx]=val;return{...f,choicesJA:c};});
  const addChoice=()=>setForm(f=>({...f,choices:[...f.choices,""],choicesJA:[...(f.choicesJA||[]),""],}));
  const removeChoice=idx=>setForm(f=>({...f,choices:f.choices.filter((_,i)=>i!==idx),choicesJA:(f.choicesJA||[]).filter((_,i)=>i!==idx),correctIndex:f.correctIndex>=idx&&f.correctIndex>0?f.correctIndex-1:f.correctIndex}));
  async function translateField(text,targetKey){if(!text.trim())return;setTranslating(t=>({...t,[targetKey]:true}));setTransError(null);try{const r=await translateEN2JA(text);set(targetKey,r);}catch(e){setTransError("翻訳失敗: "+e.message);}finally{setTranslating(t=>({...t,[targetKey]:false}));}}
  async function translateChoiceJA(idx){const text=form.choices[idx];if(!text.trim())return;const key=`cJA_${idx}`;setTranslating(t=>({...t,[key]:true}));setTransError(null);try{const r=await translateEN2JA(text);setChoiceJA(idx,r);}catch(e){setTransError("翻訳失敗: "+e.message);}finally{setTranslating(t=>({...t,[key]:false}));}}
  async function translateAll(){setTransError(null);const tasks=[];if(form.questionEN.trim()&&!form.questionJA.trim())tasks.push(translateField(form.questionEN,"questionJA"));if(form.explanationEN.trim()&&!form.explanationJA.trim())tasks.push(translateField(form.explanationEN,"explanationJA"));form.choices.forEach((c,i)=>{if(c.trim()&&!(form.choicesJA||[])[i]?.trim())tasks.push(translateChoiceJA(i));});for(const t of tasks)await t;}
  function submit(){
    if(!form.questionEN.trim())return alert("問題文（英語）を入力してください");
    if(form.choices.filter(c=>c.trim()).length<2)return alert("選択肢を2つ以上入力してください");
    if(vigQueue){
      // Store current edits back into queue
      const updatedQs=[...vigQueue.qs];
      updatedQs[vigQueue.idx]={...form};
      const nextIdx=vigQueue.idx+1;
      if(nextIdx<updatedQs.length){
        // Advance to next question — directly set form (no useEffect)
        const nextQ=updatedQs[nextIdx];
        setVigQueue({qs:updatedQs, idx:nextIdx});
        setForm({...nextQ});
      } else {
        // All edited — batch save all at once with relatedIds
        const allIds=updatedQs.map(q=>q.id);
        const withRelated=updatedQs.map(q=>({...q, relatedIds:allIds.filter(id=>id!==q.id)}));
        addQs(withRelated);
        setVigQueue(null);
        setEditQ(null);
        setPage("list");
      }
    } else {
      editQ?updateQ(form):addQ(form);
      setEditQ(null);
      setPage("list");
    }
  }
  const labels=["A","B","C","D","E"];const anyTranslating=Object.values(translating).some(Boolean);
  const canTranslateAll=(form.questionEN.trim()&&!form.questionJA.trim())||(form.explanationEN.trim()&&!form.explanationJA.trim())||form.choices.some((c,i)=>c.trim()&&!(form.choicesJA||[])[i]?.trim());
  const linkedQs=(form.relatedIds||[]).map(id=>questions.find(q=>q.id===id)).filter(Boolean);
  return(<div>
    <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    <QuickImportModal open={showImport} onClose={()=>setShowImport(false)} onImport={(parsed,vignette)=>{
      if(vignette){
        const qs=vignette.subQuestions.map(sq=>({
          ...BLANK_Q, id:uid(), topic:form.topic, difficulty:form.difficulty,
          questionEN:sq.questionEN,
          choices:sq.choices.length>=2?sq.choices:["","",""],
          choicesJA:Array(sq.choices.length).fill(""),
          correctIndex:sq.correctIndex,
          explanationEN:sq.explanationEN||"",
          vignetteText:vignette.vignetteText
        }));
        // Load Q1 directly and store queue locally — no App-level state needed
        setVigQueue({qs, idx:0});
        setForm({...qs[0]});
        setShowImport(false);
      } else if(parsed){
        applyParsed(parsed);
      }
    }} />
    {/* ── Vignette sequential header ── */}
    {vigQueue && (
      <div style={{background:"rgba(155,143,212,0.12)",border:"1px solid rgba(155,143,212,0.35)",borderRadius:5,padding:"8px 12px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{fontSize:12,color:"#b0a0e0",display:"flex",alignItems:"center",gap:6}}>
          📖 ビニエット一括登録
          <span style={{background:"rgba(155,143,212,0.3)",borderRadius:10,padding:"2px 8px",fontSize:11,fontWeight:"bold"}}>
            {vigQueue.idx+1} / {vigQueue.qs.length}
          </span>
        </div>
        <div style={{display:"flex",gap:4}}>
          {vigQueue.idx>0&&<button onClick={()=>{const prev=vigQueue.idx-1;const prevQ=vigQueue.qs[prev];setVigQueue(vq=>({...vq,idx:prev}));setForm({...prevQ});}} style={{...S.btn("ghost"),padding:"3px 9px",fontSize:11}}>← 前</button>}
          <button onClick={()=>{setVigQueue(null);setEditQ(null);setPage("list");}} style={{...S.btn("danger"),padding:"3px 9px",fontSize:11}}>中止</button>
        </div>
      </div>
    )}
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
      <button onClick={()=>{setVigQueue(null);setEditQ(null);setPage("list");}} style={{...S.btn("ghost"),padding:"6px 10px"}}><Ic.back/></button>
      <div style={{fontSize:14,color:"#c4a050",letterSpacing:"0.1em"}}>
        {vigQueue ? `小問 ${vigQueue.idx+1} を編集` : editQ?"問題を編集":"新しい問題を登録"}
      </div>
      {!editQ&&!vigQueue&&<button onClick={()=>setShowImport(true)} style={{...S.btn("teal"),padding:"6px 12px",fontSize:11,marginLeft:"auto",display:"flex",alignItems:"center",gap:4}}>📋 テキストから読込</button>}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:10,marginBottom:4}}><div><label style={S.label}>分野 *</label><select value={form.topic} onChange={e=>set("topic",e.target.value)} style={S.input}>{CFA_TOPICS.map(t=><option key={t} value={t} style={{background:"#0d1b2e"}}>{t}</option>)}</select></div><div><label style={S.label}>難易度</label><select value={form.difficulty} onChange={e=>set("difficulty",e.target.value)} style={{...S.input,width:100}}>{DIFFICULTY.map(d=><option key={d} value={d} style={{background:"#0d1b2e"}}>{d}</option>)}</select></div></div>
    <div style={{marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <label style={{...S.label,marginBottom:0,color:"#6b9fd4"}}>📖 ビニエット本文（任意）</label>
        {form.vignetteText&&<span style={{fontSize:10,color:"#4a6a8a"}}>演習中に折りたたんで表示されます</span>}
      </div>
      <InlineTableEditor
        value={form.vignetteText||""}
        onChange={v=>set("vignetteText",v)}
        labelOverride="ビニエット本文（任意）"
        hideLabelInside
        minHeight={form.vignetteText?100:44}
        placeholderText="ビニエット（大問の文章）がある場合はここに貼り付け。表はタブ区切りで自動認識されます。"
        accentColor="rgba(100,140,200,0.4)"
        textColor="#8aafcc"
      />
      {form.vignetteText!==undefined && <ImageUploader images={form.vignetteImages||[]} onChange={imgs=>set("vignetteImages",imgs)} label="ビニエット"/>}
    </div>
    <InlineTableEditor value={form.questionEN} onChange={v=>set("questionEN",v)}/>
    <ImageUploader images={form.questionImages||[]} onChange={imgs=>set("questionImages",imgs)} label="問題文"/>
    <label style={S.label}>選択肢 * （正解をクリックして選択）</label>
    {form.choices.map((choice,idx)=>{const jaVal=(form.choicesJA||[])[idx]||"";const isTrans=!!translating[`cJA_${idx}`];return(<div key={idx} style={{marginBottom:12}}><div style={{display:"flex",gap:6,alignItems:"flex-start",marginBottom:4}}><button onClick={()=>set("correctIndex",idx)} style={{minWidth:32,height:36,borderRadius:4,border:`2px solid ${form.correctIndex===idx?"#4aad8b":"rgba(196,160,80,0.3)"}`,background:form.correctIndex===idx?"rgba(74,173,139,0.2)":"transparent",color:form.correctIndex===idx?"#4aad8b":"#5a6a7a",cursor:"pointer",fontSize:12,fontWeight:"bold",display:"flex",alignItems:"center",justifyContent:"center"}}>{labels[idx]}</button><input value={choice} onChange={e=>setChoice(idx,e.target.value)} style={{...S.input,marginBottom:0,flex:1}} placeholder={`Choice ${labels[idx]}`}/>{form.choices.length>2&&<button onClick={()=>removeChoice(idx)} style={{...S.btn("danger"),padding:"6px 8px",minWidth:32,height:36}}><Ic.trash/></button>}</div><div style={{display:"flex",gap:6,alignItems:"center",paddingLeft:38}}><input value={jaVal} onChange={e=>setChoiceJA(idx,e.target.value)} style={{...S.input,marginBottom:0,flex:1,fontSize:13,borderColor:jaVal?"rgba(100,180,220,0.3)":"rgba(196,160,80,0.15)"}} placeholder={`選択肢 ${labels[idx]} の日本語訳`}/>{choice.trim()&&<TranslateBtn loading={isTrans} onClick={()=>translateChoiceJA(idx)}/>}</div></div>);})}
    {form.choices.length<5&&<button onClick={addChoice} style={{...S.btn("ghost"),fontSize:12,marginBottom:14}}>+ 選択肢を追加</button>}
    <label style={S.label}>解説（英語）</label><textarea value={form.explanationEN} onChange={e=>set("explanationEN",e.target.value)} style={S.textarea} placeholder="Explanation in English..."/>
    <div style={{borderTop:"1px solid rgba(196,160,80,0.15)",paddingTop:14,marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}><div style={{fontSize:10,color:"#c4a050",letterSpacing:"0.15em"}}>日本語セクション</div>{canTranslateAll&&<button onClick={translateAll} disabled={anyTranslating} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"6px 14px",borderRadius:4,border:"1px solid rgba(100,180,220,0.5)",background:anyTranslating?"rgba(100,180,220,0.05)":"rgba(100,180,220,0.15)",color:anyTranslating?"#5a8aaa":"#80c8e8",cursor:anyTranslating?"not-allowed":"pointer",fontSize:12,fontWeight:"bold"}}>{anyTranslating?<><span style={{display:"inline-block",animation:"spin 1s linear infinite"}}>⟳</span> 翻訳中...</>:<>🌐 まとめて自動翻訳</>}</button>}</div>
    {transError&&<div style={{background:"rgba(224,90,90,0.1)",border:"1px solid rgba(224,90,90,0.3)",borderRadius:4,padding:"8px 12px",marginBottom:12,fontSize:12,color:"#e08a8a"}}>⚠️ {transError}</div>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}><label style={{...S.label,marginBottom:0}}>問題文（日本語訳）</label><TranslateBtn loading={!!translating.questionJA} onClick={()=>translateField(form.questionEN,"questionJA")}/></div>
    <textarea value={form.questionJA} onChange={e=>set("questionJA",e.target.value)} style={{...S.textarea,borderColor:form.questionJA?"rgba(100,180,220,0.3)":"rgba(196,160,80,0.25)"}} placeholder="問題の日本語訳を入力..."/>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}><label style={{...S.label,marginBottom:0}}>解説（日本語）</label><TranslateBtn loading={!!translating.explanationJA} onClick={()=>translateField(form.explanationEN,"explanationJA")}/></div>
    <textarea value={form.explanationJA} onChange={e=>set("explanationJA",e.target.value)} style={{...S.textarea,borderColor:form.explanationJA?"rgba(100,180,220,0.3)":"rgba(196,160,80,0.25)"}} placeholder="解説の日本語訳を入力..."/>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
      <label style={{...S.label,marginBottom:0}}>📌 覚えるべきポイント</label>
      <GenerateKPBtn
        disabled={!form.questionEN.trim()||!form.explanationEN.trim()}
        question={form}
        onResult={text=>set("keyPoints",text)}
      />
    </div>
    <textarea value={form.keyPoints} onChange={e=>set("keyPoints",e.target.value)} style={{...S.textarea,borderColor:"rgba(196,160,80,0.4)"}} placeholder="覚えるべきポイント（右上のボタンでAI自動生成も可）..."/>
    <div style={{borderTop:"1px solid rgba(196,160,80,0.15)",paddingTop:14,marginBottom:14}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><div style={{fontSize:10,color:"#9b8fd4",letterSpacing:"0.15em",display:"flex",alignItems:"center",gap:5}}><Ic.link/> 関連問題リンク</div><button onClick={()=>setShowRelated(v=>!v)} style={{...S.btn("ghost"),padding:"4px 10px",fontSize:11,borderColor:"rgba(155,143,212,0.4)",color:"#9b8fd4"}}>{showRelated?"閉じる":"問題を紐づける"}</button></div>{linkedQs.length>0&&<div style={{fontSize:11,color:"#9b8fd4",marginBottom:8}}>{linkedQs.map(q=><span key={q.id} style={{...S.tag("#9b8fd4"),marginRight:4,marginBottom:4,display:"inline-block"}}>{q.questionEN.slice(0,25)}…</span>)}</div>}{showRelated&&<RelatedQuestionPicker questions={questions} selected={form.relatedIds||[]} onChange={ids=>set("relatedIds",ids)} currentId={form.id}/>}</div>
    <button style={{...S.btn("primary"),width:"100%",padding:14,fontSize:15}} onClick={submit}>
      {vigQueue
        ? vigQueue.idx+1 < vigQueue.qs.length
          ? `保存して次へ → (${vigQueue.idx+2}/${vigQueue.qs.length}問目)`
          : `保存して完了 ✓ (全${vigQueue.qs.length}問)`
        : editQ?"変更を保存する":"問題を登録する"}
    </button>
  </div>);
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App(){
  const [user,setUser]=useState(undefined); // undefined=loading, null=not logged in
  const [questions,setQuestions]=useState([]);
  const [notes,setNotes]=useState([]);
  const [page,setPage]=useState("home");
  const [editQ,setEditQ]=useState(null);
  const [editNote,setEditNote]=useState(null);
  const [viewNote,setViewNote]=useState(null);
  const [practiceMode,setPracticeMode]=useState("due");
  const [singleQId,setSingleQId]=useState(null);
  const [showSettings,setShowSettings]=useState(false);
  const [dataLoaded,setDataLoaded]=useState(false);
  const [saving,setSaving]=useState(false);

  // Auth listener
  useEffect(()=>{
    return onAuthStateChanged(auth, async u=>{
      setUser(u);
      if(u){
        const [qs,ns]=await Promise.all([fbLoadQuestions(u.uid),fbLoadNotes(u.uid)]);
        setQuestions(qs);setNotes(ns);setDataLoaded(true);
      } else { setDataLoaded(false); }
    });
  },[]);

  const persistQ=useCallback(async(qs,uid)=>{setQuestions(qs);setSaving(true);await fbSaveQuestions(uid,qs);setSaving(false);},[]);
  const persistN=useCallback(async(ns,uid)=>{setNotes(ns);setSaving(true);await fbSaveNotes(uid,ns);setSaving(false);},[]);

  const addQ=q=>persistQ([...questions,{...q,srNextReview:q.srNextReview||getTomorrow()}],user.uid);
  const addQs=qs=>persistQ([...questions,...qs.map(q=>({...q,srNextReview:q.srNextReview||getTomorrow()}))],user.uid); // batch add multiple questions
  const updateQ=q=>persistQ(questions.map(x=>x.id===q.id?q:x),user.uid);
  const deleteQ=id=>persistQ(questions.filter(q=>q.id!==id),user.uid);
  const addNote=n=>persistN([...notes,n],user.uid);
  const updateNote=n=>persistN(notes.map(x=>x.id===n.id?n:x),user.uid);
  const deleteNote=id=>persistN(notes.filter(n=>n.id!==id),user.uid);

  function startSingleQ(id){setSingleQId(id);setPracticeMode("all");setPage("practice");}

  async function handleLogout(){await signOut(auth);setQuestions([]);setNotes([]);setPage("home");}

  const dueCount=questions.filter(isDueToday).length;

  // Loading
  if(user===undefined) return(<div style={{...S.app,alignItems:"center",justifyContent:"center"}}><div style={{color:"#c4a050",letterSpacing:"0.2em",fontSize:12}}>LOADING...</div></div>);

  // Not logged in
  if(!user) return <LoginScreen/>;

  // Data loading
  if(!dataLoaded) return(<div style={{...S.app,alignItems:"center",justifyContent:"center"}}><div style={{color:"#c4a050",letterSpacing:"0.2em",fontSize:12}}>データを読み込み中...</div></div>);

  const navItems=[{key:"home",label:"Home",icon:Ic.home},{key:"list",label:"一覧",icon:Ic.list},{key:"add",label:"登録",icon:Ic.plus},{key:"practice",label:"演習",icon:Ic.play},{key:"notes",label:"ノート",icon:Ic.note}];
  const showNav=page!=="add"&&page!=="note-edit"&&page!=="note-view"&&page!=="history";

  return(<div style={S.app}>
    <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    <SettingsModal open={showSettings} onClose={()=>setShowSettings(false)} user={user} onLogout={handleLogout}/>
    <div style={S.header}>
      <div style={{display:"flex",flexDirection:"column",gap:1}}>
        <div style={{fontSize:11,letterSpacing:"0.25em",color:"#c4a050",textTransform:"uppercase"}}>CFA® Review</div>
        <div style={{fontSize:15,fontWeight:"bold",color:"#f0e8d8",letterSpacing:"0.05em"}}>My Question Bank</div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        {saving&&<span style={{fontSize:10,color:"#5a6a7a"}}>保存中...</span>}
        {dueCount>0&&<div onClick={()=>{setPracticeMode("due");setPage("practice");}} style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",background:"rgba(74,173,139,0.12)",border:"1px solid rgba(74,173,139,0.3)",borderRadius:4,padding:"3px 9px"}}><Ic.bell/><span style={{fontSize:11,color:"#4aad8b"}}>{dueCount}問</span></div>}
        <button onClick={()=>setShowSettings(true)} style={{background:"none",border:"none",cursor:"pointer",color:"#5a6a7a",padding:4,display:"flex",alignItems:"center"}}><Ic.settings/></button>
      </div>
    </div>
    <div style={S.content}>
      {page==="home"&&<Dashboard questions={questions} notes={notes} setPage={setPage} setPracticeMode={setPracticeMode}/>}
      {page==="list"&&<QuestionList questions={questions} setPage={setPage} setEditQ={setEditQ} deleteQ={deleteQ} startSingleQ={startSingleQ}/>}
      {page==="add"&&<AddQuestion editQ={editQ} setEditQ={setEditQ} addQ={addQ} addQs={addQs} updateQ={updateQ} questions={questions} setPage={setPage}/>}
      {page==="practice"&&<Practice questions={questions} updateQ={updateQ} initialMode={practiceMode} singleQId={singleQId} clearSingleQ={()=>setSingleQId(null)} onOpenSettings={()=>setShowSettings(true)}/>}
      {page==="notes"&&<NoteList notes={notes} questions={questions} setPage={setPage} setEditNote={setEditNote} setViewNote={setViewNote} deleteNote={deleteNote}/>}
      {page==="note-edit"&&<NoteEditor editNote={editNote} setEditNote={setEditNote} addNote={addNote} updateNote={updateNote} questions={questions} setPage={setPage}/>}
      {page==="note-view"&&<NoteViewer note={viewNote} questions={questions} setPage={setPage} setEditNote={setEditNote}/>}
      {page==="history"&&<HistoryPage questions={questions} setPage={setPage} startSingleQ={startSingleQ} addQ={addQ} setEditQ={setEditQ}/>}
    </div>
    {showNav&&<div style={S.nav}>{navItems.map(item=>(<button key={item.key} style={S.navBtn(page===item.key||(item.key==="notes"&&(page==="note-edit"||page==="note-view")))} onClick={()=>{setEditQ(null);setSingleQId(null);setPage(item.key);}}><item.icon/>{item.label}{item.key==="practice"&&dueCount>0&&<span style={{position:"absolute",top:0,right:4,background:"#4aad8b",color:"#fff",borderRadius:"50%",width:14,height:14,fontSize:8,display:"flex",alignItems:"center",justifyContent:"center"}}>{dueCount}</span>}</button>))}</div>}
  </div>);
}
