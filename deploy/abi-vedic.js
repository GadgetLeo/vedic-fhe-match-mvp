export const VEDIC_AUTO_MATCH_ABI = [
  // ─── Profile writes ───────────────────────────────────────────────────────
  "function createProfile(tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) varna, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) vashya, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) tara, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) yoni, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) grahaMaitri, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) gana, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) bhakoot, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) nadi, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedName, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedXHandle) external returns (uint256 profileId)",
  "function updateProfile(tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) varna, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) vashya, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) tara, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) yoni, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) grahaMaitri, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) gana, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) bhakoot, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) nadi, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedName, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedXHandle) external",
  "function withdrawProfile() external",

  // ─── Profile reads ────────────────────────────────────────────────────────
  "function activeProfileIdByOwner(address) view returns (uint256)",

  // ─── Match reads ──────────────────────────────────────────────────────────
  "function getMyResult() view returns ((uint256 matchId,address userA,address userB,uint256 profileIdA,uint256 profileIdB,uint256 profileVersionA,uint256 profileVersionB,bool scoreSubmitted,bool consentA,bool consentB,uint64 consentDeadline,uint64 decryptDeadline,uint8 state,uint8 closeReason,uint64 createdAt)[])",
  "function getMyMatchCardData(uint256 matchId) view returns ((bool ready,uint256 score,uint256 counterpartName,uint256 counterpartXHandle))",
  "function getMyProfileData() view returns (uint256 nameCt, uint256 handleCt)",

  // ─── User actions ─────────────────────────────────────────────────────────
  "function consentToReveal(uint256 matchId)",
  "function declineReveal(uint256 matchId)",
  "function closeExpiredMatch(uint256 matchId)",
  "function closeStuckDecryption(uint256 matchId)",

  // ─── Matcher / keeper ─────────────────────────────────────────────────────
  "function heartbeat()",
  "function processAutoMatchesBatch(uint256 start, uint256 end)",
  "function submitMatchScore(uint256 matchId, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedScore36, tuple(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) encryptedQualifies, bool qualifiesPlain)",

  // ─── Decryption callback (called by CoFHE coprocessor) ───────────────────
  "function onDecryptionFulfilled(uint256 matchId, uint256[] calldata plaintexts, bytes[] calldata signatures)",

  // ─── Views ────────────────────────────────────────────────────────────────
  "function matcherLastSeen() view returns (uint64)",
  "function coprocessorCallback() view returns (address)",
  "function getMyProfileData() view returns (uint256 nameCt, uint256 handleCt)",

  // ─── Events ───────────────────────────────────────────────────────────────
  "event ProfileCreated(uint256 indexed profileId, address indexed owner, uint8 version)",
  "event ProfileUpdated(uint256 indexed profileId, uint8 newVersion)",
  "event ProfileWithdrawn(uint256 indexed profileId)",
  "event MatchEnteredPendingConsent(uint256 indexed matchId, uint64 consentDeadline)",
  "event MatchEnteredDecrypting(uint256 indexed matchId, uint64 decryptDeadline)",
  "event MatchRevealed(uint256 indexed matchId)",
  "event MatchClosed(uint256 indexed matchId, uint8 closeReason)",
  "event MatchScoreSubmitted(uint256 indexed matchId)",
  "event DecryptionFulfilled(uint256 indexed matchId, bool qualified)"
];
