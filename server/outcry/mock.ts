import { randomUUID } from 'node:crypto';
import type * as gateway from '../tm/gateway.ts';
import type { AssetItem, OrderDetail, TransferDetail, CreateOrderResponse } from '../tm/types.ts';
import { Store, logCall } from './store.ts';
import { prices } from '../prices.ts';
const catalog: AssetItem[] = [
  ['SOL', 'Solana', 'solana'], ['CBBTC', 'Bitcoin', 'base'], ['USDC', 'USD Coin', 'solana'], ['USDC', 'USD Coin', 'base']
].map(([symbol, name, chain]) => ({ id: `sim-${symbol}-${chain}`, symbol: symbol!, name: name!, chain: chain!, address: `sim-${symbol}-${chain}`, decimals: 8, icon: null, stable: symbol === 'USDC', tradeable: true, venue: 'defi' }));
export const mockPrice = (s: string) => {
  const quote = prices.get(s);
  const live = Number(quote.price);
  if (quote.source === 'truemarkets_stream' && Number.isFinite(live) && live > 0) return live;
  return s === 'SOL' ? 182.46 : s === 'CBBTC' ? 67432.80 : 1;
};
const state = new Store<{ balances: Record<string, Record<string, number>>; orders: Record<string, { user: string; detail: OrderDetail; prepared: CreateOrderResponse }>; transfers: Record<string, { user: string; detail: TransferDetail }> }>('gateway', { balances: {}, orders: {}, transfers: {} });
function holdings(user: string) {
  state.value.balances[user] ??= Object.fromEntries(catalog.map(a => [a.id, a.stable ? 25 : 0]));
  return state.value.balances[user]!;
}
function asset(id: string) { const a = catalog.find(a => a.id === id); if (!a) throw Error('Unknown simulated asset'); return a; }
export const mockGateway: typeof gateway = {
  async createOrganizationUser(ref) {
    const user_id = `sim-${ref}`; holdings(user_id); state.save(); logCall('createOrganizationUser', 'SIMULATED');
    return { user_id, external_ref_id: ref, created_at: new Date().toISOString(), wallets: [{ chain_family: 'solana', address: 'SIMULATED — do not deposit' }, { chain_family: 'evm', address: 'SIMULATED — do not deposit' }] };
  },
  async listAssets() { return { data: catalog, pagination: { next_cursor: null, limit: 100 } }; },
  async priceHistory(symbol) {
    const price = mockPrice(symbol); return { symbol, window: '24h', resolution: '5m', points: Array.from({ length: 49 }, (_, i) => ({ t: new Date(Date.now() - (48 - i) * 300000).toISOString(), price: (price * (0.974 + i / 48 * .026 + Math.sin(i * 1.9) * .002)).toFixed(4) })) };
  },
  async balances(user) {
    logCall('balances', 'SIMULATED');
    return { data: catalog.map(a => ({ ...a, asset_id: a.id, total: String(holdings(user)[a.id] ?? 0), available: String(holdings(user)[a.id] ?? 0), held: '0' })) };
  },
  async portfolio(user) {
    const { data } = await this.balances(user);
    const balances = data.map(a => ({ ...a, icon: null, price: String(mockPrice(a.symbol)), value: String(Number(a.total) * mockPrice(a.symbol)), change_24h_pct: '2.6' }));
    const total = balances.reduce((n,a) => n + Number(a.value),0);
    return { total_usd: String(total), balances_usd: String(total), cash_usd: String(balances.filter(a => a.stable).reduce((n,a) => n + Number(a.value),0)), change_24h_usd: '0', change_24h_pct: '0', unrealized_pnl_usd: '0', realized_pnl_usd: '0', balances, positions: [] };
  },
  async createOrder(user, req) {
    const a = asset(req.asset_id), cash = catalog.find(b => b.stable && b.chain === a.chain)!;
    const id = `sim-order-${randomUUID()}`, qty = Number(req.qty), price = mockPrice(a.symbol);
    const usd = req.qty_unit === 'quote' ? qty : qty * price;
    const fee = usd * .002;
    const prepared = { order_id: id, status: 'awaiting_signature', payloads: [{ digest: 'simulated', payload: 'simulated' }], quote: { base_asset: a.id, quote_asset: cash.id, qty: req.qty, qty_out: String(req.side === 'buy' ? (usd - fee) / price : usd - fee), fee: String(fee), fee_asset: cash.id } };
    state.value.orders[id] = { user, prepared, detail: { order_id: id, base_asset: a.id, quote_asset: cash.id, asset_id: a.id, asset_symbol: a.symbol, type: 'market', side: req.side, price: String(price), qty: req.qty, qty_unit: req.qty_unit, executed_qty: '0', leaves_qty: req.qty, executed_vwap: String(price), fee: String(fee), venue: 'defi', status: 'awaiting_signature', created_at: new Date().toISOString() } }; state.save(); logCall('createOrder', 'SIMULATED', id); return prepared;
  },
  async executeOrder(user, id) {
    const entry = state.value.orders[id]; if (!entry || entry.user !== user) throw Error('Order not found');
    const d = entry.detail;
    if(d.status === 'complete') return { status: d.status };
    const h = holdings(user), q = entry.prepared.quote!;
    const debit = d.side === 'buy' ? d.quote_asset : d.base_asset;
    const credit = d.side === 'buy' ? d.base_asset : d.quote_asset;
    if ((h[debit] ?? 0) < Number(d.qty)) throw Error('Insufficient simulated balance');
    h[debit] = (h[debit] ?? 0) - Number(d.qty); h[credit] = (h[credit] ?? 0) + Number(q.qty_out);
    d.status = 'complete'; d.executed_qty = d.side === 'buy' ? q.qty_out : d.qty; d.leaves_qty = '0'; state.save(); logCall('executeOrder', 'SIMULATED', id); return { status: d.status };
  },
  async getOrder(user,id) { const o = state.value.orders[id]; if(!o || o.user !== user) throw Error('Order not found'); logCall('getOrder','SIMULATED',id); return o.detail; },
  async createTransfer(user, req) {
    const a=asset(req.asset_id), id=`sim-transfer-${randomUUID()}`;
    const detail: TransferDetail = { id, status:'awaiting_signature', venue:'defi', asset_id:a.id, asset_symbol:a.symbol, chain:a.chain, network:a.chain, to:req.to, qty:req.qty, qty_unit:'base', sent:'0', fee:'0', received:'0', tx_hash:'', explorer_url:null, payloads:[{digest:'simulated',payload:'simulated'}], created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
    state.value.transfers[id]={user,detail}; state.save(); logCall('createTransfer','SIMULATED',id); return detail;
  },
  async executeTransfer(user,id) {
    const e=state.value.transfers[id]; if(!e || e.user!==user) throw Error('Transfer not found'); const d=e.detail;
    if(d.status==='completed') return d;
    const h=holdings(user); if((h[d.asset_id]??0)<Number(d.qty)) throw Error('Insufficient simulated balance');
    h[d.asset_id]=(h[d.asset_id]??0)-Number(d.qty); d.status='completed'; d.sent=d.qty; d.received=d.qty; state.save(); logCall('executeTransfer','SIMULATED',id); return d;
  },
  async getTransfer(user,id) {const e=state.value.transfers[id]; if(!e||e.user!==user)throw Error('Transfer not found'); logCall('getTransfer','SIMULATED',id); return e.detail;},
  async listTransactions(user) {
    return { data: Object.values(state.value.orders).filter(o => o.user === user && o.detail.status === 'complete').map(({detail:d}) => ({id:d.order_id,type:'order' as const,asset_flow:d.side === 'buy' ? 'in' as const : 'out' as const,status:'completed' as const,created_at:d.created_at,completed_at:d.created_at,qty:d.executed_qty,asset_id:d.asset_id!,asset_symbol:d.asset_symbol!,tx_hash:null,explorer_url:null,failure_reason:null,order:d})), pagination:{next_cursor:null,limit:50} };
  }
};
