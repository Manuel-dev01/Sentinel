import { ethers } from "hardhat";

const ORACLE = "0x2D4680c64B7bC6EA9484cbA01746c3A1036c24d2";

async function main() {
  const oracle = await ethers.getContractAt("SentinelOracle", ORACLE);
  const [signer] = await ethers.getSigners();

  console.log(`Retrying event #1 on oracle ${ORACLE}...`);
  console.log(`Caller: ${signer.address}\n`);

  const tx = await oracle.retry(1);
  console.log(`Tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
