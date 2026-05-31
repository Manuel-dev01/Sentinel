# Sentinel

**Insurance that pays out faster than the rumor cycle — and proves *why* it paid.**

Sentinel is agent-native parametric insurance for stablecoin depegs, built on [Somnia](https://somnia.network), the Agentic L1. When an insured stablecoin loses its peg, Sentinel autonomously confirms the event, **investigates the cause using on-chain AI agents**, classifies it, and pays valid claims **within the same block** — with no human committee, no governance vote, and no trusted centralized oracle.

The investigation itself is consensus-validated: multiple independent validators must agree on the AI verdict before a single token moves. That verifiability is the entire reason Sentinel can only exist on Somnia.

> Built for the **Somnia Agentathon** (Encode Club, 2026).

---

## The problem

On-chain insurance today is slow where it matters most. Nexus Mutual settles via member votes that take days or weeks. Risk Harbor and InsurAce lean on centralized oracles you have to trust. None of them can react to a stablecoin depeg in the window that actually matters — the first minutes, when the peg is breaking and nobody yet agrees on *why*.

A stablecoin can lose its peg from a contract exploit, a bank run, a regulatory action, or a transient technical glitch — and each cause deserves a different response. The hard part isn't detecting the price move; it's determining the **cause**, fast, in a way nobody has to trust.

## What Sentinel does

```mermaid
flowchart LR
    A[Reactivity:<br/>watch peg] -->|deviation ≥ threshold| B[Agent 1: JSON API<br/>confirm via price basket]
    B -->|corroborated| C[Agent 2: LLM Parse Website<br/>read issuer site / X / GitHub]
    B -->|single bad oracle| X[Dismissed]
    C --> D[Agent 3: LLM Inference<br/>classify cause]
    D -->|3 validators agree| E[Payout matrix]
    E --> F[Immediate payout<br/>exploit]
    E --> G[Vested payout<br/>bank run / regulatory]
```

1. A **Somnia Reactivity** subscription watches a stablecoin's price feed — no off-chain keeper.
2. On a sustained depeg, an on-chain handler fires and dispatches a **Somnia Agent (JSON API)** to confirm the move across an independent price basket. A single bad oracle is never enough to pay out.
3. If corroborated, a **Somnia Agent (LLM Parse Website)** reads the issuer's homepage, social, and recent GitHub activity.
4. A **Somnia Agent (LLM Inference)** classifies the cause — `SMART_CONTRACT_EXPLOIT`, `BANK_RUN`, `REGULATORY`, `TECHNICAL_GLITCH`, or `UNKNOWN` — and a validator subcommittee must reach consensus on the answer.
5. A payout matrix routes funds from an LP pool: exploits pay 100% immediately; softer causes vest to deter farming. Every validator vote and agent receipt is recorded on-chain and rendered in a public audit trail.

## Why only on Somnia

| Capability Sentinel needs | Why other chains can't | Somnia primitive used |
|---|---|---|
| Detect a depeg with no off-chain keeper | Ethereum/L2s need Gelato/Chainlink Automation polling | **Reactivity** (validators invoke the handler directly) |
| Investigate cause with AI you don't have to trust | AI calls elsewhere are a centralized API — the studio could lie | **Somnia Agents** (LLM inference re-run by a validator subcommittee) |
| Pay out in the same block as the event | L1 finality + oracle delay measured in minutes | Sub-second finality, sub-cent fees |
| Prove the verdict | No chain produces a multi-validator-signed AI result | **Consensus-validated agent receipts** |

## How this maps to the judging criteria

| Criterion | How Sentinel addresses it |
|---|---|
| **Functionality** | Deployed on Somnia testnet; full detect→confirm→investigate→classify→payout flow runs end-to-end without manual steps. |
| **Agent-First Design** | Uses all three base agents (JSON API, LLM Parse Website, LLM Inference) in a single autonomous chain; agents *decide whether and how much* to pay, not just automate a transfer. |
| **Innovation & Technical Creativity** | First parametric insurer whose **claim investigation is consensus-validated**; chains Reactivity → Agents → payout; the audit receipt is a first-class on-chain artifact. |
| **Autonomous Performance** | No human in the loop between detection and settlement; the system maintains a strict state machine and handles every agent response status (success, failure, no-consensus, timeout) safely. |

## Tech stack

- **Contracts:** Solidity · Foundry (tests/fuzz/invariants) · Hardhat (deploy/TS interop) · OpenZeppelin
- **Frontend:** Next.js (App Router) · TypeScript · Tailwind · ethers v6 · wagmi/viem
- **Somnia:** Agents platform · Reactivity · [LI.FI](https://li.fi) for cross-chain deposits
- **Network:** Somnia testnet (mainnet-ready architecture)

## Quickstart

```bash
git clone <repo-url> sentinel && cd sentinel
cp .env.example .env          # fill in RPC, deployer key, platform addresses
forge install                  # contract deps
npm install                    # frontend + scripts deps

forge build && forge test      # run the contract test suite

# Deploy + wire + seed the protocol on Somnia testnet (see docs/DEMO.md for the full runbook)
pnpm deploy:testnet

# Run the demo trigger: push USDC below peg and watch the pipeline settle
pnpm simulate:depeg

# Frontend
cd frontend && npm run dev
```

You'll need Somnia testnet tokens (from the Somnia Discord `#dev-chat` faucet) for deployment and agent-request deposits.

## Build status

| Phase | State |
|---|---|
| **0 · Verify & scaffold** | ✅ Done — Foundry + Hardhat + Next.js on Somnia testnet; live docs verified |
| **0 · Riskiest-path spike** | ✅ **Passed (2026-05-29)** — both agents reached validator consensus on testnet ([`docs/spike-results.md`](docs/spike-results.md)) |
| **2 · Core engine** | ✅ **Done (2026-05-31)** — all five contracts built, tested, deployed + wired on testnet; `simulate-depeg` ran the full detect→classify→payout chain autonomously in ~27s |
| **3 · Frontend** | ⬜ — peg dashboard, policies, LP, audit trail |
| **4 · Harden & ship** | ⬜ — fuzz/invariants, video, submission |

**Phase 2 progress** (bottom-up by dependency — `Registry`/libs → `Pool` → `Policy` → `Treasury` → `Oracle`):

| Step | What | State |
|---|---|---|
| Reactivity micro-spike | On-chain `_onEvent` fires on a price update, no keeper | ✅ proven on testnet |
| Libraries | `Classification` (cause enum + agent-token parse), `FixedPoint` (1e18/bps), `PayoutMath` (the §5 matrix) | ✅ tested |
| `SentinelRegistry` | Operator-managed insurable-stable config | ✅ tested |
| `SentinelPool` | ERC-4626-style LP vault: NAV, premiums, utilization cap, withdrawal lock | ✅ unit + fuzz + invariant |
| `SentinelPolicy` | ERC-721 coverage: quote/buy, premium routing, min-age anti-farming, claim lifecycle | ✅ unit + fuzz |
| `SentinelTreasury` | Payout-matrix execution: immediate (exploit) vs. vested/delayed; per-policy settle; reentrancy-guarded | ✅ unit + reentrancy |
| `SentinelOracle` | Reactive detect→confirm→investigate→classify→route orchestrator + 3-agent chain | ✅ integration (mock platform) |
| Deploy + wire + simulate | `script/deploy.ts` (deploy 8 contracts, wire roles, register, fund+arm, seed, buy) + `script/simulate-depeg.ts` (trigger → pipeline → settle) | ✅ **ran live on testnet** — full 3-agent chain settled an exploit payout in ~27s (addresses below) |
| Full 3-agent chain (live) | Reactivity → JSON-API confirm → LLM Parse-Website investigate → LLM-Inference classify → payout, end-to-end on testnet | ✅ proven 2026-05-31 (sequential blocks, all stages reached validator consensus) |

**119 Foundry tests passing**, including a solvency-invariant suite over 128k random operation sequences, a reentrancy-attack regression test on the payout path, and a full Oracle state-machine suite (26 tests) driven by a mock 3-validator agent platform (every `ResponseStatus` branch, callback idempotency, detection gating, an agent-payload selector lock, and the free-the-live-slot-on-failure regression).

**Both Somnia primitives are proven on-chain** — this is the project's core de-risking:

| Primitive | What was proven | Tx |
|---|---|---|
| Agents · JSON API (`13174…0097713`) | consensus on a live price feed → `0.9980` | [`0x8eb8a3ca…66fcb`](https://shannon-explorer.somnia.network/tx/0x8eb8a3ca4b1e42091d0b15df8cb577abfb65fe23235e677c4b538b6fb0c66fcb) |
| Agents · LLM Inference (`12847…1029384`) | Qwen3-30B classified a depeg as `SMART_CONTRACT_EXPLOIT`, **both validators byte-identical** | [`0x416164a0…566d`](https://shannon-explorer.somnia.network/tx/0x416164a07c4b811b77a76e6421aa0580c01ebbf29ea16c98da331bdf0406566d) |
| Reactivity | a price-feed event invoked the handler on-chain with the correct decoded payload, **no off-chain keeper** | [`0x1ff5fd04…46396`](https://shannon-explorer.somnia.network/tx/0x1ff5fd0458b0c5f83ee7deb87fe2e2163bed87353fe7af8e8cc73cfa42d46396) |

Consensus-validated AI classification + keeperless on-chain detection are the two things that make Sentinel possible, and both now work on testnet — before any business logic depended on them.

## Deployed addresses (Somnia testnet)

> Deployed and verified end-to-end on 2026-05-31 (chain id 50312). The full detect → confirm → investigate → classify → payout flow ran autonomously in **~26 s** on this deployment (`SMART_CONTRACT_EXPLOIT`, 100% immediate payout). Every validator vote is persisted on-chain (`SentinelOracle.getReceipts`) and rendered by the `/audit` screen — no off-chain indexer.

| Contract | Address |
|---|---|
| SentinelRegistry | [`0xBb4a01D4903bDD23E5e164E38eF988734667fdA8`](https://shannon-explorer.somnia.network/address/0xBb4a01D4903bDD23E5e164E38eF988734667fdA8) |
| SentinelPool | [`0x1dB5c35a327338DD6d225617Dc5415d33c4002Fc`](https://shannon-explorer.somnia.network/address/0x1dB5c35a327338DD6d225617Dc5415d33c4002Fc) |
| SentinelPolicy | [`0x4966DDf7f8b74Ec07Dce1d148fe9B06702624F7E`](https://shannon-explorer.somnia.network/address/0x4966DDf7f8b74Ec07Dce1d148fe9B06702624F7E) |
| SentinelTreasury | [`0x7a2259D0eAe3BF277b673dd08972762fD944e275`](https://shannon-explorer.somnia.network/address/0x7a2259D0eAe3BF277b673dd08972762fD944e275) |
| SentinelOracle | [`0xd6Cfd84691DeE2C80B47c00c348cBa22636160cF`](https://shannon-explorer.somnia.network/address/0xd6Cfd84691DeE2C80B47c00c348cBa22636160cF) |

Demo scaffolding (operator-controlled, for reproducing the trigger): CAPITAL/sUSD [`0xBf51Db11…5D1e`](https://shannon-explorer.somnia.network/address/0xBf51Db11C17B3288c3b347EcC13aa20605245D1e) · INSURED/USDC [`0x71918476…A88a`](https://shannon-explorer.somnia.network/address/0x71918476F55ebD185DC3E8ea8514c7F2C514A88a) · MockPriceOracle [`0x7e09120C…A593`](https://shannon-explorer.somnia.network/address/0x7e09120C5A06B2aC87CB324F864f11b520d3A593) · Reactivity subscription `3535096`.

## Demo

> _Demo video link to be added (2–5 min)._ See [docs/DEMO.md](docs/DEMO.md) for the runbook and how to reproduce it locally.

The demo is deterministic by design: a mock price oracle (under operator control) and a mock issuer page let the full depeg → investigation → payout flow be triggered live and repeatably.

## Repository structure

```
src/            Solidity contracts (Registry, Pool, Policy, Treasury, Oracle, libraries, mocks)
test/           Foundry unit / fuzz / invariant / integration tests
script/         Deploy + demo scripts (simulate-depeg)
frontend/       Next.js app (peg dashboard, policies, LP, audit trail)
docs/           ARCHITECTURE · DEMO · SECURITY
CLAUDE.md       Engineering manual (project source of truth)
```

## Documentation

- [**Architecture**](docs/ARCHITECTURE.md) — system design, the event state machine, agent orchestration, contract responsibilities, design-decision log.
- [**Demo runbook**](docs/DEMO.md) — the minute-by-minute demo script, deterministic setup, and live-failure fallback.
- [**Security**](docs/SECURITY.md) — threat model, trust assumptions, attack vectors and mitigations, prototype limitations.

## Roadmap (post-hackathon)

- Multiple insured stablecoins with risk-priced premiums
- Partner integration: underwrite a Somnia-native stablecoin's own depeg coverage
- Real actuarial pricing model and capital-efficiency improvements
- Security audit and upgrade path
- Cross-chain coverage via LI.FI for stablecoins on any connected chain

## Status & disclaimer

This is a hackathon prototype. The contracts are **unaudited** and deployed on testnet for demonstration. Do not use with real funds. Somnia Agents and Reactivity are new platforms; integration details are verified against the live docs at build time and may evolve.

## Author

Built solo by Emmanuel for the Somnia Agentathon.

## License

[MIT](LICENSE)
