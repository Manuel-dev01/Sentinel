/**
 * Redeploy SentinelOracle with the investigate-stall fix (handleResponse now re-derives consensus
 * from the validator votes instead of trusting the platform's overall status label), then migrate the
 * live deployment onto it WITHOUT redeploying anything else.
 *
 * Steps:
 *   1. Read the old Oracle's config on-chain (confirm feeds per stable, agent ids, budgets, investigate
 *      params) so the new Oracle is byte-for-byte identical except for the bug fix.
 *   2. Deploy the new Oracle (same ctor args) and replicate that config.
 *   3. Move treasury.ORACLE_ROLE: grant to new, revoke from old.
 *   4. Fund (>=32 STT subscription + agent budget) and arm() the new Oracle.
 *   5. Retire the old Oracle: disarm() and withdraw its STT back to the deployer.
 *   6. Rewrite deployments/somniaTestnet.json (contracts.oracle, subscriptionId, verify entry).
 *
 * After this: run `node script/gen-frontend.mjs` to repoint the frontend, then `pnpm simulate:depeg`
 * a few times to repopulate the audit history on the new Oracle, then `pnpm verify:testnet`.
 *
 *   pnpm hardhat run script/redeploy-oracle.ts --network somniaTestnet
 *
 * Optional env: ORACLE_FUNDING_STT (default 40).
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const tx = (h: string) => `https://shannon-explorer.somnia.network/tx/${h}`;
const FUNDING = ethers.parseEther(process.env.ORACLE_FUNDING_STT?.trim() || "40");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = dep.contracts;
  const [signer] = await ethers.getSigners();

  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${signer.address}`);
  console.log(`Old Oracle: ${c.oracle}\n`);

  const oldOracle = await ethers.getContractAt("SentinelOracle", c.oracle);
  const treasury = await ethers.getContractAt("SentinelTreasury", c.treasury);
  if ((await oldOracle.owner()).toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("Signer is not the old Oracle owner.");
  }

  // Unified list of every insured stable: demo + autonomous live assets.
  const stables: { label: string; addr: string }[] = [
    ...dep.stables.map((s: { symbol: string; address: string }) => ({ label: s.symbol, addr: s.address })),
    ...((dep.monitor?.assets ?? []) as { symbol?: string; display?: string; asset: string }[]).map((a) => ({
      label: a.display ?? a.symbol ?? "live",
      addr: a.asset,
    })),
  ];

  // ── 1) Read the old config to replicate exactly ──
  console.log("─── Reading old Oracle config ───");
  const feeds: { label: string; addr: string; url: string; selector: string; decimals: number }[] = [];
  for (const s of stables) {
    const f = await oldOracle.confirmFeeds(s.addr); // (url, selector, decimals)
    feeds.push({ ...s, url: f[0], selector: f[1], decimals: Number(f[2]) });
    console.log(`  ${s.label.padEnd(10)} feed=${f[0] || "(none)"} sel=${f[1]} dec=${Number(f[2])}`);
  }
  const agentIds = {
    json: await oldOracle.jsonApiAgentId(),
    parse: await oldOracle.parseWebsiteAgentId(),
    llm: await oldOracle.llmInferenceAgentId(),
  };
  const budgets = {
    confirm: await oldOracle.confirmBudget(),
    investigate: await oldOracle.investigateBudget(),
    classify: await oldOracle.classifyBudget(),
  };
  const ip = await oldOracle.investigateParams(); // struct: key, description, prompt, resolveUrl, numPages, confidenceThreshold

  // ── 2) Deploy the new Oracle (same ctor args) ──
  console.log("\n─── Deploying fixed Oracle ───");
  const platformAddr = dep.agentPlatform;
  const Factory = await ethers.getContractFactory("SentinelOracle");
  const oracle = await Factory.deploy(platformAddr, c.registry, c.treasury, c.priceOracle, signer.address);
  await oracle.waitForDeployment();
  const newAddr = await oracle.getAddress();
  console.log(`  new Oracle: ${newAddr}`);

  // Replicate agent ids / budgets / investigate params (defensive — ctor already sets defaults).
  await (await oracle.setAgentIds(agentIds.json, agentIds.parse, agentIds.llm)).wait();
  await (await oracle.setBudgets(budgets.confirm, budgets.investigate, budgets.classify)).wait();
  await (
    await oracle.setInvestigateParams(ip.key, ip.description, ip.prompt, ip.resolveUrl, ip.numPages, ip.confidenceThreshold)
  ).wait();
  console.log("  · replicated agent ids, budgets, investigate params");

  // ── 3) Confirm feeds ──
  for (const f of feeds) {
    if (!f.url) {
      console.log(`  · skip ${f.label} (no confirm feed registered)`);
      continue;
    }
    await (await oracle.setConfirmFeed(f.addr, f.url, f.selector, f.decimals)).wait();
    console.log(`  · confirm feed set for ${f.label}`);
  }

  // ── 4) Roles: grant new, revoke old ──
  const ORACLE_ROLE = await treasury.ORACLE_ROLE();
  await (await treasury.grantRole(ORACLE_ROLE, newAddr)).wait();
  await (await treasury.revokeRole(ORACLE_ROLE, c.oracle)).wait();
  console.log("  · treasury.ORACLE_ROLE moved to the new Oracle");

  // ── 5) Fund + arm ──
  await (await signer.sendTransaction({ to: newAddr, value: FUNDING })).wait();
  const armTx = await oracle.arm();
  await armTx.wait();
  const subId = await oracle.subscriptionId();
  console.log(`  · funded ${ethers.formatEther(FUNDING)} STT + arm() · subscription ${subId.toString()}`);

  // ── 6) Retire the old Oracle ──
  if (await oldOracle.subscribed()) {
    await (await oldOracle.disarm()).wait();
    console.log("  · old Oracle disarmed");
  }
  const oldBal = await ethers.provider.getBalance(c.oracle);
  if (oldBal > 0n) {
    await (await oldOracle.withdraw(signer.address, oldBal)).wait();
    console.log(`  · reclaimed ${ethers.formatEther(oldBal)} STT from the old Oracle`);
  }

  // ── 7) Update the deployment artifact ──
  dep.contracts.oracle = newAddr;
  dep.subscriptionId = subId.toString();
  dep.verify = (dep.verify ?? []).filter(
    (t: { contract: string }) => t.contract !== "src/SentinelOracle.sol:SentinelOracle",
  );
  dep.verify.push({
    name: "oracle",
    address: newAddr,
    contract: "src/SentinelOracle.sol:SentinelOracle",
    args: [platformAddr, c.registry, c.treasury, c.priceOracle, signer.address],
  });
  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  console.log(`\nArtifact updated. Old Oracle ${c.oracle} retired → new ${newAddr}`);
  console.log("Next: `node script/gen-frontend.mjs`, then `pnpm simulate:depeg` to repopulate audit, then `pnpm verify:testnet`.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
