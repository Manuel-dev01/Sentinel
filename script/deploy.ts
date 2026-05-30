/**
 * M6 — Deploy + wire + seed the full Sentinel protocol on Somnia testnet.
 *
 * Order (bottom-up by dependency):
 *   1. CAPITAL token (sUSD)  — pool capital + premiums + payouts (does not depeg).
 *   2. INSURED token (USDC)  — the watched stablecoin that depegs.
 *   3. MockPriceOracle       — operator-controlled price feed for INSURED (the detection source).
 *   4. SentinelRegistry      — register INSURED with its risk params + issuer URLs.
 *   5. SentinelPool(CAPITAL) — LP vault.
 *   6. SentinelPolicy        — ERC-721 coverage (premium in CAPITAL).
 *   7. SentinelTreasury      — payout execution.
 *   8. SentinelOracle        — reactive engine; subscribes to MockPriceOracle.PriceUpdated.
 *
 * Then: wire roles, register the stable, set the confirm feed, fund the Oracle (>=32 STT for the
 * subscription + agent-request budget), arm() the subscription, seed the pool, and buy one policy.
 *
 * Writes deployments/somniaTestnet.json and prints a copy-paste .env / README block.
 *
 *   pnpm deploy:testnet   # = hardhat run script/deploy.ts --network somniaTestnet
 *
 * Requires in .env: DEPLOYER_PRIVATE_KEY, AGENT_PLATFORM_ADDRESS, MOCK_ISSUER_URL.
 * Optional: ISSUER_PAGE_URL (Parse Website target; defaults to MOCK_ISSUER_URL),
 *           ORACLE_FUNDING_STT (default 34), POOL_SEED (default 1_000_000),
 *           POLICY_NOTIONAL (default 100_000), POLICY_TERM_DAYS (default 365).
 */

import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const PLATFORM_FALLBACK_TESTNET = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";

// Demo risk params for the insured stable.
const PEG_TARGET = ethers.parseEther("1"); // $1.00 in WAD
const DEPEG_THRESHOLD_BPS = 50; // 0.5% arms detection
const MIN_DURATION_SECONDS = 0; // demo: first breach triggers immediately
const ANNUAL_RATE_BPS = 50; // 0.50%/yr premium
const TIERS = { noPayoutBps: 200, partialBps: 500, highBps: 1000 }; // 2% / 5% / 10%
const POLICY_MIN_AGE = 0; // demo: policy eligible immediately (prod would be > 0)
const UTILIZATION_CAP_BPS = 8_000; // 80%

// Confirm feed: read the integer WAD price string with decimals=0 (no decimal-point parsing).
const CONFIRM_SELECTOR = "price_wad";
const CONFIRM_DECIMALS = 0;

function ensureEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "" || v.includes("...")) {
    throw new Error(`Missing or placeholder env var: ${name}. Edit .env and re-run.`);
  }
  return v.trim();
}

function explorerAddr(a: string): string {
  const base = process.env.SOMNIA_EXPLORER_URL ?? "https://shannon-explorer.somnia.network/";
  return `${base.replace(/\/$/, "")}/address/${a}`;
}

function explorerTx(h: string): string {
  const base = process.env.SOMNIA_EXPLORER_URL ?? "https://shannon-explorer.somnia.network/";
  return `${base.replace(/\/$/, "")}/tx/${h}`;
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log(" SENTINEL · M6 · DEPLOY + WIRE + SEED");
  console.log("══════════════════════════════════════════════════════════════\n");

  const platformAddr = process.env.AGENT_PLATFORM_ADDRESS?.trim() || PLATFORM_FALLBACK_TESTNET;
  const issuerJsonUrl = ensureEnv("MOCK_ISSUER_URL"); // basket JSON (confirm stage)
  const issuerPageUrl = process.env.ISSUER_PAGE_URL?.trim() || issuerJsonUrl; // Parse Website target
  const oracleFunding = ethers.parseEther(process.env.ORACLE_FUNDING_STT?.trim() || "34");
  const poolSeed = ethers.parseEther(process.env.POOL_SEED?.trim() || "1000000");
  const policyNotional = ethers.parseEther(process.env.POLICY_NOTIONAL?.trim() || "100000");
  const policyTerm = BigInt(Number(process.env.POLICY_TERM_DAYS?.trim() || "365")) * 86_400n;

  const [signer] = await ethers.getSigners();
  const startBalance = await ethers.provider.getBalance(signer.address);
  console.log(`Network:        ${network.name}`);
  console.log(`Operator:       ${signer.address}`);
  console.log(`Start balance:  ${ethers.formatEther(startBalance)} STT`);
  console.log(`Agent platform: ${platformAddr}`);
  console.log(`Basket JSON:    ${issuerJsonUrl}`);
  console.log(`Issuer page:    ${issuerPageUrl}\n`);

  if (startBalance < oracleFunding + ethers.parseEther("3")) {
    throw new Error(
      `Deployer needs >= ${ethers.formatEther(oracleFunding + ethers.parseEther("3"))} STT ` +
        `(Oracle funding ${ethers.formatEther(oracleFunding)} + gas). Top up and re-run.`,
    );
  }

  // ───────────────────────── 1–2. tokens ─────────────────────────
  console.log("─── Tokens ───────────────────────────────────────────────────");
  const MockStable = await ethers.getContractFactory("MockStable");
  const capital = await MockStable.deploy("Sentinel USD", "sUSD", 18);
  await capital.waitForDeployment();
  const capitalAddr = await capital.getAddress();
  console.log(`CAPITAL (sUSD):    ${capitalAddr}`);

  const insured = await MockStable.deploy("USD Coin", "USDC", 18);
  await insured.waitForDeployment();
  const insuredAddr = await insured.getAddress();
  console.log(`INSURED (USDC):    ${insuredAddr}`);

  // ───────────────────────── 3. price oracle ─────────────────────────
  const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
  const priceOracle = await MockPriceOracle.deploy(signer.address);
  await priceOracle.waitForDeployment();
  const priceOracleAddr = await priceOracle.getAddress();
  console.log(`MockPriceOracle:   ${priceOracleAddr}`);
  // Seed the insured at peg so the dashboard shows a healthy peg before the demo.
  await (await priceOracle.setPrice(insuredAddr, PEG_TARGET)).wait();
  console.log(`  · seeded USDC @ $1.0000\n`);

  // ───────────────────────── 4–8. core contracts ─────────────────────────
  console.log("─── Core contracts ───────────────────────────────────────────");
  const SentinelRegistry = await ethers.getContractFactory("SentinelRegistry");
  const registry = await SentinelRegistry.deploy(signer.address);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`SentinelRegistry:  ${registryAddr}`);

  const SentinelPool = await ethers.getContractFactory("SentinelPool");
  const pool = await SentinelPool.deploy(capitalAddr, signer.address, UTILIZATION_CAP_BPS);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log(`SentinelPool:      ${poolAddr}`);

  const SentinelPolicy = await ethers.getContractFactory("SentinelPolicy");
  const policy = await SentinelPolicy.deploy(capitalAddr, registryAddr, poolAddr, signer.address, POLICY_MIN_AGE);
  await policy.waitForDeployment();
  const policyAddr = await policy.getAddress();
  console.log(`SentinelPolicy:    ${policyAddr}`);

  const SentinelTreasury = await ethers.getContractFactory("SentinelTreasury");
  const treasury = await SentinelTreasury.deploy(registryAddr, poolAddr, policyAddr, signer.address);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log(`SentinelTreasury:  ${treasuryAddr}`);

  const SentinelOracle = await ethers.getContractFactory("SentinelOracle");
  const oracle = await SentinelOracle.deploy(platformAddr, registryAddr, treasuryAddr, priceOracleAddr, signer.address);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`SentinelOracle:    ${oracleAddr}`);
  console.log(`Explorer:          ${explorerAddr(oracleAddr)}\n`);

  // ───────────────────────── wire roles ─────────────────────────
  console.log("─── Wire authorizations ──────────────────────────────────────");
  await (await pool.grantRole(await pool.POLICY_ROLE(), policyAddr)).wait();
  await (await pool.grantRole(await pool.TREASURY_ROLE(), treasuryAddr)).wait();
  await (await policy.grantRole(await policy.CLAIM_MANAGER_ROLE(), treasuryAddr)).wait();
  await (await treasury.grantRole(await treasury.ORACLE_ROLE(), oracleAddr)).wait();
  console.log(`  · pool.POLICY_ROLE     -> SentinelPolicy`);
  console.log(`  · pool.TREASURY_ROLE   -> SentinelTreasury`);
  console.log(`  · policy.CLAIM_MANAGER -> SentinelTreasury`);
  console.log(`  · treasury.ORACLE_ROLE -> SentinelOracle\n`);

  // ───────────────────────── register stable + confirm feed ─────────────────────────
  console.log("─── Register insured stable ──────────────────────────────────");
  await (
    await registry.registerStable(
      insuredAddr,
      PEG_TARGET,
      DEPEG_THRESHOLD_BPS,
      MIN_DURATION_SECONDS,
      ANNUAL_RATE_BPS,
      TIERS,
      issuerPageUrl, // homepageUrl — the Parse Website target
      issuerPageUrl, // socialUrl (unused in demo)
      issuerPageUrl, // repoUrl (unused in demo)
    )
  ).wait();
  console.log(`  · registered USDC (threshold ${DEPEG_THRESHOLD_BPS}bps, rate ${ANNUAL_RATE_BPS}bps)`);
  await (await oracle.setConfirmFeed(insuredAddr, issuerJsonUrl, CONFIRM_SELECTOR, CONFIRM_DECIMALS)).wait();
  console.log(`  · confirm feed: ${issuerJsonUrl} [${CONFIRM_SELECTOR}, decimals=${CONFIRM_DECIMALS}]\n`);

  // ───────────────────────── fund + arm the Oracle ─────────────────────────
  console.log("─── Fund + arm Oracle ────────────────────────────────────────");
  await (await signer.sendTransaction({ to: oracleAddr, value: oracleFunding })).wait();
  console.log(`  · funded Oracle with ${ethers.formatEther(oracleFunding)} STT (>=32 subscription + agent budget)`);
  const armTx = await oracle.arm();
  await armTx.wait();
  const subId = await oracle.subscriptionId();
  console.log(`  · arm() tx: ${explorerTx(armTx.hash)}`);
  console.log(`  · subscriptionId: ${subId.toString()}\n`);

  // ───────────────────────── seed pool ─────────────────────────
  console.log("─── Seed LP pool ─────────────────────────────────────────────");
  await (await capital.mint(signer.address, poolSeed)).wait();
  await (await capital.approve(poolAddr, ethers.MaxUint256)).wait();
  await (await pool.deposit(poolSeed, signer.address)).wait();
  console.log(`  · deposited ${ethers.formatEther(poolSeed)} sUSD as LP capital\n`);

  // ───────────────────────── buy a demo policy ─────────────────────────
  console.log("─── Buy demo policy ──────────────────────────────────────────");
  const premium: bigint = await policy.quote(insuredAddr, policyNotional, policyTerm);
  // Mint premium + a buffer to the operator (who is also the demo policyholder).
  await (await capital.mint(signer.address, premium)).wait();
  await (await capital.approve(policyAddr, ethers.MaxUint256)).wait();
  const buyTx = await policy.buy(insuredAddr, policyNotional, policyTerm);
  await buyTx.wait();
  const tokenId: bigint = (await policy.nextTokenId()) - 1n;
  console.log(`  · bought policy #${tokenId.toString()}: notional ${ethers.formatEther(policyNotional)} USDC, premium ${ethers.formatEther(premium)} sUSD, term ${policyTerm / 86_400n}d\n`);

  // ───────────────────────── artifact + env block ─────────────────────────
  const endBalance = await ethers.provider.getBalance(signer.address);
  const deployment = {
    network: network.name,
    chainId: 50312,
    deployedAt: new Date().toISOString(),
    operator: signer.address,
    agentPlatform: platformAddr,
    issuerJsonUrl,
    issuerPageUrl,
    subscriptionId: subId.toString(),
    demoTokenId: tokenId.toString(),
    contracts: {
      capital: capitalAddr,
      insured: insuredAddr,
      priceOracle: priceOracleAddr,
      registry: registryAddr,
      pool: poolAddr,
      policy: policyAddr,
      treasury: treasuryAddr,
      oracle: oracleAddr,
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2) + "\n");

  console.log("══════════════════════════════════════════════════════════════");
  console.log(" DEPLOYED");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`Artifact:       ${path.relative(process.cwd(), outFile)}`);
  console.log(`STT spent:      ${ethers.formatEther(startBalance - endBalance)} (incl. ${ethers.formatEther(oracleFunding)} parked in Oracle)`);
  console.log("\nFrontend .env block:");
  console.log(`NEXT_PUBLIC_REGISTRY_ADDRESS=${registryAddr}`);
  console.log(`NEXT_PUBLIC_POOL_ADDRESS=${poolAddr}`);
  console.log(`NEXT_PUBLIC_POLICY_ADDRESS=${policyAddr}`);
  console.log(`NEXT_PUBLIC_TREASURY_ADDRESS=${treasuryAddr}`);
  console.log(`NEXT_PUBLIC_ORACLE_ADDRESS=${oracleAddr}`);
  console.log("\nNext: pnpm simulate:depeg  (pushes USDC below peg and watches the pipeline to SETTLED)\n");
}

main().catch((err) => {
  console.error("\n✖ Deploy failed:");
  console.error(err);
  process.exitCode = 1;
});
