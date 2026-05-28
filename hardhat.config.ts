import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";
const SOMNIA_TESTNET_RPC_URL =
  process.env.SOMNIA_TESTNET_RPC_URL ?? "https://api.infra.testnet.somnia.network/";
const SOMNIA_MAINNET_RPC_URL =
  process.env.SOMNIA_MAINNET_RPC_URL ?? "https://api.infra.mainnet.somnia.network/";

const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache-hardhat",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    somniaTestnet: {
      url: SOMNIA_TESTNET_RPC_URL,
      chainId: 50312,
      accounts,
    },
    somniaMainnet: {
      url: SOMNIA_MAINNET_RPC_URL,
      chainId: 5031,
      accounts,
    },
  },
};

export default config;
