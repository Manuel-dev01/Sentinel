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
      // Match Foundry's default target. OpenZeppelin 5.x (Strings/Bytes via SentinelOracle) emits
      // `mcopy`, a Cancun opcode; without this Hardhat targets "paris" and compilation fails.
      // Somnia is full-EVM and the Cancun-compiled contracts deploy fine on testnet.
      evmVersion: "cancun",
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
  // Source verification on Shannon Explorer (Blockscout). Blockscout ignores the API key but
  // hardhat-verify requires a non-empty string. `npx hardhat verify --network somniaTestnet <addr> <args>`
  // (or `pnpm verify:testnet`, which reads constructor args from the deployment artifact).
  etherscan: {
    apiKey: {
      somniaTestnet: "blockscout",
      somniaMainnet: "blockscout",
    },
    customChains: [
      {
        network: "somniaTestnet",
        chainId: 50312,
        urls: {
          apiURL: "https://shannon-explorer.somnia.network/api",
          browserURL: "https://shannon-explorer.somnia.network",
        },
      },
      {
        network: "somniaMainnet",
        chainId: 5031,
        urls: {
          apiURL: "https://explorer.somnia.network/api",
          browserURL: "https://explorer.somnia.network",
        },
      },
    ],
  },
  sourcify: {
    enabled: false,
  },
};

export default config;
