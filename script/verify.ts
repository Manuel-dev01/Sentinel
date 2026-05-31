/**
 * Source-verify every deployed Sentinel contract on Shannon Explorer (Blockscout).
 *
 * Reads deployments/<network>.json (the `verify` array deploy.ts writes: address + FQN +
 * constructor args) and shells out to `forge verify-contract` against the Blockscout verifier.
 *
 * Why forge and not hardhat-verify: hardhat-verify v2 routes through the Etherscan-V2 multichain
 * endpoint, which doesn't know Somnia's chain id, so it reports every address as "not a smart
 * contract." forge's `--verifier blockscout --verifier-url` talks to Shannon Explorer directly
 * and works (foundry.toml's solc 0.8.30 / cancun / optimizer-200 match the Hardhat deploy build,
 * so the bytecode matches).
 *
 * Verification is what makes the explorer show a contract's Code / Read / Write tabs and decoded
 * state. Without it, even a real, working contract renders as an opaque/EOA-like address — which
 * is what made the earlier deploy look "fake."
 *
 * NOTE: Shannon Explorer's Blockscout indexer only accepts verification once it has flagged the
 * address as a contract (`is_contract: true` in /api/v2/addresses/<a>). Freshly-deployed contracts
 * can take a few minutes to flip; forge retries the detection. If a target persists as "not a smart
 * contract," wait a minute and re-run — this is indexer lag, not a deploy problem.
 *
 *   pnpm verify:testnet   # = hardhat run script/verify.ts --network somniaTestnet
 */

import hre, { ethers, network } from "hardhat";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as fs from "fs";
import * as path from "path";

type Target = { name: string; address: string; contract: string; args: unknown[] };

/**
 * Resolve the forge binary. Foundry (via foundryup) installs to ~/.foundry/bin, which is on the
 * Bash/CI PATH but NOT the Windows PowerShell PATH — so a bare `forge` ENOENTs when this script is
 * run through `pnpm` from PowerShell. Prefer $FORGE_BIN, then the foundry home install, then PATH.
 */
function resolveForge(): string {
  const fromEnv = process.env.FORGE_BIN?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const home = process.env.FOUNDRY_DIR?.trim() || path.join(os.homedir(), ".foundry");
  const candidates =
    process.platform === "win32"
      ? [path.join(home, "bin", "forge.exe"), path.join(home, "bin", "forge")]
      : [path.join(home, "bin", "forge")];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "forge"; // last resort: rely on PATH
}

const FORGE = resolveForge();

const VERIFIER_URLS: Record<string, string> = {
  somniaTestnet: "https://shannon-explorer.somnia.network/api/",
  somniaMainnet: "https://explorer.somnia.network/api/",
};

function loadDeployment(): { verify?: Target[] } {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment artifact at ${file}. Run \`pnpm deploy:testnet\` first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** ABI-encode constructor args using the compiled artifact's constructor input types. */
async function encodeArgs(target: Target): Promise<string> {
  if (target.args.length === 0) return "0x";
  const artifact = await hre.artifacts.readArtifact(target.contract);
  const ctor = artifact.abi.find((e: { type: string }) => e.type === "constructor") as
    | { inputs: { type: string }[] }
    | undefined;
  const types = (ctor?.inputs ?? []).map((i) => i.type);
  return ethers.AbiCoder.defaultAbiCoder().encode(types, target.args);
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log(" SENTINEL · SOURCE VERIFICATION (Shannon Explorer / Blockscout)");
  console.log("══════════════════════════════════════════════════════════════\n");

  const verifierUrl = VERIFIER_URLS[network.name];
  if (!verifierUrl) throw new Error(`No Blockscout verifier URL configured for network ${network.name}.`);

  const dep = loadDeployment();
  const targets = dep.verify;
  if (!targets || targets.length === 0) {
    throw new Error("Deployment artifact has no `verify` array — redeploy with the updated deploy.ts.");
  }

  let ok = 0;
  let already = 0;
  let failed = 0;
  for (const t of targets) {
    console.log(`· ${t.name.padEnd(14)} ${t.address}`);
    try {
      const encoded = await encodeArgs(t);
      const out = execFileSync(
        FORGE,
        [
          "verify-contract",
          t.address,
          t.contract,
          "--verifier",
          "blockscout",
          "--verifier-url",
          verifierUrl,
          "--constructor-args",
          encoded,
          "--watch",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (/already verified/i.test(out)) {
        console.log("  already verified ✓");
        already++;
      } else if (/successfully verified|Pass - Verified/i.test(out)) {
        console.log("  verified ✅");
        ok++;
      } else {
        console.log(`  done — ${out.trim().split("\n").pop()}`);
        ok++;
      }
    } catch (e) {
      const msg = ((e as { stdout?: string }).stdout ?? (e as Error).message ?? String(e)).toString();
      if (/already verified/i.test(msg)) {
        console.log("  already verified ✓");
        already++;
      } else {
        console.log(`  FAILED — ${msg.trim().split("\n").pop()}`);
        failed++;
      }
    }
  }

  console.log(`\n── SUMMARY ── verified ${ok}, already ${already}, failed ${failed}`);
  if (failed > 0) {
    console.log("If failures say 'not a smart-contract', that's Blockscout indexer lag — wait a minute and re-run.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n✖ Verify failed:");
  console.error(err);
  process.exitCode = 1;
});
