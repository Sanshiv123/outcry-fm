import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../app.ts';
import { env } from '../env.ts';
import { ApiError } from '../http.ts';
import type { Customer } from '../customers.ts';
import { Store, logCall } from './store.ts';
import { announce, currentPrice } from './standing.ts';

// Crowd Calls: a free prediction game on air. Listeners call bull or bear on an asset for a short round,
// the hosts read the result off live prices, and callers build points and streaks. No funds move.
export type Side = 'bull' | 'bear';
export type Round = {
  id: string; asset_id: string; symbol: string; open_price: number; opens_at: number; locks_at: number; closes_at: number;
  votes: { customer: string; name: string; side: Side; at: number }[];
  status: 'OPEN' | 'SETTLED' | 'VOID'; close_price?: number; result?: Side | 'flat'; change_pct?: number;
};
export type Caller = { name: string; points: number; calls: number; streak: number; best_streak: number };
export const rounds = new Store<Round[]>('crowd-rounds', []);
export const callers = new Store<Record<string, Caller>>('crowd-callers', {});

// Moves smaller than this are a push: nobody scores, nobody loses a streak.
const FLAT_PCT = 0.01;

export function parseCall(text: string): { side: Side; symbol?: string } | null {
  const m = text.toLowerCase().trim().replace(/[.!?]$/, '').match(/^(?:i'?m |i am |vote |call |going |put me down as )?(bull|bullish|long|up|bear|bearish|short|down)(?: on ([a-z]+))?$/);
  if (!m) return null;
  return { side: /^(bull|long|up)/.test(m[1]!) ? 'bull' : 'bear', symbol: m[2]?.toUpperCase() };
}

const pct = (n: number) => `${Math.abs(n).toFixed(2)} percent`;
// Spoken names: TTS spells tickers out letter by letter.
const say = (symbol: string) => ({ CBBTC: 'Bitcoin', SOL: 'Solana' } as Record<string, string>)[symbol] ?? symbol;
const span = (ms: number) => ms < 90_000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60_000)} minutes`;

export function makeCrowd(deps: AppDeps) {
  const roundMs = env.CROWD_ROUND_SECONDS * 1000;
  let nextAsset = 0;

  const current = () => rounds.value.find(r => r.status === 'OPEN');

  function open() {
    const assets = deps.assets.tradeable();
    for (let tries = 0; tries < assets.length; tries++) {
      const a = assets[nextAsset++ % assets.length]!;
      const p = currentPrice(deps, a.symbol);
      if (p === null) continue;
      const now = Date.now();
      // Calls lock at two thirds of the round so nobody can wait for the last tick.
      const r: Round = { id: randomUUID(), asset_id: a.id, symbol: a.symbol, open_price: p, opens_at: now, locks_at: now + Math.round(roundMs * 2 / 3), closes_at: now + roundMs, votes: [], status: 'OPEN' };
      rounds.value.push(r); rounds.value = rounds.value.slice(-50); rounds.save();
      logCall('crowd call', 'OPEN', r.id);
      announce(`New crowd call. Where is ${say(a.symbol)} in ${span(roundMs)}? Bulls or bears. Tap your call, or call the floor and say bullish or bearish. It is a game. No money moves.`, r.id);
      return;
    }
  }

  function settle(r: Round) {
    const p = currentPrice(deps, r.symbol);
    if (p === null) {
      // No fresh price, no result: void the round rather than score it on stale data.
      r.status = 'VOID'; rounds.save(); logCall('crowd call', 'VOID', r.id);
      announce(`The ${say(r.symbol)} crowd call is void. We could not get a fresh price to settle it.`, r.id);
      return;
    }
    const change = (p - r.open_price) / r.open_price * 100;
    const result: Round['result'] = Math.abs(change) < FLAT_PCT ? 'flat' : change > 0 ? 'bull' : 'bear';
    Object.assign(r, { status: 'SETTLED', close_price: p, result, change_pct: change });
    const winners: string[] = [];
    if (result !== 'flat') for (const v of r.votes) {
      const c = callers.value[v.customer] ??= { name: v.name, points: 0, calls: 0, streak: 0, best_streak: 0 };
      c.name = v.name; c.calls++;
      if (v.side === result) { c.points++; c.streak++; c.best_streak = Math.max(c.best_streak, c.streak); winners.push(v.customer); }
      else c.streak = 0;
    }
    rounds.save(); callers.save(); logCall('crowd call', `SETTLED ${result.toUpperCase()}`, r.id);
    const right = winners.length, total = r.votes.length;
    const hot = winners.map(id => callers.value[id]!).filter(c => c.streak >= 2).sort((a, b) => b.streak - a.streak)[0];
    const move = result === 'flat' ? `${say(r.symbol)} barely moved, so that one is a push` : `${say(r.symbol)} closed ${result === 'bull' ? 'up' : 'down'} ${pct(change)}. The ${result === 'bull' ? 'bulls' : 'bears'} take it`;
    const tally = result === 'flat' || !total ? '' : ` ${right} of ${total} ${total === 1 ? 'caller' : 'callers'} had it right.`;
    announce(`Ding ding. ${move}.${tally}${hot ? ` ${hot.name} is on a ${hot.streak} call streak.` : ''}`, r.id);
  }

  function tick() {
    const r = current();
    if (r && Date.now() >= r.closes_at) settle(r);
    if (!current()) open();
  }

  function vote(customer: Customer, side: Side, symbol?: string) {
    const r = current();
    if (!r) throw new ApiError(409, 'conflict', 'No crowd call is open right now. The next one starts shortly.');
    if (symbol && symbol !== r.symbol && !(['BTC', 'BITCOIN'].includes(symbol) && r.symbol === 'CBBTC') && !(symbol === 'SOLANA' && r.symbol === 'SOL')) {
      throw new ApiError(409, 'conflict', `This round is on ${r.symbol}, not ${symbol}.`);
    }
    if (Date.now() >= r.locks_at) throw new ApiError(409, 'conflict', 'Calls are locked for this round. Wait for the bell.');
    // One call per caller per round; changing your mind before the lock replaces it.
    r.votes = r.votes.filter(v => v.customer !== customer.id);
    r.votes.push({ customer: customer.id, name: customer.first_name || 'Listener', side, at: Date.now() });
    rounds.save();
    return r;
  }

  function view(customer?: string) {
    const r = current();
    const last = rounds.value.filter(x => x.status !== 'OPEN').at(-1);
    const tally = (x: Round) => ({ bull: x.votes.filter(v => v.side === 'bull').length, bear: x.votes.filter(v => v.side === 'bear').length });
    const strip = (x: Round) => { const { votes, ...rest } = x; return { ...rest, ...tally(x), mine: customer ? votes.find(v => v.customer === customer)?.side ?? null : null }; };
    const leaders = Object.entries(callers.value).map(([id, c]) => ({ ...c, me: id === customer })).filter(c => c.calls > 0)
      .sort((a, b) => b.points - a.points || b.streak - a.streak || a.calls - b.calls).slice(0, 10);
    return { round: r ? strip(r) : null, last: last ? strip(last) : null, leaders, me: customer ? callers.value[customer] ?? null : null };
  }

  function start() {
    if (!env.CROWD_CALLS) return;
    setTimeout(() => { try { tick(); } catch { /* retried on the next tick */ } }, 5000);
    setInterval(() => { try { tick(); } catch { /* retried on the next tick */ } }, 2000).unref();
  }

  return { vote, view, start, tick };
}

export function voteReply(r: Round, side: Side) {
  const secs = Math.max(0, Math.round((r.locks_at - Date.now()) / 1000));
  return `You are down as a ${side} on ${r.symbol}, from ${r.open_price.toFixed(2)} dollars. Calls lock in ${secs} seconds, and the bell rings at the close. It is a game, not advice.`;
}
