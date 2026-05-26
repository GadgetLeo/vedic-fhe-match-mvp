export const CONFIG = {
  network: {
    name: "Base Sepolia",
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org/"
  },
  constants: {
    ACTIVE_POOL_CAP: 100,
    MAX_NEW_MATCHES_PER_TX: 20,
    MATCHER_SLA_HOURS: 24,
    CONSENT_WINDOW_DAYS: 7,
    DECRYPT_WINDOW_HOURS: 1,
    PERMIT_TTL_MINUTES: 30
  },
  productRules: {
    scoreThreshold: 25,
    allowInstantReveal: false,
    requireDualConsent: true,
    shareCardUnlockedState: "Revealed"
  },
  contracts: {
    vedicAutoMatch: "0x11E8B83EEF9D8C36bC616014165F61a3b1739dc0"
  }
};
