// Step 3 spike runner. Deploys SpikeJsonApi (when written), funds it above the
// per-agent budget, fires a JSON-API agent call, and prints the callback receipts.
// Implementation deferred to Step 3.
import { ethers, network } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`Network: ${network.name}`);
  console.log(`Signer: ${signer.address}`);
  console.log("spike runner stub. Implementation in Step 3.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
