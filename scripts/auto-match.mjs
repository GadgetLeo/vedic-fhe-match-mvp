import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || process.env.VITE_BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const contractAddress = process.env.VITE_HOROSCOPE_MATCHER_ADDRESS;
const privateKey = process.env.MATCHER_PRIVATE_KEY || process.env.PRIVATE_KEY;
const maxPairs = Number(process.env.MATCHER_MAX_PAIRS || '8');

if (!contractAddress) throw new Error('Set VITE_HOROSCOPE_MATCHER_ADDRESS');
if (!privateKey) throw new Error('Set MATCHER_PRIVATE_KEY or PRIVATE_KEY');

const abi = parseAbi([
  'function memberCount() view returns (uint256)',
  'function members(uint256 index) view returns (address)',
  'function hasEncryptedChart(address user) view returns (bool)',
  'function getPair(address userA, address userB) view returns (address userA,address userB,uint64 computedAt,uint64 profileVersionA,uint64 profileVersionB,bool computed,bool revealA,bool revealB)',
  'function computeCompatibilityFor(address userA, address userB) returns (uint256)',
]);

const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

async function main() {
  const count = Number(
    await publicClient.readContract({
      address: contractAddress,
      abi,
      functionName: 'memberCount',
    }),
  );
  const members = await Promise.all(
    Array.from({ length: count }).map((_, index) =>
      publicClient.readContract({
        address: contractAddress,
        abi,
        functionName: 'members',
        args: [BigInt(index)],
      }),
    ),
  );

  let submitted = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      if (submitted >= maxPairs) break;

      const userA = members[i];
      const userB = members[j];
      const [hasA, hasB, pair] = await Promise.all([
        publicClient.readContract({ address: contractAddress, abi, functionName: 'hasEncryptedChart', args: [userA] }),
        publicClient.readContract({ address: contractAddress, abi, functionName: 'hasEncryptedChart', args: [userB] }),
        publicClient.readContract({ address: contractAddress, abi, functionName: 'getPair', args: [userA, userB] }),
      ]);

      if (!hasA || !hasB || pair.computed) continue;

      console.log(`computing ${userA} <> ${userB}`);
      const hash = await walletClient.writeContract({
        address: contractAddress,
        abi,
        functionName: 'computeCompatibilityFor',
        args: [userA, userB],
        gas: 3_000_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000 });
      if (receipt.status !== 'success') throw new Error(`compute failed: ${hash}`);
      submitted += 1;
    }
  }

  console.log(JSON.stringify({ members: members.length, submitted }, null, 2));
}

await main();
