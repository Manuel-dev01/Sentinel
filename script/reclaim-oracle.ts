/**
 * Reclaim native STT parked in a retired SentinelOracle back to the operator/deployer.
 * disarm() (frees the 32-ether subscription-owner hold) then withdraw(full balance).
 *
 *   OLD_ORACLE=0x... pnpm hardhat run script/reclaim-oracle.ts --network somniaTestnet
 */
import { ethers, network } from "hardhat";
const tx = (h: string) => `https://shannon-explorer.somnia.network/tx/${h}`;
async function main() {
  const addr = process.env.OLD_ORACLE?.trim();
  if (!addr) throw new Error("Set OLD_ORACLE=0x...");
  const [signer] = await ethers.getSigners();
  const oracle = await ethers.getContractAt("SentinelOracle", addr);
  console.log(`Network:  ${network.name}`);
  console.log(`Oracle:   ${addr}`);
  console.log(`Deployer: ${signer.address}`);
  const owner = await oracle.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer is not the Oracle owner (owner=${owner}).`);
  }
  let bal = await ethers.provider.getBalance(addr);
  console.log(`Oracle balance: ${ethers.formatEther(bal)} STT`);

  if (await oracle.subscribed()) {
    console.log("disarm()…");
    const d = await oracle.disarm();
    await d.wait();
    console.log(`  disarm tx: ${tx(d.hash)}`);
  } else {
    console.log("Already disarmed.");
  }

  bal = await ethers.provider.getBalance(addr);
  if (bal === 0n) {
    console.log("Nothing to withdraw.");
    return;
  }
  console.log(`withdraw(${ethers.formatEther(bal)} STT -> deployer)…`);
  const w = await oracle.withdraw(signer.address, bal);
  await w.wait();
  console.log(`  withdraw tx: ${tx(w.hash)}`);
  console.log(`Oracle balance now: ${ethers.formatEther(await ethers.provider.getBalance(addr))} STT`);
  console.log(`Deployer balance now: ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} STT`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
