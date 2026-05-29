# Spike Results — 2026-05-29T19:35:36.680Z

Step 3 of Phase 0. Two on-chain agent round-trips on Somnia testnet.

- Network: somniaTestnet
- Mock issuer URL: https://sentinel-issuer.vercel.app/api/peg-status
- Signer: `0xBCA6f82e240C6AC36B23b4f7D21adF17e03966Fe`
- Start balance: 49.953619464 STT
- End balance:   49.458041104 STT
- Total spent:   **0.49557836 STT**

## Stage A — JSON API
- Contract: [`0xe8eB3a0233D8E227636f91f45Cd17583Be6A1008`](https://shannon-explorer.somnia.network/address/0xe8eB3a0233D8E227636f91f45Cd17583Be6A1008)
- `fire()` tx: (reused — not fired this run)
- requestId: `3005907`
- Floor deposit: 0.03 STT
- Finalized: true
- Consensus: **0.9980**
- Median executionCost: 0.03 STT/validator
- Validators that responded:
  - `0x0742f5b929be6Fab5842c2fd6dA33bA4506c2393` · status=**Success** · cost=0.03 STT · result=`0.9980`
  - `0xA571a6c0d79a5C1451330A64b36725dD333019c9` · status=**Success** · cost=0.03 STT · result=`0.9980`

## Stage B — LLM Inference (Qwen3-30B)
- Contract: [`0xACc703e3344799eC546A2E0F0634d2f2a1234299`](https://shannon-explorer.somnia.network/address/0xACc703e3344799eC546A2E0F0634d2f2a1234299)
- `fire()` tx: [`0x416164a07c4b811b77a76e6421aa0580c01ebbf29ea16c98da331bdf0406566d`](https://shannon-explorer.somnia.network/tx/0x416164a07c4b811b77a76e6421aa0580c01ebbf29ea16c98da331bdf0406566d)
- requestId: `3060393`
- Finalized: true
- Consensus: **SMART_CONTRACT_EXPLOIT**
- Median executionCost: 0.07 STT/validator
- Validators that responded:
  - `0x1Cb38b3ee632B5dCc0347dB81766606d6Aad4926` · status=**Success** · cost=0.07 STT · result=`SMART_CONTRACT_EXPLOIT`
  - `0x55Acbe370872c7D90F504eF169217a00c29E2A33` · status=**Success** · cost=0.07 STT · result=`SMART_CONTRACT_EXPLOIT`

Prompt used (allowedValues: SMART_CONTRACT_EXPLOIT, BANK_RUN, REGULATORY, TECHNICAL_GLITCH, UNKNOWN):
```
Classify the root cause of this stablecoin depeg event.

Event: USDx stablecoin vault drained via reentrancy exploit. 90% of reserves lost. Price moved from $1.00 to $0.94.
```

## Verdict
✅ **Both agents reached consensus.** Pivot risk #1 (LLM determinism) cleared empirically.

---

# M0 Reactivity Micro-Spike — 2026-05-29T20:12:04.615Z

Proves the Somnia Reactivity round-trip: a price-feed event invokes the handler on-chain, no keeper.

- Network: somniaTestnet
- MockPriceOracle: [`0xDAC780EdD2a1c082b019d12952E3b93599da2A6C`](https://shannon-explorer.somnia.network/address/0xDAC780EdD2a1c082b019d12952E3b93599da2A6C)
- SpikeReactivity (handler): [`0xD6cB413c0E4a5839Fd4B02aFFeBF65e6868726b9`](https://shannon-explorer.somnia.network/address/0xD6cB413c0E4a5839Fd4B02aFFeBF65e6868726b9)
- subscriptionId: `3173993`
- arm() tx: [`0x1ff5fd0458b0c5f83ee7deb87fe2e2163bed87353fe7af8e8cc73cfa42d46396`](https://shannon-explorer.somnia.network/tx/0x1ff5fd0458b0c5f83ee7deb87fe2e2163bed87353fe7af8e8cc73cfa42d46396)
- setPrice() tx: [`0x12ff2a2cbd3b999e9a0d71930176316276a870bc8cfabcafef8de250bc6c2894`](https://shannon-explorer.somnia.network/tx/0x12ff2a2cbd3b999e9a0d71930176316276a870bc8cfabcafef8de250bc6c2894)
- Handler funded: 33.0 STT (min 32.0)

## Result
- `_onEvent` fired: **true**
- eventCount: 1
- decoded asset: `0x000000000000000000000000000000000000dEaD` (match: true)
- decoded price: 0.94 (match: true)

✅ **Reactivity round-trip works.** Pushing a price triggered `_onEvent` with the correct decoded payload, with no off-chain keeper. The last Phase-0 platform unknown is cleared; SentinelOracle can rely on Reactivity for detection.
