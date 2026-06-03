/**
 * Add two more insured stablecoins (DAI + FRAX) to the LIVE deployment — no core redeploy.
 *
 * Everything here is operator calls on the already-deployed Registry / Oracle / Pool / Policy:
 *   - deploy 2 MockStable tokens (DAI, FRAX)
 *   - registry.registerStable(...) each, with a sensible DEFAULT incident scenario baked into the
 *     issuer URLs (?incident=...). The operator scenario switch on the dashboard can re-point these
 *     at runtime via registry.updateConfig — so any asset can demo any cause.
 *   - oracle.setConfirmFeed(...) each
 *   - priceOracle.setPrice(stable, peg) so the dashboard shows them healthy
 *   - buy one demo policy each
 *   - also re-point USDT's default scenario to bank-run (updateConfig) so the four assets default to
 *     four different payout classes out of the box (USDC=exploit, USDT=bank-run, DAI=regulatory,
 *     FRAX=glitch)
 *   - patch deployments/somniaTestnet.json (stables / demoTokens / verify) and print next steps
 *
 *   pnpm hardhat run script/add-stables.ts --network somniaTestnet
 *   then: node script/gen-frontend.mjs && pnpm verify:testnet
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const PEG_TARGET = ethers.parseEther("1");
const DEPEG_THRESHOLD_BPS = 50;
const MIN_DURATION_SECONDS = 0;
const TIERS = { noPayoutBps: 200, partialBps: 500, highBps: 1000 };
const CONFIRM_SELECTOR = "price_wad";
const CONFIRM_DECIMALS = 0;

// New stables to add, each with a default incident scenario (overridable from the UI switch).
const NEW_STABLES = [
  { name: "Dai Stablecoin", symbol: "DAI", annualRateBps: 55, scenario: "regulatory" },
  { name: "Frax", symbol: "FRAX", annualRateBps: 70, scenario: "glitch" },
];
// Existing stables whose DEFAULT scenario we re-point so the four assets differ out of the box.
const REPOINT = [{ symbol: "USDT", scenario: "bank-run" }];

const STABLE_FQN = "src/mocks/MockStable.sol:MockStable";

function withScenario(base: string, scenario: string): string {
  const u = new URL(base);
  u.searchParams.set("incident", scenario);
  return u.toString();
}

function loadArtifact() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  return { file, dep: JSON.parse(fs.readFileSync(file, "utf8")) };
}

async function main() {
  console.log("─── Add stables (DAI + FRAX) to the live deployment ───────────\n");
  const { file, dep } = loadArtifact();
  const c = dep.contracts;
  const incidentBase: string = dep.issuerPageUrl;
  const socialBase: string = dep.issuerSocialUrl ?? dep.issuerPageUrl.replace("/issuer/incident", "/issuer/social");
  const jsonUrl: string = dep.issuerJsonUrl;

  const [signer] = await ethers.getSigners();
  console.log(`Operator: ${signer.address}`);
  console.log(`Registry: ${c.registry}\n`);

  const MockStable = await ethers.getContractFactory("MockStable");
  const registry = await ethers.getContractAt("SentinelRegistry", c.registry);
  const oracle = await ethers.getContractAt("SentinelOracle", c.oracle);
  const priceOracle = await ethers.getContractAt("MockPriceOracle", c.priceOracle);
  const policy = await ethers.getContractAt("SentinelPolicy", c.policy);
  const capital = await ethers.getContractAt("MockStable", c.capital);

  // Make sure the Policy contract can pull premiums from the operator.
  await (await capital.approve(c.policy, ethers.MaxUint256)).wait();

  const policyNotional = ethers.parseEther("100000");
  const policyTerm = 365n * 86_400n;

  dep.stables = dep.stables ?? [];
  dep.demoTokens = dep.demoTokens ?? {};
  dep.verify = dep.verify ?? [];

  for (const s of NEW_STABLES) {
    const tok = await MockStable.deploy(s.name, s.symbol, 18);
    await tok.waitForDeployment();
    const addr = await tok.getAddress();
    console.log(`${s.symbol}: ${addr}  (default scenario: ${s.scenario})`);

    const homepageUrl = withScenario(incidentBase, s.scenario);
    const socialUrl = withScenario(socialBase, s.scenario);
    await (
      await registry.registerStable(
        addr,
        PEG_TARGET,
        DEPEG_THRESHOLD_BPS,
        MIN_DURATION_SECONDS,
        s.annualRateBps,
        TIERS,
        homepageUrl,
        socialUrl,
        socialUrl,
      )
    ).wait();
    await (await oracle.setConfirmFeed(addr, jsonUrl, CONFIRM_SELECTOR, CONFIRM_DECIMALS)).wait();
    await (await priceOracle.setPrice(addr, PEG_TARGET)).wait();
    console.log(`  registered + confirm feed + seeded @ $1.0000`);

    // demo policy
    const premium: bigint = await policy.quote(addr, policyNotional, policyTerm);
    await (await capital.mint(signer.address, premium)).wait();
    await (await policy.buy(addr, policyNotional, policyTerm)).wait();
    const tokenId: bigint = (await policy.nextTokenId()) - 1n;
    dep.demoTokens[s.symbol] = tokenId.toString();
    console.log(`  bought demo policy #${tokenId.toString()}\n`);

    dep.stables.push({ address: addr, symbol: s.symbol, name: s.name, annualRateBps: s.annualRateBps });
    dep.verify.push({ name: `insured:${s.symbol}`, address: addr, contract: STABLE_FQN, args: [s.name, s.symbol, 18] });
  }

  // Re-point existing stables' default scenario (URLs only; keep all other config).
  for (const r of REPOINT) {
    const entry = dep.stables.find((x: { symbol: string }) => x.symbol === r.symbol);
    if (!entry) continue;
    const cfg = await registry.getConfig(entry.address);
    const homepageUrl = withScenario(incidentBase, r.scenario);
    const socialUrl = withScenario(socialBase, r.scenario);
    await (
      await registry.updateConfig(
        entry.address,
        cfg.pegTarget,
        cfg.depegThresholdBps,
        cfg.minDurationSeconds,
        cfg.annualRateBps,
        { noPayoutBps: cfg.tiers.noPayoutBps, partialBps: cfg.tiers.partialBps, highBps: cfg.tiers.highBps },
        homepageUrl,
        socialUrl,
        socialUrl,
      )
    ).wait();
    console.log(`re-pointed ${r.symbol} default scenario -> ${r.scenario}`);
  }

  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  console.log(`\nPatched ${path.relative(process.cwd(), file)}.`);
  console.log("Next:\n  node script/gen-frontend.mjs\n  pnpm verify:testnet   # verify the 2 new MockStables\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
