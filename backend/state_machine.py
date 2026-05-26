from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Tuple


class MatchState(str, Enum):
    COMPUTED = "Computed"
    PENDING_CONSENT = "PendingConsent"
    DECRYPTING = "Decrypting"
    REVEALED = "Revealed"
    CLOSED = "Closed"


class CloseReason(str, Enum):
    NONE = "None"
    NOT_QUALIFIED = "NotQualified"
    DECLINED = "Declined"
    CONSENT_EXPIRED = "ConsentExpired"
    DECRYPT_FAILED = "DecryptFailed"
    SUPERSEDED = "Superseded"


@dataclass
class Profile:
    owner: str
    profile_id: int
    profile_version: int
    status: str = "Active"  # Active | Matched | Withdrawn


@dataclass
class MatchRecord:
    match_id: int
    user_a: str
    user_b: str
    profile_id_a: int
    profile_id_b: int
    profile_version_a: int
    profile_version_b: int
    score36: Optional[int] = None
    qualifies: Optional[bool] = None
    consent_a: bool = False
    consent_b: bool = False
    consent_deadline: Optional[int] = None
    decrypt_deadline: Optional[int] = None
    state: MatchState = MatchState.COMPUTED
    close_reason: CloseReason = CloseReason.NONE


class MatchEngine:
    def __init__(self, consent_window_s: int = 7 * 24 * 3600, decrypt_window_s: int = 3600):
        self.profiles: Dict[str, Profile] = {}
        self.records: Dict[int, MatchRecord] = {}
        self.consent_window_s = consent_window_s
        self.decrypt_window_s = decrypt_window_s

    def add_profile(self, owner: str, profile_id: int, profile_version: int = 1):
        self.profiles[owner] = Profile(owner=owner, profile_id=profile_id, profile_version=profile_version)

    def add_scored_match(self, record: MatchRecord):
        if record.score36 is None:
            raise ValueError("score36 required")
        record.qualifies = record.score36 > 25
        if record.qualifies:
            record.state = MatchState.PENDING_CONSENT
            record.consent_deadline = 0 + self.consent_window_s
            record.close_reason = CloseReason.NONE
        else:
            record.state = MatchState.CLOSED
            record.close_reason = CloseReason.NOT_QUALIFIED
        self.records[record.match_id] = record

    def _participant_active(self, owner: str) -> bool:
        p = self.profiles.get(owner)
        return bool(p and p.status == "Active")

    def consent(self, match_id: int, caller: str):
        r = self.records[match_id]
        if r.state != MatchState.PENDING_CONSENT:
            return
        if caller == r.user_a:
            r.consent_a = True
        elif caller == r.user_b:
            r.consent_b = True
        else:
            raise ValueError("caller not in match")

        if r.consent_a and r.consent_b:
            r.state = MatchState.DECRYPTING
            r.decrypt_deadline = (r.consent_deadline or 0) + self.decrypt_window_s

    def decline(self, match_id: int, caller: str):
        r = self.records[match_id]
        if r.state != MatchState.PENDING_CONSENT:
            return
        if caller not in {r.user_a, r.user_b}:
            raise ValueError("caller not in match")
        r.state = MatchState.CLOSED
        r.close_reason = CloseReason.DECLINED

    def close_expired_match(self, match_id: int, now_ts: int):
        r = self.records[match_id]
        if r.state == MatchState.PENDING_CONSENT and r.consent_deadline is not None and now_ts > r.consent_deadline:
            r.state = MatchState.CLOSED
            r.close_reason = CloseReason.CONSENT_EXPIRED

    def close_stuck_decryption(self, match_id: int, now_ts: int):
        r = self.records[match_id]
        if r.state == MatchState.DECRYPTING and r.decrypt_deadline is not None and now_ts > r.decrypt_deadline:
            r.state = MatchState.CLOSED
            r.close_reason = CloseReason.DECRYPT_FAILED

    def on_decryption_fulfilled(self, match_id: int) -> Tuple[MatchState, CloseReason]:
        r = self.records[match_id]
        if r.state != MatchState.DECRYPTING:
            return r.state, r.close_reason

        active_a = self._participant_active(r.user_a)
        active_b = self._participant_active(r.user_b)

        if not (active_a and active_b):
            r.state = MatchState.CLOSED
            r.close_reason = CloseReason.SUPERSEDED
            return r.state, r.close_reason

        r.state = MatchState.REVEALED
        r.close_reason = CloseReason.NONE
        self.profiles[r.user_a].status = "Matched"
        self.profiles[r.user_b].status = "Matched"

        for mid, other in self.records.items():
            if mid == match_id:
                continue
            involves_a = other.user_a == r.user_a or other.user_b == r.user_a
            involves_b = other.user_a == r.user_b or other.user_b == r.user_b
            if involves_a or involves_b:
                if other.state in {MatchState.PENDING_CONSENT, MatchState.DECRYPTING}:
                    other.state = MatchState.CLOSED
                    other.close_reason = CloseReason.SUPERSEDED

        return r.state, r.close_reason

    def snapshot(self) -> List[dict]:
        rows = []
        for r in sorted(self.records.values(), key=lambda x: x.match_id):
            rows.append(
                {
                    "match_id": r.match_id,
                    "state": r.state.value,
                    "close_reason": r.close_reason.value,
                    "consent_a": r.consent_a,
                    "consent_b": r.consent_b,
                }
            )
        return rows
