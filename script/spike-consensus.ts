/**
 * GATING SPIKE — is 3/3 consensus achievable on Somnia testnet?
 *
 * The Oracle currently advances on 2-of-3 majority, but the product thesis is 3/3 unanimity. Every
 * prior spike returned only 2 validator responses with a BASIC createRequest. This fires an ADVANCED
 * request explicitly asking for subcommitteeSize=3, threshold=3, ConsensusType.Threshold, and reports
 * how many validators actually respond. If 3 respond Success+identical, 3/3 is viable; if only 2, we
 * must decide (bigger subcommittee vs soften the claim) before changing the contract.
 *
 *   COMMITTEE=3 THRESHOLD=3 ADV_TIMEOUT=0 pnpm hardhat run script/spike-consensus.ts --network somniaTestnet
 */
import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

const RS = ["None", "Pending", "Success", "Failed", "TimedOut"] as const;
const PLATFORM = process.env.AGENT_PLATFORM_ADDRESS?.trim() || "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const url = process.env.MOCK_ISSUER_URL?.trim() || "https://sentinel-issuer.vercel.app/api/peg-status";
  const size = BigInt(process.env.COMMITTEE?.trim() || "3");
  const threshold = BigInt(process.env.THRESHOLD?.trim() || "3");
  const advTimeout = BigInt(process.env.ADV_TIMEOUT?.trim() || "0");

  const [signer] = await ethers.getSigners();
  console.log(`Network:   ${network.name}`);
  console.log(`Signer:    ${signer.address}  (${ethers.formatEther(await ethers.provider.getBalance(signer.address))} STT)`);
  console.log(`Feed:      ${url} [price]`);
  console.log(`Request:   subcommittee=${size}, threshold=${threshold}, ConsensusType.Threshold, timeout=${advTimeout}\n`);

  const platform = new ethers.Contract(
    PLATFORM,
    [
      "function getAdvancedRequestDeposit(uint256) view returns (uint256)",
      "function getRequestDeposit() view returns (uint256)",
    ],
    signer,
  );
  let floor: bigint;
  try {
    floor = await platform.getAdvancedRequestDeposit(size);
  } catch {
    floor = await platform.getRequestDeposit();
  }
  // floor + generous per-validator budget × size + buffer.
  const value = floor + ethers.parseEther("0.05") * size + ethers.parseEther("0.03");
  console.log(`Deposit floor ${ethers.formatEther(floor)} → sending ${ethers.formatEther(value)} STT\n`);

  const Spike = await ethers.getContractFactory("SpikeJsonApi");
  const spike = await Spike.deploy(PLATFORM);
  await spike.waitForDeployment();
  const addr = await spike.getAddress();
  console.log(`SpikeJsonApi: ${addr}`);

  const tx = await spike.fireAdvanced(url, "price", size, threshold, advTimeout, { value });
  await tx.wait();
  const reqId: bigint = await spike.lastRequestId();
  console.log(`fireAdvanced tx: https://shannon-explorer.somnia.network/tx/${tx.hash}`);
  console.log(`requestId: ${reqId}\n`);

  console.log("Polling contract state (up to 240s)…");
  const deadline = Date.now() + 240_000;
  let lastN = -1;
  while (Date.now() < deadline) {
    const finalized: boolean = await spike.callbackSeen(reqId);
    const responses = await spike.responsesFor(reqId);
    if (responses.length !== lastN) {
      console.log(`  · ${responses.length} response(s)${finalized ? " · finalized" : ""}`);
      lastN = responses.length;
    }
    if (finalized) break;
    await sleep(5_000);
  }

  const responses = await spike.responsesFor(reqId);
  const status: number = Number(await spike.statusByRequest(reqId));
  console.log(`\n── RESULT ──`);
  console.log(`overall status: ${RS[status] ?? status}`);
  console.log(`responses: ${responses.length}`);
  const decoded: string[] = [];
  for (const r of responses) {
    let val = r.result as string;
    try {
      [val] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], r.result);
    } catch {
      /* leave raw */
    }
    decoded.push(val);
    console.log(`  · ${r.validator} · ${RS[Number(r.status)]} · cost ${ethers.formatEther(r.executionCost)} · "${val}"`);
  }
  const successes = responses.filter((r: { status: bigint }) => Number(r.status) === 2);
  const unique = new Set(decoded);
  console.log(`\nSuccess responses: ${successes.length} / requested ${size}`);
  console.log(`distinct results:  ${unique.size}`);

  console.log(`\n── VERDICT ──`);
  if (successes.length >= Number(size) && unique.size === 1) {
    console.log(`✅ 3/3 ACHIEVABLE — ${successes.length} validators returned Success, all identical. Proceed with unanimity in the contract.`);
  } else {
    console.log(`⚠ 3/3 NOT met — only ${successes.length} Success response(s) (distinct=${unique.size}). Decide: raise subcommittee size, or keep 2-of-3 + soften the marketing claim.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
