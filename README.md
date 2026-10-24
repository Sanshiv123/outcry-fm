# OUTCRY.FM

**Listen like a podcast. Trade with one tap. Call in if you want to be on air.**

Trading used to have a voice. OUTCRY brings the open-outcry floor back as a shared
AI radio station with explicitly confirmed trades. Built for Tech@NYU Shipyard.

## Run locally

Requires Node **22.22+** and npm. No provider credentials are needed for the demo.

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

For this workspace, `./run-local.sh` also starts the app using the temporary
Node runtime if no system Node is installed.

Open **http://localhost:4747**. Create an account with a first name, email, and
password. Default `MOCK_MODE=true` creates $50 of simulated USDC split between
Solana and Base. Mock wallet addresses are deliberately non-depositable.
For development, `npm run dev` runs Hono on 4747 and Vite on 5173.

If Node is not installed, the temporary runtime downloaded during setup is at
`/private/tmp/node-v22.16.0-darwin-arm64/bin`; install a current supported Node
release for ongoing development. The initial build was checked with that runtime.

## What is implemented

- Responsive radio station, host transcript, shared segment and activity feed.
- Tensho signup/login, real wallet provisioning adapter, balances, funding page,
  normal buy/sell screen, and external payments screen.
- One-dollar buy and crypto tip tickets, explicit review/confirmation, expiry,
  cancellation, owner checks, daily/order/station limits in backend code.
- Gateway IDs in The Wire; verified fills only on the public board.
- Persistent simulation, wallet balances and ticket ledger; no mock result is
  presented as a real trade. Mock and live stores are separated by default.
- Grok show scripts and optional intent parsing; two ElevenLabs voices, Scribe
  push-to-talk, optional live conversational-agent SDK, optional generated bell.
- Typed/tapped and browser-speech fallbacks when providers are unavailable.

**Verification status:** local simulation, type checking, production build and
HTTP signup → buy → confirmation → tip flow verified. ElevenLabs host intros and pit bell have now been generated; a private Gemini-powered
agent was created and its signed-session access verified. A microphone call has
not yet been rehearsed. True Markets authentication and real station receiving-wallet creation succeeded;
no real funding or trades were performed. Real trading remains unverified. Grok is disabled
with `ENABLE_GROK=false`; the station uses scripted market commentary.
The app does not claim real fills, track eligibility, a live deployment, or a
public repository yet. No commits or pushes have been made.

## Real integrations

1. Put the True Markets organization key JSON downloaded from its console in
   `.secrets/`, or point `TM_API_KEY_PATH` at it. This is a signed JSON-key flow,
   **not** a guessed bearer API-key integration.
2. Set `SIGNER_KEY_PATH` to an existing file holding the P-256 hex scalar if one
   is already used for your wallets. Otherwise Tensho generates
   `data/live/wallet-signer-key`. Back it up before funding any wallet.
3. Set `MOCK_MODE=false`. Sign up for a new live account; simulated accounts and
   balances are separate. Resolve `TM_TOKENS` against the actual Gateway catalog.
   Defaults are SOL on Solana and CBBTC on Base; tokenized stocks can be added
   only after their symbols/chains and availability are verified.
4. Fund the address shown by `/add-funds` with a small amount on its matching
   chain. No automated funding, Discord posting, or real-money test order is run.
5. ElevenLabs keys, two voice IDs and a private agent are configured locally. Grok
   is intentionally disabled; no xAI key is needed for this configuration. See
   [ElevenLabs setup](docs/ELEVENLABS.md) for the optional conversational agent.
6. The station receiving wallets are now created, and `STATION_WALLET_SOLANA` /
   `STATION_WALLET_EVM` are set in the local `.env`. Tip tickets
   spend holdings of the selected asset: buy at least $2 of SOL before the
   one-dollar SOL tip demo, because the buy fee reduces purchased holdings.

Secrets remain on the server and are excluded from git. `.env.example` documents
all settings. `DATABASE_URL` is reserved, not an implemented database connection;
this single-process hackathon app uses atomic JSON files in `data/`.

## Architecture and ownership

```text
React station + retained Tensho wallet screens
              ↓ signed customer session
Hono routes → immutable ticket + deterministic policy
              ↓ exact explicit confirmation
Persistent execution coordinator → Tensho Gateway + P-256 signer
              ↓ status lookup, never blind resubmission
Verified board → shared show coordinator → Grok → ElevenLabs
```

| Team area | Files |
| --- | --- |
| P1 Gateway/policy | `server/tm/`, `server/outcry/policy.ts`, `server/outcry/mock.ts` |
| P2 Call-in | `server/outcry/routes.ts`, `web/src/components/LiveCall.tsx` |
| P3 Show | `server/outcry/show.ts` |
| P4 UI/pitch | `web/src/pages/Station.tsx`, `station.css`, `docs/DEMO.md` |

[Full API contract](docs/INTERFACES.md) · [Tensho provenance](docs/UPSTREAM.md)

## Safety and limits

Every path, including retained trade/send screens, uses the same policy
coordinator. Default caps are $5/order, $20/customer/UTC day (pending + filled),
and $50/station lifetime budget. Caps can be lowered with env settings.
Unconfirmed tickets expire after 30 seconds and are never silently re-quoted.
Changing a draft cancels the old ticket. Missing/invalid/stale prices or balances
fail closed. Pending quantities are reserved. Unknown outcomes remain reserved
and query the original Gateway ID instead of resubmitting.

Run **one server process** with one persistent data directory. Atomic file writes
and an in-process queue protect this prototype, but it is not a distributed
execution service. Do not use multiple replicas. State may be reconciled by
reading a ticket after a restart. Do not delete ledger data to reset live caps.
Dollar valuations use bounded JavaScript numbers, so this is not audited
production accounting. External agent configuration, provider latency, asset
minimums/quote expiry and fees still need a live rehearsal with the Gateway team.

## Demo

See [demo script](docs/DEMO.md). Browser audio requires pressing Play. Microphone
access requires localhost or HTTPS. The show shares a segment, not sample-exact
continuous streaming. The price-card sparkline is explicitly illustrative.

Retained and policy checks can be run with `npm test`; `npm run typecheck` and
`npm run build` validate the app. Per the request, no further test cases are being
added. Provider calls are not made by the offline checks.

Hosts are AI. Not financial advice. Real trading carries risk. The AI can draft
but cannot sign or independently authorize a transaction.

## License

New OUTCRY code is MIT. The upstream repository had no license file at the pinned
revision; see `docs/UPSTREAM.md`. Clarify the retained Tensho code's license before
publishing the entire derivative as open source.
