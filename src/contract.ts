import { createPublicClient, createWalletClient, custom, http, getAddress, parseAbiItem } from 'viem';
import { baseSepolia } from 'viem/chains';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/web';
import { Encryptable, FheTypes } from '@cofhe/sdk';
import { getChainById } from '@cofhe/sdk/chains';
import { ChartFeatures, ProfileForm, PublicProfile } from './types';

export const CONTRACT_ADDRESS = (import.meta.env.VITE_HOROSCOPE_MATCHER_ADDRESS || '') as `0x${string}`;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
const SAVE_PROFILE_GAS_LIMIT = 2_500_000n;
const COMPUTE_MATCH_GAS_LIMIT = 3_000_000n;
const compatibilityComputedEvent = parseAbiItem(
  'event CompatibilityComputed(address indexed userA, address indexed userB, uint256 scoreHandle)',
);

const encryptedInputComponents = [
  { name: 'ctHash', type: 'uint256' },
  { name: 'securityZone', type: 'int32' },
  { name: 'utype', type: 'uint8' },
  { name: 'signature', type: 'bytes' },
] as const;

export const horoscopeAbi = [
  {
    type: 'function',
    name: 'saveProfile',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'displayName', type: 'string' },
      { name: 'xHandle', type: 'string' },
      { name: 'avatarColor', type: 'string' },
      {
        name: 'encryptedChart',
        type: 'tuple',
        components: [
          { name: 'moonSign', type: 'tuple', components: encryptedInputComponents },
          { name: 'nakshatra', type: 'tuple', components: encryptedInputComponents },
          { name: 'ascSign', type: 'tuple', components: encryptedInputComponents },
          { name: 'sunSign', type: 'tuple', components: encryptedInputComponents },
          { name: 'venusSign', type: 'tuple', components: encryptedInputComponents },
          { name: 'marsSign', type: 'tuple', components: encryptedInputComponents },
          { name: 'jupiterSign', type: 'tuple', components: encryptedInputComponents },
          { name: 'saturnSign', type: 'tuple', components: encryptedInputComponents },
          { name: 'seventhHouseSign', type: 'tuple', components: encryptedInputComponents },
          { name: 'venusHouse', type: 'tuple', components: encryptedInputComponents },
          { name: 'marsHouse', type: 'tuple', components: encryptedInputComponents },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'computeCompatibility',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'other', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getScore',
    stateMutability: 'view',
    inputs: [
      { name: 'userA', type: 'address' },
      { name: 'userB', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'profiles',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'displayName', type: 'string' },
      { name: 'xHandle', type: 'string' },
      { name: 'avatarColor', type: 'string' },
      { name: 'createdAt', type: 'uint64' },
      { name: 'exists', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'hasEncryptedChart',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'members',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'memberCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export function getPublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL || undefined),
  });
}

function getCofheConfigForBaseSepolia() {
  const cofheChain = getChainById(BASE_SEPOLIA_CHAIN_ID);
  if (!cofheChain) {
    throw new Error('Base Sepolia is not available in this @cofhe/sdk version.');
  }
  return createCofheConfig({ supportedChains: [cofheChain] });
}

export async function getWalletClient() {
  if (!window.ethereum) {
    throw new Error('Wallet not found. Install a browser wallet to continue.');
  }

  const [account] = (await window.ethereum.request({
    method: 'eth_requestAccounts',
  })) as [`0x${string}`];

  await ensureBaseSepolia();

  return createWalletClient({
    account,
    chain: baseSepolia,
    transport: custom(window.ethereum),
  });
}

export async function ensureBaseSepolia() {
  if (!window.ethereum) return;
  const chainId = await window.ethereum.request({ method: 'eth_chainId' });
  if (Number(chainId) === BASE_SEPOLIA_CHAIN_ID) return;

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x14a34' }],
    });
  } catch {
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: '0x14a34',
          chainName: 'Base Sepolia',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://sepolia.base.org'],
          blockExplorerUrls: ['https://sepolia.basescan.org'],
        },
      ],
    });
  }
}

export async function connectWallet() {
  const walletClient = await getWalletClient();
  return walletClient.account!.address;
}

export async function encryptAndSaveProfile(profile: ProfileForm, features: ChartFeatures, onStep: (label: string) => void) {
  if (!CONTRACT_ADDRESS) {
    throw new Error('Contract address missing. Set VITE_HOROSCOPE_MATCHER_ADDRESS after deployment.');
  }

  const publicClient = getPublicClient();
  const walletClient = await getWalletClient();
  const cofheClient = createCofheClient(getCofheConfigForBaseSepolia());

  onStep('Connecting Fhenix client');
  await cofheClient.connect(publicClient as never, walletClient as never);

  const orderedValues = [
    features.moonSign,
    features.nakshatra,
    features.ascSign,
    features.sunSign,
    features.venusSign,
    features.marsSign,
    features.jupiterSign,
    features.saturnSign,
    features.seventhHouseSign,
    features.venusHouse,
    features.marsHouse,
  ];

  onStep('Encrypting chart signals');
  const encrypted = await cofheClient
    .encryptInputs(orderedValues.map((value) => Encryptable.uint8(BigInt(value))))
    .onStep((step: unknown, ctx?: { isStart?: boolean }) => {
      if (ctx?.isStart) onStep(String(step));
    })
    .execute();

  const encryptedChart = {
    moonSign: encrypted[0],
    nakshatra: encrypted[1],
    ascSign: encrypted[2],
    sunSign: encrypted[3],
    venusSign: encrypted[4],
    marsSign: encrypted[5],
    jupiterSign: encrypted[6],
    saturnSign: encrypted[7],
    seventhHouseSign: encrypted[8],
    venusHouse: encrypted[9],
    marsHouse: encrypted[10],
  };

  onStep('Writing encrypted profile');
  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: horoscopeAbi,
    functionName: 'saveProfile',
    args: [profile.displayName, profile.xHandle, profile.avatarColor, encryptedChart as never],
    gas: SAVE_PROFILE_GAS_LIMIT,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function fetchProfiles(): Promise<PublicProfile[]> {
  if (!CONTRACT_ADDRESS) return [];

  const publicClient = getPublicClient();
  const count = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: horoscopeAbi,
    functionName: 'memberCount',
  });

  const profiles = await Promise.all(
    Array.from({ length: Number(count) }).map(async (_, index) => {
      const address = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: horoscopeAbi,
        functionName: 'members',
        args: [BigInt(index)],
      });
      const profile = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: horoscopeAbi,
        functionName: 'profiles',
        args: [address],
      });
      const hasChart = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: horoscopeAbi,
        functionName: 'hasEncryptedChart',
        args: [address],
      });

      return {
        address: address as `0x${string}`,
        displayName: profile[0],
        xHandle: profile[1],
        avatarColor: profile[2],
        createdAt: profile[3],
        exists: profile[4],
        hasChart,
      };
    }),
  );

  return profiles.filter((profile) => profile.exists);
}

export async function fetchProfileByAddress(address: `0x${string}`): Promise<PublicProfile | null> {
  if (!CONTRACT_ADDRESS) return null;

  const publicClient = getPublicClient();
  const profile = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: horoscopeAbi,
    functionName: 'profiles',
    args: [address],
  });

  if (!profile[4]) return null;

  const hasChart = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: horoscopeAbi,
    functionName: 'hasEncryptedChart',
    args: [address],
  });

  return {
    address,
    displayName: profile[0],
    xHandle: profile[1],
    avatarColor: profile[2],
    createdAt: profile[3],
    exists: profile[4],
    hasChart,
  };
}

export async function fetchMatchedProfilesForWallet(account: `0x${string}`): Promise<PublicProfile[]> {
  if (!CONTRACT_ADDRESS) return [];

  const publicClient = getPublicClient();
  const normalizedAccount = getAddress(account);
  const [asUserA, asUserB] = await Promise.all([
    publicClient.getLogs({
      address: CONTRACT_ADDRESS,
      event: compatibilityComputedEvent,
      args: { userA: normalizedAccount },
      fromBlock: 0n,
      toBlock: 'latest',
    }),
    publicClient.getLogs({
      address: CONTRACT_ADDRESS,
      event: compatibilityComputedEvent,
      args: { userB: normalizedAccount },
      fromBlock: 0n,
      toBlock: 'latest',
    }),
  ]);

  const counterparties = new Map<string, `0x${string}`>();
  for (const log of [...asUserA, ...asUserB]) {
    const userA = log.args.userA ? getAddress(log.args.userA) : null;
    const userB = log.args.userB ? getAddress(log.args.userB) : null;
    const other = userA?.toLowerCase() === normalizedAccount.toLowerCase() ? userB : userA;
    if (other && other.toLowerCase() !== normalizedAccount.toLowerCase()) {
      counterparties.set(other.toLowerCase(), other as `0x${string}`);
    }
  }

  const profiles = await Promise.all([...counterparties.values()].map((address) => fetchProfileByAddress(address)));
  return profiles.filter((profile): profile is PublicProfile => Boolean(profile?.exists));
}

export async function computeAndDecryptMatch(other: `0x${string}`, self: `0x${string}`, onStep: (label: string) => void) {
  if (!CONTRACT_ADDRESS) {
    throw new Error('Contract address missing. Set VITE_HOROSCOPE_MATCHER_ADDRESS after deployment.');
  }

  const publicClient = getPublicClient();
  const walletClient = await getWalletClient();
  const cofheClient = createCofheClient(getCofheConfigForBaseSepolia());

  onStep('Connecting permit');
  await cofheClient.connect(publicClient as never, walletClient as never);
  const permit = await cofheClient.permits.getOrCreateSelfPermit();

  onStep('Running private synastry');
  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: horoscopeAbi,
    functionName: 'computeCompatibility',
    args: [other],
    gas: COMPUTE_MATCH_GAS_LIMIT,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  onStep('Reading encrypted score handle');
  const scoreHandle = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: horoscopeAbi,
    functionName: 'getScore',
    args: [self, other],
  });

  onStep('Decrypting authorized score');
  const score = await cofheClient.decryptForView(scoreHandle, FheTypes.Uint16).withPermit(permit).execute();
  return Number(score);
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}
