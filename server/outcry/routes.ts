import { Hono } from 'hono';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { AppDeps } from '../app.ts';
import { env } from '../env.ts';
import { ApiError,parseJson,positiveDecimal } from '../http.ts';
import { optionalCustomer,requireCustomer,type AppEnv } from '../session.ts';
import { isAddressOn } from '../../shared/validation.ts';
import { exclusive,expire,ledger,makeFloor,owned,publicTicket,usage } from './policy.ts';
import { wire } from './store.ts';
import { getMarketStatus } from '../prices.ts';
import { segment,speech,transcribe,interpretOrder } from './show.ts';
import { bulletins,describe,makeStanding,parseStanding,publicRule,rules } from './standing.ts';
import { makeCrowd,parseCall,voteReply } from './crowd.ts';
const body=z.object({asset_id:z.string(),kind:z.enum(['buy','sell','tip']),amount:positiveDecimal});
export function floorRoutes(deps:AppDeps){
  const floor=makeFloor(deps);const app=new Hono<AppEnv>();
  const standing=makeStanding(deps);standing.start();
  const crowd=makeCrowd(deps);crowd.start();
  app.get('/station',c=>c.json({simulated:env.MOCK_MODE,market_data:getMarketStatus(),segment,limits:{order:env.MAX_ORDER_USD,daily:env.MAX_DAILY_USD,station:env.MAX_STATION_USD},assets:deps.assets.tradeable().map(a=>({id:a.id,symbol:a.symbol,name:a.name,...deps.prices.get(a.symbol)})),board:ledger.value.filter(t=>t.status==='FILLED').slice(-30).reverse().map(t=>({id:t.id,name:t.name,kind:t.kind,symbol:t.symbol,amount_usd:t.amount_usd,created:t.created,order_id:t.upstream,simulated:t.simulated})),bulletins:bulletins.value.filter(b=>Date.now()-b.time<10*60_000).slice(0,10),standing_orders:env.STANDING_ORDERS,providers:{grok:process.env.ENABLE_GROK!=='false'&&!!process.env.XAI_API_KEY,elevenlabs:!!process.env.ELEVENLABS_API_KEY,agent:!!process.env.ELEVENLABS_API_KEY&&!!process.env.ELEVENLABS_AGENT_ID}}));
  app.get('/wire',requireCustomer,c=>c.json(wire.value));
  app.get('/crowd',async c=>c.json(crowd.view((await optionalCustomer(c))?.id)));
  app.post('/crowd/vote',requireCustomer,async c=>{const {side}=await parseJson(c,z.object({side:z.enum(['bull','bear'])}));crowd.vote(c.var.customer,side);return c.json(crowd.view(c.var.customer.id));});
  app.get('/standing',requireCustomer,c=>c.json(rules.value.filter(r=>r.customer===c.var.customer.id).slice(-20).reverse().map(publicRule)));
  app.post('/standing/:id/arm',requireCustomer,c=>c.json(publicRule(standing.arm(c.var.customer,c.req.param('id')))));
  app.post('/standing/:id/cancel',requireCustomer,c=>c.json(standing.cancel(c.var.customer,c.req.param('id')).map(publicRule)));
  app.get('/audio/:file',c=>{const file=c.req.param('file');if(!/^\d+-\d+\.mp3$/.test(file))throw new ApiError(404,'not_found','Audio not found');try{return c.body(new Uint8Array(readFileSync(`data/audio/${file}`)),200,{'Content-Type':'audio/mpeg','Cache-Control':'public, max-age=3600'});}catch{throw new ApiError(404,'not_found','Audio unavailable');}});
  app.get('/tickets',requireCustomer,c=>{expire();return c.json(ledger.value.filter(t=>t.customer===c.var.customer.id).slice(-20).reverse().map(publicTicket));});
  app.post('/tickets',requireCustomer,async c=>{const r=await parseJson(c,body);const a=deps.assets.byId(r.asset_id);const to=r.kind==='tip'?(env.MOCK_MODE?'SIMULATED-STATION':process.env[a?.chain==='solana'?'STATION_WALLET_SOLANA':'STATION_WALLET_EVM']):undefined;return c.json(publicTicket(await floor.draft(c.var.customer,{...r,to})));});
  app.post('/tickets/:id/confirm',requireCustomer,async c=>{await parseJson(c,z.object({confirm:z.literal(true)}).strict());return c.json(publicTicket(await floor.confirm(c.var.customer,c.req.param('id'))));});
  app.post('/tickets/:id/cancel',requireCustomer,async c=>exclusive(async()=>{const t=owned(c.req.param('id'),c.var.customer.id);if(t.status!=='AWAITING_CONFIRMATION')throw new ApiError(409,'conflict','Only an unconfirmed ticket can be canceled');t.status='CANCELED';delete t.payloads;ledger.save();return c.json(publicTicket(t));}));
  app.get('/tickets/:id',requireCustomer,async c=>exclusive(async()=>{const t=owned(c.req.param('id'),c.var.customer.id);if(['UNKNOWN','SUBMITTING'].includes(t.status))await floor.reconcile(t);return c.json(publicTicket(t));}));
  // The original Tensho screens use the same policy coordinator; no alternate execution path.
  app.post('/orders',requireCustomer,async c=>{const r=await parseJson(c,z.object({asset_id:z.string(),side:z.enum(['buy','sell']),amount:positiveDecimal}));const t=await floor.draft(c.var.customer,{asset_id:r.asset_id,kind:r.side,amount:r.amount,units:r.side==='sell'?'base':'usd'});return c.json({order_id:t.upstream,status:'awaiting_signature',quote:t.quote,prepared_at:new Date(t.created).toISOString()});});
  app.post('/orders/:id/execute',requireCustomer,async c=>{const t=await floor.confirm(c.var.customer,c.req.param('id'));return c.json({order_id:t.upstream,status:t.status==='FILLED'?'complete':'pending'});});
  app.get('/orders/:id',requireCustomer,async c=>{const t=owned(c.req.param('id'),c.var.customer.id);if(['UNKNOWN','SUBMITTING'].includes(t.status))await exclusive(()=>floor.reconcile(t));const r=await deps.gateway.getOrder(t.user,t.upstream!);return c.json(r);});
  app.post('/transfers',requireCustomer,async c=>{const r=await parseJson(c,z.object({asset_id:z.string(),qty:positiveDecimal,to:z.string()}));const a=deps.assets.byId(r.asset_id);if(!a||!isAddressOn(a.chain,r.to))throw new ApiError(400,'invalid_argument','Invalid destination address');const t=await floor.draft(c.var.customer,{asset_id:r.asset_id,kind:'send',amount:r.qty,units:'base',to:r.to});return c.json({transfer_id:t.upstream,status:'awaiting_signature',fee:t.fee,qty:t.qty,prepared_at:new Date(t.created).toISOString()});});
  app.post('/transfers/:id/execute',requireCustomer,async c=>{const t=await floor.confirm(c.var.customer,c.req.param('id'));return c.json({transfer_id:t.upstream,status:t.status==='FILLED'?'completed':'pending'});});
  app.get('/transfers/:id',requireCustomer,async c=>{const t=owned(c.req.param('id'),c.var.customer.id);if(['UNKNOWN','SUBMITTING'].includes(t.status))await exclusive(()=>floor.reconcile(t));return c.json(await deps.gateway.getTransfer(t.user,t.upstream!));});
  app.post('/call/session',requireCustomer,async c=>{
    const key=process.env.ELEVENLABS_API_KEY,id=process.env.ELEVENLABS_AGENT_ID;
    if(!key||!id)throw new ApiError(503,'unavailable','Live agent is not configured. Use push-to-talk.');
    const r=await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(id)}`,{headers:{'xi-api-key':key},signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new ApiError(503,'unavailable','Live agent is unavailable. Use push-to-talk.');
    const response=await r.json() as {signed_url:string};return c.json({signed_url:response.signed_url,first_name:c.var.customer.first_name||'Listener',execution_mode:env.MOCK_MODE?'SIMULATED':'REAL FUNDS',asset_catalog:JSON.stringify(deps.assets.tradeable().map(a=>({id:a.id,symbol:a.symbol,name:a.name})))});
  });
  app.post('/call',requireCustomer,async c=>{
    const {text,ticket_id}=await parseJson(c,z.object({text:z.string().min(1).max(300),ticket_id:z.string().optional()}));
    const normalized=text.toLowerCase().trim().replace(/[.!?]$/,'').replace(/\b(five hundred|one|two|three|four|five)\b/g,w=>({'one':'1','two':'2','three':'3','four':'4','five':'5','five hundred':'500'}[w]||w));
    if(normalized==='confirm'){
      if(!ticket_id)throw new ApiError(400,'invalid_argument','There is no reviewed ticket to confirm.');
      const t=await floor.confirm(c.var.customer,ticket_id);return c.json({reply:t.status==='FILLED'?`Confirmed. Your ${t.simulated?'simulated ':''}${t.kind} is complete.`:'Your ticket is being checked. Please do not place it again.',ticket:publicTicket(t)});
    }
    // Standing orders and price alerts: parsed by a fixed grammar, armed only by an explicit "arm it".
    const pendingRule=rules.value.filter(r=>r.customer===c.var.customer.id&&r.status==='PENDING_AUTHORIZATION').at(-1);
    if(['arm','arm it','arm the order','authorize','authorize it'].includes(normalized)||(normalized==='confirm'&&!ticket_id&&pendingRule)){
      const r=standing.arm(c.var.customer);return c.json({reply:`Armed. ${describe(r)} I will call every fill on air. Say cancel my standing orders to stop it.`,rule:publicRule(r)});
    }
    if(['cancel','scratch that'].includes(normalized)&&!ticket_id&&pendingRule){standing.cancel(c.var.customer,pendingRule.id);return c.json({reply:'Scratched. That standing order was never armed.'});}
    if(/^(?:cancel|stop|kill|clear)(?: all)?(?: of)?(?: my)? (?:standing orders?|auto ?orders?|rules|alerts|price alerts)$/.test(normalized)){
      const hit=standing.cancel(c.var.customer);return c.json({reply:hit.length?`Done. ${hit.length} standing ${hit.length===1?'order is':'orders are'} canceled. Nothing further will fill.`:'You have no standing orders or alerts running.'});
    }
    if(/^(?:what are |list |read )?(?:my )?(?:standing orders|rules|alerts|price alerts)$/.test(normalized)){
      const mine=rules.value.filter(r=>r.customer===c.var.customer.id&&r.status==='ACTIVE');
      return c.json({reply:mine.length?mine.map((r,i)=>`${i+1}. ${describe(r)}${r.kind!=='alert'?` ${r.fills} of ${r.max_fills} filled.`:''}`).join(' '):'No standing orders or alerts are running.'});
    }
    if(/^(?:what (?:are|is) )?(?:my )?(?:limits?|caps?|spending limits?|budget)$|^how much (?:can i|do i have left to) (?:spend|trade)/.test(normalized)){
      const u=usage(c.var.customer.id),left=Math.max(0,env.MAX_DAILY_USD-u.today);
      return c.json({reply:`Your limits: up to ${env.MAX_ORDER_USD} dollars per order and ${env.MAX_DAILY_USD} dollars a day, counting pending tickets. You have used ${u.today.toFixed(2)} today, so ${left.toFixed(2)} dollars left. The station budget is ${env.MAX_STATION_USD} dollars, with ${Math.max(0,env.MAX_STATION_USD-u.station).toFixed(2)} remaining. These are enforced in code, not by me.`});
    }
    const crowdCall=parseCall(normalized);
    if(crowdCall){const r=crowd.vote(c.var.customer,crowdCall.side,crowdCall.symbol);return c.json({reply:voteReply(r,crowdCall.side)});}
    const standingIntent=parseStanding(normalized,deps.assets.tradeable());
    if(standingIntent){const {rule,reply}=standing.propose(c.var.customer,standingIntent);return c.json({reply,rule:publicRule(rule)});}
    if(['cancel','scratch that'].includes(normalized)&&ticket_id){return exclusive(async()=>{const t=owned(ticket_id,c.var.customer.id);if(t.status==='AWAITING_CONFIRMATION'){t.status='CANCELED';delete t.payloads;ledger.save();}return c.json({reply:'Your ticket status is '+t.status.toLowerCase()+'.'});});}
    const match=normalized.match(/^(buy|sell|tip)\s+\$?(\d+(?:\.\d{1,2})?)\s*(?:dollars?\s*)?(?:of\s+)?([a-z]+)$/);
    if(!match){
      const intent=await interpretOrder(text,deps.assets.tradeable()).catch(()=>null);
      if(intent){
        const a=deps.assets.byId(intent.asset_id)!;
        const to=intent.kind==='tip'?(env.MOCK_MODE?'SIMULATED-STATION':process.env[a.chain==='solana'?'STATION_WALLET_SOLANA':'STATION_WALLET_EVM']):undefined;
        const t=await floor.draft(c.var.customer,{...intent,to});
        return c.json({reply:`${t.simulated?'Simulated ticket. ':''}${t.kind} ${t.amount_usd} dollars of ${t.symbol}. Fee ${t.fee} ${t.fee_asset}. Ticket ${t.id.slice(0,6)}. Review and say confirm within thirty seconds.`,ticket:publicTicket(t)});
      }
      return c.json({reply:`Hello ${c.var.customer.first_name||'Listener'}. Please specify an action, dollar amount and asset. For example, buy one dollar of Solana, or type buy 1 SOL. I will read the exact ticket back before you confirm.`});
    }
    const symbol=match[3]!.toUpperCase();const kind=match[1] as 'buy'|'sell'|'tip';
    // Tips may name a tip-only cash asset (e.g. a stablecoin the station actually holds); buy/sell stay restricted to the tradeable allowlist.
    const pool=kind==='tip'?deps.assets.all():deps.assets.tradeable();
    const a=pool.find(a=>a.symbol===symbol||a.name.toUpperCase()===symbol||(symbol==='BTC'&&a.symbol==='CBBTC'));
    if(!a)throw new ApiError(422,'policy_blocked','That asset is not on the verified allowlist.');
    const to=kind==='tip'?(env.MOCK_MODE?'SIMULATED-STATION':process.env[a.chain==='solana'?'STATION_WALLET_SOLANA':'STATION_WALLET_EVM']):undefined;
    const t=await floor.draft(c.var.customer,{asset_id:a.id,kind,amount:match[2]!,to});
    return c.json({reply:`${t.simulated?'Simulated ticket. ':''}${kind} ${Number(match[2]).toFixed(2)} dollars of ${a.symbol}. Quoted fee ${t.fee} ${t.fee_asset}. Ticket ${t.id.slice(0,6)}. Say confirm within thirty seconds, or scratch that.`,ticket:publicTicket(t)});
  });
  app.post('/call/transcribe',requireCustomer,async c=>{const bytes=new Uint8Array(await c.req.arrayBuffer());if(bytes.length>5_000_000)throw new ApiError(413,'invalid_argument','Keep recordings below 5 MB');try{return c.json({text:await transcribe(bytes,c.req.header('Content-Type')||'audio/webm')});}catch(e){throw new ApiError(503,'unavailable',e instanceof Error?e.message:'Transcription unavailable');}});
  app.post('/call/speak',requireCustomer,async c=>{const {text}=await parseJson(c,z.object({text:z.string().max(600)}));try{const audio=await speech(text);if(!audio)return c.body(null,204);return c.body(new Uint8Array(audio).buffer,200,{'Content-Type':'audio/mpeg'});}catch{throw new ApiError(503,'unavailable','Voice unavailable; read the reply on screen.');}});
  return app;
}
