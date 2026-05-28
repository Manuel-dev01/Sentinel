// Deploy stub. Filled in during Step 4 once core contracts exist.
// Run: pnpm deploy:testnet
import { ethers, network } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);
  console.log("No contracts to deploy yet. See plan Step 4.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
