import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node';
import { Encryptable, FheTypes } from '@cofhe/sdk';
import { getChainById } from '@cofhe/sdk/chains';

const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || process.env.VITE_BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const contractAddress = process.env.VITE_HOROSCOPE_MATCHER_ADDRESS;
const funderKey = process.env.QA_FUNDER_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!contractAddress) throw new Error('Set VITE_HOROSCOPE_MATCHER_ADDRESS');
if (!funderKey) throw new Error('Set QA_FUNDER_PRIVATE_KEY or PRIVATE_KEY');

const signCount = 12;
const nakshatraCount = 27;

const abi = parseAbi([
  'function REVEAL_THRESHOLD() view returns (uint16)',
  'function memberCount() view returns (uint256)',
  'function saveProfile(string displayName,string xHandle,string avatarColor,((uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) moonSign,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) nakshatra,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) ascSign,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) sunSign,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) venusSign,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) marsSign,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) jupiterSign,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) saturnSign,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) seventhHouseSign,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) venusHouse,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) marsHouse) encryptedChart)',
  'function computeCompatibilityBatch(address user,address[] candidates) returns (uint256 computedCount)',
  'function requestReveal(address other)',
  'function getScore(address userA,address userB) view returns (uint256)',
  'function getPublicRevealScore(address userA,address userB) returns (uint256)',
  'function getPair(address userA,address userB) view returns (address userA,address userB,uint64 computedAt,uint64 profileVersionA,uint64 profileVersionB,bool computed,bool revealA,bool revealB)',
]);

const profiles = [
  {
    label: 'Mumbai base',
    displayName: 'Anika Mumbai',
    xHandle: '@qa_mumbai',
    avatarColor: '#0ad9dc',
    birth: { date: '1998-04-17', time: '09:12', location: 'Mumbai, India', timezone: 'Asia/Kolkata' },
  },
  {
    label: 'Singapore broad match',
    displayName: 'Mei Singapore',
    xHandle: '@qa_singapore',
    avatarColor: '#e8b84a',
    birth: { date: '1999-04-16', time: '10:20', location: 'Singapore', timezone: 'Asia/Singapore' },
  },
  {
    label: 'Dubai broad match',
    displayName: 'Sara Dubai',
    xHandle: '@qa_dubai',
    avatarColor: '#8ee6a5',
    birth: { date: '1999-04-11', time: '21:10', location: 'Dubai, UAE', timezone: 'Asia/Dubai' },
  },
  {
    label: 'Berlin low match',
    displayName: 'Lena Berlin',
    xHandle: '@qa_berlin',
    avatarColor: '#7585ff',
    birth: { date: '1989-01-12', time: '03:40', location: 'Berlin, Germany', timezone: 'Europe/Berlin' },
  },
];

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function wrap(value, size) {
  return ((value % size) + size) % size;
}

function locationBucket(location) {
  return hashString(location.trim().toLowerCase()) % 12;
}

function timezoneOffsetMinutes(timezone) {
  const normalized = timezone.trim();
  const upper = normalized.toUpperCase();
  const explicitOffset = upper.match(/^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/);

  if (explicitOffset) {
    const sign = explicitOffset[1] === '-' ? -1 : 1;
    const hours = Number(explicitOffset[2]) || 0;
    const minutes = Number(explicitOffset[3]) || 0;
    return sign * (hours * 60 + minutes);
  }

  const offsets = {
    'Asia/Kolkata': 330,
    'Asia/Calcutta': 330,
    'Asia/Dubai': 240,
    'Asia/Singapore': 480,
    'Asia/Tokyo': 540,
    'Asia/Bangkok': 420,
    'Asia/Hong_Kong': 480,
    'Europe/London': 0,
    'Europe/Paris': 60,
    'Europe/Berlin': 60,
    'Europe/Madrid': 60,
    'America/New_York': -300,
    'America/Chicago': -360,
    'America/Denver': -420,
    'America/Los_Angeles': -480,
    'America/Toronto': -300,
    'Australia/Sydney': 600,
    'Africa/Johannesburg': 120,
  };

  return offsets[normalized] ?? 0;
}

function locationRegion(location) {
  const normalized = location.toLowerCase();

  if (/(india|mumbai|delhi|bangalore|bengaluru|kolkata|chennai|pune|hyderabad)/.test(normalized)) return 0;
  if (/(singapore|tokyo|japan|bangkok|thailand|hong kong|china|seoul|korea)/.test(normalized)) return 1;
  if (/(dubai|uae|qatar|doha|saudi|riyadh|kuwait|oman|bahrain)/.test(normalized)) return 2;
  if (/(london|paris|berlin|madrid|rome|europe|uk|france|germany|italy|spain)/.test(normalized)) return 3;
  if (/(new york|los angeles|chicago|toronto|america|usa|canada|vancouver|san francisco)/.test(normalized)) return 4;
  if (/(sydney|melbourne|australia|auckland|new zealand)/.test(normalized)) return 5;
  if (/(cape town|johannesburg|africa|nairobi|lagos|cairo)/.test(normalized)) return 6;

  return locationBucket(location) % 7;
}

function deriveChartFeatures(birth) {
  const [year, month, day] = birth.date.split('-').map((part) => Number(part) || 0);
  const [hour, minute] = birth.time.split(':').map((part) => Number(part) || 0);
  void year;
  const regionBand = locationRegion(birth.location);
  const offsetMinutes = timezoneOffsetMinutes(birth.timezone);
  const timeBand = Math.floor(hour / 2);
  const minuteBand = Math.floor(minute / 20);
  const timezoneBand = wrap(Math.floor(offsetMinutes / 180), 4);

  const solarBase = wrap(month - 1, signCount);
  const lunarBase = wrap(day + timeBand, signCount);
  const ascBase = wrap(Math.floor(hour / 3) + minuteBand + regionBand, signCount);
  const nakshatra = wrap(day + Math.floor(hour / 3) + regionBand, nakshatraCount);
  const moonHarmonyGroup = wrap(lunarBase + Math.floor(nakshatra / 9), 4);
  const temperamentGroup = nakshatra % 3;
  const bhakootGroup = wrap(lunarBase + solarBase, 4);
  const yoniGroup = nakshatra % 4;
  const timeChemistryGroup = wrap(Math.floor(hour / 6) + timezoneBand, 6);

  return [
    lunarBase,
    nakshatra,
    ascBase,
    solarBase,
    wrap(solarBase + 1 + (month % 2), signCount),
    wrap(lunarBase + 5 + Math.floor(day / 15), signCount),
    moonHarmonyGroup,
    temperamentGroup,
    bhakootGroup,
    yoniGroup + 1,
    timeChemistryGroup + 1,
  ];
}

function expectedScore(a, b) {
  let score = 0;
  const add = (condition, points) => {
    if (condition) score += points;
  };
  add(a[0] === b[0], 10);
  add(a[1] === b[1], 6);
  add(a[2] === b[2], 6);
  add(a[3] === b[3], 6);
  add(a[4] === b[4], 4);
  add(a[5] === b[5], 4);
  add(a[4] === b[5], 8);
  add(b[4] === a[5], 8);
  add(a[6] === b[6], 12);
  add(a[7] === b[7], 10);
  add(a[8] === b[8], 10);
  add(a[9] === b[9], 8);
  add(a[10] === b[10], 8);
  return score;
}

function chartInput(encrypted) {
  return {
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
}

async function sendAndWait(publicClient, walletClient, request) {
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000 });
  if (receipt.status !== 'success') throw new Error(`transaction failed: ${hash}`);
  return hash;
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function decryptScoreWithRetry({ publicClient, walletClient, cofheChain, userA, userB, attempts = 5 }) {
  const scoreHandle = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'getScore',
    args: [userA, userB],
  });

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(15_000);
    }

    try {
      const cofheClient = createCofheClient(createCofheConfig({ supportedChains: [cofheChain] }));
      await cofheClient.connect(publicClient, walletClient);
      const permit = await cofheClient.permits.getOrCreateSelfPermit();
      const decrypted = await cofheClient.decryptForView(scoreHandle, FheTypes.Uint16).withPermit(permit).execute();
      return Number(decrypted);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function main() {
  const cofheChain = getChainById(84532);
  if (!cofheChain) throw new Error('Base Sepolia missing from CoFHE SDK chain list');

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const funder = privateKeyToAccount(funderKey.startsWith('0x') ? funderKey : `0x${funderKey}`);
  const funderWallet = createWalletClient({ account: funder, chain: baseSepolia, transport: http(rpcUrl) });
  const startingCount = await publicClient.readContract({ address: contractAddress, abi, functionName: 'memberCount' });
  const threshold = await publicClient.readContract({ address: contractAddress, abi, functionName: 'REVEAL_THRESHOLD' });
  const balance = await publicClient.getBalance({ address: funder.address });

  console.log(`contract=${contractAddress}`);
  console.log(`threshold=${threshold}`);
  console.log(`startingMembers=${startingCount}`);
  console.log(`funderBalance=${formatEther(balance)}`);

  const qaAccounts = profiles.map(() => privateKeyToAccount(generatePrivateKey()));
  for (const account of qaAccounts) {
    const hash = await funderWallet.sendTransaction({ to: account.address, value: parseEther('0.003') });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000 });
    if (receipt.status !== 'success') throw new Error(`funding failed: ${hash}`);
  }

  const prepared = profiles.map((profile, index) => ({
    ...profile,
    account: qaAccounts[index],
    features: deriveChartFeatures(profile.birth),
  }));

  for (const profile of prepared) {
    const walletClient = createWalletClient({ account: profile.account, chain: baseSepolia, transport: http(rpcUrl) });
    const cofheClient = createCofheClient(createCofheConfig({ supportedChains: [cofheChain] }));
    await cofheClient.connect(publicClient, walletClient);

    const encrypted = await cofheClient
      .encryptInputs(profile.features.map((value) => Encryptable.uint8(BigInt(value))))
      .execute();

    await sendAndWait(publicClient, walletClient, {
      address: contractAddress,
      abi,
      functionName: 'saveProfile',
      args: [profile.displayName, profile.xHandle, profile.avatarColor, chartInput(encrypted)],
      gas: 2_500_000n,
    });
    console.log(`saved=${profile.label}:${profile.account.address}`);
  }

  const anchor = prepared[0];
  const candidates = prepared.slice(1).map((profile) => profile.account.address);
  const anchorWallet = createWalletClient({ account: anchor.account, chain: baseSepolia, transport: http(rpcUrl) });
  await sendAndWait(publicClient, anchorWallet, {
    address: contractAddress,
    abi,
    functionName: 'computeCompatibilityBatch',
    args: [anchor.account.address, candidates],
    gas: 3_000_000n * BigInt(candidates.length),
  });

  const results = [];
  for (const candidate of prepared.slice(1)) {
    const candidateWallet = createWalletClient({ account: candidate.account, chain: baseSepolia, transport: http(rpcUrl) });
    await sendAndWait(publicClient, anchorWallet, {
      address: contractAddress,
      abi,
      functionName: 'requestReveal',
      args: [candidate.account.address],
      gas: 900_000n,
    });
    await sendAndWait(publicClient, candidateWallet, {
      address: contractAddress,
      abi,
      functionName: 'requestReveal',
      args: [anchor.account.address],
      gas: 900_000n,
    });

    const expected = expectedScore(anchor.features, candidate.features);
    try {
      const decrypted = await decryptScoreWithRetry({
        publicClient,
        walletClient: anchorWallet,
        cofheChain,
        userA: anchor.account.address,
        userB: candidate.account.address,
      });
      results.push({
        pair: `${anchor.label} <> ${candidate.label}`,
        expected,
        decrypted,
      });
    } catch (error) {
      results.push({
        pair: `${anchor.label} <> ${candidate.label}`,
        expected,
        decrypted: null,
        decryptError: error?.code || error?.shortMessage || error?.message || 'decrypt failed',
      });
    }
  }

  console.log(JSON.stringify({ results }, null, 2));
}

await main();
