/**
 * Deploy SimGateway and make depeg simulation permissionless for the demo stables.
 *
 * Today "Simulate depeg" calls the poller's owner-only `operatorSetPrice`, so only the operator can
 * trigger it — a judge cannot self-serve. SimGateway becomes the poller's owner and re-exposes that one
 * capability to anyone, but only for an allow-list of demo stables (live assets stay protected, and the
 * poller keeps owning the price oracle so the autonomous monitor is untouched).
 *
 * Steps:
 *   1. Deploy SimGateway(poller, operator).
 *   2. Allow-list the four demo stables.
 *   3. Transfer the poller's ownership to SimGateway (operator keeps control via the forwarded admin).
 *   4. Record contracts.simGateway + a verify entry in the deployment artifact.
 *
 * After this: `node script/gen-frontend.mjs`, then point the frontend Simulate/Reset at SimGateway.
 *
 *   pnpm hardhat run script/deploy-sim-gateway.ts --network somniaTestnet
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const pollerAddr: string = dep.monitor?.poller;
  if (!pollerAddr) throw new Error("No monitor.poller in the deployment artifact.");

  const [signer] = await ethers.getSigners();
  const operator = dep.operator ?? signer.address;
  const demoStables: string[] = (dep.stables ?? []).map((s: { address: string }) => s.address);
  if (demoStables.length === 0) throw new Error("No demo stables in the artifact.");

  console.log(`Network:  ${network.name}`);
  console.log(`Poller:   ${pollerAddr}`);
  console.log(`Operator: ${operator}`);
  console.log(`Demo stables (simulatable): ${demoStables.length}\n`);

  const poller = await ethers.getContractAt("PriceFeedPoller", pollerAddr);
  const currentOwner = await poller.owner();
  if (currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Poller owner is ${currentOwner}, not the deployer ${signer.address}. Cannot transfer.`);
  }

  // 1. Deploy.
  const SimGateway = await ethers.getContractFactory("SimGateway");
  const gw = await SimGateway.deploy(pollerAddr, operator);
  await gw.waitForDeployment();
  const gwAddr = await gw.getAddress();
  console.log(`  · SimGateway deployed: ${gwAddr}`);

  // 2. Allow-list the demo stables.
  await (await gw.setSimulatableBatch(demoStables, true)).wait();
  console.log(`  · allow-listed ${demoStables.length} demo stables`);

  // 3. Transfer poller ownership to the gateway.
  await (await poller.transferOwnership(gwAddr)).wait();
  console.log(`  · poller ownership -> SimGateway (verify: ${await poller.owner()})`);

  // 4. Record in the artifact.
  dep.contracts.simGateway = gwAddr;
  dep.verify = (dep.verify ?? []).filter(
    (t: { contract: string }) => t.contract !== "src/SimGateway.sol:SimGateway",
  );
  dep.verify.push({
    name: "simGateway",
    address: gwAddr,
    contract: "src/SimGateway.sol:SimGateway",
    args: [pollerAddr, operator],
  });
  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  console.log(`\nDone. SimGateway ${gwAddr} owns the poller; demo depegs are now permissionless.`);
  console.log("Next: `node script/gen-frontend.mjs`, then wire the frontend Simulate/Reset to SimGateway.simulate.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
