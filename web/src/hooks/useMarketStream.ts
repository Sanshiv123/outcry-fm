import { useEffect, useState } from "react";

export type MarketQuote = { price: string | null; change_24h: string | null; as_of: string | null; received_at: string | null; source: string };
export type MarketFeedStatus = { mode: "simulated" | "connecting" | "streaming" | "fallback"; source: string; connected: boolean; updated_at: string | null };
type Snapshot = { status: MarketFeedStatus; quotes: Record<string, MarketQuote> };

function decode<T>(event: Event): T | null {
  try { return JSON.parse((event as MessageEvent<string>).data) as T; } catch { return null; }
}

export function useMarketStream() {
  const [status, setStatus] = useState<MarketFeedStatus>({ mode: "connecting", source: "Connecting to price feed…", connected: false, updated_at: null });
  const [quotes, setQuotes] = useState<Record<string, MarketQuote>>({});
  const [browserConnected, setBrowserConnected] = useState(false);

  useEffect(() => {
    const stream = new EventSource("/api/market/stream");
    stream.onopen = () => setBrowserConnected(true);
    stream.onerror = () => setBrowserConnected(false);
    stream.addEventListener("snapshot", (event) => {
      const snapshot = decode<Snapshot>(event);
      if (snapshot) { setStatus(snapshot.status); setQuotes(snapshot.quotes); }
    });
    stream.addEventListener("status", (event) => {
      const update = decode<{ status: MarketFeedStatus }>(event);
      if (update) setStatus(update.status);
    });
    stream.addEventListener("price", (event) => {
      const update = decode<{ symbol: string; quote: MarketQuote }>(event);
      if (update) setQuotes((current) => ({ ...current, [update.symbol.toUpperCase()]: update.quote }));
    });
    stream.addEventListener("heartbeat", (event) => {
      const update = decode<{ status: MarketFeedStatus }>(event);
      if (update) setStatus(update.status);
    });
    return () => stream.close();
  }, []);

  return { status, quotes, browserConnected };
}
