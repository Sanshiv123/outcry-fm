import { useMemo } from "react";
import { Activity, Radio, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import { Page } from "../components/AppShell.tsx";
import { Banner, Card, Spinner } from "../components/ui.tsx";
import { useMarketStream, type MarketQuote } from "../hooks/useMarketStream.ts";

type MarketAsset = { id: string; symbol: string; name: string; chain: string | null; address: string | null };
type Point = { t: string; price: string };
type History = { series: { symbol: string; points: Point[]; error?: string; source: string }[] };

function LiveChart({ asset, points, quote }: { asset: MarketAsset; points: Point[]; quote?: MarketQuote }) {
  const plot = useMemo(() => {
    const values = points.map((point) => ({ t: point.t, price: Number(point.price) })).filter((point) => Number.isFinite(point.price) && point.price > 0);
    if (quote?.price && Number(quote.price) > 0) {
      const at = quote.as_of ?? quote.received_at ?? new Date().toISOString();
      if (!values.length || values.at(-1)?.t !== at) values.push({ t: at, price: Number(quote.price) });
    }
    const visible = values.slice(-180);
    if (!visible.length) return { line: "", min: 0, max: 1, low: null as number | null, high: null as number | null, last: null as number | null };
    const low = Math.min(...visible.map((point) => point.price));
    const high = Math.max(...visible.map((point) => point.price));
    let min = low;
    let max = high;
    if (min === max) { min *= 0.995; max *= 1.005; }
    const margin = (max - min) * 0.08;
    min = Math.max(0, min - margin);
    max += margin;
    const line = visible.map((point, index) => {
      const x = visible.length === 1 ? 300 : (index / (visible.length - 1)) * 600;
      const y = 164 - ((point.price - min) / (max - min)) * 148;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return { line, min, max, low, high, last: visible.at(-1)!.price };
  }, [points, quote?.price, quote?.as_of, quote?.received_at]);

  const change = quote?.change_24h === null || quote?.change_24h === undefined ? null : Number(quote.change_24h) * 100;
  const color = change === null || change >= 0 ? "#3ddc97" : "#ff6b6b";
  const price = quote?.price ?? points.at(-1)?.price;
  const source = quote?.source === "truemarkets_stream" ? "TRUE MARKETS LIVE" : quote?.source === "simulated_history" ? "SIMULATED" : "HISTORY FALLBACK";

  return (
    <Card className="flex min-w-0 flex-col gap-3 overflow-hidden p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="m-0 truncate text-sm font-bold">{asset.name}</p><p className="m-0 mt-0.5 text-xs text-muted">{asset.symbol} · {asset.chain ?? "Market"}</p></div>
        <span className={`shrink-0 rounded-full bg-ink px-2 py-1 text-[10px] font-bold tracking-wide ${quote?.source === "truemarkets_stream" ? "text-up" : "text-faint"}`}>{source}</span>
      </div>
      <div className="flex items-end justify-between gap-2"><strong className="font-mono text-xl tabular-nums">{price ? `$${Number(price).toLocaleString("en-US", { maximumFractionDigits: 6 })}` : "—"}</strong><span className={`text-xs tabular-nums ${change === null ? "text-muted" : change >= 0 ? "text-up" : "text-down"}`}>{change === null ? "24h —" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}% 24h`}</span></div>
      <svg viewBox="0 0 600 180" role="img" aria-label={`${asset.symbol} price chart over the last 24 hours`} className="h-36 w-full overflow-visible">
        {[16, 65, 114, 164].map((y) => <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="#43523a" strokeDasharray="3 6" strokeWidth="1" />)}
      {plot.line && <>
          <polyline points={plot.line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          {plot.last !== null && <circle cx="600" cy={164 - ((plot.last - plot.min) / (plot.max - plot.min)) * 148} r="4" fill={color} />}
        </>}
        {!plot.line && <text x="300" y="94" textAnchor="middle" fill="#819375" fontSize="13">Waiting for price data</text>}
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-faint"><span>24H LOW ${plot.low ? plot.low.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</span><span>HIGH ${plot.high ? plot.high.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</span></div>
    </Card>
  );
}

export function Charts() {
  const { status, quotes, browserConnected } = useMarketStream();
  const assetsQuery = useQuery({ queryKey: ["market-assets"], queryFn: () => api<{ assets: MarketAsset[] }>("/api/market/assets"), staleTime: 60_000 });
  const assets = useMemo(() => {
    const bySymbol = new Map<string, MarketAsset>();
    for (const asset of assetsQuery.data?.assets ?? []) if (!bySymbol.has(asset.symbol.toUpperCase())) bySymbol.set(asset.symbol.toUpperCase(), asset);
    return [...bySymbol.values()].slice(0, 36);
  }, [assetsQuery.data]);
  const symbols = assets.map((asset) => asset.symbol.toUpperCase()).join(",");
  const historyQuery = useQuery({
    queryKey: ["market-history", symbols],
    queryFn: () => api<History>(`/api/market/history?symbols=${encodeURIComponent(symbols)}`),
    enabled: !!symbols,
    staleTime: 60_000,
  });
  const series = useMemo(() => new Map((historyQuery.data?.series ?? []).map((item) => [item.symbol.toUpperCase(), item.points])), [historyQuery.data]);
  const displayStatus = !browserConnected
    ? { ...status, mode: "fallback" as const, source: "App stream reconnecting · charts use last available data" }
    : status;

  return (
    <Page title="Live charts" subtitle="A multi-asset market board with True Markets live prices and 24-hour history.">
      <Banner title={displayStatus.mode === "streaming" ? "True Markets stream connected" : displayStatus.mode === "simulated" ? "Simulated market data" : displayStatus.mode === "connecting" ? "Connecting to market stream" : "History fallback active"}>
        {displayStatus.source}. {assets.length} chart slots shown; market catalog is capped at 36 symbols in this view. Price updates are for information and can be delayed.
      </Banner>
      <div className="flex items-center justify-between gap-4"><div className="flex items-center gap-2 text-sm text-muted"><Activity size={16} /> {assets.length} assets</div>{historyQuery.isFetching ? <span className="flex items-center gap-2 text-xs text-muted"><RefreshCw size={13} className="animate-spin" /> Loading history</span> : <span className="flex items-center gap-2 text-xs text-muted"><Radio size={13} /> Refreshes live</span>}</div>
      {assetsQuery.error && <Banner tone="error">{assetsQuery.error.message}</Banner>}
      {historyQuery.error && <Banner tone="error">Historical chart data unavailable: {historyQuery.error.message}</Banner>}
      {(assetsQuery.isLoading || historyQuery.isLoading) && <Spinner />}
      {!assetsQuery.isLoading && assets.length === 0 && <Card className="p-6 text-sm text-muted">No market assets are available from the Gateway catalog.</Card>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
        {assets.map((asset) => <LiveChart key={asset.id} asset={asset} points={series.get(asset.symbol.toUpperCase()) ?? []} quote={quotes[asset.symbol.toUpperCase()]} />)}
      </div>
      <p className="m-0 text-xs leading-relaxed text-faint">Charts show the last 24 hours of price history with streamed updates appended while this page stays open. This feed does not place orders; check the quote again before trading.</p>
    </Page>
  );
}
