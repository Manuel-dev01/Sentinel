/**
 * Recover the stuck depeg event on the CURRENT deployment.
 *
 * Root cause (see investigation): the registered USDC `homepageUrl` points at the JSON API
 * endpoint, but Agent #2 (LLM Parse Website) is an HTML scraper — it returned Failed/empty and
 * parked the event in `Failed`. The fix: repoint `homepageUrl` to the live HTML incident page
 * (already deployed at /issuer/incident), then `oracle.retry(eventId)` to resume from Investigate.
 *
 * This is the cheap end-to-end proof of the previously-failing Parse-Website -> Classify path
 * (~0.4 STT) before committing to a full redeploy with the contract live-slot fix.
 *
 *   EVENT_ID=1 pnpm hardhat run script/recover-event.ts --network somniaTestnet
 */
import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const STATE = ["None", "Confirming", "Investigating", "Classifying", "Classified", "Dismissed", "Failed"] as const;
const CAUSE = ["UNKNOWN", "SMART_CONTRACT_EXPLOIT", "BANK_RUN", "REGULATORY", "TECHNICAL_GLITCH"] as const;

function tx(h: string): string {
  return `https://shannon-explorer.somnia.network/tx/${h}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const c = dep.contracts;
  const insured = c.insured;
  const pageUrl =
    process.env.ISSUER_PAGE_URL?.trim() || "https://sentinel-issuer.vercel.app/issuer/incident";
  const eventId = BigInt(process.env.EVENT_ID?.trim() || "1");

  const oracle = await ethers.getContractAt("SentinelOracle", c.oracle);
  const registry = await ethers.getContractAt("SentinelRegistry", c.registry);

  console.log(`Network:    ${network.name}`);
  console.log(`Oracle:     ${c.oracle}`);
  console.log(`Registry:   ${c.registry}`);
  console.log(`Insured:    ${insured}`);
  console.log(`Page URL:   ${pageUrl}`);
  console.log(`Event:      #${eventId}\n`);

  const ev0 = await oracle.getFunction("getEvent").staticCall(eventId);
  console.log(`Event #${eventId} state: ${STATE[Number(ev0.state)]}, stage: ${Number(ev0.stage)}`);
  if (Number(ev0.state) !== 6) {
    console.log("Event is not in Failed state — nothing to recover. Exiting.");
    return;
  }

  // ── 1. Repoint homepageUrl (Agent #2 target) to the HTML page ──
  const cfg = await registry.getConfig(insured);
  console.log(`\nCurrent homepageUrl: ${cfg.homepageUrl}`);
  if (cfg.homepageUrl !== pageUrl) {
    console.log("Repointing homepageUrl -> HTML incident page…");
    const utx = await registry.updateConfig(
      insured,
      cfg.pegTarget,
      cfg.depegThresholdBps,
      cfg.minDurationSeconds,
      cfg.annualRateBps,
      { noPayoutBps: cfg.tiers.noPayoutBps, partialBps: cfg.tiers.partialBps, highBps: cfg.tiers.highBps },
      pageUrl, // homepageUrl — the Parse Website target
      cfg.socialUrl,
      cfg.repoUrl,
    );
    await utx.wait();
    console.log(`  updateConfig tx: ${tx(utx.hash)}`);
  } else {
    console.log("homepageUrl already points at the HTML page — skipping update.");
  }

  // ── 2. Retry the failed event (resumes at the Investigate stage) ──
  console.log("\nCalling oracle.retry(eventId)…");
  const rtx = await oracle.retry(eventId);
  await rtx.wait();
  console.log(`  retry tx: ${tx(rtx.hash)}`);
  const t0 = Date.now();

  // ── 3. Watch the state machine ──
  console.log("\nWatching pipeline (Parse Website -> Classify)…");
  let last = -1;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const ev = await oracle.getFunction("getEvent").staticCall(eventId);
    const s = Number(ev.state);
    if (s !== last) {
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${el.padStart(6)}s] ${STATE[s] ?? s}`);
      if (s === 3 && ev.disclosure) {
        console.log(`           disclosure: "${ev.disclosure.slice(0, 140)}${ev.disclosure.length > 140 ? "…" : ""}"`);
      }
      last = s;
    }
    if (s === 4) {
      console.log(`\n✅ CLASSIFIED: ${CAUSE[Number(ev.cause)] ?? ev.cause} · deviation ${ev.deviationBps}bps`);
      console.log("   Parse-Website -> Classify path now works end-to-end. Run simulate:depeg / settle next.");
      return;
    }
    if (s === 5) {
      console.log("\n⚠ DISMISSED — basket did not corroborate (unexpected on retry).");
      return;
    }
    if (s === 6) {
      console.log("\n✖ Event FAILED AGAIN at the Investigate/Classify stage.");
      console.log("   Parse-Website still rejects the HTML page. Next step: fall back to the JSON-API");
      console.log("   disclosure fetch (fetchString(url, 'issuer_disclosure')) in _dispatchInvestigate.");
      return;
    }
    await sleep(4_000);
  }
  console.log("\n⚠ Timed out waiting for a terminal state.");
}

main().catch((e) => {
  console.error("\n✖ recover-event failed:");
  console.error(e);
  process.exitCode = 1;
});
