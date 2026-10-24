import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowUpRight, Bell, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import { useAssets } from "../api.ts";
import { Page } from "../components/AppShell.tsx";
import { Banner, Button, Card, Spinner } from "../components/ui.tsx";
import type { AssetRow } from "../types.ts";
import { useMarketStream } from "../hooks/useMarketStream.ts";

type Rule = {
  id: string;
  asset_id: string;
  symbol: string;
  side: "buy" | "sell";
  amount: string;
  comparator: "below" | "above";
  threshold: string;
  enabled: boolean;
  created_at: string;
};

const STORAGE_KEY = "outcry.price-rules.v1";
const FIELD = "h-11 rounded-xl border border-edge bg-panel px-3 text-text outline-none focus:border-muted";

function readRules(): Rule[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value as Rule[] : [];
  } catch {
    return [];
  }
}

function parseRule(text: string, assets: AssetRow[]): Omit<Rule, "id" | "enabled" | "created_at"> | null {
  const match = text.trim().match(/^buy\s+\$?(\d+(?:\.\d{1,2})?)\s+(?:of\s+)?([a-z0-9]+)\s+(?:if\s+(?:the\s+)?price\s+)?(falls?\s+below|drops?\s+below|below|rises?\s+above|goes?\s+above|above)\s+\$?(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  const amount = match[1]!;
  const symbol = match[2]!.toUpperCase();
  const phrase = match[3]!.toLowerCase();
  const asset = assets.find((item) => item.symbol.toUpperCase() === symbol && !item.cash);
  if (!asset || Number(amount) <= 0 || Number(match[4]) <= 0) return null;
  return {
    asset_id: asset.asset_id,
    symbol: asset.symbol,
    side: "buy",
    amount,
    comparator: phrase.includes("below") ? "below" : "above",
    threshold: match[4]!,
  };
}

function currentPrice(rule: Rule, assets: AssetRow[], quotes: Record<string, { price: string | null; received_at: string | null }>): number | null {
  const streamQuote = quotes[rule.symbol.toUpperCase()];
  if (streamQuote?.price && streamQuote.received_at && Date.now() - Date.parse(streamQuote.received_at) <= 60_000) {
    const livePrice = Number(streamQuote.price);
    if (Number.isFinite(livePrice) && livePrice > 0) return livePrice;
  }
  const asset = assets.find((item) => item.asset_id === rule.asset_id);
  if (!asset?.price || !asset.as_of || Date.now() - Date.parse(asset.as_of) > 60_000) return null;
  const price = Number(asset.price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function met(rule: Rule, price: number | null): boolean {
  if (price === null) return false;
  return rule.comparator === "below" ? price <= Number(rule.threshold) : price >= Number(rule.threshold);
}

export function Rules() {
  const assetsQuery = useAssets();
  const assets = assetsQuery.data ?? [];
  const market = useMarketStream();
  const navigate = useNavigate();
  const [rules, setRules] = useState<Rule[]>(readRules);
  const [text, setText] = useState("buy $5 SOL below $150");
  const [error, setError] = useState("");

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  }, [rules]);

  const parsed = useMemo(() => parseRule(text, assets), [text, assets]);

  function addRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const draft = parseRule(text, assets);
    if (!draft) {
      setError("Use: buy $5 SOL below $150. Choose a positive amount and price, and an asset from the supported market list.");
      return;
    }
    if (Number(draft.amount) > 5) {
      setError("This prototype caps a rule at $5 per order, matching the current app policy.");
      return;
    }
    setRules((existing) => [{ ...draft, id: crypto.randomUUID(), enabled: true, created_at: new Date().toISOString() }, ...existing]);
  }

  function openTrade(rule: Rule) {
    navigate(`/trade?asset=${encodeURIComponent(rule.asset_id)}&side=${rule.side}&amount=${encodeURIComponent(rule.amount)}`);
  }

  return (
    <Page title="Price rules" subtitle="Describe a trigger, monitor the latest reported price, then review the trade yourself.">
      <Banner tone="warning" title={`Monitoring only · ${market.status.mode === "streaming" ? "True Markets stream" : market.status.mode === "simulated" ? "simulated price feed" : "history fallback"}`}>
        {market.status.source}. A matching rule is a prompt to review the market; it does not submit a trade.
      </Banner>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)]">
        <Card className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="m-0 text-lg font-bold">Create a rule</h2>
            <p className="mb-0 mt-1 text-sm text-muted">Example: <span className="font-mono text-text">buy $5 SOL below $150</span></p>
          </div>
          <form onSubmit={addRule} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm text-muted" htmlFor="rule-text">Condition</label>
            <input id="rule-text" className={FIELD} value={text} onChange={(event) => setText(event.target.value)} placeholder="buy $5 BTC above $70000" />
            {error && <p role="alert" className="m-0 text-sm text-down">{error}</p>}
            {parsed && (
              <div className="rounded-xl border border-edge bg-ink p-4 text-sm">
                <div className="mb-2 flex items-center gap-2 font-bold text-up"><Bell size={15} /> Parsed rule</div>
                <p className="m-0">When {parsed.symbol} is {parsed.comparator} ${parsed.threshold}, prepare a ${parsed.amount} {parsed.side} for review.</p>
              </div>
            )}
            <Button type="submit" disabled={!parsed || assetsQuery.isLoading} className="h-11">Save price rule</Button>
          </form>
          <p className="m-0 text-xs leading-relaxed text-faint">Supported format: buy, a dollar amount, a supported asset symbol, and a “below” or “above” price. Rules are saved in this browser only.</p>
        </Card>

        <Card className="flex flex-col gap-3 p-6">
          <h2 className="m-0 text-lg font-bold">Generated rule snippet</h2>
          {parsed ? <pre className="m-0 overflow-x-auto rounded-xl border border-edge bg-ink p-4 text-xs leading-relaxed text-muted">{JSON.stringify({
            asset_id: parsed.asset_id,
            side: parsed.side,
            amount_usd: Number(parsed.amount),
            trigger: { price: parsed.comparator, value_usd: Number(parsed.threshold) },
            action: "notify_and_open_trade_for_manual_review",
          }, null, 2)}</pre> : <p className="m-0 text-sm text-muted">Enter a supported condition to see its structured form.</p>}
          <p className="m-0 text-xs leading-relaxed text-faint">This is a preview for the app, not executable code or an authorization to trade.</p>
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-4">
          <div><h2 className="m-0 text-lg font-bold">Your rules</h2><p className="mb-0 mt-1 text-sm text-muted">{rules.length} saved in this browser</p></div>
          {assetsQuery.isFetching && <span className="text-xs text-muted">Refreshing market data…</span>}
        </div>
        {assetsQuery.error && <Banner tone="error">{assetsQuery.error.message}</Banner>}
        {assetsQuery.isLoading && <Spinner />}
        {!assetsQuery.isLoading && rules.length === 0 && <Card className="p-6 text-sm text-muted">No rules yet. Create one above to monitor a price condition.</Card>}
        {rules.map((rule) => {
          const price = currentPrice(rule, assets, market.quotes);
          const triggered = rule.enabled && met(rule, price);
          return (
            <Card key={rule.id} className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${triggered ? "bg-up/15 text-up" : rule.enabled ? "bg-line text-muted" : "bg-ink text-faint"}`}>
                    {triggered ? "CONDITION MET" : rule.enabled ? "MONITORING" : "PAUSED"}
                  </span>
                  <b className="text-sm">{rule.side.toUpperCase()} ${rule.amount} {rule.symbol}</b>
                </div>
                <p className="mb-0 mt-2 text-sm text-muted">When price is {rule.comparator} ${rule.threshold}. Current: {price === null ? "unavailable or stale" : `$${price.toLocaleString("en-US", { maximumFractionDigits: 6 })}`}.</p>
                {triggered && <p className="mb-0 mt-1 text-xs text-up">Review the current quote before placing an order.</p>}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button type="button" className="h-10 rounded-xl border border-edge px-3 text-sm text-muted hover:text-text" onClick={() => setRules((all) => all.map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled } : item))}>{rule.enabled ? "Pause" : "Resume"}</button>
                <button type="button" aria-label="Delete rule" className="flex size-10 items-center justify-center rounded-xl border border-edge text-muted hover:text-down" onClick={() => setRules((all) => all.filter((item) => item.id !== rule.id))}><Trash2 size={16} /></button>
                {triggered && <Button type="button" className="h-10" onClick={() => openTrade(rule)}>Review trade <ArrowUpRight size={15} /></Button>}
              </div>
            </Card>
          );
        })}
      </section>
    </Page>
  );
}
