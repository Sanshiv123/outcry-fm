import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppDeps } from "./app.ts";
import { env } from "./env.ts";
import { tmFetch } from "./tm/client.ts";
import type { PriceHistoryBatchResponse } from "./tm/types.ts";
import { getMarketStatus, prices, subscribeMarket } from "./prices.ts";
import type { AppEnv } from "./session.ts";

export function marketRoutes(deps: AppDeps) {
  const marketAssets = () => deps.assets.market?.() ?? deps.assets.tradeable();
  return new Hono<AppEnv>()
    .get("/market/stream", (c) => streamSSE(c, async (stream) => {
      const symbols = [...new Set(deps.assets.tradeable().map((asset) => asset.symbol.toUpperCase()))];
      const unsubscribe = subscribeMarket((event) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => undefined);
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify({
          status: getMarketStatus(),
          quotes: Object.fromEntries(symbols.map((symbol) => [symbol, prices.get(symbol)])),
        }),
        retry: 3000,
      });
      while (!stream.aborted) {
        await stream.sleep(15_000);
        if (!stream.aborted) await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ status: getMarketStatus() }) });
      }
      unsubscribe();
    }))
    .get("/market/assets", (c) => c.json({ assets: marketAssets().map(({ id, symbol, name, chain, address }) => ({ id, symbol, name, chain, address })) }))
    .get("/market/history", async (c) => {
      const symbols = [...new Set(marketAssets().map((asset) => asset.symbol.toUpperCase()))];
      const requested = c.req.query("symbols")?.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
      const selected = (requested?.length ? symbols.filter((symbol) => requested.includes(symbol)) : symbols).slice(0, 36);
      let result: PriceHistoryBatchResponse;
      let source: string;
      try {
        result = await tmFetch<PriceHistoryBatchResponse>(`/v1/defi/market/prices/history/batch?${new URLSearchParams({ symbols: selected.join(","), window: "24h", resolution: "5m" })}`, { auth: "none" });
        source = "truemarkets_history";
      } catch (error) {
        if (!env.MOCK_MODE) throw error;
        result = { window: "24h", resolution: "5m", results: await Promise.all(selected.map(async (symbol) => ({ symbol, points: (await deps.gateway.priceHistory(symbol)).points }))) };
        source = "simulated_history";
      }
      const series = result.results.map((entry) => ({ symbol: entry.symbol, points: entry.points ?? [], error: entry.error, source }));
      return c.json({ series });
    });
}
