import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import "@cofhe/hardhat-plugin";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  cofhe: { logMocks: true, gasWarning: true },
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  defaultNetwork: "hardhat",
  networks: {
    "base-sepolia": {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 84532,
      gasMultiplier: 1.2,
      timeout: 120000,
    },
  },
  etherscan: {
    apiKey: { "base-sepolia": process.env.BASESCAN_API_KEY || "" },
  },
};
export default config;
