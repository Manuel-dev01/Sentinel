# Security

This document records Sentinel's threat model, trust assumptions, and the mitigations built into the contracts. It expands the security checklist in [`CLAUDE.md`](../CLAUDE.md) §15.

**This is an unaudited hackathon prototype on testnet. Do not use with real funds.** The mitigations below describe design intent, not a guarantee.

---

## 1. Trust assumptions

- **Somnia validators are honest-majority.** Agent results are trusted only when a validator subcommittee reaches consensus, recomputed on-chain by the Oracle (never trusting a single response). Sentinel inherits the chain's trust model; it does not add a trusted off-chain party.
- **Consensus is tiered to the safety role of each stage.** The two stages that *sign the payout* — the JSON-API price **Confirm** and the LLM-Inference **Classify** verdict — require strict **3-of-3 unanimity** (both deterministic, so this is reliably met). The free-form **Parse-Website** investigate stages, which only gather corroborating evidence, require a **2-of-3 majority** (the scraper agent reliably musters only a quorum on testnet). Security rationale: relaxing the *evidence* threshold never enables an unjustified payout — the verdict that releases funds still demands unanimity — while requiring unanimity on the evidence stages would only add a liveness/availability tax (a stuck event), not safety.
- **The price feed(s) are imperfect.** No single price source is trusted. Detection arms on a feed; payout requires independent corroboration via the JSON-API basket.
- **The operator is trusted for configuration only.** The operator registers stablecoins and sets parameters but cannot direct a payout to a specific party or bypass the state machine. Operator powers are behind an `OPERATOR_ROLE` and limited to config + emergency pause.
- **LLM determinism holds well enough for consensus.** The system assumes constrained prompts yield stable outputs across validators; this is validated empirically (see Limitations).

## 2. Threat model and mitigations

### Oracle manipulation
*Risk:* an attacker pushes a false depeg on one source to trigger a payout.
*Mitigation:* detection only arms the pipeline; the JSON-API basket confirmation must independently corroborate the depeg, and the deviation must be sustained for `minDurationSeconds`. A single bad oracle reaches `DISMISSED`, not payout.

### Agent response spoofing
*Risk:* a forged `handleResponse` call fakes a classification.
*Mitigation:* callbacks require `msg.sender == platformAddress`; each response is bound to a known pending `requestId` mapped to a specific (eventId, stage); responses that don't match are rejected.

### Replay / late / duplicate responses
*Risk:* a duplicate or late agent response re-advances state or double-pays.
*Mitigation:* callbacks are idempotent; once a stage advances, responses for that stage are ignored; each `requestId` is single-use.

### Payout farming
*Risk:* a user buys coverage *after* a depeg begins, or repeatedly farms transient dips.
*Mitigation:* policies have a `minAge` and must have been active before the event trigger timestamp; non-exploit classes vest (24h) rather than paying instantly; a minimum deviation tier is required before any payout; classification and timing are checked against on-chain `block.timestamp`.

### Reentrancy
*Risk:* a malicious recipient re-enters during payout to drain the pool.
*Mitigation:* Checks-Effects-Interactions on all value-moving functions; `ReentrancyGuard` on the Treasury's `settle` / `claimVested` and the Pool's `deposit` / `redeem`; SafeERC20 for transfers; per-policy settlement (not an unbounded loop) so payout is one bounded tx. A re-entrant capital token is regression-tested against the vested-claim path.

### LP capital drain / griefing
*Risk:* an LP withdraws capital needed to cover a settling event, or the pool oversells coverage.
*Mitigation:* withdrawals are locked or queued while an event for an exposed stablecoin is in a non-terminal state; a utilization cap (`liability ≤ capital × utilizationCapBps / 1e4`) blocks selling coverage the pool can't back.

### Insolvency
*Risk:* total payouts exceed pool capital.
*Mitigation:* the utilization cap bounds outstanding liability at policy-sale time; per-event reserved capital bounds total payouts; the Treasury never pays more than reserved for an event.

### Stranded events (availability)
*Risk:* an agent fails or validators can't reach consensus, leaving an event mid-flow and policies unsettled.
*Mitigation:* every `ResponseStatus` is handled explicitly; failed/no-consensus responses park the event with a logged reason and support retry or operator-triggered dismissal. The deliberate bias is **fail-closed** — no payout without consensus — accepting that a stuck event is safer than an unjustified payout.

### Precision / rounding
*Risk:* integer truncation that benefits a claimant or breaks share accounting.
*Mitigation:* a single fixed-point convention documented in `SentinelPool`; rounding favors the pool on premiums and never favors a claimant beyond the matrix; share/asset accounting fuzz-tested for value conservation.

### Access control
*Risk:* unauthorized config changes or payouts.
*Mitigation:* `OPERATOR_ROLE` for config + pause; payout pulls restricted to the Treasury (`TREASURY_ROLE` on the Pool); the Treasury's `recordVerdict` (the spec's `routePayouts`) callable only by the Oracle (`ORACLE_ROLE`); the Oracle's `handleResponse` gated to the agent platform and `_onEvent` to the Reactivity precompile; no unguarded upgrade or `selfdestruct` paths. The on-chain audit receipts (`getReceipts`) are append-only and read-only — they add no value-moving surface.

## 3. Emergency controls

- `Pausable` on value paths lets the operator halt new policies and payouts if a platform-level issue is detected during the event window.
- Pausing does not enable the operator to seize funds; it only stops state transitions.

## 4. Testing for these properties

See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) and the test suite. Coverage specifically targets: every `handleResponse` status branch, wrong-sender callbacks, duplicate/late/unknown `requestId`, single-oracle false positives, post-depeg policy purchase, reentrancy on claim, LP withdraw races, and solvency invariants under fuzzed deposit/withdraw/payout sequences.

## 5. Limitations and out-of-scope (prototype)

- **Unaudited.** No formal verification or third-party audit.
- **LLM determinism** under consensus is assumed, not proven; if validators diverge on a classification, the event fails closed (stuck), which is a liveness cost, not a safety hole.
- **Single stablecoin** and simplified risk pricing in the MVP.
- **No legal/regulatory structuring.** The product is framed as a smart-contract risk pool, not a regulated insurance product.
- **Mock oracle and mock issuer** are demo scaffolding, not production data sources.

## 6. Responsible disclosure

This is a testnet prototype built for a hackathon. If you find an issue, open a GitHub issue or contact the author. No funds are at risk; nothing here should be deployed to mainnet with real value without an audit.
