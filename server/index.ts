import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { assets, loadAssets, loadMarketAssets } from "./assets.ts";
import { env } from "./env.ts";
import { prices, startPricePoller } from "./prices.ts";
import * as real from "./tm/gateway.ts";
import { mockGateway } from "./outcry/mock.ts";
import { startShow } from "./outcry/show.ts";
import { startMarketStream } from "./market-stream.ts";
const gateway = env.MOCK_MODE ? mockGateway : real;
await loadAssets(gateway.listAssets);
if (env.MOCK_MODE) {
  try { await loadMarketAssets(real.listAssets); } catch { /* Retain the small simulated catalog when public catalog access is unavailable. */ }
}
startPricePoller([...new Set(assets.all().map(a => a.symbol))], 15000, gateway.priceHistory);
startMarketStream([...new Set([...assets.tradeable(), ...(assets.market?.() ?? [])].map(a => a.symbol))]);
const deps = { gateway, assets, prices };
startShow(deps);
serve({ fetch: createApp(deps).fetch, port: env.PORT }, info => console.log(`OUTCRY.FM http://localhost:${info.port} · ${env.MOCK_MODE ? "SIMULATED" : "REAL FUNDS"}`));
