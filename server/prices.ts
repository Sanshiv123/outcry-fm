import { errorMessage } from "./tm/errors.ts";
import { priceHistory } from "./tm/gateway.ts";
import { env } from "./env.ts";

export interface PriceQuote {
  price: string | null;
  change_24h: string | null;
  as_of: string | null;
  received_at?: string | null;
  source?: "truemarkets_stream" | "history_poll" | "simulated_history" | "unavailable";
}

export interface PriceBook {
  get(symbol: string): PriceQuote;
}

const EMPTY: PriceQuote = { price: null, change_24h: null, as_of: null, received_at: null, source: "unavailable" };

const quotes = new Map<string, PriceQuote>();
const streamQuotes = new Map<string, PriceQuote>();
const failing = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;
export type MarketStatus = { mode: "simulated" | "connecting" | "streaming" | "fallback"; source: string; connected: boolean; updated_at: string | null };
export type MarketEvent = { type: "price"; symbol: string; quote: PriceQuote } | { type: "status"; status: MarketStatus };
const listeners = new Set<(event: MarketEvent) => void>();
let marketStatus: MarketStatus = env.MOCK_MODE
  ? { mode: "simulated", source: "Simulated history polling", connected: false, updated_at: null }
  : { mode: "connecting", source: "Connecting to True Markets WebSocket", connected: false, updated_at: null };

function emit(event: MarketEvent) {
  for (const listener of listeners) {
    try { listener(event); } catch { /* A disconnected client must not interrupt other subscribers. */ }
  }
}

export function subscribeMarket(listener: (event: MarketEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMarketStatus(status: MarketStatus): void {
  marketStatus = status;
  emit({ type: "status", status });
}

export function getMarketStatus(): MarketStatus {
  return marketStatus;
}

export function publishStreamPrice(symbol: string, value: { price: string; change_24h: string | null; as_of: string }): void {
  const key = symbol.toUpperCase();
  const quote: PriceQuote = { ...value, received_at: new Date().toISOString(), source: "truemarkets_stream" };
  streamQuotes.set(key, quote);
  marketStatus = { ...marketStatus, updated_at: quote.received_at ?? new Date().toISOString() };
  emit({ type: "price", symbol: key, quote });
}

function relativeChange(first: string, last: string): string | null {
  const from = Number(first);
  if (!Number.isFinite(from) || from === 0) return null;
  return ((Number(last) - from) / from).toFixed(4);
}

async function refresh(symbol: string, fetchHistory: typeof priceHistory): Promise<void> {
  const key = symbol.toUpperCase();
  try {
    const { points } = await fetchHistory(symbol);
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last) throw new Error("no price points");
    const quote: PriceQuote = {
      price: last.price,
      change_24h: relativeChange(first.price, last.price),
      as_of: last.t,
      received_at: new Date().toISOString(),
      source: env.MOCK_MODE ? "simulated_history" : "history_poll",
    };
    quotes.set(key, quote);
    const effective = prices.get(key);
    emit({ type: "price", symbol: key, quote: { ...effective, change_24h: effective.change_24h ?? null } });
    failing.delete(key);
  } catch (err) {
    if (failing.has(key)) return;
    failing.add(key);
    console.warn(`price poll for ${symbol} failed: ${errorMessage(err)}`);
  }
}

export function startPricePoller(symbols: string[], intervalMs = 15_000, fetchHistory = priceHistory): void {
  const poll = () => Promise.allSettled(symbols.map((s) => refresh(s, fetchHistory)));
  void poll();
  timer = setInterval(poll, intervalMs);
}

export function stopPricePoller(): void {
  clearInterval(timer);
  timer = undefined;
  quotes.clear();
  streamQuotes.clear();
  failing.clear();
}

export const prices: PriceBook = {
  get(symbol) {
    const key = symbol.toUpperCase();
    const streamQuote = streamQuotes.get(key);
    if (streamQuote?.received_at && Date.now() - Date.parse(streamQuote.received_at) <= 60_000) return streamQuote;
    return quotes.get(key) ?? EMPTY;
  },
};
