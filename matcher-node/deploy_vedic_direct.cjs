const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
const PK_RAW = process.env.PRIVATE_KEY || process.env.MATCHER_PRIVATE_KEY;
if (!PK_RAW) throw new Error('PRIVATE_KEY or MATCHER_PRIVATE_KEY required');
const PRIVATE_KEY = PK_RAW.startsWith('0x') ? PK_RAW : `0x${PK_RAW}`;

const CONTRACT_PATH = '/data/workspace/output/blind-reveal-base-sepolia/contracts/VedicAutoMatch.sol';
const CONTRACT_NAME = 'VedicAutoMatch';

function resolveImport(importPath) {
  const candidates = [
    path.resolve(path.dirname(CONTRACT_PATH), importPath),
    path.resolve('/data/workspace/output/projects/vedic-fhe-match-mvp/matcher-node/node_modules', importPath),
    path.resolve('/data/workspace/output/blind-reveal-base-sepolia/node_modules', importPath),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return null;
}

function findImports(importPath) {
  const content = resolveImport(importPath);
  if (content != null) return { contents: content };
  return { error: `File not found: ${importPath}` };
}

async function main() {
  const source = fs.readFileSync(CONTRACT_PATH, 'utf8');
  const input = {
    language: 'Solidity',
    sources: {
      [path.basename(CONTRACT_PATH)]: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'cancun',
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (out.errors?.length) {
    const fatals = out.errors.filter((e) => e.severity === 'error');
    if (fatals.length) {
      console.error(fatals.map((e) => e.formattedMessage).join('\n'));
      process.exit(1);
    }
  }

  const contractOut = out.contracts[path.basename(CONTRACT_PATH)][CONTRACT_NAME];
  if (!contractOut) throw new Error('Compiled contract missing');
  const abi = contractOut.abi;
  const bytecode = `0x${contractOut.evm.bytecode.object}`;

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const deployTx = await factory.deploy(wallet.address, wallet.address, { gasLimit: 8_000_000n });
  await deployTx.waitForDeployment();
  const address = await deployTx.getAddress();

  const payload = { address, deployer: wallet.address, tx: deployTx.deploymentTransaction().hash };
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
