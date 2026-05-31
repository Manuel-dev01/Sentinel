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

## 4. The script (target ~3 minutes)

**0:00–0:20 — The hook.**
> "On-chain insurance is too slow where it matters. Sentinel pays out faster than the rumor cycle — and proves *why* it paid. It's parametric depeg insurance where an AI investigation, validated by the chain's own consensus, decides the claim. It only works on Somnia."

Show the peg dashboard: stablecoin at peg, pool funded, a policy active.

**0:20–0:50 — The hero moment.**
Press **Simulate Depeg**. Start the on-screen timer. Narrate as the dashboard updates live:
> "Reactivity fires — no keeper. A JSON-API agent confirms the depeg across a price basket, so one bad oracle can't trigger a payout. Then a two-source investigation: an agent reads the issuer's formal disclosure and a second reads its status feed. A third agent classifies the cause — and the verdict that signs the payout requires all three validators to agree."

Show the classification land as `SMART_CONTRACT_EXPLOIT` and the payout transaction confirm. **Stop the timer.** Call out the elapsed time. (The investigation runs a few minutes — trim the agent waits in the edit; the payout itself is instant once the verdict signs.)

**0:50–2:10 — The proof (audit trail).**
Open `/audit/[eventId]`.
> "This is the part no other chain can do. Here's every agent call — confirm, two investigation sources, and the verdict. Here's each validator's individual response. And notice the consensus is *tiered*: the price confirm and the final verdict — the stages that actually release funds — carry a 3-of-3 stamp; the web-evidence stages carry a 2-of-3 majority. That's deliberate — the verdict signs only on unanimity, while the corroborating evidence needs a majority that still agrees byte-for-byte. No human touched this, and anyone can verify it on-chain."

Walk the receipts: basket prices (3/3), the two parsed disclosures (2/3 each), the per-validator votes on the cause (3/3).

**2:10–3:00 — The economics + interop.**
> "LPs earn the premiums and take the tail risk. The protocol never sells more coverage than the pool can back. And the classification changes the payout — an exploit pays immediately; a bank run vests over 24 hours so you can't farm it."

Show LP view (NAV, exposure, utilization cap) and the vesting difference. Show a **LI.FI** cross-chain deposit if implemented.

**3:00–end — The close.**
> "Built solo in three weeks on Somnia. Reactivity for detection, Agents for a trustless investigation, sub-second finality for same-block payout. Repo and deployed contracts are in the description."

Show repo + addresses.

## 5. Mapping the narration to judging criteria

Say these words at least once so judges can check the boxes:
- **Functionality** — "deployed, runs end-to-end, no manual steps."
- **Agent-First Design** — "three agents make the decision, not just automate a transfer."
- **Innovation** — "the investigation itself is consensus-validated, across two independent web sources — that's new."
- **Autonomous Performance** — "detection to settlement with no human in the loop, and it handles failed or split agent responses safely — with *tiered* consensus: 3-of-3 unanimity to sign the payout, 2-of-3 majority on the evidence stages, matched to the agents' real behaviour on-chain."

## 6. Recording tips

- Record at a steady resolution; keep the timer and the dashboard both visible during the hero moment.
- Pre-write the narration; read it. Don't improvise the technical claims.
- Keep it under 5 minutes; aim for 3. Cut dead air during transaction confirmation by tightening, not by hiding it.
- One take of the hero moment minimum; record a few and pick the cleanest.

## 7. Live-failure fallback

If a stage hangs or an agent response is slow during a *live* (non-recorded) presentation:
- The state machine parks the event safely — narrate that as a feature ("it refuses to pay without consensus").
- Have a pre-recorded clean run of the hero moment ready to cut to.
- Keep a screenshot set of the audit trail as a static fallback.
- Never show real funds; everything is testnet and clearly labeled.
