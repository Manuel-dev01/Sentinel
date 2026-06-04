/**
 * Upgrade to the MULTI-ASSET autonomous poller: all four stablecoins (USDC/USDT/DAI/FRAX) monitored
 * live from real sources, all buyable. One poller = ONE 32-STT subscription lock for all four.
 *
 * Steps (operator ops on the live deployment, no core redeploy):
 *   1. Recover STT from the two DEAD oracles (withdraw → deployer) to fund this.
 *   2. Deploy 3 new live MockStables (USDT·live, DAI·live, FRAX·live); register each with a REAL
 *      CoinGecko confirm feed + TWO real issuer/status sources; buy a demo policy each.
 *   3. Deploy the multi-asset PriceFeedPoller; setFeeds([USDC·live, USDT·live, DAI·live, FRAX·live]).
 *   4. Transfer MockPriceOracle ownership from the OLD single-asset poller → the new one; disarm old.
 *   5. Fund the new poller (≥32 + buffer) and arm the cron.
 *   6. Patch deployments/somniaTestnet.json (monitor.assets[] + verify[]).
 *
 *   pnpm hardhat run script/deploy-poller-v2.ts --network somniaTestnet
 *   then: node script/gen-frontend.mjs && pnpm verify:testnet  (+ redeploy frontend)
 *
 * NOTE: the OLD single-asset poller has no withdraw — its ~41 STT is stranded (accepted cost).
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const PEG = ethers.parseEther("1");
const THRESHOLD_BPS = 50;
const MIN_DURATION = 0;
const RATE_BPS = 50;
const TIERS = { noPayoutBps: 200, partialBps: 500, highBps: 1000 };
const STABLE_FQN = "src/mocks/MockStable.sol:MockStable";
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL?.trim() || "600");
const POLLER_FUNDING = ethers.parseEther(process.env.POLLER_FUNDING_STT?.trim() || "40");
const NOTIONAL = ethers.parseEther("100000");
const TERM = 365n * 86_400n;

const cg = (id: string) => `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;

// Dead oracles to drain (NOT the current live one 0xe6d838c0…a91c).
const DEAD_ORACLES = [
  "0xd6Cfd84691DeE2C80B47c00c348cBa22636160cF",
  "0xF308D880551D3F3526Cb0e6e1B36C828213aD1ab",
];

// New live assets: real CoinGecko price + two real sources (formal + status/data).
const NEW_LIVE = [
  {
    name: "Tether USD (live)", symbol: "USDTL", cgId: "tether",
    homepage: "https://tether.to/en/transparency", social: "https://tether.to/en/news",
  },
  {
    name: "Dai (live)", symbol: "DAIL", cgId: "dai",
    homepage: "https://forum.makerdao.com", social: "https://makerburn.com",
  },
  {
    name: "Frax (live)", symbol: "FRAXL", cgId: "frax",
    homepage: "https://gov.frax.finance", social: "https://facts.frax.finance",
  },
];

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = dep.contracts;
  const platformAddr = dep.agentPlatform;
  const [signer] = await ethers.getSigners();
  console.log(`Operator: ${signer.address}  (${ethers.formatEther(await ethers.provider.getBalance(signer.address))} STT)\n`);

  // ── 1) recover STT from dead oracles ──
  console.log("─── 1) Recover STT from dead oracles ───");
  for (const addr of DEAD_ORACLES) {
    const bal = await ethers.provider.getBalance(addr);
    if (bal === 0n) { console.log(`  ${addr}: 0 STT (skip)`); continue; }
    try {
      const o = await ethers.getContractAt("SentinelOracle", addr);
      try { if (await o.subscribed()) await (await o.disarm()).wait(); } catch { /* ignore */ }
      await (await o.withdraw(signer.address, bal)).wait();
      console.log(`  ${addr}: recovered ${ethers.formatEther(bal)} STT`);
    } catch (e) {
      console.log(`  ${addr}: withdraw failed (${(e as Error).message.split("\n")[0]})`);
    }
  }
  console.log(`  deployer now ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} STT\n`);

  // ── 2) deploy + register the 3 new live assets ──
  console.log("─── 2) Deploy + register live assets ───");
  const MockStable = await ethers.getContractFactory("MockStable");
  const registry = await ethers.getContractAt("SentinelRegistry", c.registry);
  const oracle = await ethers.getContractAt("SentinelOracle", c.oracle);
  const priceOracleOldOwner = await ethers.getContractAt("PriceFeedPoller", dep.monitor.poller);
  const policy = await ethers.getContractAt("SentinelPolicy", c.policy);
  const capital = await ethers.getContractAt("MockStable", c.capital);
  await (await capital.approve(c.policy, ethers.MaxUint256)).wait();

  // Top up LP capital so the utilization cap doesn't block the extra demo policies (and leaves room
  // for external buyers). 8+ policies × 100k notional needs a pool well above the 1M seed.
  const pool = await ethers.getContractAt("SentinelPool", c.pool);
  const TOPUP_CAPITAL = ethers.parseEther("4000000");
  await (await capital.mint(signer.address, TOPUP_CAPITAL)).wait();
  await (await capital.approve(c.pool, ethers.MaxUint256)).wait();
  await (await pool.deposit(TOPUP_CAPITAL, signer.address)).wait();
  console.log(`  +${ethers.formatEther(TOPUP_CAPITAL)} sUSD LP capital deposited\n`);

  // priceOracle is owned by the OLD poller; seed new-asset prices via its operator passthrough.
  const opSetPrice = (asset: string, price: bigint) => priceOracleOldOwner.operatorSetPrice(asset, price);

  type LiveAsset = { asset: string; symbol: string; display: string; policyTokenId: string; url: string; selector: string };
  const liveAssets: LiveAsset[] = [];

  // existing USDC·live carries over
  liveAssets.push({
    asset: dep.monitor.asset, symbol: "USDCL", display: dep.monitor.display,
    policyTokenId: dep.monitor.policyTokenId, url: cg("usd-coin"), selector: "usd-coin.usd",
  });

  for (const a of NEW_LIVE) {
    const tok = await MockStable.deploy(a.name, a.symbol, 18);
    await tok.waitForDeployment();
    const addr = await tok.getAddress();
    await (
      await registry.registerStable(addr, PEG, THRESHOLD_BPS, MIN_DURATION, RATE_BPS, TIERS, a.homepage, a.social, a.social)
    ).wait();
    await (await oracle.setConfirmFeed(addr, cg(a.cgId), `${a.cgId}.usd`, 18)).wait();
    await (await opSetPrice(addr, PEG)).wait();
    const premium: bigint = await policy.quote(addr, NOTIONAL, TERM);
    await (await capital.mint(signer.address, premium)).wait();
    await (await policy.buy(addr, NOTIONAL, TERM)).wait();
    const tokenId = ((await policy.nextTokenId()) - 1n).toString();
    liveAssets.push({ asset: addr, symbol: a.symbol, display: `${a.cgId === "tether" ? "USDT" : a.cgId === "dai" ? "DAI" : "FRAX"}·live`, policyTokenId: tokenId, url: cg(a.cgId), selector: `${a.cgId}.usd` });
    dep.verify.push({ name: `liveAsset:${a.symbol}`, address: addr, contract: STABLE_FQN, args: [a.name, a.symbol, 18] });
    console.log(`  ${a.symbol} ${addr} · policy #${tokenId} · ${a.homepage} + ${a.social}`);
  }

  // ── 3) deploy the multi-asset poller + setFeeds ──
  console.log("\n─── 3) Deploy multi-asset poller ───");
  const Poller = await ethers.getContractFactory("PriceFeedPoller");
  const poller = await Poller.deploy(platformAddr, c.priceOracle, signer.address);
  await poller.waitForDeployment();
  const pollerAddr = await poller.getAddress();
  await (
    await poller.setFeeds(liveAssets.map((a) => ({ asset: a.asset, url: a.url, selector: a.selector, decimals: 18 })))
  ).wait();
  await (await poller.setPollInterval(POLL_INTERVAL)).wait();
  console.log(`  poller ${pollerAddr} · ${liveAssets.length} feeds · ${POLL_INTERVAL}s`);

  // ── 4) migrate MockPriceOracle ownership: old poller → new poller; disarm old ──
  console.log("\n─── 4) Migrate ownership + disarm old poller ───");
  await (await priceOracleOldOwner.returnPriceOracleOwnership(pollerAddr)).wait();
  try { if (await priceOracleOldOwner.armed()) await (await priceOracleOldOwner.disarm()).wait(); } catch { /* ignore */ }
  console.log(`  MockPriceOracle → ${pollerAddr}; old poller disarmed (its STT is stranded)`);

  // ── 5) fund + arm ──
  console.log("\n─── 5) Fund + arm ───");
  await (await signer.sendTransaction({ to: pollerAddr, value: POLLER_FUNDING })).wait();
  await (await poller.arm()).wait();
  console.log(`  funded ${ethers.formatEther(POLLER_FUNDING)} STT · armed · cron ${(await poller.cronSubscriptionId()).toString()}`);

  // ── 6) patch artifact ──
  c.poller = pollerAddr;
  dep.monitor = { poller: pollerAddr, pollIntervalSeconds: POLL_INTERVAL, assets: liveAssets };
  dep.demoTokens = dep.demoTokens ?? {};
  for (const a of liveAssets) dep.demoTokens[a.symbol] = a.policyTokenId;
  dep.verify.push({ name: "poller", address: pollerAddr, contract: "src/PriceFeedPoller.sol:PriceFeedPoller", args: [platformAddr, c.priceOracle, signer.address] });
  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  console.log("\nPatched artifact. Next: node script/gen-frontend.mjs && pnpm verify:testnet (+ redeploy frontend).");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
