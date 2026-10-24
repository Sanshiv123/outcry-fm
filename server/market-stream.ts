import { env } from "./env.ts";
import { publishStreamPrice, setMarketStatus } from "./prices.ts";

const WS_URL = "wss://api.truemarkets.co/v1/defi/market";
let socket: WebSocket | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let attempt = 0;
let feedSymbols = new Map<string, string>();

function websocketSymbol(symbol: string): string {
  // The Gateway's wrapped Base bitcoin asset is displayed as CBBTC, while the
  // public market feed names its reference-price topic BTC.
  return symbol.toUpperCase() === "CBBTC" ? "BTC" : symbol.toUpperCase();
}

function connect(): void {
  if (stopped) return;
  setMarketStatus({ mode: "connecting", source: "Connecting to True Markets WebSocket", connected: false, updated_at: null });
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    setMarketStatus({
      mode: "fallback",
      source: env.MOCK_MODE ? "True Markets stream unavailable · using simulated history" : "True Markets stream unavailable · using history polling",
      connected: false,
      updated_at: new Date().toISOString(),
    });
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    attempt = 0;
    const directTopics = [...feedSymbols.keys()].slice(0, 8).map((symbol) => `price.${symbol}`);
    socket?.send(JSON.stringify({ type: "subscribe", topics: ["price_candles", ...directTopics] }));
    setMarketStatus({ mode: "streaming", source: "True Markets live WebSocket", connected: true, updated_at: new Date().toISOString() });
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as {
        type?: string;
        timestamp?: number;
        data?: { symbol?: string; price?: string; close?: string; change_24h?: string; timestamp?: string; interval?: string } | { symbol?: string; close?: string; interval?: string }[];
      };
      const publish = (symbolValue: string, priceValue: string, sourceChange?: string, timestampValue?: string) => {
        const symbol = symbolValue.toUpperCase();
        const appSymbols = feedSymbols.get(symbol);
        const price = Number(priceValue);
        if (!appSymbols || !Number.isFinite(price) || price <= 0) return;
        const change = sourceChange !== undefined && Number.isFinite(Number(sourceChange))
          ? (Number(sourceChange) / 100).toString()
          : null;
        const timestamp = timestampValue && Number.isFinite(Date.parse(timestampValue))
          ? timestampValue
          : new Date((message.timestamp ?? Date.now() / 1000) * 1000).toISOString();
        for (const appSymbol of appSymbols.split(",")) {
          publishStreamPrice(appSymbol, { price: priceValue, change_24h: change, as_of: timestamp });
        }
      };
      if (message.type === "price" && !Array.isArray(message.data) && message.data?.symbol && message.data.price) {
        publish(message.data.symbol, message.data.price, message.data.change_24h, message.data.timestamp);
      } else if ((message.type === "price_candles" || message.type === "priceCandles") && Array.isArray(message.data)) {
        const intervals: Record<string, number> = { "30s": 0, "1m": 1, "5m": 2, "1h": 3, "4h": 4, "24h": 5 };
        const latest = new Map<string, { close: string; interval: string }>();
        for (const candle of message.data) {
          if (!candle.symbol || !candle.close) continue;
          const interval = candle.interval ?? "24h";
          const existing = latest.get(candle.symbol.toUpperCase());
          if (!existing || (intervals[interval] ?? 99) < (intervals[existing.interval] ?? 99)) {
            latest.set(candle.symbol.toUpperCase(), { close: candle.close, interval });
          }
        }
        for (const [symbol, candle] of latest) publish(symbol, candle.close);
      }
    } catch {
      // Ignore malformed or unrelated upstream messages; reconnect is handled by close/error.
    }
  });

  socket.addEventListener("error", () => socket?.close());
  socket.addEventListener("close", () => {
    socket = undefined;
    if (stopped) return;
    setMarketStatus({
      mode: "fallback",
      source: env.MOCK_MODE ? "True Markets stream disconnected · using simulated history" : "True Markets stream disconnected · using history polling",
      connected: false,
      updated_at: new Date().toISOString(),
    });
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (stopped || retryTimer) return;
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5));
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    connect();
  }, delay);
}

export function startMarketStream(symbols: string[]): void {
  feedSymbols = new Map();
  for (const symbol of symbols) {
    const sourceSymbol = websocketSymbol(symbol);
    const existing = feedSymbols.get(sourceSymbol);
    feedSymbols.set(sourceSymbol, existing ? `${existing},${symbol.toUpperCase()}` : symbol.toUpperCase());
  }
  connect();
}

export function stopMarketStream(): void {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  socket?.close();
  socket = undefined;
}
