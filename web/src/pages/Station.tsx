import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Mic, Play, Pause, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { PalmMark } from '../components/ui.tsx';
import { api,useMe,usePortfolio } from '../api.ts';
import './station.css';
import { LiveCall } from '../components/LiveCall.tsx';
type Asset={id:string;symbol:string;name:string;price:string|null;change_24h:string|null};
type Ticket={id:string;kind:string;symbol:string;amount_usd:number;fee:string;fee_asset:string;status:string;expires:number;simulated:boolean;upstream?:string};
type Segment={bell?:string;id:string;started_at:number;duration:number;source:string;voice:string;lines:{speaker:'A'|'B';line:string;audio?:string}[];assets:string[]};
type StationData={simulated:boolean;market_data:{mode:string;source:string;connected:boolean;updated_at:string|null};segment:Segment;assets:Asset[];limits:{order:number;daily:number};board:{id:string;name:string;kind:string;symbol:string;amount_usd:number;created:number;order_id:string;simulated:boolean}[];providers:{grok:boolean;elevenlabs:boolean;agent:boolean}};
const money=(n:number|string|null|undefined)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n||0));
export function Station(){
  const qc=useQueryClient(),me=useMe(),portfolio=usePortfolio();
  const station=useQuery({queryKey:['station'],queryFn:()=>api<StationData>('/api/station'),refetchInterval:2500});
  const data=station.data;
  const [modal,setModal]=useState<'auth'|'ticket'|'call'|'wire'|null>(null),[login,setLogin]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[ticket,setTicket]=useState<Ticket|null>(null),[playing,setPlaying]=useState(false),[line,setLine]=useState(0),[tab,setTab]=useState<'board'|'transcript'>('board'),[now,setNow]=useState(Date.now()),[reply,setReply]=useState('Welcome to the floor. Try “buy 1 SOL”. I’ll read your ticket back before you confirm.'),[callText,setCallText]=useState(''),[recording,setRecording]=useState(false);
  const audio=useRef<HTMLAudioElement|null>(null),recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),speechRun=useRef(0);
  const wire=useQuery({queryKey:['wire'],queryFn:()=>api<{time:string;operation:string;status:string;id?:string;simulated:boolean}[]>('/api/wire'),enabled:modal==='wire'&&!!me.data,refetchInterval:3000});
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  const stop=()=>{speechRun.current++;audio.current?.pause();window.speechSynthesis?.cancel();};
  useEffect(()=>()=>{stop();stream.current?.getTracks().forEach(t=>t.stop());},[]);
  async function speak(text:string,voice:'A'|'B'='A',url?:string){
    return new Promise<void>((resolve)=>{
      if(url){const a=new Audio(url);audio.current=a;a.onended=()=>resolve();a.onerror=()=>resolve();void a.play().catch(()=>resolve());return;}
      if(!('speechSynthesis'in window)){setError('Audio is unavailable in this browser. Follow the transcript below.');resolve();return;}
      const utter=new SpeechSynthesisUtterance(text),voices=window.speechSynthesis.getVoices().filter(v=>v.lang.startsWith('en'));
      utter.voice=voices[voice==='A'?0:Math.min(1,voices.length-1)]||null;utter.rate=voice==='A'?1:1.06;utter.pitch=voice==='A'?.9:1.1;utter.onend=()=>resolve();utter.onerror=()=>resolve();window.speechSynthesis.speak(utter);
    });
  }
  useEffect(()=>{if(!playing||!data)return;const run=++speechRun.current;const seg=data.segment;void(async()=>{if(seg.bell)await speak('','A',seg.bell);let i=Math.floor(((Date.now()-seg.started_at)/1000%seg.duration)/seg.duration*seg.lines.length);while(speechRun.current===run){const current=seg.lines[i%seg.lines.length]!;setLine(i%seg.lines.length);await speak(current.line,current.speaker,current.audio);if(speechRun.current!==run)break;await new Promise(r=>setTimeout(r,600));i++;}})();return stop;},[playing,data?.segment.id]);
  useEffect(()=>{if(!ticket||!['UNKNOWN','SUBMITTING'].includes(ticket.status))return;const t=setInterval(()=>{void api<Ticket>(`/api/tickets/${ticket.id}`).then(t=>{setTicket(t);void qc.invalidateQueries({queryKey:['portfolio']});}).catch(e=>setError(e.message));},2000);return()=>clearInterval(t);},[ticket?.id,ticket?.status]);
  function open(m:typeof modal){setError('');if(m!=='auth'&&!me.data){setModal('auth');return;}if(m==='call')setPlaying(false);setModal(m);}
  async function run(fn:()=>Promise<void>){setError('');setBusy(true);try{await fn();}catch(e){setError(e instanceof Error?e.message:'Please try again.');}finally{setBusy(false);}}
  async function draft(asset:Asset,kind='buy'){if(!me.data){open('auth');return;}await run(async()=>{setTicket(await api<Ticket>('/api/tickets',{method:'POST',body:{asset_id:asset.id,kind,amount:'1'}}));setModal('ticket');});}
  async function confirm(){if(!ticket)return;await run(async()=>{const t=await api<Ticket>(`/api/tickets/${ticket.id}/confirm`,{method:'POST',body:{confirm:true}});setTicket(t);await qc.invalidateQueries({queryKey:['portfolio']});await qc.invalidateQueries({queryKey:['station']});});}
  async function auth(e:FormEvent<HTMLFormElement>){e.preventDefault();const f=new FormData(e.currentTarget);await run(async()=>{const profile=await api('/api/'+(login?'login':'signup'),{method:'POST',body:{email:f.get('email'),password:f.get('password'),...(!login?{first_name:f.get('name')}: {})}});qc.setQueryData(['me'],profile);await qc.invalidateQueries({queryKey:['portfolio']});setModal(null);});}
  async function call(text=callText){await run(async()=>{let res:{reply:string;ticket?:Ticket};try{res=await api<{reply:string;ticket?:Ticket}>('/api/call',{method:'POST',body:{text,ticket_id:ticket?.id}});}catch(e){if(e instanceof Error&&/floor|limit|allowlist|budget/i.test(e.message)){res={reply:e.message};}else throw e;}setReply(res.reply);setTicket(res.ticket||null);setCallText('');stop();const r=await fetch('/api/call/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:res.reply})});if(r.ok&&r.status!==204){const url=URL.createObjectURL(await r.blob());await speak(res.reply,'A',url);URL.revokeObjectURL(url);}else await speak(res.reply);void qc.invalidateQueries({queryKey:['portfolio']});});}
  async function record(){if(recording){recorder.current?.stop();setRecording(false);return;}await run(async()=>{if(!navigator.mediaDevices?.getUserMedia)throw Error('Microphone needs localhost or HTTPS. You can type your order below.');stream.current=await navigator.mediaDevices.getUserMedia({audio:true});const r=new MediaRecorder(stream.current);recorder.current=r;const chunks:Blob[]=[];r.ondataavailable=e=>chunks.push(e.data);r.onstop=()=>{stream.current?.getTracks().forEach(t=>t.stop());setRecording(false);void run(async()=>{const response=await fetch('/api/call/transcribe',{method:'POST',headers:{'Content-Type':r.mimeType},body:new Blob(chunks,{type:r.mimeType})});const result=await response.json();if(!response.ok)throw Error(result.message);setCallText(result.text);setReply('Review the transcript below, then send it to the floor.');});};r.start();setRecording(true);setTimeout(()=>{if(r.state==='recording')r.stop();},15000);});}
  const seg=data?.segment,active=seg?.lines[line%seg.lines.length];
  const STATION=typeof window!=='undefined'&&new URLSearchParams(window.location.search).has('station');
  const sym=(a:{symbol:string})=>a.symbol==='CBBTC'?'BTC':a.symbol;
  const heard=(data?.assets||[]).filter(a=>a.price&&(seg?.assets||[]).includes(a.id));
  const tickets=(heard.length?heard:(data?.assets||[]).filter(a=>a.price)).slice(0,3);
  const badgeColors=['#ffd21f','#ffffff','#7fe0a6','#ffb3ad','#b9c6ff','#ffcf8a'];
  const badge=(name:string)=>{let h=0;for(const ch of name)h=(h*31+ch.charCodeAt(0))>>>0;return <span className="tb" style={{background:badgeColors[h%badgeColors.length]}}>{(name.replace(/[^a-z]/gi,'').toUpperCase().slice(0,3))||'???'}</span>;};
  const progress=seg&&playing?Math.min(100,((line%seg.lines.length)+1)/seg.lines.length*100):0;
  const isA=active?.speaker!=='B';
  return <div className={'station'+(STATION?' is-station':'')}>
    <header className="band">
      <div className="wrap">
        <div className="mast">
          <Link to="/" className="brand" aria-label="OUTCRY.FM home"><PalmMark size={40}/><span className="word">OUTCRY<span className="fm">.FM</span></span></Link>
          <div className="mast-right">
            <span className={'onair'+(playing?' lit':'')}>ON AIR</span>
            {!STATION&&<button className="wallet-chip" onClick={()=>me.data?window.location.assign('/wallet'):open('auth')}>{me.data?money(portfolio.data?.priced!==false?portfolio.data?.cash_usd:0):'Join the floor'}</button>}
          </div>
        </div>
        <div className="stationrow">
          <div>
            <div className="stage">
              <div className="who">{playing&&active?<>{<span className={'tb'+(isA?'':' b')}>{isA?'MAX':'JULES'}</span>}<span className="role">{isA?'the pulse':'the perspective'}</span></>:null}</div>
              <p className={'caption'+(playing&&active?'':' idle')}>{playing&&active?active.line:'The market, out loud. Press play to hear the floor.'}</p>
            </div>
            <div className="controls">
              <button className="play" aria-label={playing?'Pause the show':'Play the show'} onClick={()=>setPlaying(!playing)}>{playing?<Pause fill="currentColor"/>:<Play fill="currentColor"/>}</button>
              <div className="prog"><div className="track"><i style={{width:progress+'%'}}/></div>
                <div className="status"><span>{playing?(seg?.source==='Grok'?'Live, written by Grok':'Live now'):'Max and Jules, your AI hosts'}</span>{data?.simulated?<span className="sim">Simulated</span>:data?<span className="sim real">Real funds</span>:null}</div></div>
            </div>
          </div>
          {STATION&&<aside className="qr"><p>Scan to trade</p><QRCodeSVG value={window.location.origin+'/'} size={232} fgColor="#0f1640"/><small>{window.location.host}</small></aside>}
        </div>
      </div>
    </header>
    <main className="wrap floor">
      <p className="note">Hosts are AI. Not financial advice.{data?.simulated?' Simulated market: no real money moves.':''}</p>
      {error&&modal===null&&<div role="alert" className="floor-error">{error}</div>}
      {station.error&&<div role="alert" className="floor-error">The station isn't reachable. Check that the backend is running.</div>}
      <div className="cols"><div className="col-a">
      {!STATION&&<section className="actions">
        <div className="tickets">{tickets.map(a=><button key={a.id} className="ticket" disabled={busy} onClick={()=>void draft(a)}><span className="k">{heard.length?'Heard on air':'On the board'}</span><span className="v">Buy $1 {sym(a)}</span></button>)}</div>
        <button className="call" onClick={()=>open('call')}><PalmMark size={34} mono/><div><b>Call the floor</b><span>Say your order. Max reads it back.</span></div></button>
        <div className="pair">
          <button className="quiet" onClick={()=>me.data?window.location.assign('/trade'):open('auth')}>Buy or sell</button>
          <button className="quiet" disabled={busy||!data?.assets[0]} onClick={()=>data?.assets[0]&&void draft(data.assets[0],'tip')}>Tip the hosts $1</button>
        </div>
      </section>}
      <h2>Prices <small>live from True Markets</small></h2>
      <div className="tape">{(data?.assets||[]).map(a=>{const ch=a.change_24h==null?null:Number(a.change_24h)*100;return <div className="q" key={a.id}><div className="s">{sym(a)}</div><div className="p">{a.price?money(a.price):'Unavailable'}</div>{ch!=null&&<div className={'c '+(ch>=0?'up':'down')}>{ch>=0?'+':'−'}{Math.abs(ch).toFixed(2)}% today</div>}</div>;})}</div>
      </div><div className="col-b">
      <h2>The floor <small>everyone's confirmed trades and tips</small></h2>
      <div className="board">{!data?.board.length?<p className="empty">No trades yet. The first one gets a shout-out on air.</p>:data.board.map(t=><div className="slip" key={t.id}>{badge(t.name)}<div className="what"><b>{t.name}</b> {t.kind==='tip'?'tipped the hosts':t.kind==='buy'?'bought':t.kind==='sell'?'sold':'sent'} {money(t.amount_usd)} of {t.symbol==='CBBTC'?'BTC':t.symbol}<small>{t.order_id}</small></div><span className={'st '+(t.simulated?'sim-st':'filled')}>{t.simulated?'Simulated':'Verified'}</span></div>)}</div>
      <details className="transcript-box"><summary><h2>Transcript <small>this segment ▾</small></h2></summary><div className="transcript">{seg?.lines.map((l,i)=><p key={i} className={i===line&&playing?'current':''}><b>{l.speaker==='A'?'Max':'Jules'}</b> {l.line}</p>)}</div></details>
      </div></div>
      <p className="foot">Trades run on the True Markets Gateway. Voices by ElevenLabs. Scripts by Grok.<br/><button className="linkish" onClick={()=>open('wire')}>Open the Wire: every Gateway call</button> · <a href="/?station=1">Station screen</a></p>
    </main>
    {modal&&<div className="sheet" onClick={e=>{if(e.target===e.currentTarget&&!busy)setModal(null);}}><section className="panel" role="dialog" aria-modal="true" aria-label={modal==='auth'?'Join the floor':modal==='wire'?'The Wire':modal==='call'?'Call the floor':'Order ticket'}>
      <button className="close" aria-label="Close" onClick={()=>{stop();stream.current?.getTracks().forEach(t=>t.stop());setModal(null);}}><X/></button>
      {modal==='auth'?<><h3 className="sheet-title">{login?'Welcome back.':'Get your seat on the floor.'}</h3><p className="sheet-sub">{data?.simulated?'You get a demo wallet with $50 of simulated funds.':'You get real True Markets wallets on Solana and Base.'}</p><form className="form" onSubmit={e=>void auth(e)}>{!login&&<label>First name<input name="name" required pattern="[A-Za-z]{1,30}" maxLength={30} autoComplete="given-name"/></label>}<label>Email<input name="email" type="email" required autoComplete="email"/></label><label>Password<input name="password" type="password" minLength={8} required autoComplete={login?'current-password':'new-password'}/></label><button className="cta" disabled={busy}>{busy?'Opening your wallet…':login?'Sign in':'Get my wallet'}</button></form><button className="linkish" onClick={()=>setLogin(!login)}>{login?'New here? Create an account':'Already have an account? Sign in'}</button></>:null}
      {modal==='ticket'&&ticket?<div className={'oticket'+(ticket.kind==='sell'?' sell':'')}>
        <div className="head"><span className={'kind '+ticket.kind}>{ticket.kind==='tip'?'Tip for the hosts':ticket.kind==='sell'?'Sell ticket':'Buy ticket'}</span>{ticket.status==='AWAITING_CONFIRMATION'&&<span className="exp">Good for {Math.max(0,Math.ceil((ticket.expires-now)/1000))}s</span>}</div>
        {ticket.status==='FILLED'&&<span className="stamp pop">FILLED</span>}
        <div className="grid"><div><span>Amount</span><b>{money(ticket.amount_usd)}</b></div><div><span>Asset</span><b>{ticket.symbol==='CBBTC'?'BTC':ticket.symbol}</b></div><div><span>Quoted fee</span><b>{ticket.fee} {ticket.fee_asset}</b></div><div><span>Ticket</span><b>{ticket.id.slice(0,8)}</b></div></div>
        {ticket.simulated&&<p className="small"><span className="sim">Simulated</span> No real money moves in this mode.</p>}
        {ticket.status==='AWAITING_CONFIRMATION'?<div className="acts"><button className="confirm" disabled={busy||now>=ticket.expires} onClick={()=>void confirm()}>{busy?'Sending…':now>=ticket.expires?'Ticket expired. Start again.':ticket.kind==='tip'?'Send tip':'Confirm'}</button><button className="cancel" disabled={busy} onClick={()=>void run(async()=>{await api(`/api/tickets/${ticket.id}/cancel`,{method:'POST'});setModal(null);})}>Scratch that</button></div>
        :<><p className="say">{ticket.status==='FILLED'?'Confirmed and on the floor. The hosts will give you a shout-out.':ticket.status==='UNKNOWN'||ticket.status==='SUBMITTING'?'Checking the original order with the exchange. It will not be sent again.':'This ticket is closed. Start a new one to trade.'}</p><div className="acts"><button className="cancel" onClick={()=>setModal(null)}>Back to the show</button></div></>}
      </div>:null}
      {modal==='call'?<><div className="callhead"><span className="t">On the floor with Max</span><span className="onair lit">ON AIR</span></div>{data?.providers.agent&&<LiveCall/>}
        <div className="convo"><div className="m host">{reply}</div>{callText&&<div className="m me">{callText}</div>}</div>
        <button className={'talk'+(recording?' rec':'')} disabled={busy} onClick={()=>void record()}><Mic/>{recording?'Listening. Tap to stop':'Tap to talk'}<small>{recording?'Then send it to the floor':'Say: buy one dollar of Solana'}</small></button>
        <form className="typer" onSubmit={e=>{e.preventDefault();void call();}}><input value={callText} onChange={e=>setCallText(e.target.value)} placeholder="Or type: buy 1 SOL" aria-label="Your order" required maxLength={300}/><button disabled={busy||!callText}>{busy?'…':'Send'}</button></form>
        {ticket?.status==='AWAITING_CONFIRMATION'&&<div className="acts"><button className="confirm" disabled={busy||now>=ticket.expires} onClick={()=>void call('confirm')}>Confirm this ticket</button><button className="cancel" disabled={busy} onClick={()=>void call('scratch that')}>Scratch that</button></div>}
        <p className="how">Say an order, listen to the read-back, then say <b>confirm</b>. Nothing trades until you do.</p></>:null}
      {modal==='wire'?<><h3 className="sheet-title">The Wire</h3><p className="sheet-sub">Every call to the True Markets Gateway, with its ID.{data?.simulated?' All calls here are simulated.':''}</p><div className="log">{wire.isPending?<p className="empty">Loading calls…</p>:wire.error?<p role="alert">{wire.error.message}</p>:wire.data?.length?wire.data.map((w,i)=><div className="lrow" key={i}><time>{new Date(w.time).toLocaleTimeString([],{hour12:false})}</time><div><span className="op">{w.operation}</span> <span className="ref">{w.id||''}</span>{w.simulated&&<span className="sim">Simulated</span>}</div><span className={w.status==='ok'||w.status==='success'?'up':''}>{w.status}</span></div>):<p className="empty">No calls yet. Write a ticket to see the flow.</p>}</div></>:null}
      {error&&<p role="alert" className="floor-error">{error}</p>}
    </section></div>}
  </div>;
}
