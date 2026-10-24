import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCatalog } from "../assets.ts";
import type { PriceBook, PriceQuote } from "../prices.ts";
import { TMError } from "../tm/errors.ts";
import type * as gatewayModule from "../tm/gateway.ts";
import { signerPublicKeyCompressedHex } from "../tm/stamp.ts";
import { assetItem, verifiesStamp } from "../testing.ts";
import type { CreateOrderResponse, OrganizationUser, TransactionDetail, TransferDetail } from "../tm/types.ts";

type Gateway = typeof gatewayModule;
type OrderDetail = Awaited<ReturnType<Gateway["getOrder"]>>;

const SOLANA_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const EVM_ADDRESS = "0x3fA9b1C47e0D2a8F5E6c9B04d71A2F8e5b3Cc21E";

const SOL = assetItem("SOL");
const PENGU = assetItem("PENGU");
const USDC = assetItem("USDC");
const AERO = assetItem("AERO", "base");
const BASE_USDC = assetItem("USDC", "base");
const ORDER = { asset_id: PENGU.id, side: "buy", amount: "1.20" };
const TRANSFER = { asset_id: SOL.id, qty: "0.01", to: SOLANA_ADDRESS };
const ALL = [SOL, PENGU, AERO, USDC, BASE_USDC];

const catalog: AssetCatalog = {
  byId: (id) => ALL.find((a) => a.id === id),
  symbolOf: (address) => ALL.find((a) => a.address === address)?.symbol ?? address,
  tradeable: () => [SOL, PENGU, AERO],
  isCash: (asset) => asset === USDC || asset === BASE_USDC,
  all: () => ALL,
};

const priceBook: PriceBook = {
  get: (symbol): PriceQuote =>
    symbol === "SOL"
      ? { price: "150.25", change_24h: "0.0310", as_of: "2026-09-24T10:00:00Z" }
      : { price: null, change_24h: null, as_of: null },
};

function organizationUser(externalRefId: string): OrganizationUser {
  return {
    user_id: `user-${externalRefId}`,
    external_ref_id: externalRefId,
    created_at: "2026-09-24T10:00:00Z",
    wallets: [
      { chain_family: "solana", address: SOLANA_ADDRESS },
      { chain_family: "evm", address: "0x3fA9b1C47e0D2a8F5E6c9B04d71A2F8e5b3Cc21E" },
    ],
  };
}

function preparedOrder(orderId: string): CreateOrderResponse {
  return {
    order_id: orderId,
    status: "initialized",
    payloads: [
      { digest: "d1", payload: `${orderId}-payload-1` },
      { digest: "d2", payload: `${orderId}-payload-2` },
    ],
    quote: {
      base_asset: PENGU.address!,
      quote_asset: USDC.address!,
      qty: "1.20",
      qty_out: "40.1",
      fee: "0.0024",
      fee_asset: USDC.address!,
    },
  };
}

function preparedTransfer(id: string): TransferDetail {
  return {
    id,
    status: "awaiting_signature",
    venue: "defi",
    asset_id: SOL.id,
    asset_symbol: "SOL",
    chain: "solana",
    network: null,
    to: SOLANA_ADDRESS,
    qty: "0.01",
    qty_unit: "base",
    sent: "0",
    fee: "0",
    received: "0",
    tx_hash: "",
    explorer_url: null,
    payloads: [{ digest: "d1", payload: `${id}-payload-1` }],
    created_at: "2026-09-24T10:00:00Z",
    updated_at: "2026-09-24T10:00:00Z",
  };
}

function fakeGateway() {
  return {
    createOrganizationUser: vi.fn<Gateway["createOrganizationUser"]>(async (ref) => organizationUser(ref)),
    listAssets: vi.fn<Gateway["listAssets"]>(),
    priceHistory: vi.fn<Gateway["priceHistory"]>(),
    portfolio: vi.fn<Gateway["portfolio"]>(),
    balances: vi.fn<Gateway["balances"]>(),
    createOrder: vi.fn<Gateway["createOrder"]>(async () => preparedOrder("order-1")),
    executeOrder: vi.fn<Gateway["executeOrder"]>(async () => ({ status: "pending" })),
    getOrder: vi.fn<Gateway["getOrder"]>(),
    createTransfer: vi.fn<Gateway["createTransfer"]>(async () => preparedTransfer("transfer-1")),
    executeTransfer: vi.fn<Gateway["executeTransfer"]>(async () => ({
      ...preparedTransfer("transfer-1"),
      status: "pending",
      payloads: [],
    })),
    getTransfer: vi.fn<Gateway["getTransfer"]>(),
    listTransactions: vi.fn<Gateway["listTransactions"]>(),
  } satisfies Gateway;
}

let createApp: typeof import("../app.ts").createApp;
let gateway: ReturnType<typeof fakeGateway>;
let app: Hono;
let emailCounter = 0;

beforeAll(async () => {
  vi.stubEnv("DATA_FILE", join(mkdtempSync(join(tmpdir(), "tensho-routes-")), "customers.json"));
  ({ createApp } = await import("../app.ts"));
});

function freshApp() {
  gateway = fakeGateway();
  app = createApp({ gateway, assets: catalog, prices: priceBook });
}

afterEach(() => {
  vi.useRealTimers();
});

function post(path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string) {
  return app.request(path, { headers: cookie ? { Cookie: cookie } : {} });
}

function sessionCookie(res: Response): string {
  const header = res.headers.get("Set-Cookie") ?? "";
  return header.split(";")[0]!;
}

async function signUp(): Promise<{ cookie: string; email: string }> {
  const email = `customer${++emailCounter}@example.com`;
  const res = await post("/api/signup", { email, password: "password123" });
  expect(res.status).toBe(201);
  return { cookie: sessionCookie(res), email };
}

describe("auth routes", () => {
  beforeEach(freshApp);

  it("signs up, seats a gateway user and sets the session cookie", async () => {
    const res = await post("/api/signup", { email: "Maya@Example.com", password: "password123" });

    expect(res.status).toBe(201);
    expect(res.headers.get("Set-Cookie")).toMatch(/^tensho_session=.+HttpOnly/);
    const body = (await res.json()) as { email: string; wallets: unknown[]; ready: boolean };
    expect(body).toMatchObject({ email: "maya@example.com", ready: true });
    expect(body.wallets).toHaveLength(2);
    const [ref, signerKey] = gateway.createOrganizationUser.mock.calls[0]!;
    expect(ref).toMatch(/^cust_/);
    expect(signerKey).toBe(signerPublicKeyCompressedHex);
  });

  it("keeps a customer whose wallet step failed and finishes it on the next login", async () => {
    gateway.createOrganizationUser.mockRejectedValueOnce(
      new TMError(503, { type: "unavailable", message: "wallet service unavailable" }),
    );

    const signup = await post("/api/signup", { email: "retry@example.com", password: "password123" });
    const notReady = await get("/api/portfolio", sessionCookie(signup));
    const login = await post("/api/login", { email: "retry@example.com", password: "password123" });

    expect(signup.status).toBe(201);
    expect(await signup.json()).toMatchObject({ ready: false, warning: "wallet service unavailable" });
    expect(notReady.status).toBe(409);
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ ready: true });
    const [first, second] = gateway.createOrganizationUser.mock.calls;
    expect(second).toEqual(first);
  });

  it("rejects a wrong password", async () => {
    const { email } = await signUp();

    const res = await post("/api/login", { email, password: "not-the-password" });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: "unauthenticated" });
  });

  it("rejects a session-only route without the cookie", async () => {
    const res = await get("/api/portfolio");

    expect(res.status).toBe(401);
    expect(gateway.portfolio).not.toHaveBeenCalled();
  });

  it.each([
    ["an unsigned cookie", () => "tensho_session=some-customer-id"],
    ["a tampered signature", (cookie: string) => cookie.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"))],
  ])("rejects %s", async (_, forge) => {
    const { cookie } = await signUp();

    const res = await get("/api/portfolio", forge(cookie));

    expect(res.status).toBe(401);
    expect(gateway.portfolio).not.toHaveBeenCalled();
  });

  it("answers an unknown API path with a JSON 404", async () => {
    const res = await get("/api/nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ type: "not_found" });
  });

  it("refuses a second account for the same email", async () => {
    const { email } = await signUp();

    const res = await post("/api/signup", { email: email.toUpperCase(), password: "password123" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ type: "already_exists" });
    expect(gateway.createOrganizationUser).toHaveBeenCalledTimes(1);
  });

  it("signs a seated customer in without creating the gateway user again", async () => {
    const { email } = await signUp();

    const res = await post("/api/login", { email, password: "password123" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email, ready: true });
    expect(res.headers.get("Set-Cookie")).toMatch(/^tensho_session=/);
    expect(gateway.createOrganizationUser).toHaveBeenCalledTimes(1);
  });

  it("clears the session cookie on logout", async () => {
    const { cookie } = await signUp();

    const res = await post("/api/logout", {}, cookie);

    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toMatch(/^tensho_session=;.*Max-Age=0/);
  });
});

describe("wallet routes", () => {
  let cookie: string;

  beforeEach(async () => {
    freshApp();
    ({ cookie } = await signUp());
  });

  it("relays the portfolio", async () => {
    const portfolio = { total_usd: "12.5", balances: [] } as unknown as Awaited<ReturnType<Gateway["portfolio"]>>;
    gateway.portfolio.mockResolvedValueOnce(portfolio);

    const res = await get("/api/portfolio", cookie);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(portfolio);
  });

  it("falls back to unpriced balances when the portfolio is unavailable", async () => {
    const balances = [{ symbol: "USDC", total: "3" }] as unknown as Awaited<ReturnType<Gateway["balances"]>>["data"];
    gateway.portfolio.mockRejectedValueOnce(new TMError(503, { type: "unavailable", message: "pricing down" }));
    gateway.balances.mockResolvedValueOnce({ data: balances });

    const res = await get("/api/portfolio", cookie);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ priced: false, balances });
  });

  it("relays a portfolio error other than 503 instead of falling back", async () => {
    const raw = '{"type":"internal","message":"internal server error","request_id":"req-2"}';
    gateway.portfolio.mockRejectedValueOnce(new TMError(500, JSON.parse(raw), raw));

    const res = await get("/api/portfolio", cookie);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe(raw);
    expect(gateway.balances).not.toHaveBeenCalled();
  });

  it("lists signed activity and leaves out transfers that were prepared but never signed", async () => {
    const row = (id: string, status: string) =>
      ({ id, type: "transfer", status: "pending", transfer: { ...preparedTransfer(id), status } }) as unknown as TransactionDetail;
    const order = { id: "o-1", type: "order", status: "completed" } as unknown as TransactionDetail;
    gateway.listTransactions.mockResolvedValueOnce({
      data: [row("t-unsigned", "awaiting_signature"), row("t-landing", "pending"), row("t-done", "completed"), order],
      pagination: { next_cursor: null, limit: 50 },
    });

    const res = await get("/api/transactions", cookie);

    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((tx) => tx.id)).toEqual(["t-landing", "t-done", "o-1"]);
  });

  it("lists the tradeable tokens and cash with polled prices", async () => {
    const res = await get("/api/assets", cookie);

    const rows = (await res.json()) as { symbol: string; price: string | null; change_24h: string | null; cash: boolean }[];
    expect(rows.map((r) => r.symbol)).toEqual(["SOL", "PENGU", "AERO", "USDC", "USDC"]);
    expect(rows[0]).toMatchObject({ price: "150.25", change_24h: "0.0310" });
    expect(rows[1]).toMatchObject({ price: null, change_24h: null });
    expect(rows.filter((r) => r.cash).map((r) => r.symbol)).toEqual(["USDC", "USDC"]);
  });
});

// OUTCRY replaces the original order/transfer behavior. See outcry/policy.test.ts
// for exact-ticket expiry, limits, balances, ownership and at-most-once execution.
