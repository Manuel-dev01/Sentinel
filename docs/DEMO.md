# Demo Runbook

The 2–5 minute demo video is the single most important deliverable for both the hackathon score and the hiring outcome. This runbook makes the demo deterministic, scripted, and failure-resistant.

---

## 1. Why determinism matters

The depeg trigger, the issuer "evidence," and the price basket are all controlled inputs in the demo. This is intentional: a live, repeatable trigger is worth more than a real feed for a recorded demo, and nothing should fail on camera. Realism is a post-hackathon concern.

## 1a. One-command setup (M6 scripts)

The whole environment is two scripts. From the repo root, with `.env` filled
(`DEPLOYER_PRIVATE_KEY`, `AGENT_PLATFORM_ADDRESS`, `MOCK_ISSUER_URL`, and ideally `ISSUER_PAGE_URL`):

```bash
# 0. Deploy frontend/ to Vercel FIRST so the agents have public URLs to read. The investigate
#    stages run a TWO-SOURCE investigation, so there are THREE distinct issuer URLs:
#    cd frontend && vercel --prod
#    → MOCK_ISSUER_URL    = https://<proj>.vercel.app/api/peg-status   (JSON — confirm agent)
#    → ISSUER_PAGE_URL    = https://<proj>.vercel.app/issuer/incident  (HTML — investigate #1, homepage)
#    → ISSUER_SOCIAL_URL  = https://<proj>.vercel.app/issuer/social    (HTML — investigate #2, status feed)
#      (ISSUER_SOCIAL_URL is optional; if unset, deploy.ts derives /issuer/social from ISSUER_PAGE_URL.)
#
#    ⚠ The confirm URL must be JSON; both investigate URLs must be rendered HTML pages (Parse-Website
#    is a web scraper — a JSON target returns Failed/empty). All three must be DIFFERENT URLs.
#    ⚠ PRE-WARM the two HTML pages in a browser right before recording: a cold Vercel page can make a
#    validator slow enough to miss the timeout. The investigate stages tolerate a 2-of-3 majority
#    (tiered consensus), but pre-warming makes a clean 3-responder run more likely.

# 1. Deploy + wire + seed everything (deploys 9 contracts incl. TWO insured stables USDC+USDT,
#    wires roles, registers both with confirm feeds + distinct issuer URLs, funds the Oracle with
#    34 STT, arms the subscription, seeds the LP pool, buys a demo policy per stable). Writes
#    deployments/somniaTestnet.json (incl. constructor args for verification).
pnpm deploy:testnet

# 2. Source-verify all contracts on Shannon Explorer (forge → Blockscout). Re-run if any fail with
#    "not a smart contract" — that's just the explorer's indexer lagging a few minutes behind the
#    deploy; wait until /api/v2/addresses/<addr> shows "is_contract": true, then re-run. Without
#    this, the explorer renders a real contract as an opaque/EOA-looking page.
pnpm verify:testnet

# 3. Resync the frontend's generated address/ABI layer to the new deploy.
node script/gen-frontend.mjs

# 4. Trigger the depeg and watch the autonomous pipeline settle (USDC, the primary stable).
pnpm simulate:depeg
```

**Pacing note:** the two-source pipeline runs four agent rounds (confirm → investigate → investigate-2 → classify) across sequential blocks and typically takes a few minutes end-to-end — the Parse-Website scrape stages dominate. The *payout* is instant once classified; the investigation is the deliberate, foundational part of the claim. Edit/trim the recording around the agent waits.

`deploy.ts` prints the `NEXT_PUBLIC_*` address block to paste into `frontend/.env.local`.
`simulate-depeg.ts` reads `deployments/somniaTestnet.json`, pushes USDC to `DEPEG_PRICE`
(default 0.92 = 800bps), and polls the on-chain state machine
`Confirming → Investigating → Classifying → Classified`, then settles the policy and writes
`docs/demo-run.md` with the tx hashes and elapsed time.

**Two demo tokens, on purpose:** the LP pool / premiums / payouts use **sUSD** (the capital
asset, which never depegs), while the **USDC** token is the insured stable that depegs. This keeps
the thing losing its peg separate from the thing backing claims — exactly as a real pool would.

**Funding note:** the Oracle owns its Reactivity subscription, so it must hold ≥32 STT *plus* the
agent-request budget at `arm()` time. `deploy.ts` parks 34 STT in it by default
(`ORACLE_FUNDING_STT`). The deployer therefore needs ~37+ STT for a clean run.

## 2. Pre-demo checklist

- [ ] Contracts deployed to Somnia testnet; addresses recorded in `README.md`.
- [ ] `SentinelOracle` funded with native token for several agent-request deposits (budget above scheduled cost — under-funding makes validators ignore requests).
- [ ] Reactivity subscription created, pointing the mock oracle's price-update event at `SentinelOracle._onEvent`.
- [ ] Stablecoin(s) registered; **confirm feed points at the JSON URL, `homepageUrl` at `/issuer/incident`, `socialUrl` at `/issuer/social`** (three different URLs — see §1a).
- [ ] All contracts **source-verified** on Shannon Explorer (`pnpm verify:testnet`, summary shows 0 failed) — a verified address shows Code/Read/Write tabs; an unverified one looks like an opaque/EOA page.
- [ ] LP pool seeded with capital; at least one active policy bought and past its min-age.
- [ ] Both issuer HTML pages deployed and reachable at `/issuer/incident` and `/issuer/social` (clear exploit disclosure); `curl` confirms HTTP 200 + `text/html`, and **pre-warm both in a browser** right before recording.
- [ ] Frontend running; peg dashboard and `/audit/[eventId]` both load.
- [ ] A dry run completed end-to-end within the last hour.
- [ ] Screen recording set up; on-screen timer ready.

## 3. Deterministic setup

- **MockPriceOracle** — operator-controlled price. The "Simulate Depeg" control pushes a price below the peg threshold, emitting the event Reactivity is subscribed to.
- **Mock issuer page** — a static page (e.g., on Vercel) whose copy plainly states the issuer was exploited, so the LLM-Parse-Website agent has unambiguous evidence and the LLM-Inference classification is stable across validators.
- **Price basket** — the JSON-API confirmation reads endpoints you control or that reliably return the depegged price, so the confirm stage corroborates deterministically.

## 4. The script — full shot list (slow-paced, music-backed; target ~3:30)

**Format.** Calm, cinematic, **background music throughout** (no rushed voice-over). Communicate with **on-screen captions** (short text overlays, lower-third or centered) — optional soft VO can read the same lines if you want a voice, but the captions carry the story so it works muted. Smooth cursor movement; let each panel breathe 2–3 s before clicking.

**Time compression (important).** The two-source pipeline takes a few real minutes (the Parse-Website scrapes dominate). **Record the whole run unbroken**, then in the edit **speed-ramp / cut the agent waits** so the final cut is ~3:30. The stepper advancing and the audit receipts are the payoff — keep those at real speed; compress only the dead waits. **Pre-warm `/issuer/incident` and `/issuer/social` in a browser tab right before recording** so the scrapers don't stall on a cold page.

**Pre-roll setup (before you hit record).** Connect the operator wallet. Be on the dashboard with the peg healthy. Make sure the pool is seeded and a policy is active (the deploy does this). Have the stable selector on **USDC**.

| Time | On screen / camera | 👆 Your click / action | Caption (text overlay) | Edit / music note |
|---|---|---|---|---|
| **0:00–0:12** | Black → fade up on the Sentinel wordmark over the dark peg-monitor panel. | — (no click) | **SENTINEL** — *insurance that pays out faster than the rumor cycle, and proves why.* | Music starts soft; slow fade-in. |
| **0:12–0:30** | The `/` dashboard, full. Cursor drifts across: live price **$1.0000**, *within tolerance*, pool capital, utilization, active policies, the **MONITORING** strip, the stepper resting at the start. | Hover (don't click) the price gauge, then the pool stats. | *One insured stablecoin, watched on-chain. No keeper. No committee.* | Hold; let it breathe. |
| **0:30–0:42** | Move to the operator controls. | 👆 **Click `Simulate Depeg`** (the violet button). Confirm in MetaMask. | *Trip the peg — live.* | Tiny zoom-push on the button as it's clicked. |
| **0:42–0:55** | Price gauge flips: **$0.9200**, **800 bps · BREACH** (amber). The stepper's **Detect** node lights; status strip → **IN FLIGHT**. | — (watch) | *Somnia Reactivity fires the on-chain handler — no off-chain keeper.* | Keep real-time; this is a beat. |
| **0:55–1:25** | Stepper advances **Confirm** (green). | — (watch) | *Agent 1 · JSON-API confirms the depeg across an independent price basket. One bad oracle is never enough.* | **Speed-ramp** the wait between nodes. |
| **1:25–1:55** | Stepper at **Investigate** (running, violet pulse). | — (watch) | *Agents 2 read two independent web sources — the issuer's incident page and its status feed.* | Cut/compress the wait; land on the node turning green. |
| **1:55–2:15** | Stepper **Classify** → then **Settled** (all green). Gauge area shows the verdict; payout tx confirms. | — (watch) | *Agent 3 classifies the cause: **SMART_CONTRACT_EXPLOIT**. The payout signs — 100%, immediate.* | Let "Settled" land cleanly; small music lift. |
| **2:15–2:22** | The **View investigation #N** button (violet, top-right of the monitor). | 👆 **Click `View investigation #N`** → routes to `/audit/[eventId]`. | *Now the proof.* | — |
| **2:22–2:45** | `/audit` header → the dark **VERDICT** panel: big **SMART CONTRACT EXPLOIT**, deviation, detected vs basket price, "Verdict recorded with the Treasury." | Slow-scroll down. | *Every step is on-chain. Anyone can verify it.* | — |
| **2:45–3:05** | The two **disclosure** blocks (source #1 homepage, source #2 social feed), then the **per-stage receipt cards**. Pause on each stamp. | 👆 Slow-scroll through the four stage cards. Hover the **stamps**. | *Tiered consensus: the price **Confirm** and the **verdict** carry **3/3** — unanimity signs the payout. The two web-evidence stages carry **2/3** — a byte-identical majority. Deliberate.* | This is the centerpiece — give it room. |
| **3:05–3:20** | Back to app. `/lp` — NAV, **APY**, utilization cap, the **WITHDRAWALS LOCKED** banner; then `/policies` — the Policy NFT + **Claim payout**. | 👆 **Click `LP`** in the header. Then 👆 **Click `Cover`/`Policies`**. | *LPs earn the premiums and take the tail risk. The pool never oversells coverage, and locks while an event settles. Exploit pays now; softer causes vest.* | Quick, confident. |
| **3:20–3:28** | The **stable selector** on the dashboard or coverage page. | 👆 **Click `USDT`** in the selector — show it's independently insurable. | *Two stablecoins, independently insured. The Registry scales to more.* | — |
| **3:28–3:40** | End card: Sentinel wordmark + **GitHub** + verified **Oracle** address + "Built on Somnia: Reactivity · Agents." | — | *Built solo, on Somnia. Reactivity for detection. Agents for a trustless investigation. The smart contract is the mechanism.* | Music resolves; fade to black. |

**Two beats you can add (both are real, on-chain):**
- **Autonomous monitor (≈0:18, on the dashboard).** Point at the **LIVE MONITOR · USDC·live** strip — a real CoinGecko USDC price observed on-chain, ticking up the poll count with nobody touching it. Caption: *"This is live and keeperless — a Reactivity cron + agent reads the real peg on-chain. A real depeg here fires the same pipeline."* This is what makes "Sentinel detects depegs" literal, not just simulated.
- **Any cause, live (before the trigger).** Use the operator **DEMO CAUSE** row to pick **Exploit / Bank run / Regulatory / Glitch** for the selected asset (it re-points the issuer pages via `registry.updateConfig`). Show that switching the asset (USDC→USDT→DAI→FRAX) and/or the cause changes the verdict and the payout class — exploit pays 100% now, regulatory 50% vested, etc. One clean way to show range: record an **exploit** run for the hero, then a quick **bank-run** run to show the *vested* timing difference on `/policies`.

**Caption-only cut (muted-friendly).** Because the story is carried by captions, the video reads with the sound off — judges often scrub muted. If you add VO, read the captions verbatim in a calm tone over the music bed (don't fight it).

## 5. Mapping the narration to judging criteria

Make sure these land (as caption or VO) so judges can tick each box:
- **Functionality** — *"deployed and verified on testnet; runs end-to-end, no manual steps; two stablecoins insurable."*
- **Agent-First Design** — *"three agents make the decision across two web sources — they decide whether and how much to pay, not just automate a transfer."*
- **Innovation & Technical Creativity** — *"the investigation itself is consensus-validated, with a tiered rule — that's new."*
- **Autonomous Performance** — *"detection to settlement with no human in the loop; it handles failed and split agent responses safely, and fails closed."*

## 6. Recording tips

- Record at a steady 1080p+; keep the dashboard and the stepper both in frame during the trigger and pipeline.
- **Pre-warm the two issuer pages** in a browser immediately before recording (a cold Vercel page can slow a validator past the timeout).
- Record the **full pipeline in one unbroken take**, then compress the agent waits in the edit — never fake the run; just tighten the dead air with speed-ramps.
- Do **two or three full runs** and cut from the cleanest; keep one as the live-failure fallback.
- Choose a calm, mid-tempo, loop-friendly instrumental bed; duck it slightly under any VO.
- Keep on-screen text short (≤ ~12 words) and on long enough to read twice.

## 7. Live-failure fallback

If a stage hangs or an agent is slow during a *live* (non-recorded) presentation:
- The state machine parks the event safely — narrate that as a feature: *"it refuses to pay without consensus."* The operator can `retry(eventId)` from exactly where it stalled.
- If the Parse-Website stage stalls on a cold page, it's the validator/timeout (the 2-of-3 tier tolerates one slow validator); re-warm the page and `retry`, or cut to the pre-recorded clean run.
- Have a pre-recorded clean hero run and a screenshot set of the audit trail ready to cut to.
- Never show real funds; everything is testnet and clearly labeled.
