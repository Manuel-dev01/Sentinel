/**
 * Deploy the autonomous PriceFeedPoller + a dedicated "USDC·live" monitored asset, on top of the
 * LIVE deployment (no core redeploy).
 *
 * After this:
 *   - A self-rescheduling Reactivity CRON on the poller fetches the REAL USDC price via a JSON-API
 *     agent and writes it on-chain to USDC·live — keeperless. A genuine depeg there autonomously
 *     fires the full SentinelOracle pipeline.
 *   - The poller OWNS MockPriceOracle, so the dashboard's Simulate/Reset must call
 *     poller.operatorSetPrice (the frontend is re-pointed; REDEPLOY the frontend after this).
 *   - USDC·live is registered + insured but kept OUT of the operator stable-selector; it shows in a
 *     dedicated "LIVE MONITOR" widget. Its confirm feed reads the real price too, so a real depeg
 *     can corroborate.
 *
 *   pnpm hardhat run script/deploy-poller.ts --network somniaTestnet
 *   then: node script/gen-frontend.mjs && pnpm verify:testnet   (+ redeploy the frontend)
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const PEG_TARGET = ethers.parseEther("1");
const DEPEG_THRESHOLD_BPS = 50;
const MIN_DURATION_SECONDS = 0;
const ANNUAL_RATE_BPS = 50;
const TIERS = { noPayoutBps: 200, partialBps: 500, highBps: 1000 };

// Real price source for the monitored asset (operator-configurable later via poller.setMonitor).
const PRICE_URL =
  process.env.LIVE_PRICE_URL?.trim() ||
  "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd";
const PRICE_SELECTOR = process.env.LIVE_PRICE_SELECTOR?.trim() || "usd-coin.usd";
const PRICE_DECIMALS = 18; // scale the fetched value to WAD
const POLL_INTERVAL = Number(process.env.LIVE_POLL_INTERVAL?.trim() || "120");
const POLLER_FUNDING = ethers.parseEther(process.env.POLLER_FUNDING_STT?.trim() || "34"); // ≥32 + budget

const PLATFORM_FALLBACK = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const POLICY_NOTIONAL = ethers.parseEther("100000");
const POLICY_TERM = 365n * 86_400n;

function load() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  return { file, dep: JSON.parse(fs.readFileSync(file, "utf8")) };
}
function withScenario(base: string, scenario: string): string {
  const u = new URL(base);
  u.searchParams.set("incident", scenario);
  return u.toString();
}

async function main() {
  console.log("═══ Deploy PriceFeedPoller + USDC·live monitored asset ═══\n");
  const { file, dep } = load();
  const c = dep.contracts;
  const platformAddr = process.env.AGENT_PLATFORM_ADDRESS?.trim() || dep.agentPlatform || PLATFORM_FALLBACK;
  const incidentBase: string = dep.issuerPageUrl;
  const socialBase: string = dep.issuerSocialUrl ?? incidentBase.replace("/issuer/incident", "/issuer/social");

  const [signer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(signer.address);
  console.log(`Operator: ${signer.address}  (${ethers.formatEther(bal)} STT)`);
  if (bal < POLLER_FUNDING + ethers.parseEther("5")) {
    throw new Error(`Need ≥ ${ethers.formatEther(POLLER_FUNDING + ethers.parseEther("5"))} STT (poller funding + gas).`);
  }

  const MockStable = await ethers.getContractFactory("MockStable");
  const registry = await ethers.getContractAt("SentinelRegistry", c.registry);
  const oracle = await ethers.getContractAt("SentinelOracle", c.oracle);
  const priceOracle = await ethers.getContractAt("MockPriceOracle", c.priceOracle);
  const policy = await ethers.getContractAt("SentinelPolicy", c.policy);
  const capital = await ethers.getContractAt("MockStable", c.capital);

  // 1) the monitored asset (a MockStable standing in for real USDC's peg).
  const mon = await MockStable.deploy("USD Coin (live)", "USDCL", 18);
  await mon.waitForDeployment();
  const monAddr = await mon.getAddress();
  console.log(`USDC·live (USDCL): ${monAddr}`);

  await (
    await registry.registerStable(
      monAddr,
      PEG_TARGET,
      DEPEG_THRESHOLD_BPS,
      MIN_DURATION_SECONDS,
      ANNUAL_RATE_BPS,
      TIERS,
      withScenario(incidentBase, "exploit"),
      withScenario(socialBase, "exploit"),
      withScenario(socialBase, "exploit"),
    )
  ).wait();
  // Confirm feed reads the REAL price (so a genuine depeg can corroborate).
  await (await oracle.setConfirmFeed(monAddr, PRICE_URL, PRICE_SELECTOR, PRICE_DECIMALS)).wait();
  await (await priceOracle.setPrice(monAddr, PEG_TARGET)).wait();
  console.log(`  registered + confirm feed (real price) + seeded @ $1.0000`);

  // demo policy on the monitored asset (so a real break pays a real policyholder).
  await (await capital.approve(c.policy, ethers.MaxUint256)).wait();
  const premium: bigint = await policy.quote(monAddr, POLICY_NOTIONAL, POLICY_TERM);
  await (await capital.mint(signer.address, premium)).wait();
  await (await policy.buy(monAddr, POLICY_NOTIONAL, POLICY_TERM)).wait();
  const monTokenId: bigint = (await policy.nextTokenId()) - 1n;
  console.log(`  demo policy #${monTokenId.toString()}\n`);

  // 2) the poller.
  const Poller = await ethers.getContractFactory("PriceFeedPoller");
  const poller = await Poller.deploy(platformAddr, c.priceOracle, signer.address);
  await poller.waitForDeployment();
  const pollerAddr = await poller.getAddress();
  console.log(`PriceFeedPoller: ${pollerAddr}`);

  await (await poller.setMonitor(monAddr, PRICE_URL, PRICE_SELECTOR, PRICE_DECIMALS)).wait();
  await (await poller.setPollInterval(POLL_INTERVAL)).wait();
  console.log(`  monitor: ${PRICE_URL} [${PRICE_SELECTOR}] every ${POLL_INTERVAL}s`);

  // 3) fund the poller (≥32 STT held for the subscription + agent budget).
  await (await signer.sendTransaction({ to: pollerAddr, value: POLLER_FUNDING })).wait();
  console.log(`  funded ${ethers.formatEther(POLLER_FUNDING)} STT`);

  // 4) hand MockPriceOracle to the poller so it (and the operator passthrough) can write prices.
  await (await priceOracle.transferOwnership(pollerAddr)).wait();
  console.log(`  MockPriceOracle ownership → poller (Simulate now routes via poller.operatorSetPrice)`);

  // 5) arm the autonomous cron.
  const armTx = await poller.arm();
  await armTx.wait();
  const subId = await poller.cronSubscriptionId();
  console.log(`  armed · cron subscription ${subId.toString()}\n`);

  // 6) patch artifact.
  c.poller = pollerAddr;
  dep.monitor = {
    poller: pollerAddr,
    asset: monAddr,
    symbol: "USDCL",
    display: "USDC·live",
    policyTokenId: monTokenId.toString(),
    url: PRICE_URL,
    selector: PRICE_SELECTOR,
    pollIntervalSeconds: POLL_INTERVAL,
  };
  dep.demoTokens = dep.demoTokens ?? {};
  dep.demoTokens["USDCL"] = monTokenId.toString();
  dep.verify = dep.verify ?? [];
  dep.verify.push({ name: "monitorAsset:USDCL", address: monAddr, contract: "src/mocks/MockStable.sol:MockStable", args: ["USD Coin (live)", "USDCL", 18] });
  dep.verify.push({ name: "poller", address: pollerAddr, contract: "src/PriceFeedPoller.sol:PriceFeedPoller", args: [platformAddr, c.priceOracle, signer.address] });
  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");

  console.log("Patched deployments artifact.");
  console.log("\nNext:");
  console.log("  node script/gen-frontend.mjs   # exposes addresses.poller + deployment.monitor");
  console.log("  pnpm verify:testnet            # verify the poller + monitor asset");
  console.log("  ⚠ REDEPLOY the frontend — Simulate/Reset now route through poller.operatorSetPrice.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
