/**
 * matcher.cjs — VedicAutoMatch matcher (hybrid: viem for CoFHE + ethers for txs).
 *
 * Added:
 * - automatic decrypt callback relay for matches in Decrypting state
 *   (calls onDecryptionFulfilled with CoFHE plaintexts + signatures)
 */
const { ethers } = require("ethers");
const { createPublicClient, createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { baseSepolia: viemBaseSepolia } = require("viem/chains");
const { createCofheClient, createCofheConfig } = require("@cofhe/sdk/node");
const { Encryptable } = require("@cofhe/sdk");
const { baseSepolia: cofheBaseSepolia } = require("@cofhe/sdk/chains");

const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x11E8B83EEF9D8C36bC616014165F61a3b1739dc0";
const CHAIN_ID = Number(process.env.CHAIN_ID || 84532); // Base Sepolia
const PK_RAW = process.env.MATCHER_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PK_RAW) {
  console.error("MATCHER_PRIVATE_KEY (or PRIVATE_KEY) is required");
  process.exit(2);
}
const PK = PK_RAW.startsWith("0x") ? PK_RAW : "0x" + PK_RAW;

const ETHERS_ABI = [
  "function activeProfileIds(uint256) view returns (uint256)",
  "function nextMatchId() view returns (uint256)",
  "function matcher() view returns (address)",
  "function coprocessorCallback() view returns (address)",
  "function heartbeat() external",
  "function processAutoMatchesBatch(uint256 start, uint256 end) external",
  "function matches(uint256) view returns (uint256 matchId, address userA, address userB, uint256 profileIdA, uint256 profileIdB, uint256 profileVersionA, uint256 profileVersionB, bytes32 score36Enc, bytes32 qualifiesEnc, bool scoreSubmitted, bool consentA, bool consentB, uint64 consentDeadline, uint64 decryptDeadline, uint8 state, uint8 closeReason, uint64 createdAt)",
  "function profiles(uint256) view returns (address owner, uint256 profileId, uint256 profileVersion, uint64 createdAt, uint8 status, bytes32 varna, bytes32 vashya, bytes32 tara, bytes32 yoni, bytes32 grahaMaitri, bytes32 gana, bytes32 bhakoot, bytes32 nadi, bytes32 encryptedName, bytes32 encryptedXHandle)",
  "function submitMatchScore(uint256 matchId, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedScore36, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedQualifies, bool qualifiesPlain) external",
  "function onDecryptionFulfilled(uint256 matchId, uint256[] plaintexts, bytes[] signatures) external",
];

function pickScore(idA, idB) {
  const forced = process.env.FORCE_TEST_SCORE;
  if (forced !== undefined && forced !== "") {
    const v = parseInt(forced, 10);
    if (Number.isFinite(v)) return Math.max(0, Math.min(36, v));
  }
  return Number((BigInt(idA) * 1000003n + BigInt(idB) * 7919n) % 37n);
}

async function listActiveIds(c) {
  const ids = [];
  for (let i = 0; i < 200; i++) {
    try {
      const v = await c.activeProfileIds(i);
      ids.push(BigInt(v));
    } catch {
      break;
    }
  }
  return ids;
}

async function sendTx(contract, method, args, label) {
  try {
    const tx = await contract[method](...args, { gasLimit: 2_000_000n });
    const r = await tx.wait();
    console.log(`${label} tx=${tx.hash} status=${r.status}`);
    return r;
  } catch (e) {
    console.warn(`${label} failed:`, e.shortMessage || e.reason || e.message);
    return null;
  }
}

async function decryptForCallback(client, ctHash, walletAddress, permit) {
  const res = await client
    .decryptForTx(ctHash)
    .setChainId(CHAIN_ID)
    .setAccount(walletAddress)
    .withPermit(permit)
    .execute();
  return {
    decryptedValue: BigInt(res.decryptedValue),
    signature: res.signature,
  };
}

async function tryFinalizeReveal(contract, client, walletAddress, permit, mid, matchRow) {
  if (Number(matchRow.state) !== 2) return; // only Decrypting
  if (!(matchRow.consentA && matchRow.consentB)) return;

  try {
    const pA = await contract.profiles(matchRow.profileIdA);
    const pB = await contract.profiles(matchRow.profileIdB);

    const scoreReveal = await decryptForCallback(client, matchRow.score36Enc, walletAddress, permit);
    const nameA = await decryptForCallback(client, pA.encryptedName, walletAddress, permit);
    const xA = await decryptForCallback(client, pA.encryptedXHandle, walletAddress, permit);
    const nameB = await decryptForCallback(client, pB.encryptedName, walletAddress, permit);
    const xB = await decryptForCallback(client, pB.encryptedXHandle, walletAddress, permit);

    const plaintexts = [
      scoreReveal.decryptedValue,
      nameA.decryptedValue,
      xA.decryptedValue,
      nameB.decryptedValue,
      xB.decryptedValue,
    ];
    const signatures = [
      scoreReveal.signature,
      nameA.signature,
      xA.signature,
      nameB.signature,
      xB.signature,
    ];

    await sendTx(
      contract,
      "onDecryptionFulfilled",
      [mid, plaintexts, signatures],
      `onDecryptionFulfilled match=${mid}`,
    );

    const after = await contract.matches(mid);
    console.log(`  -> reveal after: state=${after.state} scoreSubmitted=${after.scoreSubmitted}`);
  } catch (e) {
    console.warn(`onDecryptionFulfilled match=${mid} failed:`, e.shortMessage || e.reason || e.message);
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PK, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ETHERS_ABI, wallet);

  const matcherAddr = await contract.matcher();
  const callbackAddr = await contract.coprocessorCallback();
  console.log("matcher_role:", matcherAddr, "callback_role:", callbackAddr, "operator:", wallet.address);
  if (matcherAddr.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error("Wallet is not matcher role.");
    process.exit(3);
  }
  if (callbackAddr.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error("Wallet is not callback role (coprocessorCallback).");
    process.exit(3);
  }

  await sendTx(contract, "heartbeat", [], "heartbeat");

  // CoFHE client (decrypt/encrypt)
  const account = privateKeyToAccount(PK);
  const publicClient = createPublicClient({ chain: viemBaseSepolia, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ chain: viemBaseSepolia, account, transport: http(RPC_URL) });
  console.log("initializing CoFHE client...");
  const config = createCofheConfig({ supportedChains: [cofheBaseSepolia], environment: "node" });
  const client = createCofheClient(config);
  await client.connect(publicClient, walletClient);
  console.log("cofhe connected:", client.connected);

  const permit = await client.permits.getOrCreateSelfPermit(
    CHAIN_ID,
    wallet.address,
    {
      issuer: wallet.address,
      name: "Vedic Callback Permit",
    },
  );
  console.log("cofhe permit created:", !!permit);

  const ids = await listActiveIds(contract);
  console.log("active_profile_ids:", ids.map(String));
  if (ids.length < 2) {
    console.log("Not enough active profiles.");
    return;
  }

  const before = BigInt(await contract.nextMatchId());
  console.log("nextMatchId before:", String(before));
  await sendTx(contract, "processAutoMatchesBatch", [0n, BigInt(ids.length)], "processAutoMatchesBatch");
  const after = BigInt(await contract.nextMatchId());
  console.log("nextMatchId after:", String(after));

  const upper = after > 0n ? after : 1n;
  for (let mid = 1n; mid <= upper; mid++) {
    const m = await contract.matches(mid);
    if (BigInt(m.matchId) === 0n) continue;

    console.log(`match ${mid}: state=${m.state} scoreSubmitted=${m.scoreSubmitted} consentA=${m.consentA} consentB=${m.consentB}`);

    // Step 1) score computed matches
    if (!m.scoreSubmitted && Number(m.state) === 0) {
      const score = pickScore(m.profileIdA, m.profileIdB);
      const qualifies = score > 25;
      console.log(`  encrypting score=${score} qualifies=${qualifies}`);

      let enc;
      try {
        enc = await client
          .encryptInputs([Encryptable.uint8(BigInt(score)), Encryptable.bool(qualifies)])
          .execute();
      } catch (e) {
        console.error(`  encrypt failed:`, e.message);
        continue;
      }

      const [encScore, encQualifies] = enc;
      const scoreTuple = {
        ctHash: BigInt(encScore.ctHash),
        securityZone: encScore.securityZone,
        utype: encScore.utype,
        signature: encScore.signature,
      };
      const qualTuple = {
        ctHash: BigInt(encQualifies.ctHash),
        securityZone: encQualifies.securityZone,
        utype: encQualifies.utype,
        signature: encQualifies.signature,
      };

      await sendTx(contract, "submitMatchScore", [mid, scoreTuple, qualTuple, qualifies], `submitMatchScore match=${mid}`);
    }

    // Step 2) finalize decrypting matches via callback relay
    const refreshed = await contract.matches(mid);
    await tryFinalizeReveal(contract, client, wallet.address, permit, mid, refreshed);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
