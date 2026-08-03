# AlphaControl — Claude Code Project Bible

## What This Is
AlphaControl is a live crypto capital management dashboard built by Strix Labs.
- Live at: **alphacontrol.ai** (password: Underwood10)
- Legacy domain **bjbots.ai** 301-redirects to alphacontrol.ai
- Founders: Jp (product/vision) + Sam (engineering/deployment)
- Purpose: Intelligence layer between 3Commas (execution) and CoinStats (tracking)
- Pitch: Hub71/ADGM Abu Dhabi — 30-day live trial results are the centrepiece

---

## Architecture — Three Files, Three Services

### 1. `worker.js` → Cloudflare Workers
- Deployed via GitHub Actions (~30s deploy) from `samuelnewballunderwood-sketch/bjbots-dashboard` (repo name kept; Worker name stays `bjbots-dashboard` in Cloudflare — alphacontrol.ai is a Custom Domain pointing at it)
- Serves the dashboard at alphacontrol.ai (bjbots.ai 301-redirects)
- Contains the decision engine (Quantum Rules, portfolio analysis, action alerts)
- Built by `build.js` which bundles `worker.js` + `dashboard.html` together
- Deploy: push to GitHub → Actions triggers → live in 30s

### 2. `server.js` → Hetzner VPS `tbs-pricing` (Frankfurt), via Cloudflare Tunnel
- Public URL `https://tc.alphacontrol.ai`, tunnel `alphacontrol-tc`
- Runs under pm2 as `alphacontrol-tc-proxy`, user `jp`, at `/home/jp/alphacontrol/tc-proxy`
- **Deploy: edit ON THE SERVER, then `pm2 restart alphacontrol-tc-proxy`.** Pushing to
  GitHub records the change, it does NOT deploy. This is the opposite of the Worker above.
- NOT on Render. `render.yaml` in tc-proxy is vestigial and read by nothing.
- Node.js HTTP server, no framework
- Handles ALL external API calls (Binance, 3Commas, OpenAI, market data)
- Hannah AI chat endpoint (`/api/chat-dual`) — Claude Sonnet + GPT-4o-mini validator
- The Binance API key IP allowlist must contain THIS box's IP. Check with `/my-ip` on the proxy.
- Free tier: spins down after inactivity — allow 15-30s warmup
- Deploy: push to `samuelnewballunderwood-sketch/tc-proxy` repo, `main` branch

### 3. `dashboard.html` → served by worker.js
- Single HTML file, ~6800 lines
- All CSS, JS, HTML in one file
- Contains Hannah avatar/voice logic, orbital UI, all tabs

---

## Critical Infrastructure Rules

### Binance
- `AlphaControl-Reader` key: read-only, no IP restriction (used in Worker for prices)
- `AlphaControl` key: read + trade, **IP-restricted to `74.220.51.20`** (Frankfurt Render)
- Cloudflare Workers use IPv6 — Binance blocks IPv6 — ALL Binance calls MUST go through Frankfurt proxy
- If Render restarts and gets a new IP, Binance calls will fail with "Invalid API-key, IP, or permissions"
- Fix: check `/my-ip` on proxy, update Binance API key whitelist

### 3Commas API — CRITICAL QUIRKS
- URL prefix MUST be `/public/api/` (e.g. `/public/api/ver1/bots`)
- Header MUST be `Apikey` (capital K, not `apikey` or `API-KEY`)
- Two accounts: `33438577` (Binance Spot — DCA + spot grids) and `33439515` (Binance Futures)
- ALWAYS fetch both accounts for bots, grid_bots, and deals
- DCA bots: `/ver1/bots` endpoint
- Grid bots: `/ver1/grid_bots` endpoint (separate endpoint — common mistake)
- `Bot::MultiBot` type on Spot account (33438577) = spot DCA, NOT futures

### Frankfurt Proxy Endpoints
```
GET  /health              — proxy status
GET  /my-ip               — current outbound IPv4
GET  /spot-wallet         — Binance spot wallet
GET  /futures-wallet      — Binance futures wallet
GET  /bots                — all 3Commas bots (both accounts, deduped)
GET  /prices              — live BTC/ETH/SOL/XRP/BNB prices
GET  /market-signals      — F&G, BTC dominance, funding rate, regime
GET  /decisions           — redirects to Worker /api/decisions
GET  /deals/detail        — completed deals with timestamps, Trial 1 vs Trial 2 split
GET  /debug-tc            — raw 3Commas accounts + bots
POST /api/chat-dual       — Hannah AI chat (Claude Sonnet + GPT-4o-mini)
```

---

## Capital Model — CRITICAL

**grandTotal = Binance spot wallet total + Binance futures wallet balance**

3Commas capital IS Binance capital — they share the same wallet. NEVER add them together.

The reconciliation is:
- `spotFree` + `spotLocked` + `spotEarn` + `futuresTotal` = `grandTotal`
- `spotLocked` = capital held in 3Commas grid bot orders (BTC/ETH/SOL/XRP tokens + USDT)
- `spotFree` = undeployed USDT in spot wallet

### Grid Capital — Known Issue
3Commas `investment_quote_currency` only returns the USDT currently in buy orders — this FLUCTUATES as grids trade. The true investment is fixed at creation. We use hardcoded known amounts:

```js
const KNOWN_GRID_CAPITAL = {
  2759654: 299,   // BTC #2 spot grid
  2761209: 300,   // XRP spot grid
  2761214: 500,   // SOL spot grid
  2761423: 991,   // ETH spot grid
  2761412: 1000,  // BTC spot grid
  // 2761473 BTC futures quarterly — use API value
};
```

**When Sam creates new grids, add their ID + investment amount to this map.**

### Locked Profit — Trial-Scoped
3Commas `completed_deals_usd_profit` is ALL-TIME (includes Trial 1). We filter completed deals by `closed_at >= 2026-04-12T00:00:00Z` (Trial 2 start). This is done in `server.js` when building `dealProfitByBot`.

Known Trial 1 profit that must NOT be counted:
- ETH DCA: $47.68 (last deal 2026-04-11T16:40:57Z — before Trial 2)
- BNB DCA: $1.51 (last deal 2026-04-11T19:00:32Z — before Trial 2)

### Ghost Bots — FIXED
Old Binance native bots (ETH/BTC/BNB/SOL/XRP grids) were migrated to 3Commas months ago. They no longer exist. In `worker.js`: `bnBotBreakdown = []`, `bnRealised = 0`, `bnCapital = 0`.

---

## Active Bots — Current State (as of Day 6, April 17 2026)

### 3Commas Grid Bots (active)
| ID | Name | Investment | Range |
|---|---|---|---|
| 2761473 | BTC Futures Quarterly | ~varies | Futures |
| 2761423 | ETH/USDT | $991 | Spot |
| 2761412 | BTC/USDT | $1,000 | Spot |
| 2761214 | SOL/USDT | $500 | Spot |
| 2761209 | XRP/USDT | $300 | Spot |
| 2759654 | BTC/USDT #2 | $299 | Spot |

### 3Commas DCA Bots
| ID | Name | Status |
|---|---|---|
| 16808289 | XRP/USDT DCA Long | Stopped (R2) |
| 16808275 | BNB/USDT DCA Long | Stopped (R2) |
| 16807404 | BTC/USDT DCA Long | Has open deal |
| 16806296 | ETH/USDT DCA Long | Stopped (R2) |
| 16806276 | SOL/USDT DCA Long | Stopped (R2) |

### Inactive/Legacy Grids (Trial 2 profit still counts)
| ID | Name | Note |
|---|---|---|
| 2759318 | BTC/USDT | Old $1K grid, replaced by 2761412 |
| 2759323 | ETH/USDT | Old $991 grid, replaced by 2761423 |

### Old Trial 1 Futures Grids (EXCLUDE from profit)
| ID | Name |
|---|---|
| 2758668 | ETHUSDT_260925 |
| 2758366 | BTCUSDT_260925 |

---

## The Trial

- **Start:** April 12 2026 (Day 1) — April 11 was setup day
- **End:** May 10 2026 (Day 30)
- **Starting capital:** ~$9,177 USDT
- **Target:** 6% = ~$551 locked profit | 10% stretch = ~$918
- **Required:** ~$19/day for 6% | ~$30.70/day for 10%
- **Trial Day formula:** `Math.floor((Date.now() - new Date('2026-04-12').getTime()) / 86400000) + 1`

---

## Quantum Rules (Decision Engine in worker.js)

| Rule | Description |
|---|---|
| R1 | Grid price must be in middle 60% of range at launch |
| R2 | F&G < 30 = no new DCA longs. R2 ACTIVE = stop all DCA bots |
| R3 | Zero trades in 48h on any bot = stop and reallocate |
| R4 | Below 0.05%/day locked profit for 48h = flag for review |
| R5 | Locked profit is the ONLY scoreboard. Floating PnL = irrelevant |
| R6 | 7+ days since last scale = increase best bot base order by 20% |
| R7 | BTC 4h change > +3% = trigger BTC Breakout Bot |
| R8 | Binance spot USDT < $150 = pause lowest priority bot |

### Target Allocations by Regime
- **R2 Active (F&G < 30):** No new DCA longs. Light hedge 15%. Grids OK.
- **Bear (F&G 30-49):** Long 30%, hedge 25%, grids 40%
- **Sideways (F&G 50-69):** Long 65%, hedge 15%, grids 45%
- **Bull (F&G ≥ 70):** Long 70%, hedge 10%, grids 45%

---

## Hannah — AI Layer

### Stack
- **Text:** Frankfurt proxy `/api/chat-dual` → Claude Sonnet (primary) + GPT-4o-mini (validator)
- **Voice:** ElevenLabs PCM16 audio, model `eleven_turbo_v2_5`, voice streamed directly from browser
- **Avatar:** Simli WebRTC (raw WebSocket, NOT the SDK — SDK has a race condition)
- **Simli flow:** POST `/compose/token` → GET `/compose/ice` → RTCPeerConnection → WebSocket to `wss://api.simli.ai/compose/webrtc/p2p` → send 6000-byte silence to activate

### Key Variables in dashboard.html
```js
const HANNAH_PROXY = 'https://tc.alphacontrol.ai';
const _EL_KEY      = '...';  // ElevenLabs key
const _SIMLI_KEY   = '...';  // Simli key
const _SIMLI_FACE  = '...';  // Simli face ID
```

### Persona Rules
- Casual questions (how are you) → human response, NO portfolio data
- Trading questions → lead with the key number, direct and concise
- 2-4 sentences max
- Never start with bold text or $ unless asked about money

### Audio Fix
Browser autoplay blocks audio started outside user gesture. Fix: call `window._simliAudio.play()` inside every send button click handler.

### Interrupt Support
`_interruptHannah()` cancels ElevenLabs stream reader (`_speakReader.cancel()`), sends silence to Simli, resets `_hannahBusy = false`. Called at start of every send action.

---

## Dashboard UI Structure

- **Login:** Password `Underwood10` (stored as `sessionStorage.alphacontrol_auth`)
- **Tabs:** Dashboard | Action Centre | Bots & Trades | Portfolio | Market
- **Hannah orbital layout:** 3-column, portrait centred, 3 spinning rings, 6 metric cards
- **Fonts:** Orbitron (headings), Rajdhani (body), JetBrains Mono (numbers)
- **Key element IDs:** `header-total`, `dm-locked`, `dm-trial-day`, `d2-chat-msgs`, `d2-input`

### Storage Keys
- `sessionStorage`: `alphacontrol_auth` (login state)
- `localStorage`: `alphacontrol_meta` (bot metadata cache)
- Legacy `bjbots_auth` / `bjbots_meta` keys no longer read — clean cutover at the alphacontrol.ai migration.

---

## Deployment

### Dashboard (worker.js + dashboard.html)
```
Repo: samuelnewballunderwood-sketch/bjbots-dashboard
Branch: main
CI: GitHub Actions (~30s)
Build: build.js bundles worker.js + dashboard.html
```

### Proxy (server.js)
```
Repo: samuelnewballunderwood-sketch/tc-proxy
Branch: main
Service: tc-proxy-eu (Frankfurt) on Render
```

**NEVER do a full rebuild.** All changes must be surgical on existing files. The v16 incident (full dashboard.html rebuild) destroyed all functionality — Jp had to revert via GitHub commit history.

---

## Known Remaining Issues (as of April 20 2026)

1. **Grid capital for new grids** — when Sam creates new grids, add `botId: investmentAmount` to `KNOWN_GRID_CAPITAL` in server.js. Otherwise capital shows as fluctuating USDT-side only.

2. **Hannah key rotation** — Simli + ElevenLabs keys now served from proxy `/api/config` (not page source) but server.js still ships fallback values. Set `SIMLI_API_KEY`, `SIMLI_FACE_ID`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` in Render env, rotate at simli.ai / elevenlabs.io, then delete fallbacks from server.js.

3. **Multi-user architecture** — not built yet. Currently single-user (Jp's keys hardcoded). Estimated 2-3 week build for auth system, per-user API vault, onboarding wizard.

4. **IBKR integration** — planned. Client Portal API via Render bridge, advisory mode, forex/stocks/ETFs starting with EUR/USD or GBP/USD grid bots.

---

## Common Debugging Patterns

### Dashboard showing all dashes (—)
→ The proxy does not cold-start — pm2 keeps it running. Check `pm2 list` on tbs-pricing,
  then `curl https://tc.alphacontrol.ai/api/total-capital`. If the API returns data but
  tiles stay empty, suspect a silently swallowed fetch — see below.

### Something looks broken but nothing errors
→ Grep server.js for `.catch(()=>null)` and `.catch(()=>({}))`. A failed fetch wrapped in
  one of those becomes a silent wrong answer rather than an error. In Aug 2026 ten calls to
  the decommissioned Render host had been failing this way for weeks; the only visible
  symptom was an unrelated-looking 500 from `/api/create-smart-trade`.

### Binance wallet returning 500
→ IP allowlist mismatch. Hit `/my-ip` on the proxy and add that IP to the Binance API key allowlist. Unlike Render, this box's IP is stable.

### 3Commas returning 403/empty
→ Check header is `Apikey` (capital K). Check URL prefix is `/public/api/`. Check account IDs are both being queried.

### Locked profit inflated (~$200 instead of ~$100)
→ Trial 1 profits bleeding in. Check `TRIAL2_START` filter in server.js is `2026-04-12T00:00:00Z`.

### Ghost Binance native bots appearing
→ Check worker.js: `bnBotBreakdown` should be `[]`, `bnRealised` should be `0`.

### Hannah not responding in dashboard chat
→ Check `HANNAH_PROXY = 'https://tc.alphacontrol.ai'` in dashboard.html. Note `/api/chat-dual` is POST-only; a GET returns 404 and that is not a fault.

### Hannah lips moving but no audio
→ Browser autoplay blocked. Ensure `window._simliAudio.play()` is called inside a user gesture (send button click).

---

## Audit Checklist — Run Before Every Deploy

Before saying anything is ready, verify ALL of these against 3Commas:

```
[ ] grandTotal matches Binance wallet total (spot + futures)
[ ] totalRealised = Trial 2 deals only (closed_at >= 2026-04-12)
[ ] bnBots array is empty (no ghost Binance native bots)
[ ] Active bot count matches 3Commas
[ ] Trial day correct (April 12 = Day 1)
[ ] F&G reading correctly
[ ] R2 status correct (ACTIVE if F&G < 30, lifted if >= 30)
[ ] Grid capitals show known investment amounts (not fluctuating USDT-side)
[ ] Grid profit counts ALL Trial 2 grids (active + old inactive ones)
[ ] Grid profit excludes Trial 1 quarterly futures (IDs 2758668, 2758366)
[ ] DCA profit is trial-scoped (use /deals/detail to verify)
[ ] Action Centre targets are sensible (not 0% long or 40% hedge)
[ ] DCA max-SO alerts firing for stopped bots with open deals
[ ] Hannah chat responding
[ ] Hannah persona correct (no P&L dump on casual questions)
[ ] Screenshot of every tab with own eyes before saying ready
```
