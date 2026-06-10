# Verification and demo test plan

A feature-by-feature checklist for verifying Sentinel by hand. Each test states its **Purpose**, the **Expected** behavior, the **Steps** to run it, and the **Gap signal** that indicates a problem.

> **Live deployment (chain 50312):** Oracle `0xe6d838c0…a91c`, Registry `0x4190c7Ae…1a89`, Pool `0x847Bab38…2296`, Policy `0x142c36b7…643e`, Treasury `0x056AA409…2FeF`, detection subscription `5981499`. Demo stables: USDC `0x0195df87…8EEF`, USDT `0x573e0382…44a7`, DAI `0x93C4284A…3435`, FRAX `0x150A14f4…BF33`. Multi-asset monitor: PriceFeedPoller `0xA12a1285…66B5`, polling USDC·live, USDT·live, DAI·live, FRAX·live. SimGateway `0x46CF6A9F…6457` (makes Simulate permissionless for the demo stables). Mock issuer site: https://sentinel-issuer.vercel.app

> **Two facts to internalize before testing.** First, consensus is tiered. Confirm (price) and Classify (verdict) require 3-of-3 unanimity, and the two Parse-Website investigate stages require a 2-of-3 majority, so a `2/3 CONSENSUS` stamp on an investigate stage is correct, not a failure. Second, timing. The full two-source pipeline takes a few minutes, since the Parse-Website scrapes dominate. The payout is instant once the verdict signs, and the investigation is the slow, deliberate part.

---

## T0. Preconditions

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 0.1 | Wallet on the right network | MetaMask connects to Somnia testnet (chain 50312, STT) | Add Somnia testnet (RPC `https://api.infra.testnet.somnia.network/`, chain 50312). Open the dApp, click Connect, pick MetaMask. | The modal lists no wallets, indicating a wagmi or RainbowKit mismatch, or a wrong-network banner appears. |
| 0.2 | Anyone can simulate; operator only configures | Simulate works from any connected wallet via SimGateway; only DEMO CAUSE and registering a stable need the operator `0xBCA6…66Fe` | Connect a non-operator wallet and Simulate a demo stable, which should succeed. Connect the operator to use DEMO CAUSE. | Simulate reverts for a non-operator (SimGateway not wired or the frontend not redeployed), or a non-operator can change a stable's config (a registry access-control gap). |
| 0.3 | Issuer pages live and dynamic | `/issuer/incident`, `/issuer/social`, and `/api/peg-status` all return 200, and `?incident=bank-run` returns a bank-run title | Open each URL, and pre-warm the two HTML pages. Run `curl …/issuer/incident?incident=bank-run`. | Any 404 means the agent cannot read it. If every scenario returns the exploit title, the issuer site was not redeployed with the dynamic pages. |
| 0.4 | Oracle funded and armed | The Oracle holds at least 32 STT and owns subscription `5981499` | On Shannon Explorer, open the Oracle address and check the balance. | A balance under 32 STT means detection may stop firing. |

## T1. On-chain credibility (the explorer)

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 1.1 | Contracts are real and verified | Every deployed address shows the green Verified tab with Code, Read, and Write | Open each address on Shannon Explorer and check the Contract tab. | An address renders as a bare account with no Code tab, meaning it is unverified. Re-run `pnpm verify:testnet` once the indexer flags it. |
| 1.2 | Oracle answers as a contract | `nextEventId()` returns a number, `MAJORITY()` is 2, `SUBCOMMITTEE_SIZE()` is 3 | On the explorer, open the Oracle, Read Contract, and call those views. | A missing `MAJORITY` means an old, pre-tiered Oracle is deployed. |

## T2. Dashboard (`/`)

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 2.1 | Live peg read | Price near `$1.0000`, deviation `0 bps`, within tolerance | Load `/` and read the gauge. | The price stays at a dash, indicating an RPC or read failure, or wrong addresses in `generated.ts`. |
| 2.2 | Pool stats | Pool capital, available, utilization, and active-policy count all populate | Read the stats console. | All zeros with a seeded pool means a wrong Pool address or a read failure. |
| 2.3 | Grouped selector | A `DEMO` group (USDC, USDT, DAI, FRAX) and a `LIVE` group (the four live assets, with green dots) appear; clicking switches the asset; selection persists across pages | Click a tab in each group, then navigate to `/policies` and back. | Selection resets on navigation, or the groups are missing. |
| 2.4 | Stepper at rest | With the peg healthy and nothing in flight, the stepper sits at the start and the strip reads `MONITORING · NO BREACH` | Observe at rest. | The stepper stays on a past event's Settled state while at peg, meaning the reset-to-monitoring fix regressed. |
| 2.5 | Simulate depeg (demo stable, any wallet) | Price drops to `$0.9200`, `800 bps · BREACH`, the strip reads `IN FLIGHT`, and the stepper begins | Select a DEMO stable, click Simulate Depeg from any connected wallet (it routes through `SimGateway.simulate`), confirm in MetaMask. | Nothing happens after the tx confirms, indicating a price-oracle wiring or subscription issue; or the tx reverts `NotSimulatable`, meaning the stable is not allow-listed. |
| 2.6 | Reset peg | Price returns to `$1.0000`, and once not breached the stepper resets to the start with the strip reading `MONITORING` | After a run settles, click Reset peg. | The stepper still shows Settled after reset. |
| 2.7 | View investigation link | A View investigation button appears whenever an event exists and routes to `/audit/N` | Click it during or after a run. | No link, or a broken route. |

## T3. The autonomous pipeline (the core differentiator)

Run Simulate Depeg on a DEMO stable and watch it advance. It resolves across sequential blocks, so allow a few minutes.

| # | Stage | What it means | Expected | Gap signal |
|---|---|---|---|---|
| 3.1 | Detect | Somnia Reactivity invokes the handler on a price event, with no off-chain keeper | The Detect node lights within seconds of the price tx | Never advances, meaning the subscription is not armed or the Oracle is underfunded. |
| 3.2 | Confirm (JSON-API, 3/3) | An agent re-reads the price across a basket, so one bad oracle cannot pay out | Advances to Confirm then Investigate, with a basket price near `$0.92` | Parks in Failed at confirm, meaning the JSON feed is unreachable or under 3/3. |
| 3.3 | Investigate, issuer disclosure (Parse-Website, 2/3) | Scrapes the issuer's formal incident page | Disclosure 1 captured | Fails, meaning `/issuer/incident` was cold or 404, or under 2 validators. |
| 3.4 | Investigate, status feed (Parse-Website, 2/3) | Scrapes a second, independent source | Disclosure 2 captured | Fails, meaning `/issuer/social` was cold or 404, so pre-warm it. |
| 3.5 | Classify (LLM-Inference, 3/3) | Verdict on the cause, constrained to one token | The cause matches the selected scenario and the event reaches Classified | Parks in Failed, meaning under 3/3 on the verdict, which is rare. |
| 3.6 | Settle | The payout matrix applies, and an exploit pays 100% immediately | The stepper reaches Settled and the verdict is recorded with the Treasury | Classified but never settles, indicating a settle wiring issue. |
| 3.7 | Dismissed path (negative) | If the basket disagrees, there is no payout | Covered by unit tests, since the live JSON feed mirrors the on-chain price | Verify through `forge test`. |
| 3.8 | Failed and retry (resilience) | A stalled stage parks as Failed, and the operator can resume | If a stage fails, the operator calls `oracle.retry(eventId)` and it resumes from that stage | A failure bricks future detection because the live slot was never freed. |

> **Tiered-consensus verification (the headline claim).** On the audit page after a run, confirm that Confirm and Classify carry 3/3 stamps and that both investigate stages carry 2/3 (or 3/3 if all three validators happened to respond, which is also valid for a 2/3 rule). That visible difference is the design.

## T4. Audit trail (`/audit/[eventId]`), the centerpiece

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 4.1 | Verdict summary | A large classification, deviation, detected versus basket price, and a state badge | Open `/audit/N`. | Shows `UNKNOWN` after a successful run, meaning the event failed before classify. |
| 4.2 | Two disclosures render | Source 1 (homepage) and source 2 (status feed) both shown as quoted evidence | Scroll to the disclosure blocks. | Only one disclosure, meaning the second investigate stage did not complete. |
| 4.3 | Per-stage receipt cards | One card per agent request, in order: Confirm, Investigate, Investigate (status feed), Classify | Scroll the stage cards. | A missing stage card, meaning that stage never recorded receipts. |
| 4.4 | Per-stage stamps | Confirm is `3/3 CONSENSUS`, the two investigate stages are `2/3` or `3/3`, and Classify is `3/3` | Read each stamp and its subtitle. | A red `NO QUORUM` or `FAILED` on a stage that should have passed. |
| 4.5 | Per-validator votes | Each card shows the validator address, status, decoded result, and cost | Inspect the validator cards. | Identical-looking placeholder data, or results that do not decode. |
| 4.6 | Reads on-chain, no backend | The page is a single `getReceipts(eventId)` read, and it works on refresh and for old events | Hard-refresh, and open an older event id. | Data disappears on refresh, or only the latest event works, meaning it reads logs rather than storage. |

## T5. Coverage and policies (`/policies`)

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 5.1 | Quote | Premium updates live from notional, annual rate, and term | Enter a notional and term and read the premium. | The premium stays at a dash or does not change with inputs. |
| 5.2 | Faucet | Mints sUSD to your wallet | With a zero balance, click Faucet and confirm the balance rises. | The button does nothing. |
| 5.3 | Approve | A one-time allowance for the Policy contract to pull premium | If the button reads Approve sUSD, click it. | Stuck on Approve after confirming. |
| 5.4 | Buy coverage | Mints a Policy NFT and transfers the premium | Click Buy coverage, confirm, and see a new policy appear. | Nothing happens, usually because of a zero sUSD balance (faucet first), or the buy reverts on the utilization cap. |
| 5.5 | Policy list and status | Each policy shows its stable, notional, premium, term, and status badge | Read your policies. | A bought policy is not listed, indicating a token-scan or ownerOf read issue. |
| 5.6 | Claim, immediate exploit | After a classified exploit event for that stable, a Claim payout button pays 100% now | Run a depeg to Classified, then click Claim payout on the matching policy and confirm the balance rises. | No claim button on a matching classified event, or the claim reverts. |
| 5.7 | Vested claim, non-exploit | Softer causes schedule a vested release, not an instant payout | Use the DEMO CAUSE switch to pick a non-exploit cause, run it, and expect a releasable-at row, then Claim vested after that time. | An exploit and a bank run behave identically, meaning the matrix is not applied. |
| 5.8 | Per-policy label | Each card labels its own stable | Buy on two different assets and confirm the labels differ. | Both show the same symbol. |

## T6. Liquidity (`/lp`)

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 6.1 | Pool metrics | NAV per share, TVL, an APY estimate, and utilization versus cap | Load `/lp`. | The APY stays at zero with active coverage. |
| 6.2 | Faucet, approve, deposit | A deposit mints LP shares at NAV | Faucet, approve, enter an amount, and Deposit, then confirm shares appear and TVL rises. | The deposit reverts, or shares do not mint. |
| 6.3 | Withdraw | Burns shares and returns sUSD, and Max fills your full position | Enter an amount or click Max, then Withdraw. | Withdraw lets you pull capital reserved for a settling event. |
| 6.4 | Withdrawal lock (any asset) | While any insured asset has a live event, withdrawals are locked | Simulate a depeg on the dashboard, then open `/lp` mid-pipeline and confirm the WITHDRAWALS LOCKED banner shows. | The lock never appears, or it locks for one asset but not another. |
| 6.5 | Solvency and utilization cap | The pool refuses coverage it cannot back | Try to buy coverage with a notional far exceeding the pool's capacity, and confirm the buy is blocked. | Coverage sells past the cap. |

## T7. Multiple assets

| # | Purpose | Expected | Gap signal |
|---|---|---|---|
| 7.1 | Independent insurability | A depeg and payout works on each demo stable | An asset cannot be triggered, or has no policy. |
| 7.2 | Shared pool, separate events | All assets draw from the same LP pool but have separate events and live slots | One asset's event blocks another's detection, or the pool double-counts. |

## T8. Operator scenario switch (demo any cause)

The issuer pages must be served dynamically so the `?incident=<cause>` parameter is honored at request time. After deploying the issuer site, `curl …/issuer/incident?incident=bank-run` must return a bank-run title.

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 8.1 | DEMO CAUSE control | A row of cause buttons appears under the operator controls, with the current one highlighted | Connect the operator wallet and look below Simulate and Reset. | No row, or it shows for non-operators. |
| 8.2 | Re-points the issuer pages | Clicking a cause sends a `registry.updateConfig` tx that sets the selected stable's issuer URLs to that cause | Click a cause, confirm the tx, and watch the highlight move. | The tx reverts (operator only), or the highlight does not update. |
| 8.3 | Verdict follows the cause | The next Simulate classifies as the chosen cause with its payout class | Pick Regulatory, Simulate, and confirm `/audit` shows REGULATORY at 50% vested. Repeat for each cause. | The verdict stays the previous cause, usually an issuer-page cache, so re-warm the page. |
| 8.4 | Per-asset defaults | USDC defaults to exploit, USDT to bank run, DAI to regulatory, FRAX to glitch | Switch demo assets without touching the cause row. | All assets default to the same cause. |

## T9. Autonomous live monitor

The multi-asset PriceFeedPoller runs a keeperless Reactivity cron that fetches the real USDC, USDT, DAI, and FRAX prices on-chain and writes them to the four live assets, with no operator action.

| # | Purpose | Expected | Steps | Gap signal |
|---|---|---|---|---|
| 9.1 | LIVE MONITOR widget | The monitor panel shows all four real pegs near a dollar, with observed timestamps, a rising poll count, and a green pulse | Load `/` and watch for a few minutes. | A price stuck at a dash, or a poll count that never rises. |
| 9.2 | Real prices | The values are live CoinGecko prices, not exactly a dollar | Compare to coingecko.com. | Always exactly `$1.0000`, meaning it is not reading real data. |
| 9.3 | Keeperless and self-rescheduling | The poll count climbs with nobody clicking, and the cron re-arms each tick | Verify on-chain that `poller.pollCount()` rises and `poller.cronSubscriptionId()` changes between ticks. | The count is frozen, meaning the cron stopped, often because the poller balance fell under 32 STT. |
| 9.4 | Live assets are buyable | The live assets appear in the LIVE group, anyone can buy coverage on them, and their dashboard shows the autonomously-monitored note with no operator controls | Select a live asset on `/`, and buy coverage on `/policies`. | Operator controls show for a live asset, or it is missing from the selector. |
| 9.5 | Real two-source evidence | Each live asset's investigation reads two real sources (for example status.circle.com and circle.com/usdc) | Read `registry.getConfig(asset)` and check the homepage URL. | Still points at the mock issuer site. |
| 9.6 | Monitor longevity and calibration | The monitor runs until the spendable balance above 32 STT is exhausted, and live assets fire only on a real, sustained 2% depeg | Run `pnpm health:poller` to check balance, armed status, and poll count. If the poll count freezes, run `pnpm health:poller:fix` to auto-topup and re-arm. Confirm `registry.getConfig(liveAsset).depegThresholdBps` is 200. | A 50 bps threshold makes a live asset fire on normal market wobble and drains the Oracle. Run `script/calibrate-live.ts`. |

## T10. Known design choices that may look like gaps

| # | What you see | Why it is intentional |
|---|---|---|
| 10.1 | An investigate stage shows `3/3 agreed, 2/3 required` | The rule is a 2/3 majority, and this run simply got all three. It is truthful and good. |
| 10.2 | The pipeline takes a few minutes | Two Parse-Website scrapes run across a subcommittee, which is the real platform latency. The demo video compresses the waits in the edit. |
| 10.3 | You can buy a policy and claim immediately | The demo sets min-age and min-duration to zero so the flow is instant on stage. Production would set both above zero, and the anti-farming gate is in the contract and tested. |
| 10.4 | A live asset never triggers in a normal demo | Live assets fire only on a genuine, sustained 2% depeg, which is rare. The autonomous detection is real, and the LIVE MONITOR shows it running. |
| 10.5 | `next dev` may crash on a low-memory host | A V8 heap limit. Use `pnpm build` and `pnpm start`, and the dev script also bumps the heap. |

## T11. One clean end-to-end demo pass

1. Pre-warm `/issuer/incident` and `/issuer/social` in browser tabs.
2. On `/`, confirm MONITORING, a healthy peg, and a DEMO stable selected.
3. Click Simulate Depeg and watch Detect, Confirm (3/3), Investigate twice (2/3), Classify (3/3), Settled.
4. Click View investigation and confirm the verdict, both disclosures, and the tiered stamps on `/audit`.
5. On `/policies`, click Claim payout on the matching policy and confirm the balance rises.
6. On `/lp`, show NAV, APY, and utilization, and optionally trigger again to show the withdrawal lock.
7. Switch to another demo asset and repeat to prove independent insurability.
8. Switch to a LIVE asset and show the real peg ticking and the buyable real coverage.
9. Click Reset peg and confirm the stepper returns to MONITORING.
