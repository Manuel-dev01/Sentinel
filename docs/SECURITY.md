# Security

This document records Sentinel's threat model, trust assumptions, and the mitigations built into the contracts.

**This is an unaudited hackathon prototype on testnet. Do not use with real funds.** The mitigations below describe design intent, not a guarantee.

---

## 1. Trust assumptions

- **Somnia validators are honest-majority.** Agent results are trusted only when a validator subcommittee reaches consensus, recomputed on-chain by the Oracle so it never trusts a single response. Sentinel inherits the chain's trust model and does not add a trusted off-chain party.
- **Consensus is tiered to the safety role of each stage.** The two stages that sign the payout are the JSON-API price Confirm and the LLM-Inference Classify verdict, and both require strict 3-of-3 unanimity. Both are deterministic, so this is reliably met. The free-form Parse-Website investigate stages, which only gather corroborating evidence, require a 2-of-3 majority, because the scraper agent reliably musters only a quorum on testnet. The security rationale is that relaxing the evidence threshold never enables an unjustified payout, since the verdict that releases funds still demands unanimity, while requiring unanimity on the evidence stages would only add a liveness and availability tax in the form of a stuck event, not safety.
- **The price feeds are imperfect.** No single price source is trusted. Detection arms on a feed, and payout requires independent corroboration through the JSON-API basket.
- **The operator is trusted for configuration only.** The operator registers stablecoins and sets parameters, but cannot direct a payout to a specific party or bypass the state machine. Operator powers sit behind an `OPERATOR_ROLE` and are limited to configuration and an emergency pause.
- **LLM determinism holds well enough for consensus.** The system assumes constrained prompts yield stable outputs across validators, and this is validated empirically (see Limitations).

## 2. Threat model and mitigations

### Oracle manipulation
*Risk:* an attacker pushes a false depeg on one source to trigger a payout.
*Mitigation:* detection only arms the pipeline. The JSON-API basket confirmation must independently corroborate the depeg, and the deviation must be sustained for `minDurationSeconds`. A single bad oracle reaches `DISMISSED`, not payout.

### Agent response spoofing
*Risk:* a forged `handleResponse` call fakes a classification.
*Mitigation:* callbacks require `msg.sender == platformAddress`. Each response is bound to a known pending `requestId` mapped to a specific event and stage, and responses that do not match are rejected.

### Replay, late, or duplicate responses
*Risk:* a duplicate or late agent response re-advances state or double-pays.
*Mitigation:* callbacks are idempotent. Once a stage advances, responses for that stage are ignored, and each `requestId` is single-use.

### Payout farming
*Risk:* a user buys coverage after a depeg begins, or repeatedly farms transient dips.
*Mitigation:* policies have a `minAge` and must have been active before the event trigger timestamp. Non-exploit classes vest over 24 hours rather than paying instantly, a minimum deviation tier is required before any payout, and classification and timing are checked against on-chain `block.timestamp`.

### Reentrancy
*Risk:* a malicious recipient re-enters during payout to drain the pool.
*Mitigation:* Checks-Effects-Interactions on all value-moving functions, `ReentrancyGuard` on the Treasury's `settle` and `claimVested` and the Pool's `deposit` and `redeem`, SafeERC20 for transfers, and per-policy settlement rather than an unbounded loop, so payout is one bounded transaction. A re-entrant capital token is regression-tested against the vested-claim path.

### LP capital drain or griefing
*Risk:* an LP withdraws capital needed to cover a settling event, or the pool oversells coverage.
*Mitigation:* withdrawals are locked while an event for an exposed stablecoin is in a non-terminal state, and a utilization cap (`liability <= capital * utilizationCapBps / 1e4`) blocks selling coverage the pool cannot back.

### Insolvency
*Risk:* total payouts exceed pool capital.
*Mitigation:* the utilization cap bounds outstanding liability at policy-sale time, per-event reserved capital bounds total payouts, and the Treasury never pays more than reserved for an event.

### Stranded events (availability)
*Risk:* an agent fails or validators cannot reach consensus, leaving an event mid-flow and policies unsettled.
*Mitigation:* every `ResponseStatus` is handled explicitly. Failed or no-consensus responses park the event with a logged reason and support retry or operator-triggered dismissal. The deliberate bias is to fail closed, with no payout without consensus, accepting that a stuck event is safer than an unjustified payout.

### Precision and rounding
*Risk:* integer truncation that benefits a claimant or breaks share accounting.
*Mitigation:* a single fixed-point convention documented in `SentinelPool`, rounding that favors the pool on premiums and never favors a claimant beyond the matrix, and share-to-asset accounting fuzz-tested for value conservation.

### Access control
*Risk:* unauthorized config changes or payouts.
*Mitigation:* `OPERATOR_ROLE` for configuration and pause; payout pulls restricted to the Treasury through `TREASURY_ROLE` on the Pool; the Treasury's `recordVerdict` callable only by the Oracle through `ORACLE_ROLE`; the Oracle's `handleResponse` gated to the agent platform and `_onEvent` gated to the Reactivity precompile; and no unguarded upgrade or `selfdestruct` paths. The on-chain audit receipts from `getReceipts` are append-only and read-only, so they add no value-moving surface.

## 3. Emergency controls

- `Pausable` on the value paths lets the operator halt new policies and payouts if a platform-level issue is detected during an event window.
- Pausing does not let the operator seize funds. It only stops state transitions.

## 4. Testing for these properties

See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) and the test suite. Coverage specifically targets every `handleResponse` status branch, wrong-sender callbacks, duplicate, late, and unknown `requestId` values, single-oracle false positives, post-depeg policy purchase, reentrancy on claim, LP withdraw races, and solvency invariants under fuzzed deposit, withdraw, and payout sequences.

## 5. Limitations and out of scope (prototype)

- **Unaudited.** There is no formal verification or third-party audit.
- **LLM determinism** under consensus is assumed, not proven. If validators diverge on a classification, the event fails closed and becomes stuck, which is a liveness cost, not a safety hole.
- **Simplified risk pricing** in this prototype.
- **No legal or regulatory structuring.** The product is framed as a smart-contract risk pool, not a regulated insurance product.
- **The mock oracle and mock issuer pages** are demo scaffolding, not production data sources. The live assets read real price feeds and real issuer sources, but that scrape is best-effort.

## 6. Responsible disclosure

This is a testnet prototype built for a hackathon. If you find an issue, open a GitHub issue or contact the author. No funds are at risk, and nothing here should be deployed to mainnet with real value without an audit.
