import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowUpRight, CheckCircle2, CircleAlert, Wallet } from "lucide-react";
import { Link } from "react-router";
import { api } from "../api.ts";
import type { BalanceItem, Portfolio, TransactionDetail } from "../types.ts";
import { Banner, Card, Mono, Spinner } from "../components/ui.tsx";
import { chainName, relativeTime, tokenAmount, usd } from "../format.ts";

interface ConnectedWalletData {
  connected: boolean;
  source: string;
  wallets: { chain_family: string }[];
  balances: BalanceItem[];
  portfolio: Portfolio;
  transactions: Pick<TransactionDetail, "id" | "type" | "asset_flow" | "status" | "created_at" | "qty" | "asset_symbol">[];
}

export function ConnectedWallet() {
  const wallet = useQuery({
    queryKey: ["connected-wallet"],
    queryFn: () => api<ConnectedWalletData>("/api/connected-wallet"),
    refetchInterval: 15_000,
  });
  const data = wallet.data;
  const total = data?.portfolio && "total_usd" in data.portfolio ? data.portfolio.total_usd : null;
  const rows = data?.balances.filter((balance) => Number(balance.total) !== 0) ?? [];

  return (
    <main className="min-h-full bg-night px-5 py-8 text-text sm:px-10 sm:py-12">
      <div className="mx-auto flex max-w-4xl flex-col gap-7">
        <header className="flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 text-sm text-muted no-underline hover:text-text">
            <ArrowLeft size={17} /> OUTCRY.FM
          </Link>
          <Link to="/login" className="text-sm text-muted hover:text-text">Sign in to trade <ArrowUpRight className="inline" size={14} /></Link>
        </header>

        <div>
          <div className="mb-2 flex items-center gap-2 text-accent"><Wallet size={18} /><span className="text-xs font-bold uppercase tracking-[0.15em]">True Markets Gateway</span></div>
          <h1 className="m-0 font-display text-3xl font-bold sm:text-4xl">Connected wallet</h1>
          <p className="mb-0 mt-2 text-sm text-muted">Read-only wallet balances and recent activity. This view does not require sign-in.</p>
        </div>

        {wallet.isLoading && <Card className="flex justify-center p-10"><Spinner /></Card>}
        {wallet.error && <Banner tone="error" title="Wallet data unavailable">{wallet.error.message}</Banner>}

        {data && <>
          <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
            <div>
              <div className="flex items-center gap-2 text-sm text-up"><CheckCircle2 size={17} /> Connected</div>
              <p className="mb-0 mt-2 text-sm text-muted">Wallet networks: {data.wallets.length ? data.wallets.map((wallet) => wallet.chain_family).join(" · ") : "Gateway account"}</p>
            </div>
            <div className="sm:text-right"><span className="text-xs uppercase tracking-wider text-muted">Portfolio value</span><Mono className="mt-1 block text-3xl">{total === null ? "Not priced" : usd(total)}</Mono></div>
          </Card>

          <div className="grid gap-5 md:grid-cols-[1.3fr_1fr]">
            <Card className="p-5 sm:p-6">
              <h2 className="mb-4 mt-0 text-lg font-bold">Assets</h2>
              {rows.length ? <div>{rows.map((balance) => <div key={`${balance.symbol}:${balance.chain}`} className="flex items-center justify-between gap-4 border-t border-line py-4">
                <div><div className="font-bold">{balance.name || balance.symbol}</div><div className="mt-1 text-xs text-muted">{balance.symbol}{balance.chain ? ` · ${chainName(balance.chain)}` : ""}</div></div>
                <div className="text-right"><Mono className="text-sm">{tokenAmount(balance.total, balance.symbol)}</Mono><div className="mt-1 text-xs text-muted">{tokenAmount(balance.available, balance.symbol)} available</div></div>
              </div>)}</div> : <p className="text-sm text-muted">No assets in this wallet yet.</p>}
            </Card>

            <Card className="p-5 sm:p-6">
              <div className="mb-4 flex items-center gap-2"><Activity size={17} className="text-accent" /><h2 className="m-0 text-lg font-bold">Recent activity</h2></div>
              {data.transactions.length ? data.transactions.slice(0, 8).map((tx) => <div key={tx.id} className="flex items-center justify-between gap-3 border-t border-line py-3">
                <div><div className="text-sm font-semibold">{tx.type === "order" ? "Trade" : tx.type === "transfer" ? "Transfer" : "Funding"} {tx.asset_symbol ?? ""}</div><div className="mt-1 text-xs text-muted">{relativeTime(tx.created_at)}</div></div>
                <div className="text-right"><div className="text-sm">{tx.qty ? `${tx.asset_flow === "out" ? "−" : "+"}${tokenAmount(tx.qty, tx.asset_symbol ?? "")}` : tx.status}</div><div className="mt-1 text-xs text-muted">{tx.status}</div></div>
              </div>) : <p className="text-sm text-muted">No completed activity to show.</p>}
            </Card>
          </div>
          <p className="m-0 flex items-start gap-2 text-xs text-muted"><CircleAlert size={14} className="mt-0.5 shrink-0" />Balances refresh every 15 seconds. Wallet addresses and transfer destinations are not shown.</p>
        </>}
      </div>
    </main>
  );
}
