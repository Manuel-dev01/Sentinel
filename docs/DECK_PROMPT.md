# Presentation-deck prompt

Paste the block below into a fresh Claude conversation (Claude Code or claude.ai) to generate the Sentinel pitch deck. It encodes the real architecture and the Sentinel design system so the output matches the product and the landing page. Everything in it is factual as of the current build — don't let the model invent stats.

> **Tip:** the default output is a single self-contained HTML deck (arrow-key navigable) so it honors the exact fonts/colors. If you'd rather have editable slides, change the "Output" section to ask for **Slidev** or **Marp** Markdown instead.

---

```
You are a senior product designer + technical storyteller. Produce a hackathon pitch DECK for
"Sentinel" — built for the Somnia Agentathon (Encode Club, 2026). Output a SINGLE self-contained
HTML file (no external assets, no build step) that I can open in a browser and present full-screen,
advancing slides with the arrow keys / spacebar. One slide per viewport, 16:9.

# What Sentinel is (use these facts verbatim — do not invent numbers)
Agent-native parametric insurance for stablecoin depegs on Somnia, the Agentic L1. When an insured
stablecoin loses its peg, Sentinel autonomously: (1) detects it on-chain via a Somnia Reactivity
subscription — no off-chain keeper; (2) confirms it with a JSON-API agent across an independent
price basket; (3) investigates the CAUSE by scraping TWO independent web sources (the issuer's
incident page and its status feed) with LLM Parse-Website agents; (4) classifies the cause with an
LLM-Inference agent into a fixed enum {SMART_CONTRACT_EXPLOIT, BANK_RUN, REGULATORY,
TECHNICAL_GLITCH, UNKNOWN}; (5) routes a payout from an LP pool via a deterministic matrix — exploits
pay 100% immediately, softer causes vest/scale. Every validator vote is stored on-chain and rendered
in a public audit trail.

Signature engineering point — TIERED CONSENSUS:
- The two stages that SIGN THE PAYOUT — the price Confirm and the Classify verdict — require strict
  3-of-3 validator unanimity, byte-identical.
- The two free-form Parse-Website investigate stages require a 2-of-3 majority (that scraper agent
  reliably musters only a quorum on testnet; the responders agree, the third is often just absent).
- Tagline for this: "the payout signs only on 3-of-3; the evidence needs a byte-identical majority."

Other true facts you may use:
- Built solo, in ~3 weeks, for the Somnia Agentathon.
- Deployed AND source-verified on Somnia testnet (chain 50312). Two stablecoins (USDC + USDT)
  independently insurable.
- 126 Foundry tests (unit/fuzz/invariant/integration) + a frontend unit suite; CI on every push.
- Both Somnia primitives proven on-chain before any business logic depended on them (Reactivity
  round-trip; agent consensus on a live price feed and on a classification).
- Receipts are read on-chain via getReceipts(eventId) — no off-chain indexer, no backend.
- Why only Somnia: Reactivity (keeperless on-chain detection) + Somnia Agents (AI re-run across a
  validator subcommittee, so the *reason* for a payout inherits the chain's consensus). No other L1
  has both.
- It is an UNAUDITED testnet prototype — do not imply mainnet or real funds.

# Audience & goal
Hackathon judges scoring on: Functionality, Agent-First Design, Innovation & Technical Creativity,
Autonomous Performance. The deck must make all four obvious. Confident, technical, founder-grade —
not salesy. Short lines, lots of negative space.

# Design system — "Editorial Technical · Paper · Ink · Ultraviolet" (match exactly)
Colors (CSS):
  --paper:#EFECE6; --paper-2:#E6E2D9; --paper-3:#D8D3C7;
  --ink:#000000; --ink-2:rgba(0,0,0,.74); --ink-3:rgba(0,0,0,.55);
  --violet:#7000FF; --violet-soft:#8A3BFF; --violet-faint:rgba(112,0,255,.12);
  --off:#EFECE6 (cream text on dark); --line:#000; --line-soft:rgba(0,0,0,.14);
  status: --green:#7CFFA8; --amber:#FFB870; --red:#FF8A6B;
Two surface modes: PAPER slides (cream bg, ink text) and DARK slides (near-black #0F0D0A bg, cream
text) — alternate them for rhythm; put the hero, the live-demo/monitor, and the audit/receipts
slides on DARK.
Type: display = "Anton" (uppercase, tight tracking, huge); serif accent = "Newsreader" ITALIC (for
one emphasized word per headline, in violet or ink); body/labels = "JetBrains Mono" (uppercase
kickers with wide letter-spacing, e.g. "[ 02 ] · WHY SAME-BLOCK"). Load via Google Fonts <link>.
Motifs: thin 1px rules; section numbers like "[ 01 ]"; small monospace kickers above headlines; a
"rubber stamp" treatment for verdicts (e.g. a rotated outlined box reading "3/3 CONSENSUS" in
violet, "PAID" etc.); subtle paper-grain via an SVG/feTurbulence overlay at low opacity; NO glassy
blur, NO neon glow, NO drop shadows. Keep it flat, printed, precise.
Logo/mark (use as a small corner glyph on every slide): an SVG — a 45°-rotated square outline + a
circle outline (both ink, ~1.8 stroke) + a solid violet (#7000FF) center dot. Wordmark "SENTINEL"
in Anton with "NEL" — or just the final letters — accented; keep it simple.

# Slides (≈12; one idea each)
1.  Cover — wordmark + mark; tagline "Insurance that pays out faster than the rumor cycle — and
    proves why it paid."; "Somnia Agentathon · 2026". DARK.
2.  The problem — legacy on-chain insurance settles by committee vote over days/weeks; the cause of
    a depeg (exploit vs bank-run vs regulatory vs glitch) is the hard part, and it must be
    trustless and fast.
3.  The idea — Detect → Investigate → Pay, autonomously, with the AI investigation itself
    consensus-validated. One sentence + the 5-step flow as a clean horizontal pipeline diagram.
4.  How it works — the pipeline in detail: Reactivity → JSON-API confirm → 2× Parse-Website (two
    sources) → LLM-Inference classify → payout matrix. Label each with its agent + consensus tier.
5.  Tiered consensus (the money slide) — 3/3 to sign the payout (Confirm + Verdict), 2/3 on the web
    evidence. Explain WHY (the on-chain receipt finding) and frame it as deliberate engineering.
    DARK; use the stamp motif (3/3 vs 2/3).
6.  Why only on Somnia — Reactivity + Somnia Agents; a 2-column "other chains can't / Somnia
    primitive" table.
7.  Proof / receipts — every validator vote on-chain via getReceipts; show a stylized audit card
    (verdict SMART_CONTRACT_EXPLOIT, two disclosures, per-stage 3/3 and 2/3 stamps). DARK.
8.  The economics — LP pool earns premiums, takes tail risk; utilization cap + withdrawal lock;
    payout matrix table (cause → factor → timing).
9.  Built & verified — deployed + source-verified on testnet (chain 50312), 2 stablecoins, 126
    tests, CI, both primitives proven on-chain. A confidence/credibility slide.
10. Judging criteria — 2×2 grid mapping Functionality / Agent-First / Innovation / Autonomous
    Performance to one concrete line each.
11. Demo — a single bold call to "watch the 90-second drill"; leave a placeholder for the video
    link/QR.
12. Close — "Built solo, on Somnia. The smart contract is the mechanism." + GitHub + the verified
    Oracle address; the mark.

# Output
- One valid, self-contained .html file. Inline <style>. Google-Fonts <link> in <head>.
- Keyboard nav (←/→/space) + a slim slide counter. Respect prefers-reduced-motion.
- Leave clearly-marked placeholders for: the demo-video URL, the GitHub URL, and the live-app URL.
- Don't invent metrics, partners, TVL, or a mainnet claim. If you need a number that isn't above,
  leave a bracketed placeholder instead.
- After the file, give me a 3-bullet "how to present this" note.
```

---

**Real values to drop into the placeholders after generation:**
- Verified Oracle: `0xe6d838c0b51e73fAD5F9C06D0fa48FC3C92Aa91c` ([explorer](https://shannon-explorer.somnia.network/address/0xe6d838c0b51e73fAD5F9C06D0fa48FC3C92Aa91c))
- GitHub: `https://github.com/Manuel-dev01/Sentinel` *(confirm the exact repo slug)*
- Live demo / issuer: `https://sentinel-issuer.vercel.app`
- Demo video: _add when recorded_
