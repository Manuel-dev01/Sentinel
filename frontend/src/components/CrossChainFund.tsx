/**
 * Cross-chain funding showcase (CLAUDE.md §8/§12 · LI.FI).
 *
 * Deep-links into LI.FI's hosted Jumper app, preconfigured to bridge any-chain assets into a real
 * Somnia-mainnet stablecoin (USDC.e — verified live in LI.FI's token list for chain 5031). We use
 * the hosted route rather than the embedded @lifi/widget on purpose: the widget pulls a heavy
 * multi-ecosystem (Sui/Solana) wallet stack with a transitive version conflict in this workspace,
 * and — critically — a real bridge can't settle into our *mock* testnet capital token anyway. The
 * deep-link tells the same interop story honestly with zero dependency surface; on mainnet (post
 * audit) the pool's capital asset becomes USDC.e and this funds the pool for real.
 */

const SOMNIA_USDCE = "0x28BEc7E30E6faee657a03e19Bf1128AaD7632A00";
const JUMPER_URL = `https://jumper.exchange/?toChain=5031&toToken=${SOMNIA_USDCE}`;

export function CrossChainFund({ blurb }: { blurb: string }) {
  return (
    <section className="section-pad rule-b">
      <div
        style={{
          display: "flex",
          gap: 16,
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div style={{ maxWidth: "56ch" }}>
          <div className="kicker" style={{ marginBottom: 10 }}>
            <span className="dot" /> CROSS-CHAIN FUNDING · LI.FI
          </div>
          <p className="muted" style={{ fontFamily: "var(--mono)", fontSize: 13, lineHeight: 1.6 }}>
            {blurb} Bridge from any chain into Somnia (USDC.e) through LI.FI&apos;s router.{" "}
            <span className="ed">Mainnet showcase</span> — the testnet demo funds via the faucet
            above; on mainnet this routes real capital into the pool.
          </p>
        </div>
        <a className="pill violet" href={JUMPER_URL} target="_blank" rel="noopener noreferrer">
          Fund from any chain <span className="arr">↗</span>
        </a>
      </div>
    </section>
  );
}
