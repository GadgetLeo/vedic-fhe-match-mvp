require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const PK = process.env.PRIVATE_KEY;

if (!PK) {
  console.error('PRIVATE_KEY missing');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PK, provider);

const abi = JSON.parse(fs.readFileSync('../src/abi-vedic.js', 'utf8')).VedicAutoMatch;
const bytecode = fs.readFileSync('../src/VedicAutoMatch.bytecode', 'utf8').trim();

async function main() {
  console.log('Deployer:', wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log('Balance:', ethers.formatEther(balance), 'ETH');

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log('Deployed to:', address);
}

main().catch(console.error);
