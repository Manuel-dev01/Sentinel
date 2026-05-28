# Demo Runbook

The 2–5 minute demo video is the single most important deliverable for both the hackathon score and the hiring outcome. This runbook makes the demo deterministic, scripted, and failure-resistant.

---

## 1. Why determinism matters

The depeg trigger, the issuer "evidence," and the price basket are all controlled inputs in the demo. This is intentional: a live, repeatable trigger is worth more than a real feed for a recorded demo, and nothing should fail on camera. Realism is a post-hackathon concern.

## 2. Pre-demo checklist

- [ ] Contracts deployed to Somnia testnet; addresses recorded in `README.md`.
- [ ] `SentinelOracle` funded with native token for several agent-request deposits (budget above scheduled cost — under-funding makes validators ignore requests).
- [ ] Reactivity subscription created, pointing the mock oracle's price-update event at `SentinelOracle._onEvent`.
- [ ] One stablecoin registered; demo issuer URLs point at the mock page.
- [ ] LP pool seeded with capital; at least one active policy bought and past its min-age.
- [ ] Mock issuer page deployed and reachable (content reads as a clear exploit disclosure).
- [ ] Frontend running; peg dashboard and `/audit/[requestId]` both load.
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
> "Reactivity fires — no keeper. A JSON-API agent confirms the depeg across a price basket, so one bad oracle can't trigger a payout. A second agent reads the issuer's page. A third classifies the cause — and three independent validators have to agree."

Show the classification land as `SMART_CONTRACT_EXPLOIT` and the payout transaction confirm. **Stop the timer.** Call out the elapsed time.

**0:50–2:10 — The proof (audit trail).**
Open `/audit/[requestId]`.
> "This is the part no other chain can do. Here's every agent call. Here's each validator's individual response. They agreed — and that agreement is what released the funds. No human touched this, and anyone can verify it."

Walk the three receipts: basket prices, parsed evidence, the per-validator votes on the cause.

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
- **Innovation** — "the investigation itself is consensus-validated — that's new."
- **Autonomous Performance** — "detection to settlement with no human in the loop, and it handles failed or split agent responses safely."

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
