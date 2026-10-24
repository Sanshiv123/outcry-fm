import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AssetCatalog } from "./assets.ts";
import { ApiError, errorResponse } from "./http.ts";
import type { PriceBook } from "./prices.ts";
import { authRoutes } from "./routes/auth.ts";
import { floorRoutes } from "./outcry/routes.ts";

import { walletRoutes } from "./routes/wallet.ts";
import { marketRoutes } from "./market-routes.ts";
import type * as gateway from "./tm/gateway.ts";

export interface AppDeps {
  gateway: typeof gateway;
  assets: AssetCatalog;
  prices: PriceBook;
}

const DIST = "./dist";

export function createApp(deps: AppDeps) {
  const app = new Hono()
    .use("/api/*", bodyLimit({ maxSize: 5_000_000 }))
    .use("/api/*", async (c, next) => {
      const origin = c.req.header("Origin");
      if (c.req.method === "POST" && origin && new URL(origin).host !== c.req.header("Host")) throw new ApiError(403, "forbidden", "Cross-origin requests are not allowed");
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      await next();
    })
    .route("/api", authRoutes(deps))
    .route("/api", walletRoutes(deps))
    .route("/api", marketRoutes(deps))
    .route("/api", floorRoutes(deps))
    .all("/api/*", () => {
      throw new ApiError(404, "not_found", "not found");
    });

  app.onError(errorResponse);

  if (existsSync(DIST)) {
    app.use("*", serveStatic({ root: DIST }));
    app.get("*", serveStatic({ path: `${DIST}/index.html` }));
  }

  return app;
}
