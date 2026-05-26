/**
 * matcher.mjs — Node.js matcher for VedicAutoMatch on Base Sepolia.
 *
 * 1. Discovers active profiles on-chain
 * 2. Calls processAutoMatchesBatch(start, end) to create match jobs
 * 3. For each newly created match, encrypts score+qualifies via cofhejs
 * 4. Submits submitMatchScore(matchId, encryptedScore, encryptedQualifies, qualifiesPlain)
 *
 * Env required:
 *   RPC_URL              (default https://sepolia.base.org)
 *   MATCHER_PRIVATE_KEY  (operator wallet, must be matcher role on contract)
 *   CONTRACT_ADDRESS     (default deployed address)
 *   FORCE_TEST_SCORE     (optional; integer 0-36 to override score for QA)
 */

import { ethers } from "ethers";
import { cofhejs, Encryptable } from "cofhejs/node";

const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x11E8B83EEF9D8C36bC616014165F61a3b1739dc0";
const PK = process.env.MATCHER_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PK) {
  console.error("MATCHER_PRIVATE_KEY (or PRIVATE_KEY) is required");
  process.exit(2);
}

const ABI = [
  "function activeProfileIds(uint256) view returns (uint256)",
  "function activeProfileIdByOwner(address) view returns (uint256)",
  "function nextMatchId() view returns (uint256)",
  "function matcher() view returns (address)",
  "function heartbeat() external",
  "function processAutoMatchesBatch(uint256 start, uint256 end) external",
  "function matches(uint256) view returns (uint256 matchId, address userA, address userB, uint256 profileIdA, uint256 profileIdB, uint256 profileVersionA, uint256 profileVersionB, bytes32 score36Enc, bytes32 qualifiesEnc, bool scoreSubmitted, bool consentA, bool consentB, uint64 consentDeadline, uint64 decryptDeadline, uint8 state, uint8 closeReason, uint64 createdAt)",
  "function submitMatchScore(uint256 matchId, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedScore36, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedQualifies, bool qualifiesPlain) external",
  "event MatchJobCreated(uint256 indexed matchId, bytes32 pairKey, address indexed userA, address indexed userB)",
];

function pickScore(profileIdA, profileIdB) {
  const forced = process.env.FORCE_TEST_SCORE;
  if (forced !== undefined && forced !== "") {
    const v = parseInt(forced, 10);
    if (Number.isFinite(v)) return Math.max(0, Math.min(36, v));
  }
  // Deterministic seed-based score so repeats don't oscillate.
  const seed = (Number(profileIdA) * 1000003 + Number(profileIdB) * 7919) % 37;
  return seed;
}

async function listActiveProfileIds(contract) {
  const ids = [];
  for (let i = 0; i < 200; i++) {
    try {
      const v = await contract.activeProfileIds(i);
      ids.push(Number(v));
    } catch {
      break;
    }
  }
  return ids;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PK, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  const matcherAddr = await contract.matcher();
  console.log("matcher_role:", matcherAddr);
  console.log("operator:    ", wallet.address);
  if (matcherAddr.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error("Wallet is not the matcher role — submitMatchScore will revert.");
    process.exit(3);
  }

  // Heartbeat (best effort)
  try {
    const tx = await contract.heartbeat();
    await tx.wait();
    console.log("heartbeat tx:", tx.hash);
  } catch (e) {
    console.warn("heartbeat failed:", e.shortMessage || e.message);
  }

  // Initialize cofhejs against Base Sepolia testnet
  const init = await cofhejs.initializeWithEthers({
    ethersProvider: provider,
    ethersSigner: wallet,
    environment: "TESTNET",
    generatePermit: false,
  });
  if (init && init.success === false) {
    console.error("cofhejs.initializeWithEthers failed:", init.error);
    process.exit(4);
  }

  const activeIds = await listActiveProfileIds(contract);
  console.log("active_profile_ids:", activeIds);
  if (activeIds.length < 2) {
    console.log("Not enough active profiles to match.");
    return;
  }

  const beforeNextMatchId = Number(await contract.nextMatchId());
  console.log("nextMatchId before batch:", beforeNextMatchId);

  // Trigger pair-job creation for all active profiles in one batch
  try {
    const tx = await contract.processAutoMatchesBatch(0, activeIds.length, { gasLimit: 1_500_000n });
    const receipt = await tx.wait();
    console.log("processAutoMatchesBatch tx:", tx.hash, "status:", receipt.status);
  } catch (e) {
    console.warn("processAutoMatchesBatch failed:", e.shortMessage || e.message);
  }

  const afterNextMatchId = Number(await contract.nextMatchId());
  console.log("nextMatchId after batch:", afterNextMatchId);

  if (afterNextMatchId <= beforeNextMatchId) {
    // No new matches created. Try scoring the latest existing match anyway if it's unsubmitted.
    if (afterNextMatchId >= 1) {
      await scoreIfPending(contract, afterNextMatchId);
    }
    return;
  }

  for (let mid = beforeNextMatchId + 1; mid <= afterNextMatchId; mid++) {
    await scoreIfPending(contract, mid);
  }
}

async function scoreIfPending(contract, matchId) {
  const m = await contract.matches(matchId);
  console.log(`match ${matchId}: state=${m.state} scoreSubmitted=${m.scoreSubmitted}`);
  if (m.scoreSubmitted) return;
  if (Number(m.state) !== 0) return; // only Computed → can be scored

  const score = pickScore(m.profileIdA, m.profileIdB);
  const qualifies = score > 25;
  console.log(`encrypting score=${score} qualifies=${qualifies}`);

  const enc = await cofhejs.encrypt([
    Encryptable.uint8(BigInt(score)),
    Encryptable.bool(qualifies),
  ]);
  if (!enc || enc.success === false) {
    console.error(`encrypt failed for match ${matchId}:`, enc?.error);
    return;
  }
  const [encScore, encQualifies] = enc.data;

  try {
    const tx = await contract.submitMatchScore(
      matchId,
      encScore,
      encQualifies,
      qualifies,
      { gasLimit: 1_200_000n },
    );
    const receipt = await tx.wait();
    console.log(`submitMatchScore match=${matchId} tx=${tx.hash} status=${receipt.status}`);
  } catch (e) {
    console.error(`submitMatchScore match=${matchId} failed:`, e.shortMessage || e.message);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
