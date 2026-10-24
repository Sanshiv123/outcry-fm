import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../app.ts';
import { env } from '../env.ts';
import { ApiError } from '../http.ts';
import { stampAll } from '../tm/stamp.ts';
import type { Customer } from '../customers.ts';
import { gatewayUserId } from '../session.ts';
import type { QuoteDetails, UnsignedPayload } from '../tm/types.ts';
import { Store,logCall } from './store.ts';
export type Ticket = { id: string; customer: string; name: string; user: string; kind: 'buy'|'sell'|'tip'|'send'; asset_id: string; symbol: string; amount_usd: number; qty: string; fee: string; fee_asset: string; quote?: QuoteDetails; to?: string; status: string; upstream?: string; created: number; expires: number; payloads?: UnsignedPayload[]; simulated: boolean };
export const ledger = new Store<Ticket[]>('tickets', []);
// Serialized across awaits: reservation, balance read and execution cannot race in one server.
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> { const p=queue.then(fn,fn); queue=p.catch(()=>{}); return p; }
function deny(message: string): never { throw new ApiError(422,'policy_blocked',message); }
const pending = (t: Ticket) => ['DRAFTED','AWAITING_CONFIRMATION','SUBMITTING','UNKNOWN'].includes(t.status);
export function expire() { for(const t of ledger.value) if(['DRAFTED','AWAITING_CONFIRMATION'].includes(t.status)&&Date.now()>t.expires) { t.status='EXPIRED'; delete t.payloads; } ledger.save(); }
export function checkCaps(amount: number, customer: string, tickets=ledger.value) {
  if(!Number.isFinite(amount)||amount<=0) deny('Enter a positive amount.');
  if(amount > env.MAX_ORDER_USD + 1e-8) deny(`The floor will not allow orders over ${env.MAX_ORDER_USD} dollars.`);
  const day=new Date().toISOString().slice(0,10);
  const reserved=tickets.filter(t=>pending(t)||(t.status==='FILLED'&&new Date(t.created).toISOString().slice(0,10)===day));
  if(reserved.filter(t=>t.customer===customer).reduce((n,t)=>n+t.amount_usd,0)+amount>env.MAX_DAILY_USD+1e-8) deny(`Your daily limit is ${env.MAX_DAILY_USD} dollars, including pending tickets.`);
  // Station budget is lifetime spend, including fees for non-buy flows.
  if(tickets.filter(t=>pending(t)||t.status==='FILLED').reduce((n,t)=>n+t.amount_usd,0)+amount>env.MAX_STATION_USD+1e-8) deny('The station demo budget has been reached.');
}
export function publicTicket(t: Ticket) { const {payloads,customer,user,...safe}=t; return safe; }
export function owned(id:string,customer:string) { const t=ledger.value.find(t=>(t.id===id||t.upstream===id)&&t.customer===customer); if(!t) throw new ApiError(404,'not_found','Ticket not found'); return t; }
export function makeFloor(deps:AppDeps) {
  const {gateway,assets,prices}=deps;
  function price(id:string) { const a=assets.byId(id); if(!a) deny('That asset is not on the verified allowlist.'); const p=prices.get(a.symbol); if(!p.price||!p.as_of||!Number.isFinite(Date.parse(p.as_of))||Date.now()-Date.parse(p.as_of)>10*60_000||!Number.isFinite(Number(p.price))||Number(p.price)<=0) deny('Fresh price data is unavailable. Please try again.'); return {asset:a,price:Number(p.price)}; }
  async function balance(t:Ticket) {
    const {asset:a}=price(t.asset_id); const data=(await gateway.balances(t.user)).data;
    const paying=t.kind==='buy'?assets.all().find(x=>assets.isCash(x)&&x.chain===a.chain):a;
    const b=data.find(b=>b.asset_id===paying?.id||(b.symbol===paying?.symbol&&b.chain===paying?.chain));
    const available=Number(b?.available);
    const reserved=ledger.value.filter(x=>x.id!==t.id&&x.customer===t.customer&&pending(x)&&((t.kind==='buy'&&x.kind==='buy'&&assets.byId(x.asset_id)?.chain===a.chain)||(t.kind!=='buy'&&x.kind!=='buy'&&x.asset_id===a.id))).reduce((n,x)=>n+Number(x.qty),0);
    const required=Number(t.qty)+(t.kind==='tip'||t.kind==='send'?Number(t.fee):0);
    if(!b||!Number.isFinite(available)||available-reserved+1e-10<required) {
      const alternative=t.kind==='buy'&&paying?data.find(x=>x.stable&&Number(x.available)>0&&(x.symbol!==paying.symbol||x.chain!==paying.chain)):undefined;
      if(alternative&&paying) deny(`Your wallet has ${alternative.available} ${alternative.symbol} on ${alternative.chain}, but this Gateway buy requires ${paying.symbol} on ${paying.chain}. Fund the required asset to continue.`);
      deny('Available balance is missing or insufficient, including pending tickets.');
    }
  }
  async function draft(customer:Customer, request:{asset_id:string;kind:Ticket['kind'];amount:string;units?:'base'|'usd';to?:string}) {
    return exclusive(async()=>{
      expire(); const {asset:a,price:p}=price(request.asset_id); const n=Number(request.amount);
      const amount=request.units==='base'?n*p:n;
      // Replacing an unconfirmed draft invalidates its old confirmation.
      for(const t of ledger.value) if(t.customer===customer.id&&t.status==='AWAITING_CONFIRMATION') { t.status='CANCELED'; delete t.payloads; }
      ledger.save(); checkCaps(amount,customer.id);
      if((request.kind==='buy'||request.kind==='sell')&&(!a.tradeable||assets.isCash(a))) deny('This asset is not tradable.');
      const t:Ticket={id:randomUUID(),customer:customer.id,name:customer.first_name || 'Listener',user:gatewayUserId(customer),kind:request.kind,asset_id:a.id,symbol:a.symbol,amount_usd:amount,qty:request.units==='base'?request.amount:request.kind==='buy'?request.amount:(amount/p).toFixed(Math.min(a.decimals,8)),fee:'0',fee_asset:'',to:request.to,status:'DRAFTED',created:Date.now(),expires:Date.now()+30000,simulated:env.MOCK_MODE};
      if(!Number.isFinite(Number(t.qty))||Number(t.qty)<=0)deny('Amount is below this asset’s precision.');
      await balance(t); ledger.value.push(t); ledger.save();
      try {
        if(t.kind==='buy'||t.kind==='sell') {
          const r=await gateway.createOrder(t.user,{asset_id:a.id,chain:a.chain!,side:t.kind,qty:t.qty,qty_unit:t.kind==='buy'?'quote':'base'});
          t.upstream=r.order_id;
          if(!r.quote||r.quote.issues?.length||!r.payloads?.length) deny('The Gateway could not provide a valid quote.');
          if(!Number.isFinite(Number(r.quote.fee))||Number(r.quote.fee)<0) deny('The Gateway fee is unavailable.');
          t.quote={...r.quote,base_asset:assets.symbolOf(r.quote.base_asset),quote_asset:assets.symbolOf(r.quote.quote_asset),fee_asset:assets.symbolOf(r.quote.fee_asset)}; t.fee=t.quote.fee;t.fee_asset=t.quote.fee_asset;t.payloads=r.payloads;
          if(t.kind==='sell') { const total=Number(r.quote.qty_out)+Number(r.quote.fee); checkCaps(Math.max(amount,total),customer.id,ledger.value.filter(x=>x.id!==t.id));t.amount_usd=Math.max(amount,total); }
        } else {
          if(!t.to) deny('Station wallet is not configured.');
          const r=await gateway.createTransfer(t.user,{asset_id:a.id,qty:t.qty,to:t.to});t.upstream=r.id;
          if(!r.payloads?.length||!Number.isFinite(Number(r.fee))||Number(r.fee)<0)deny('The Gateway could not provide a valid transfer quote.');
          t.fee=r.fee;t.fee_asset=a.symbol;t.payloads=r.payloads;
          const total=amount+Number(r.fee)*p;checkCaps(total,customer.id,ledger.value.filter(x=>x.id!==t.id));t.amount_usd=total;await balance(t);
        }
        t.status='AWAITING_CONFIRMATION'; ledger.save();return t;
      }catch(e){t.status='FAILED';delete t.payloads;ledger.save();throw e;}
    });
  }
  async function reconcile(t:Ticket) {
    if(!t.upstream) return t;
    const prior=t.status;
    try { const result=t.kind==='buy'||t.kind==='sell'?await gateway.getOrder(t.user,t.upstream):await gateway.getTransfer(t.user,t.upstream);
      t.status=['complete','completed'].includes(result.status)?'FILLED':['failed','canceled'].includes(result.status)?'FAILED':'UNKNOWN';
    } catch {t.status='UNKNOWN';} if(prior!==t.status)logCall('ticket status',t.status,t.upstream); ledger.save();return t;
  }
  async function confirm(customer:Customer,id:string) {return exclusive(async()=>{
    const t=owned(id,customer.id);
    if(['SUBMITTING','UNKNOWN'].includes(t.status))return reconcile(t);
    if(t.status==='FILLED')return t;
    expire();if(t.status!=='AWAITING_CONFIRMATION')deny('This ticket is expired or canceled. Review a new ticket.');
    await balance(t); if(Date.now()>t.expires) {t.status='EXPIRED';ledger.save();deny('This ticket expired. Review a new ticket.');}
    const signatures=env.MOCK_MODE?['SIMULATED']:stampAll(t.payloads!);
    t.status='SUBMITTING';delete t.payloads;ledger.save();logCall('ticket status','SUBMITTING',t.upstream);
    try {if(t.kind==='buy'||t.kind==='sell')await gateway.executeOrder(t.user,t.upstream!,signatures);else await gateway.executeTransfer(t.user,t.upstream!,signatures);}catch{t.status='UNKNOWN';ledger.save();}
    return reconcile(t);
  });}
  return {draft,confirm,reconcile};
}
