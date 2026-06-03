# Sentinel — Human Verification & Demo Test Plan

A feature-by-feature checklist a human can run by hand to verify every part of Sentinel works, understand what each piece *means*, and spot gaps. For each test: **Purpose** (what it is) · **Expected** (what it should do) · **Steps** (how to test) · **Gap signal** (what "wrong" looks like).

> **Live deployment (chain 50312):** Oracle `0xe6d838c0…a91c` · Registry `0x4190c7Ae…1a89` · Pool `0x847Bab38…2296` · Policy `0x142c36b7…643e` · Treasury `0x056AA409…2FeF` · detection sub `3711687`. Insured: **USDC** `0x0195df87…8EEF` · **USDT** `0x573e0382…44a7` · **DAI** `0x93C4284A…3435` · **FRAX** `0x150A14f4…BF33`. Autonomous monitor: **PriceFeedPoller** `0xA7831e47…48cE` → **USDC·live** `0xb12BAA2B…c32F`. Mock issuer: https://sentinel-issuer.vercel.app
>
> **Two facts to internalize before testing:**
> 1. **Tiered consensus.** Confirm (price) and Classify (verdict) require **3/3** unanimity; the two Parse-Website investigate stages require a **2/3** majority. A stage stamp of `2/3 CONSENSUS` on an investigate stage is **correct**, not a failure.
> 2. **Timing.** The full two-source pipeline takes **a few minutes** (the Parse-Website scrapes dominate). The payout is instant once the verdict signs; the investigation is the slow, deliberate part.

---

## T0 · Preconditions (do these first)

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 0.1 | Wallet on the right network | MetaMask connects to Somnia testnet (chain 50312, STT) | Add Somnia testnet to MetaMask (RPC `https://api.infra.testnet.somnia.network/`, chain 50312). Open the dApp, click **Connect**, pick MetaMask. | Modal lists no wallets → wagmi/RainbowKit mismatch. Wrong-network banner → add/switch network. |
| 0.2 | Operator account | You're connected as the deployer/operator `0xBCA6…66Fe` | Confirm the connected address. Only the operator should see Simulate working (it writes to the price oracle the operator controls). | A non-operator can still move the price → access-control gap. |
| 0.3 | Pages are live | `/issuer/incident`, `/issuer/social` (HTML), `/api/peg-status` (JSON) all return 200 | Open each URL in a browser tab (this also **pre-warms** them for the demo). | Any 404 → the agent can't read it → investigate will fail. |
| 0.4 | Oracle funded + armed | Oracle holds ≥32 STT and owns subscription `3711687` | On Shannon Explorer, open the Oracle address → balance ≥32 STT. | Balance <32 → detection won't fire (subscription dropped). |

---

## T1 · On-chain credibility (the explorer)

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 1.1 | Contracts are real + **verified** | All 9 addresses show the green **Verified** tab with Code / Read / Write | Open each address on shannon-explorer. Check the "Contract" tab shows source + a "Read/Write Contract" sub-tab. | An address renders as a bare account with no Code tab → unverified (re-run `pnpm verify:testnet`; wait for `is_contract:true`). |
| 1.2 | Oracle answers as a contract | `nextEventId()` returns a number; `MAJORITY()` = 2; `SUBCOMMITTEE_SIZE()` = 3 | Explorer → Oracle → Read Contract → call those. | `MAJORITY` missing → an old (pre-tiered) Oracle is deployed. |

---

## T2 · Dashboard (`/`) — the monitor

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 2.1 | Live peg read | Price ≈ `$1.0000`, deviation `0 bps`, "within tolerance", tolerance `±0.50%` | Load `/`. Read the gauge. | Price `—` forever → RPC/read failure or wrong addresses in `generated.ts`. |
| 2.2 | Pool stats | Pool capital, available, utilization %, active-policy count all populate | Read the stats console row. | All zeros with a seeded pool → wrong Pool address or read failure. |
| 2.3 | Stable selector | Two tabs **USDC / USDT**; clicking switches the monitored stable; selection persists across pages | Click **USDT** → price/threshold/labels update to USDT. Navigate to `/policies` and back — USDT stays selected. | Only one stable, or selection resets on navigation. |
| 2.4 | **Stepper — monitoring** | With the peg healthy, the stepper sits at the **start** (all idle) and the strip reads `MONITORING · NO BREACH` | Just observe at rest. | Stepper stuck showing a past event's "Settled" while at peg → the reset-to-monitoring fix isn't applied. |
| 2.5 | Simulate Depeg (operator) | Price drops to `$0.9200`, `800 bps · BREACH` (amber); strip → `IN FLIGHT`; stepper begins | Click **Simulate Depeg**, confirm in MetaMask. | Nothing happens after the tx confirms → price oracle wiring or Reactivity subscription issue. |
| 2.6 | **Reset peg** | Price returns to `$1.0000`; once not breached + no live event, the stepper **resets to the beginning** and strip reads `MONITORING` | After a run settles, click **Reset peg**. | Stepper still shows "Settled DONE" after reset → the fix regressed (this is the bug you flagged). |
| 2.7 | View investigation link | A `View investigation #N` button appears whenever an event exists and routes to `/audit/N` | Click it during/after a run. | No link, or 404 route. |

---

## T3 · The autonomous pipeline (the core differentiator)

Run **Simulate Depeg** on USDC and watch it advance. It resolves across sequential blocks; give it a few minutes.

| # | Stage | Purpose / what it means | Expected | Gap signal |
|---|---|---|---|---|
| 3.1 | **Detect** | Somnia Reactivity invokes the handler on a price event — **no off-chain keeper** | Stepper "Detect" lights within seconds of the price tx | Never advances → subscription not armed / Oracle underfunded. |
| 3.2 | **Confirm** (JSON-API, **3/3**) | An agent re-reads the price across a basket; one bad oracle can't pay out | Advances to "Confirm" then "Investigate"; basket price ≈ `$0.92` | Parks in Failed at confirm → JSON feed unreachable or <3/3. |
| 3.3 | **Investigate — issuer disclosure** (Parse-Website, **2/3**) | Scrapes the issuer's formal incident page | Disclosure #1 captured ("Security Incident — Reserve Vault Exploited") | Fails → `/issuer/incident` was cold/404, or <2 validators. |
| 3.4 | **Investigate — status feed** (Parse-Website, **2/3**) | Scrapes a *second, independent* source | Disclosure #2 captured (the social/status text) | Fails → `/issuer/social` cold/404 (pre-warm it). |
| 3.5 | **Classify** (LLM-Inference, **3/3**) | Verdict on the cause, constrained to one token | Cause = `SMART_CONTRACT_EXPLOIT`; event → Classified | Parks Failed → <3/3 on the verdict (rare; the classifier is deterministic). |
| 3.6 | **Settle** | Payout matrix applies; exploit → 100% immediate | Stepper reaches "Settled"; verdict recorded with Treasury | Classified but never settles → settle wiring. |
| 3.7 | **Dismissed path** (negative) | If the basket *disagrees*, no payout | (Hard to trigger live — the JSON feed mirrors the on-chain price. Covered by `test_*` unit tests.) | n/a live — verify via forge test. |
| 3.8 | **Failed + retry** (resilience) | A stalled stage parks as `Failed`; operator can resume | If a stage fails (e.g. a cold issuer page), the dashboard shows the failure; operator calls `oracle.retry(eventId)` (Explorer → Write, or a script) → it resumes from that stage | Failure bricks future detection (slot never freed) → the `_fail` regression. |

> **Tiered-consensus verification (the headline claim).** During/after a run, confirm on the audit page that **Confirm and Classify carry 3/3** stamps and **both Investigate stages carry 2/3** (or 3/3 if all three happened to respond — both are valid for a 2/3 rule). That visible difference *is* the design.

---

## T4 · Audit trail (`/audit/[eventId]`) — the centerpiece

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 4.1 | Verdict summary | Big classification (e.g. `SMART CONTRACT EXPLOIT`), deviation, detected vs basket price, state badge | Open `/audit/N`. | Shows `UNKNOWN` after a *successful* run → the event Failed before classify (check which stage). |
| 4.2 | **Two disclosures render** | Source #1 (homepage) **and** Source #2 (status feed) both shown as quoted evidence | Scroll to the disclosure blocks. | Only one disclosure → the second investigate stage didn't complete (single-source fallback or it failed). |
| 4.3 | Per-stage receipt cards | One card per agent request, in order: Confirm → Investigate → Investigate(status feed) → Classify | Scroll the stage cards. | Missing a stage card → that stage never recorded receipts. |
| 4.4 | **Per-stage stamps** | Confirm = `3/3 CONSENSUS`; Investigate ×2 = `2/3` or `3/3 CONSENSUS`; Classify = `3/3 CONSENSUS` | Read each stamp + the subtitle "`N/3 validators agreed · X/3 … required`". | A red `NO QUORUM`/`FAILED` on a stage that should have passed. |
| 4.5 | Per-validator votes | Each card shows each validator's address, status, decoded result, and cost | Inspect the validator cards. | Identical-looking placeholder data, or results that don't decode. |
| 4.6 | Reads on-chain (no backend) | The page is a single `getReceipts(eventId)` read; works on refresh and for old events | Hard-refresh the page; open an older event id. | Data disappears on refresh / only the latest event works → it's reading logs, not storage. |

---

## T5 · Coverage / Policies (`/policies`)

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 5.1 | Quote | Premium updates live from notional × annual-rate × term | Enter notional `100000`, term `365`. Read premium (USDC ≈ 500 sUSD @ 0.50%, USDT ≈ 650 @ 0.65%). | Premium `—` or doesn't change with inputs. |
| 5.2 | Faucet (test funds) | Mints sUSD to your wallet | Wallet balance `0` → click **Faucet · mint 10K sUSD** → balance shows 10,000. | Button does nothing / balance unchanged. |
| 5.3 | Approve | One-time allowance for the Policy contract to pull premium | If button reads **Approve sUSD**, click it. | Stuck on Approve after confirming. |
| 5.4 | **Buy coverage** | Mints a Policy NFT, transfers the premium | Click **Buy coverage** → confirm → a new policy appears in "Your policies". | "Nothing happens" → usually **0 sUSD balance** (faucet first) or the buy reverts (insufficient pool capacity / utilization cap). |
| 5.5 | Policy list + status | Each policy shows its stable, notional, premium, term, status badge | Read your policies. | Policy bought but not listed → token scan/ownerOf read issue. |
| 5.6 | **Claim (immediate, exploit)** | After a classified exploit event for that stable, a **Claim payout** button pays 100% now | Run a depeg to Classified, then on `/policies` click **Claim payout** on the matching policy → wallet balance rises by the payout. | No claim button on a matching classified event, or claim reverts. |
| 5.7 | **Vested claim (non-exploit)** | Softer causes schedule a vested release, not an instant payout (anti-farming) | (Needs a non-exploit verdict — see T8.3.) Expect a "releasable at <time>" row, then **Claim vested** after that time. | Exploit and bank-run behave identically → matrix not applied. |
| 5.7 | Per-policy stable label | Each card labels its own stable (USDC vs USDT) | Buy on USDC and on USDT; confirm labels differ. | Both show the same symbol. |

---

## T6 · Liquidity (`/lp`)

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 6.1 | Pool metrics | NAV/share, TVL, **APY** estimate, utilization % vs cap | Load `/lp`. | APY always 0 with active coverage → APY calc gap. |
| 6.2 | Faucet + Approve + Deposit | Deposit mints LP shares at NAV | Faucet 1M sUSD → Approve → enter `50000` → **Deposit** → shares appear, TVL rises. | Deposit reverts or shares don't mint. |
| 6.3 | Withdraw | Burns shares, returns sUSD; **Max** fills your full position | Enter an amount (or **Max**) → **Withdraw**. | Withdraw lets you pull capital that's reserved for a settling event. |
| 6.4 | **Withdrawal lock (any stable)** | While *any* insured stable has a live, non-terminal event, withdrawals are **locked** | Click **Simulate Depeg** on the dashboard, then quickly open `/lp` mid-pipeline → the **WITHDRAWALS LOCKED** banner shows and Withdraw is disabled. After the event settles + peg reset, the lock clears. | Lock never appears, or only locks for one stable but not the other. |
| 6.5 | Solvency / utilization cap | The pool refuses coverage it can't back | Try to buy coverage with a notional far exceeding `pool capital × 80%` → the buy should revert / be blocked. | Coverage sells past the cap. |

---

## T7 · Multi-stable (4 assets)

| # | Purpose | Expected | Gap signal |
|---|---|---|---|
| 7.1 | Independent insurability | A depeg + payout works on each of USDC / USDT / DAI / FRAX | Select each, Simulate, watch it classify + claim. | An asset can't be triggered or has no policy. |
| 7.2 | Shared pool, separate events | All stables draw from the **same** LP pool but have **separate** events/live-slots | Trigger USDC, confirm USDT shows no live event but the LP lock still engages (shared capital). | One asset's event blocks another's detection, or the pool double-counts. |

---

## T10 · Operator scenario switch (demo any cause)

> **Prerequisite:** the issuer pages must be served **dynamically** so `?incident=<cause>` is honored. They were `force-static` (which ignored the param → every cause classified as exploit); now `force-dynamic`. After deploying the issuer site, `curl …/issuer/incident?incident=bank-run` must return a *bank-run* title, not "Reserve Vault Exploited". If every cause still classifies as exploit, the issuer site wasn't redeployed.

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 10.1 | DEMO CAUSE control | A row of cause buttons (Exploit / Bank run / Regulatory / Glitch) appears under the operator controls; the current one is highlighted | Connect the operator wallet; look below Simulate/Reset. | No row, or it shows for non-operators. |
| 10.2 | Re-points the issuer pages | Clicking a cause sends a `registry.updateConfig` tx that sets the selected stable's issuer URLs to `?incident=<cause>` | Click **Bank run** on USDC → confirm the tx → the highlight moves. | Tx reverts (must be operator) or highlight doesn't update. |
| 10.3 | Verdict follows the cause | The next Simulate classifies as the chosen cause with its payout class | Pick **Regulatory** → Simulate → `/audit` shows `REGULATORY`, 50% vested. Repeat for each cause. | Verdict stays the previous cause (issuer page cache — re-warm `/issuer/incident?incident=<cause>`). |
| 10.4 | Per-asset defaults | Out of the box: USDC=exploit, USDT=bank-run, DAI=regulatory, FRAX=glitch | Switch assets without touching the cause row; each shows its default. | All assets default to the same cause. |

## T11 · Autonomous live monitor (the "Sentinel detects depegs" thesis)

The `PriceFeedPoller` runs a keeperless Reactivity cron that fetches the **real** USDC price on-chain every ~120 s and writes it to the **USDC·live** asset — no operator action, no off-chain keeper.

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 11.1 | LIVE MONITOR widget | The dark monitor panel shows `LIVE MONITOR · USDC·live`, a real price near $1.00, "observed Ns ago", a rising poll count, a green pulse | Load `/`; watch for ~2–3 min. | Price stuck at `—` / "awaiting first poll" forever, or poll count never rises. |
| 11.2 | It's the *real* price | The value is the live CoinGecko USDC price (e.g. `$0.9996`), not exactly $1.0000 | Compare to coingecko.com USDC. | Always exactly `$1.0000` → it's not reading real data. |
| 11.3 | Keeperless + self-rescheduling | Poll count keeps climbing with nobody clicking; the cron re-arms itself each tick | Verify on-chain: `poller.pollCount()` rises; `poller.cronSubscriptionId()` changes between ticks. | Count frozen → cron stopped (poller out of funds <32 STT → top it up + `arm()`). |
| 11.4 | Simulate still works (re-pointed) | Simulate/Reset on the 4 demo stables still trigger (now routed through `poller.operatorSetPrice`) | Simulate on USDC as usual. | Simulate reverts → the deployed frontend predates the poller re-point; redeploy it. |
| 11.5 | **USDC·live is buyable** | USDC·live appears in the coverage selector; anyone can buy real coverage on it; its dashboard shows "Autonomously monitored" (no Simulate/DEMO CAUSE) | Select **USDC·live** on `/` → operator controls are hidden. On `/policies` → buy coverage on it like any stable. | Operator controls show for USDC·live, or it's missing from the selector. |
| 11.6 | Monitor longevity | Runs until the spendable balance above 32 STT is exhausted (~9.8 STT buffer ≈ ~100 polls at 300 s). Re-fuel + re-arm before a demo | If `armed=false` / poll count frozen: `pnpm hardhat run script/tune-monitor.ts --network somniaTestnet` (tops up + re-arms). | — |
| 11.7 | Real evidence | USDC·live's investigation reads Circle's real status (`status.circle.com`) + USDC page, not the mock issuer | Check `registry.getConfig(USDC·live)` homepageUrl = status.circle.com. | Still points at `sentinel-issuer…/issuer/…`. |

---

## T8 · Known design choices that may *look* like gaps (so you don't mis-flag them)

| # | What you'll see | Why it's intentional | If you want it different |
|---|---|---|---|
| 8.1 | Investigate shows `3/3 agreed · 2/3 required` | The rule is a 2/3 majority; this run simply got all 3. Truthful and good. | Ask me to reword to `consensus 3/3 · rule 2/3` or drop the count. |
| 8.2 | The pipeline takes a few minutes | Two Parse-Website scrapes across a subcommittee; that's the real platform latency. | The demo video compresses the waits in the edit. |
| 8.3 | ~~Every live run classifies as SMART_CONTRACT_EXPLOIT~~ **RESOLVED** | The dashboard now has an operator **DEMO CAUSE** switch (T10) that re-points the issuer pages per-asset, so any cause is demoable live. Defaults: USDC=exploit, USDT=bank-run, DAI=regulatory, FRAX=glitch. | — |
| 8.4 | You can buy a policy and claim immediately | Demo `minAge = 0` and `minDuration = 0` so the flow is instant on stage. Production would set both > 0 (the anti-farming gate is in the contract + tested). | Ask me to set non-zero demo values. |
| 8.5 | Both stables confirm against the same price feed | One mock JSON feed backs both for the demo; only one stable depegs at a time. | Fine for the demo; per-stable feeds are a config change. |
| 8.6 | `next dev` may crash on a low-memory host | V8 heap; use `pnpm build && pnpm start` (the `dev` script now bumps the heap). | — |

---

## T9 · One clean end-to-end demo pass (the script to actually run)

1. **Pre-warm** `/issuer/incident` and `/issuer/social` in browser tabs.
2. `/` → confirm **MONITORING**, peg healthy, USDC selected.
3. **Simulate Depeg** → watch **Detect → Confirm (3/3) → Investigate ×2 (2/3) → Classify (3/3) → Settled**.
4. **View investigation** → `/audit`: verdict `SMART_CONTRACT_EXPLOIT`, **both disclosures**, the **tiered stamps**.
5. `/policies` → **Claim payout** on the USDC policy → balance rises 100%.
6. `/lp` → show NAV/APY/utilization; (optionally trigger again to show the **withdrawal lock**).
7. Switch selector to **USDT** → repeat 3–5 to prove independent insurability.
8. **Reset peg** → confirm the stepper returns to **MONITORING**.

If any step deviates from "Expected," note the test ID (e.g. "T4.2 only shows one disclosure") and send it over — that maps directly to a fix.
