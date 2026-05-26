export const MatchState = {
  Computed: "Computed",
  PendingConsent: "PendingConsent",
  Decrypting: "Decrypting",
  Revealed: "Revealed",
  Closed: "Closed"
};

export const CloseReason = {
  None: "None",
  NotQualified: "NotQualified",
  Declined: "Declined",
  ConsentExpired: "ConsentExpired",
  DecryptFailed: "DecryptFailed",
  Superseded: "Superseded"
};

export function canCloseExpiredMatch(record, nowTs) {
  return (
    record.state === MatchState.PendingConsent &&
    nowTs > record.consentDeadline
  );
}

export function canCloseStuckDecryption(record, nowTs) {
  return (
    record.state === MatchState.Decrypting &&
    nowTs > record.decryptDeadline
  );
}

export function shouldEnterPendingConsent(score36) {
  return score36 > 25;
}
