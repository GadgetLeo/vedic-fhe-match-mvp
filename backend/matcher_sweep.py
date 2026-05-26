"""
matcher_sweep.py
================
Simulation of the M2 backend workstream:
  - MatcherQueue     : ordered sweep queue with batch dequeue
  - MatcherHeartbeat : periodic timestamp tracking + SLA violation detection
  - DelayedStatus    : derives per-profile UI state from heartbeat + profile age
  - SweepEngine      : wires queue + heartbeat + MatchEngine together

All behaviour is deterministic and in-memory so it can be driven from sim tests
without any network or chain dependency.
"""
from __future__ import annotations

import heapq
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

from state_machine import MatchEngine, MatchRecord, MatchState, CloseReason


# ---------------------------------------------------------------------------
# Constants (mirrors PRD §0A defaults — can be overridden in tests)
# ---------------------------------------------------------------------------
DEFAULT_MATCHER_SLA_S: int = 6 * 3600     # 6 h
DEFAULT_MAX_NEW_MATCHES_PER_TX: int = 5
DEFAULT_ACTIVE_POOL_CAP: int = 500


# ---------------------------------------------------------------------------
# MatcherQueue
# ---------------------------------------------------------------------------
class QueueEntry:
    """Priority-queue entry: lower priority_ts = processed first."""
    __slots__ = ("priority_ts", "profile_id", "owner", "enqueued_at")

    def __init__(self, priority_ts: int, profile_id: int, owner: str, enqueued_at: int):
        self.priority_ts = priority_ts
        self.profile_id = profile_id
        self.owner = owner
        self.enqueued_at = enqueued_at

    def __lt__(self, other: "QueueEntry") -> bool:
        return self.priority_ts < other.priority_ts

    def to_dict(self) -> dict:
        return {
            "priority_ts": self.priority_ts,
            "profile_id": self.profile_id,
            "owner": self.owner,
            "enqueued_at": self.enqueued_at,
        }


class MatcherQueue:
    """
    Min-heap sweep queue.  Profiles are enqueued on activation; removed when
    matched or withdrawn.  dequeue_batch returns up to N entries in priority
    order.
    """

    def __init__(self):
        self._heap: List[QueueEntry] = []
        self._removed: set = set()   # owner keys marked as logically removed

    def enqueue(self, owner: str, profile_id: int, priority_ts: int, now_ts: int):
        entry = QueueEntry(priority_ts, profile_id, owner, now_ts)
        heapq.heappush(self._heap, entry)

    def remove(self, owner: str):
        """Mark a profile as logically removed (lazy deletion)."""
        self._removed.add(owner)

    def dequeue_batch(self, max_count: int) -> List[QueueEntry]:
        """Pop up to max_count valid entries."""
        results: List[QueueEntry] = []
        while self._heap and len(results) < max_count:
            # Peek
            top = self._heap[0]
            if top.owner in self._removed:
                heapq.heappop(self._heap)
                continue
            heapq.heappop(self._heap)
            results.append(top)
        return results

    def size(self) -> int:
        """Approximate size (includes logically removed entries)."""
        return len(self._heap)

    def pending_count(self) -> int:
        """Count entries that haven't been removed."""
        return sum(1 for e in self._heap if e.owner not in self._removed)

    def snapshot(self) -> List[dict]:
        return [e.to_dict() for e in sorted(self._heap, key=lambda x: x.priority_ts)
                if e.owner not in self._removed]


# ---------------------------------------------------------------------------
# MatcherHeartbeat
# ---------------------------------------------------------------------------
@dataclass
class HeartbeatRecord:
    beat_ts: int
    beat_number: int


class MatcherHeartbeat:
    """
    Records periodic heartbeat timestamps from the matcher service.
    Allows any consumer to check if the matcher is alive (last beat within SLA).
    """

    def __init__(self, sla_s: int = DEFAULT_MATCHER_SLA_S):
        self.sla_s = sla_s
        self._beats: List[HeartbeatRecord] = []
        self._beat_counter: int = 0

    def beat(self, now_ts: int):
        self._beat_counter += 1
        self._beats.append(HeartbeatRecord(now_ts, self._beat_counter))

    @property
    def last_beat_ts(self) -> Optional[int]:
        return self._beats[-1].beat_ts if self._beats else None

    @property
    def beat_count(self) -> int:
        return len(self._beats)

    def is_alive(self, now_ts: int) -> bool:
        if self.last_beat_ts is None:
            return False
        return (now_ts - self.last_beat_ts) <= self.sla_s

    def seconds_since_last_beat(self, now_ts: int) -> Optional[int]:
        if self.last_beat_ts is None:
            return None
        return now_ts - self.last_beat_ts

    def snapshot(self) -> dict:
        return {
            "beat_count": self._beat_counter,
            "last_beat_ts": self.last_beat_ts,
            "sla_s": self.sla_s,
        }


# ---------------------------------------------------------------------------
# DelayedStatus
# ---------------------------------------------------------------------------
class ProfileUIStatus(str, Enum):
    QUEUED = "Queued"
    PROCESSING = "Processing"
    DELAYED = "Delayed"       # SLA exceeded — spinner shows warning
    MATCHED = "Matched"


@dataclass
class ProfileStatusResult:
    owner: str
    ui_status: ProfileUIStatus
    age_s: int
    sla_exceeded: bool
    matcher_alive: bool
    message: str


class DelayedStatus:
    """
    Derives per-profile UI status from:
      - profile activation time
      - matcher heartbeat liveness
      - whether a Revealed match exists for the owner
    """

    def __init__(self, heartbeat: MatcherHeartbeat, sla_s: int = DEFAULT_MATCHER_SLA_S):
        self.heartbeat = heartbeat
        self.sla_s = sla_s

    def compute(
        self,
        owner: str,
        activated_ts: int,
        now_ts: int,
        has_revealed: bool = False,
    ) -> ProfileStatusResult:
        if has_revealed:
            return ProfileStatusResult(
                owner=owner,
                ui_status=ProfileUIStatus.MATCHED,
                age_s=now_ts - activated_ts,
                sla_exceeded=False,
                matcher_alive=self.heartbeat.is_alive(now_ts),
                message="Match revealed — see result.",
            )

        age_s = now_ts - activated_ts
        sla_exceeded = age_s > self.sla_s
        alive = self.heartbeat.is_alive(now_ts)

        if sla_exceeded:
            status = ProfileUIStatus.DELAYED
            msg = (
                f"Matching delayed: your profile has been active for "
                f"{age_s // 3600}h (SLA: {self.sla_s // 3600}h). "
                "Processing continues automatically."
            )
        elif alive:
            status = ProfileUIStatus.PROCESSING
            msg = "Matcher is active — searching for compatible profiles."
        else:
            status = ProfileUIStatus.QUEUED
            msg = "Waiting for matcher to pick up your profile."

        return ProfileStatusResult(
            owner=owner,
            ui_status=status,
            age_s=age_s,
            sla_exceeded=sla_exceeded,
            matcher_alive=alive,
            message=msg,
        )


# ---------------------------------------------------------------------------
# RetryQueue
# ---------------------------------------------------------------------------
@dataclass
class RetryJob:
    job_id: int
    match_id: int
    attempt: int
    next_retry_ts: int
    reason: str


class RetryQueue:
    """
    Simple in-memory retry queue for failed submitMatchScore jobs.
    Jobs with next_retry_ts <= now_ts are eligible for retry.
    """

    def __init__(self, max_attempts: int = 5, backoff_s: int = 60):
        self.max_attempts = max_attempts
        self.backoff_s = backoff_s
        self._jobs: Dict[int, RetryJob] = {}
        self._counter: int = 0

    def enqueue(self, match_id: int, reason: str, now_ts: int) -> RetryJob:
        self._counter += 1
        job = RetryJob(
            job_id=self._counter,
            match_id=match_id,
            attempt=1,
            next_retry_ts=now_ts + self.backoff_s,
            reason=reason,
        )
        self._jobs[job.job_id] = job
        return job

    def due(self, now_ts: int) -> List[RetryJob]:
        return [j for j in self._jobs.values() if j.next_retry_ts <= now_ts]

    def retry(self, job_id: int, now_ts: int) -> Optional[RetryJob]:
        job = self._jobs.get(job_id)
        if job is None:
            return None
        if job.attempt >= self.max_attempts:
            del self._jobs[job_id]
            return None
        job.attempt += 1
        job.next_retry_ts = now_ts + self.backoff_s * (2 ** (job.attempt - 1))
        return job

    def complete(self, job_id: int):
        self._jobs.pop(job_id, None)

    def pending_count(self) -> int:
        return len(self._jobs)

    def snapshot(self) -> List[dict]:
        return [
            {
                "job_id": j.job_id,
                "match_id": j.match_id,
                "attempt": j.attempt,
                "next_retry_ts": j.next_retry_ts,
                "reason": j.reason,
            }
            for j in sorted(self._jobs.values(), key=lambda x: x.next_retry_ts)
        ]


# ---------------------------------------------------------------------------
# SweepEngine (top-level integration)
# ---------------------------------------------------------------------------
@dataclass
class SweepResult:
    pairs_processed: int
    matches_scored: int
    qualified: int
    not_qualified: int
    retry_enqueued: int


class SweepEngine:
    """
    Wires MatcherQueue, MatcherHeartbeat, RetryQueue, and MatchEngine together.

    sweep_batch():
      1. Dequeue up to MAX_NEW_MATCHES_PER_TX profiles
      2. Score them against a provided score_fn, deduplicating symmetric pairs
      3. Feed results into MatchEngine
      4. Enqueue failed scorings into RetryQueue
      5. Record heartbeat
    """

    def __init__(
        self,
        match_engine: MatchEngine,
        heartbeat: MatcherHeartbeat,
        retry_queue: RetryQueue,
        max_per_tx: int = DEFAULT_MAX_NEW_MATCHES_PER_TX,
    ):
        self.queue = MatcherQueue()
        self.match_engine = match_engine
        self.heartbeat = heartbeat
        self.retry_queue = retry_queue
        self.max_per_tx = max_per_tx
        self._match_id_counter: int = 100
        # Track scored pairs to avoid symmetric duplicates (A,B) == (B,A)
        self._scored_pairs: set = set()

    def _next_match_id(self) -> int:
        self._match_id_counter += 1
        return self._match_id_counter

    def activate_profile(self, owner: str, profile_id: int, now_ts: int):
        """Add profile to both MatchEngine and sweep queue."""
        self.match_engine.add_profile(owner, profile_id)
        self.queue.enqueue(owner, profile_id, priority_ts=now_ts, now_ts=now_ts)

    def sweep_batch(
        self,
        now_ts: int,
        score_fn,          # Callable[[str, str], Optional[int]] — may return None to simulate failure
        candidate_pool: List[str],   # list of all active owner addresses
    ) -> SweepResult:
        """
        Dequeue a batch of profiles and attempt to score them against
        each other.  Symmetric pairs are deduplicated so (A,B) is only
        scored once regardless of which owner appears in the batch first.
        """
        batch = self.queue.dequeue_batch(self.max_per_tx)
        pairs_processed = 0
        matches_scored = 0
        qualified = 0
        not_qualified = 0
        retry_enqueued = 0

        for entry in batch:
            for candidate in candidate_pool:
                if candidate == entry.owner:
                    continue
                # Deduplicate: canonical pair key is frozenset
                pair_key = frozenset([entry.owner, candidate])
                if pair_key in self._scored_pairs:
                    continue
                self._scored_pairs.add(pair_key)
                pairs_processed += 1
                score = score_fn(entry.owner, candidate)
                mid = self._next_match_id()

                if score is None:
                    # scorer failed — send to retry queue
                    self.retry_queue.enqueue(mid, reason="score_fn_failed", now_ts=now_ts)
                    retry_enqueued += 1
                    continue

                rec = MatchRecord(
                    match_id=mid,
                    user_a=entry.owner,
                    user_b=candidate,
                    profile_id_a=entry.profile_id,
                    profile_id_b=self.match_engine.profiles[candidate].profile_id,
                    profile_version_a=self.match_engine.profiles[entry.owner].profile_version,
                    profile_version_b=self.match_engine.profiles[candidate].profile_version,
                    score36=score,
                )
                self.match_engine.add_scored_match(rec)
                matches_scored += 1
                if rec.qualifies:
                    qualified += 1
                else:
                    not_qualified += 1

        self.heartbeat.beat(now_ts)
        return SweepResult(
            pairs_processed=pairs_processed,
            matches_scored=matches_scored,
            qualified=qualified,
            not_qualified=not_qualified,
            retry_enqueued=retry_enqueued,
        )

    def expire_sweep(self, now_ts: int):
        """Close consent-expired and stuck-decrypting records."""
        for mid, rec in list(self.match_engine.records.items()):
            if rec.state == MatchState.PENDING_CONSENT:
                self.match_engine.close_expired_match(mid, now_ts)
            elif rec.state == MatchState.DECRYPTING:
                self.match_engine.close_stuck_decryption(mid, now_ts)
