// Demo trigger stub. Pushes a sub-peg price into MockPriceOracle to fire the
// Reactivity subscription that drives the SentinelOracle pipeline.
// Filled in after Oracle + MockPriceOracle are deployed.
// Run: pnpm simulate:depeg
import { ethers, network } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`Network: ${network.name}`);
  console.log(`Signer: ${signer.address}`);
  console.log("simulate-depeg stub. Implementation in Step 4 once MockPriceOracle is deployed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
