import { MatchState, CloseReason } from "./state-machine.js";

export const mockProfile = {
  owner: "0xA1...9F",
  profileId: 12,
  profileVersion: 2,
  status: "Active",
  createdAt: "2026-05-26T08:00:00Z"
};

export const mockMatches = [
  {
    matchId: 901,
    counterpart: "@astro_alpha",
    score36: 29,
    state: MatchState.PendingConsent,
    closeReason: CloseReason.None,
    consentDeadline: "2026-06-02T14:00:00Z",
    decryptDeadline: null,
    consentA: true,
    consentB: false
  },
  {
    matchId: 902,
    counterpart: null,
    score36: null,
    state: MatchState.Decrypting,
    closeReason: CloseReason.None,
    consentDeadline: "2026-06-01T14:00:00Z",
    decryptDeadline: "2026-05-26T09:00:00Z",
    consentA: true,
    consentB: true
  },
  {
    matchId: 903,
    counterpart: "@luna_beta",
    score36: 31,
    state: MatchState.Closed,
    closeReason: CloseReason.Superseded,
    consentDeadline: "2026-05-27T14:00:00Z",
    decryptDeadline: "2026-05-27T15:00:00Z",
    consentA: true,
    consentB: true
  }
];
