import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AppDeps } from '../app.ts';
import { env } from '../env.ts';
import { ApiError } from '../http.ts';
import { findById, type Customer } from '../customers.ts';
import type { AssetItem } from '../tm/types.ts';
import { checkBudget, checkCaps, makeFloor } from './policy.ts';
import { Store, logCall } from './store.ts';
import { speech } from './show.ts';

// Standing orders: a caller authorizes a rule once ("buy 1 dollar of SOL every time it drops below 98"),
// then the floor drafts and executes each fill itself. Every fill still goes through draft/confirm, so the
// per-order, daily and station caps, the allowlist and balance checks apply to each one. Alerts never trade.
export type Rule = {
  id: string; customer: string; name: string; kind: 'buy'|'sell'|'alert'; asset_id: string; symbol: string;
  op: 'below'|'above'; trigger: number; amount_usd: number; repeat: boolean; max_fills: number; fills: number;
  status: 'PENDING_AUTHORIZATION'|'ACTIVE'|'DONE'|'CANCELED'|'EXPIRED'|'HALTED';
  created: number; authorize_by: number; expires: number; armed: boolean; last_fill?: number; last_error?: string;
  tickets: string[]; simulated: boolean;
};
export type Bulletin = { id: string; time: number; line: string; audio?: string; rule?: string };
export const rules = new Store<Rule[]>('standing', []);
export const bulletins = new Store<Bulletin[]>('bulletins', []);

const AUTHORIZE_WINDOW_MS = 60_000, COOLDOWN_MS = 60_000, MAX_ACTIVE_PER_CUSTOMER = 3, MAX_ACTIVE_STATION = 12;
const DEFAULT_LIFETIME_MS = 2 * 3600_000, MAX_LIFETIME_MS = 24 * 3600_000;
// After a fill, a repeating rule re-arms only once price moves back across the trigger by this fraction.
const REARM_BAND = 0.002;

function deny(message: string): never { throw new ApiError(422, 'policy_blocked', message); }
const live = (r: Rule) => r.status === 'ACTIVE' || r.status === 'PENDING_AUTHORIZATION';
const dollars = (n: number) => n === 1 ? '1 dollar' : Number.isInteger(n) ? `${n} dollars` : `${n.toFixed(2)} dollars`;
const priceWords = (n: number) => n >= 1000 ? `${Math.round(n)} dollars` : dollars(n);

export function findAsset(word: string, assets: AssetItem[]) {
  const w = word.toUpperCase();
  return assets.find(a => a.symbol === w || a.name.toUpperCase() === w || (['BTC','BITCOIN'].includes(w) && a.symbol === 'CBBTC') || (w === 'SOLANA' && a.symbol === 'SOL'));
}

export type StandingIntent = { kind: Rule['kind']; asset: AssetItem; op: Rule['op'] | 'cross'; trigger: number; amount_usd: number; repeat: boolean; max_fills: number; lifetime_ms: number };

// Deterministic grammar; nothing here is decided by a model.
//   buy 1 dollar of sol if it drops below 98
//   sell 2 dollars of sol every time it goes above 105, up to 3 times, for 1 hour
//   alert me when sol crosses 105
//   limit buy 1 dollar of sol at 98   (buy at/below, sell at/above the price)
export function parseStanding(text: string, assets: AssetItem[]): StandingIntent | null {
  const t = text.toLowerCase().replace(/[,!?]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  const lifetime = t.match(/\bfor (?:the next )?(\d+(?:\.\d+)?) ?(minutes?|mins?|hours?|hrs?)\b/);
  const lifetime_ms = lifetime ? Math.min(MAX_LIFETIME_MS, Number(lifetime[1]) * (lifetime[2]!.startsWith('h') ? 3600_000 : 60_000)) : DEFAULT_LIFETIME_MS;
  const alert = t.match(/^(?:alert me|tell me|let me know|ping me|notify me)\s+(?:when|if)\s+([a-z]+)\s+(?:goes |gets |is |trades |drops |falls |dips |rises |climbs |moves )?(above|over|below|under|past|crosses|to)\s+\$?(\d+(?:\.\d+)?)/)
    ?? t.match(/^(?:alert me|tell me|let me know|ping me|notify me)\s+(?:when|if)\s+([a-z]+)\s+(crosses)\s+\$?(\d+(?:\.\d+)?)/);
  if (alert) {
    const asset = findAsset(alert[1]!, assets); if (!asset) deny('That asset is not on the verified allowlist.');
    const dir = alert[2]!;
    return { kind: 'alert', asset, op: /above|over/.test(dir) ? 'above' : /below|under/.test(dir) ? 'below' : 'cross', trigger: Number(alert[3]), amount_usd: 0, repeat: false, max_fills: 1, lifetime_ms };
  }
  const limit = t.match(/^(?:limit |place a limit (?:order )?(?:to )?)?(buy|sell)\s+\$?(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd)?\s*(?:worth\s+)?(?:of\s+|in\s+)?([a-z]+)\s+(?:at|@)\s+\$?(\d+(?:\.\d+)?)(?:\s+dollars?)?(.*)$/);
  if (limit) {
    const asset = findAsset(limit[3]!, assets); if (!asset) deny('That asset is not on the verified allowlist.');
    const rest = limit[5]!;
    const repeat = /\b(every ?time|each time|whenever|all the time|always)\b/.test(rest);
    const times = rest.match(/\b(?:up to |max(?:imum)? |at most )?(\d+) times?\b/);
    const max_fills = Math.max(1, Math.min(env.STANDING_MAX_FILLS, times ? Number(times[1]) : repeat ? env.STANDING_MAX_FILLS : 1));
    return { kind: limit[1] as 'buy'|'sell', asset, op: limit[1] === 'buy' ? 'below' : 'above', trigger: Number(limit[4]), amount_usd: Number(limit[2]), repeat: repeat || max_fills > 1, max_fills, lifetime_ms };
  }
  const order = t.match(/^(buy|sell)\s+\$?(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd)?\s*(?:worth\s+)?(?:of\s+|in\s+)?([a-z]+)\s+(.+)$/);
  if (!order) return null;
  const rest = order[4]!;
  const cond = rest.match(/\b(below|under|less than|lower than|beneath|above|over|more than|greater than|higher than)\s+\$?(\d+(?:\.\d+)?)/)
    ?? rest.match(/\b(drops?|falls?|dips?|sinks?|rises?|climbs?|jumps?|hits?)\s+(?:to\s+)?\$?(\d+(?:\.\d+)?)/);
  if (!cond || !/\b(if|when|whenever|once|every ?time|each time|all the time|always)\b/.test(rest)) return null;
  const asset = findAsset(order[3]!, assets); if (!asset) deny('That asset is not on the verified allowlist.');
  const word = cond[1]!;
  const op: Rule['op'] = /below|under|less|lower|beneath|drop|fall|dip|sink/.test(word) ? 'below' : 'above';
  const repeat = /\b(every ?time|each time|whenever|all the time|always)\b/.test(rest);
  const times = rest.match(/\b(?:up to |max(?:imum)? |at most )?(\d+) times?\b/);
  const max_fills = Math.max(1, Math.min(env.STANDING_MAX_FILLS, times ? Number(times[1]) : repeat ? env.STANDING_MAX_FILLS : 1));
  return { kind: order[1] as 'buy'|'sell', asset, op, trigger: Number(cond[2]), amount_usd: Number(order[2]), repeat: repeat || max_fills > 1, max_fills, lifetime_ms };
}

export function currentPrice(deps: AppDeps, symbol: string) {
  const p = deps.prices.get(symbol);
  if (!p.price || !p.as_of || Date.now() - Date.parse(p.as_of) > 120_000) return null;
  const n = Number(p.price); return Number.isFinite(n) && n > 0 ? n : null;
}

export function describe(r: Rule) {
  const cond = `${r.symbol} trades ${r.op === 'below' ? 'at or below' : 'at or above'} ${priceWords(r.trigger)}`;
  if (r.kind === 'alert') return `Alert when ${cond}.`;
  const verb = r.kind === 'buy' ? 'Buy' : 'Sell';
  return `${verb} ${dollars(r.amount_usd)} of ${r.symbol} ${r.repeat ? 'each time' : 'once'} ${cond}${r.repeat ? `, up to ${r.max_fills} fills` : ''}.`;
}

export function publicRule(r: Rule) { const { customer, ...safe } = r; return safe; }

export function announce(line: string, rule?: string) {
  const b: Bulletin = { id: randomUUID(), time: Date.now(), line, rule };
  bulletins.value.unshift(b); bulletins.value = bulletins.value.slice(0, 30); bulletins.save();
  // Voice the bulletin with host B when ElevenLabs voices are configured; the browser falls back to speech.
  void speech(line, 'B').then(audio => {
    if (!audio) return;
    mkdirSync('data/audio', { recursive: true });
    const file = `${b.time}-99.mp3`; if (!existsSync(`data/audio/${file}`)) writeFileSync(`data/audio/${file}`, audio);
    b.audio = `/api/audio/${file}`; bulletins.save();
  }).catch(() => {});
  return b;
}

export function makeStanding(deps: AppDeps) {
  const floor = makeFloor(deps);

  function expireRules() {
    let changed = false;
    for (const r of rules.value) {
      if (r.status === 'PENDING_AUTHORIZATION' && Date.now() > r.authorize_by) { r.status = 'EXPIRED'; changed = true; }
      if (r.status === 'ACTIVE' && Date.now() > r.expires) { r.status = 'EXPIRED'; changed = true; logCall('standing order', 'EXPIRED', r.id); }
    }
    if (changed) rules.save();
  }

  function propose(customer: Customer, intent: StandingIntent) {
    if (!env.STANDING_ORDERS) deny('Standing orders are switched off on this station.');
    expireRules();
    if (!Number.isFinite(intent.trigger) || intent.trigger <= 0) deny('Give me a trigger price above zero.');
    const now = currentPrice(deps, intent.asset.symbol);
    if (now === null) deny('Fresh price data is unavailable, so I will not set a standing order right now.');
    const op: Rule['op'] = intent.op === 'cross' ? (intent.trigger >= now ? 'above' : 'below') : intent.op;
    if (intent.kind !== 'alert') {
      if (!intent.asset.tradeable || deps.assets.isCash(intent.asset)) deny('This asset is not tradable.');
      // The whole rule must fit inside today's limits up front, not just its first fill.
      checkCaps(intent.amount_usd, customer.id);
      checkBudget(intent.amount_usd * intent.max_fills, customer.id);
    }
    const mine = rules.value.filter(r => r.customer === customer.id && live(r));
    for (const r of mine) if (r.status === 'PENDING_AUTHORIZATION') r.status = 'CANCELED';
    if (mine.filter(r => r.status === 'ACTIVE').length >= MAX_ACTIVE_PER_CUSTOMER) deny(`You already have ${MAX_ACTIVE_PER_CUSTOMER} standing orders. Cancel one first.`);
    if (rules.value.filter(r => r.status === 'ACTIVE').length >= MAX_ACTIVE_STATION) deny('The floor is holding too many standing orders right now.');
    const r: Rule = {
      id: randomUUID(), customer: customer.id, name: customer.first_name || 'Listener', kind: intent.kind, asset_id: intent.asset.id, symbol: intent.asset.symbol,
      op, trigger: intent.trigger, amount_usd: intent.amount_usd, repeat: intent.repeat, max_fills: intent.max_fills, fills: 0,
      status: intent.kind === 'alert' ? 'ACTIVE' : 'PENDING_AUTHORIZATION', created: Date.now(), authorize_by: Date.now() + AUTHORIZE_WINDOW_MS,
      expires: Date.now() + intent.lifetime_ms, armed: true, tickets: [], simulated: env.MOCK_MODE,
    };
    rules.value.push(r); rules.save(); logCall('standing order', r.status, r.id);
    const met = op === 'below' ? now <= r.trigger : now >= r.trigger;
    const mins = Math.round(intent.lifetime_ms / 60_000);
    const life = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
    if (r.kind === 'alert') return { rule: r, reply: `Alert set. I will call it on air when ${r.symbol} trades ${op === 'below' ? 'at or below' : 'at or above'} ${priceWords(r.trigger)}. It is ${priceWords(now)} now. Good for ${life}.` };
    const reply = `${r.simulated ? 'Simulated. ' : ''}Standing order: ${describe(r)} ${r.symbol} is ${priceWords(now)} now${met ? ', so the first fill would happen right away' : ''}. Good for ${life}. Once armed, fills execute automatically within your limits, without asking again. Say arm it within sixty seconds to authorize, or scratch that.`;
    return { rule: r, reply };
  }

  function arm(customer: Customer, id?: string) {
    expireRules();
    const r = rules.value.filter(r => r.customer === customer.id && r.status === 'PENDING_AUTHORIZATION' && (!id || r.id === id)).at(-1);
    if (!r) deny('There is no standing order waiting for authorization. Set a new one.');
    if (r.kind !== 'alert') checkBudget(r.amount_usd * (r.max_fills - r.fills), customer.id);
    r.status = 'ACTIVE'; r.expires = Date.now() + (r.expires - r.created); rules.save(); logCall('standing order', 'ARMED', r.id);
    return r;
  }

  function cancel(customer: Customer, id?: string) {
    const hit = rules.value.filter(r => r.customer === customer.id && live(r) && (!id || r.id === id));
    if (id && !hit.length) throw new ApiError(404, 'not_found', 'Standing order not found');
    for (const r of hit) { r.status = 'CANCELED'; logCall('standing order', 'CANCELED', r.id); }
    rules.save(); return hit;
  }

  const firing = new Set<string>();
  async function fire(r: Rule, price: number) {
    const customer = findById(r.customer);
    if (!customer) { r.status = 'HALTED'; r.last_error = 'Customer no longer exists.'; rules.save(); return; }
    r.armed = false; r.last_fill = Date.now(); rules.save();
    logCall('standing order', 'TRIGGERED', r.id);
    try {
      const draft = await floor.draft(customer, { asset_id: r.asset_id, kind: r.kind as 'buy'|'sell', amount: r.amount_usd.toFixed(2) });
      r.tickets.push(draft.id); rules.save();
      // The rule was authorized when armed; this is the pre-authorized confirmation of this exact fresh ticket.
      const t = await floor.confirm(customer, draft.id);
      r.fills++;
      if (r.fills >= r.max_fills) r.status = 'DONE';
      rules.save();
      const verb = r.kind === 'buy' ? 'bought' : 'sold';
      announce(t.status === 'FILLED'
        ? `Standing order on the floor. ${r.name} just ${verb} ${dollars(r.amount_usd)} of ${r.symbol}${t.simulated ? ' in simulation' : ''} as it crossed ${priceWords(r.trigger)}. Fill ${r.fills} of ${r.max_fills}.`
        : `${r.name}'s standing order on ${r.symbol} triggered at ${priceWords(price)}. The floor is checking the order status now.`, r.id);
    } catch (e) {
      // Any refusal halts the rule rather than retrying into a limit or an empty wallet.
      r.status = 'HALTED'; r.last_error = e instanceof Error ? e.message : 'Execution failed.'; rules.save();
      logCall('standing order', 'HALTED', r.id);
      announce(`${r.name}'s standing order on ${r.symbol} was stopped by the floor. ${r.last_error}`, r.id);
    }
  }

  function tick() {
    expireRules();
    for (const r of rules.value) {
      if (r.status !== 'ACTIVE' || firing.has(r.id)) continue;
      const p = currentPrice(deps, r.symbol); if (p === null) continue;
      const met = r.op === 'below' ? p <= r.trigger : p >= r.trigger;
      if (!r.armed) {
        const recovered = r.op === 'below' ? p > r.trigger * (1 + REARM_BAND) : p < r.trigger * (1 - REARM_BAND);
        if (recovered && Date.now() - (r.last_fill ?? 0) >= COOLDOWN_MS) { r.armed = true; rules.save(); }
        continue;
      }
      if (!met) continue;
      if (r.kind === 'alert') {
        r.status = 'DONE'; r.fills = 1; rules.save(); logCall('price alert', 'TRIGGERED', r.id);
        announce(`Price alert for ${r.name}. ${r.symbol} is ${r.op === 'below' ? 'down at' : 'up at'} ${priceWords(p)}, through the ${priceWords(r.trigger)} mark.`, r.id);
        continue;
      }
      if (!env.STANDING_ORDERS) continue;
      firing.add(r.id);
      void fire(r, p).finally(() => firing.delete(r.id));
    }
  }

  function start() { setInterval(() => { try { tick(); } catch { /* next tick retries */ } }, 3000).unref(); }
  return { propose, arm, cancel, start, tick };
}
