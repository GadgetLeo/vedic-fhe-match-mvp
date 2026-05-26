import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying VedicAutoMatch with:", deployer.address);

  const VedicAutoMatch = await ethers.getContractFactory("VedicAutoMatch");
  const contract = await VedicAutoMatch.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("VedicAutoMatch deployed to:", address);
  console.log("Update config.js with this address.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
