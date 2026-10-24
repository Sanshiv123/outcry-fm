import { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import { gatewayUserId, requireCustomer, type AppEnv } from "../session.ts";
import { TMError } from "../tm/errors.ts";
import { env } from "../env.ts";
import { getSoleOrganizationUser } from "../tm/organization.ts";

export function walletRoutes({ gateway, assets, prices }: AppDeps) {
  const app = new Hono<AppEnv>();
  app.get("/connected-wallet", ...(env.TM_PUBLIC_WALLET_VIEW ? [] : [requireCustomer]), async (c) => {
    const linked = env.TM_PUBLIC_WALLET_VIEW ? await getSoleOrganizationUser() : undefined;
    const customer = env.TM_PUBLIC_WALLET_VIEW ? undefined : c.var.customer;
    const userId = linked?.user_id ?? (customer ? gatewayUserId(customer) : "");
    if (!userId) return c.json({ type: "unavailable", message: "No linked Gateway wallet is configured" }, 503);
    const wallets = linked?.wallets ?? customer?.wallets ?? [];
    const [balances, portfolio, transactions] = await Promise.all([
      gateway.balances(userId),
      gateway.portfolio(userId).catch(async (err: unknown) => {
        if (!(err instanceof TMError) || err.status !== 503) throw err;
        const b = await gateway.balances(userId);
        return { priced: false as const, balances: b.data };
      }),
      gateway.listTransactions(userId),
    ]);
    return c.json({
      connected: true,
      source: "True Markets Gateway",
      wallets: wallets.map(({ chain_family }) => ({ chain_family })),
      balances: balances.data,
      portfolio,
      transactions: transactions.data
        .filter((tx) => tx.transfer?.status !== "awaiting_signature")
        .slice(0, 20)
        .map(({ id, type, asset_flow, status, created_at, qty, asset_symbol }) => ({ id, type, asset_flow, status, created_at, qty, asset_symbol })),
    });
  });
  return app
    .get("/portfolio", requireCustomer, async (c) => {
      const userId = gatewayUserId(c.var.customer);
      try {
        return c.json(await gateway.portfolio(userId));
      } catch (err) {
        // Conductor answers 503 when it cannot price the portfolio; quantities are still worth showing.
        if (!(err instanceof TMError) || err.status !== 503) throw err;
        const { data } = await gateway.balances(userId);
        return c.json({ priced: false, balances: data });
      }
    })
    .get("/assets", requireCustomer, (c) => {
      const rows = assets.all().map((asset) => ({
        asset_id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        chain: asset.chain,
        icon: asset.icon,
        ...prices.get(asset.symbol),
        cash: assets.isCash(asset),
      }));
      return c.json(rows);
    })
    .get("/transactions", requireCustomer, async (c) => {
      const page = await gateway.listTransactions(gatewayUserId(c.var.customer));
      // Conductor lists prepared-but-unsigned transfers, while it already leaves unexecuted orders out.
      const data = page.data.filter((tx) => tx.transfer?.status !== "awaiting_signature");
      return c.json({ ...page, data });
    });
}
