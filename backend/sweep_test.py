"""
sweep_test.py
=============
Deterministic tests for:
  - MatcherQueue  (enqueue, dequeue_batch, lazy-remove, priority ordering)
  - MatcherHeartbeat (beat, is_alive, SLA violation)
  - DelayedStatus (Queued / Processing / Delayed / Matched derivations)
  - RetryQueue (enqueue, due, retry with backoff, complete)
  - SweepEngine.sweep_batch (qualified + not-qualified + retry path)
  - SweepEngine.expire_sweep (consent-expiry + stuck-decrypt recovery)
  - Full integration scenario: activate → sweep → consent → reveal → sibling superseded
"""

import sys
import traceback
from state_machine import (
    MatchEngine, MatchRecord, MatchState, CloseReason,
)
from matcher_sweep import (
    MatcherQueue, MatcherHeartbeat, DelayedStatus, ProfileUIStatus,
    RetryQueue, SweepEngine,
)

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

PASS = "✅"
FAIL = "❌"

results: list[dict] = []


def assert_eq(actual, expected, msg: str):
    if actual != expected:
        raise AssertionError(f"{msg}\n  expected: {expected!r}\n  got:      {actual!r}")


def run(label: str, fn):
    """Execute fn(); record pass/fail."""
    try:
        fn()
        results.append({"label": label, "status": "pass", "error": None})
        print(f"  {PASS}  {label}")
    except Exception as exc:
        tb = traceback.format_exc()
        results.append({"label": label, "status": "fail", "error": str(exc)})
        print(f"  {FAIL}  {label}")
        print(f"      {exc}")


# ──────────────────────────────────────────────────────────────────────────────
# MatcherQueue tests
# ──────────────────────────────────────────────────────────────────────────────

def test_queue_enqueue_and_dequeue():
    q = MatcherQueue()
    q.enqueue("alice", 1, priority_ts=100, now_ts=100)
    q.enqueue("bob",   2, priority_ts=50,  now_ts=100)
    q.enqueue("carol", 3, priority_ts=200, now_ts=100)
    batch = q.dequeue_batch(2)
    assert_eq(len(batch), 2, "batch size")
    # bob has lowest priority_ts, should come first
    assert_eq(batch[0].owner, "bob",   "first dequeued owner")
    assert_eq(batch[1].owner, "alice", "second dequeued owner")


def test_queue_lazy_remove():
    q = MatcherQueue()
    q.enqueue("dave", 10, priority_ts=10, now_ts=0)
    q.enqueue("eve",  11, priority_ts=20, now_ts=0)
    q.remove("dave")
    batch = q.dequeue_batch(10)
    owners = [e.owner for e in batch]
    assert_eq("dave" in owners, False, "removed owner not in batch")
    assert_eq("eve"  in owners, True,  "non-removed owner in batch")


def test_queue_pending_count():
    q = MatcherQueue()
    q.enqueue("u1", 1, 10, 0)
    q.enqueue("u2", 2, 20, 0)
    q.enqueue("u3", 3, 30, 0)
    q.remove("u2")
    assert_eq(q.pending_count(), 2, "pending count after remove")


# ──────────────────────────────────────────────────────────────────────────────
# MatcherHeartbeat tests
# ──────────────────────────────────────────────────────────────────────────────

def test_heartbeat_alive():
    hb = MatcherHeartbeat(sla_s=600)
    hb.beat(1000)
    assert_eq(hb.is_alive(1500), True, "alive within SLA")
    assert_eq(hb.is_alive(1700), False, "dead beyond SLA")


def test_heartbeat_no_beat():
    hb = MatcherHeartbeat(sla_s=600)
    assert_eq(hb.is_alive(0), False, "no beat => not alive")
    assert_eq(hb.last_beat_ts, None, "last_beat_ts None before any beat")


def test_heartbeat_multiple_beats():
    hb = MatcherHeartbeat(sla_s=300)
    hb.beat(100)
    hb.beat(500)
    hb.beat(900)
    assert_eq(hb.beat_count, 3, "beat count")
    assert_eq(hb.last_beat_ts, 900, "last beat ts")
    assert_eq(hb.seconds_since_last_beat(1000), 100, "seconds since last beat")


# ──────────────────────────────────────────────────────────────────────────────
# DelayedStatus tests
# ──────────────────────────────────────────────────────────────────────────────

def test_status_queued():
    hb = MatcherHeartbeat(sla_s=600)
    ds = DelayedStatus(hb, sla_s=3600)
    # no heartbeat yet, not SLA-exceeded
    r = ds.compute("alice", activated_ts=0, now_ts=100)
    assert_eq(r.ui_status, ProfileUIStatus.QUEUED, "status without heartbeat = Queued")
    assert_eq(r.matcher_alive, False, "matcher not alive")


def test_status_processing():
    hb = MatcherHeartbeat(sla_s=600)
    hb.beat(50)
    ds = DelayedStatus(hb, sla_s=3600)
    r = ds.compute("alice", activated_ts=0, now_ts=100)
    assert_eq(r.ui_status, ProfileUIStatus.PROCESSING, "status with fresh heartbeat = Processing")
    assert_eq(r.matcher_alive, True, "matcher alive")


def test_status_delayed():
    hb = MatcherHeartbeat(sla_s=600)
    hb.beat(50)
    ds = DelayedStatus(hb, sla_s=3600)
    r = ds.compute("alice", activated_ts=0, now_ts=3700)  # 3700 > 3600 SLA
    assert_eq(r.ui_status, ProfileUIStatus.DELAYED, "SLA exceeded = Delayed")
    assert_eq(r.sla_exceeded, True, "sla_exceeded flag")


def test_status_matched():
    hb = MatcherHeartbeat(sla_s=600)
    hb.beat(50)
    ds = DelayedStatus(hb, sla_s=3600)
    r = ds.compute("alice", activated_ts=0, now_ts=100, has_revealed=True)
    assert_eq(r.ui_status, ProfileUIStatus.MATCHED, "has_revealed = Matched")


# ──────────────────────────────────────────────────────────────────────────────
# RetryQueue tests
# ──────────────────────────────────────────────────────────────────────────────

def test_retry_enqueue_and_due():
    rq = RetryQueue(max_attempts=3, backoff_s=60)
    job = rq.enqueue(match_id=1, reason="score_fn_failed", now_ts=0)
    assert_eq(rq.pending_count(), 1, "pending after enqueue")
    # not yet due
    assert_eq(len(rq.due(50)), 0, "not due before backoff")
    # now due
    assert_eq(len(rq.due(70)), 1, "due after backoff")
    assert_eq(rq.due(70)[0].match_id, 1, "correct match_id in due list")


def test_retry_backoff():
    rq = RetryQueue(max_attempts=3, backoff_s=60)
    job = rq.enqueue(match_id=5, reason="fail", now_ts=0)
    jid = job.job_id
    j2 = rq.retry(jid, now_ts=65)   # first retry
    assert_eq(j2.attempt, 2, "attempt incremented")
    assert_eq(j2.next_retry_ts, 65 + 60 * 2, "exponential backoff")


def test_retry_max_attempts_exhausted():
    rq = RetryQueue(max_attempts=2, backoff_s=10)
    job = rq.enqueue(match_id=9, reason="fail", now_ts=0)
    jid = job.job_id
    rq.retry(jid, now_ts=15)        # attempt=2, this is last
    result = rq.retry(jid, now_ts=50)  # should be evicted
    assert_eq(result, None, "None returned when max_attempts exhausted")
    assert_eq(rq.pending_count(), 0, "job evicted after exhaustion")


def test_retry_complete():
    rq = RetryQueue(max_attempts=5, backoff_s=30)
    job = rq.enqueue(match_id=3, reason="fail", now_ts=0)
    rq.complete(job.job_id)
    assert_eq(rq.pending_count(), 0, "job removed on complete")


# ──────────────────────────────────────────────────────────────────────────────
# SweepEngine tests
# ──────────────────────────────────────────────────────────────────────────────

def _make_sweep_engine(consent_window=200, decrypt_window=50):
    me = MatchEngine(consent_window_s=consent_window, decrypt_window_s=decrypt_window)
    hb = MatcherHeartbeat(sla_s=600)
    rq = RetryQueue(max_attempts=3, backoff_s=60)
    return SweepEngine(me, hb, rq, max_per_tx=5)


def test_sweep_qualified_and_not_qualified():
    eng = _make_sweep_engine()
    eng.activate_profile("A", 1, now_ts=0)
    eng.activate_profile("B", 2, now_ts=0)
    eng.activate_profile("C", 3, now_ts=0)

    pool = ["A", "B", "C"]

    def score_fn(u1, u2):
        pairs = {frozenset(["A", "B"]): 30, frozenset(["A", "C"]): 20}
        return pairs.get(frozenset([u1, u2]), 18)

    result = eng.sweep_batch(now_ts=10, score_fn=score_fn, candidate_pool=pool)
    assert_eq(result.matches_scored > 0, True, "at least one match scored")
    assert_eq(result.qualified >= 1, True, "at least one qualified")
    assert_eq(result.not_qualified >= 1, True, "at least one not qualified")
    assert_eq(eng.heartbeat.last_beat_ts, 10, "heartbeat recorded after sweep")


def test_sweep_retry_on_score_failure():
    eng = _make_sweep_engine()
    eng.activate_profile("X", 10, now_ts=0)
    eng.activate_profile("Y", 11, now_ts=0)

    pool = ["X", "Y"]
    result = eng.sweep_batch(now_ts=5, score_fn=lambda a, b: None, candidate_pool=pool)
    assert_eq(result.retry_enqueued >= 1, True, "retry job enqueued on failure")
    assert_eq(eng.retry_queue.pending_count() >= 1, True, "retry queue has pending jobs")


def test_expire_sweep_consent():
    eng = _make_sweep_engine(consent_window=100, decrypt_window=50)
    me = eng.match_engine

    # Manually insert a match that should expire
    me.add_profile("P", 20)
    me.add_profile("Q", 21)
    rec = MatchRecord(901, "P", "Q", 20, 21, 1, 1, score36=30)
    me.add_scored_match(rec)
    assert_eq(me.records[901].state, MatchState.PENDING_CONSENT, "starts PendingConsent")

    # Expire at ts=1000 (> consent_deadline of 100)
    eng.expire_sweep(now_ts=1000)
    assert_eq(me.records[901].state, MatchState.CLOSED, "consent-expired match closed")
    assert_eq(me.records[901].close_reason, CloseReason.CONSENT_EXPIRED, "close reason ConsentExpired")


def test_expire_sweep_stuck_decryption():
    eng = _make_sweep_engine(consent_window=100, decrypt_window=50)
    me = eng.match_engine

    me.add_profile("M", 30)
    me.add_profile("N", 31)
    rec = MatchRecord(902, "M", "N", 30, 31, 1, 1, score36=30)
    me.add_scored_match(rec)
    me.consent(902, "M")
    me.consent(902, "N")
    assert_eq(me.records[902].state, MatchState.DECRYPTING, "both consented => Decrypting")

    # stuck decrypt deadline exceeded
    eng.expire_sweep(now_ts=5000)
    assert_eq(me.records[902].state, MatchState.CLOSED, "stuck decrypt closed")
    assert_eq(me.records[902].close_reason, CloseReason.DECRYPT_FAILED, "close reason DecryptFailed")


# ──────────────────────────────────────────────────────────────────────────────
# Full integration scenario
# ──────────────────────────────────────────────────────────────────────────────

def test_full_integration_scenario():
    """
    Activate 3 profiles → sweep → two pairs qualify → first reveal wins →
    sibling for the winner is superseded.
    """
    eng = _make_sweep_engine(consent_window=1000, decrypt_window=200)
    me = eng.match_engine

    eng.activate_profile("Alice", 1, now_ts=0)
    eng.activate_profile("Bob",   2, now_ts=0)
    eng.activate_profile("Carol", 3, now_ts=0)

    pool = ["Alice", "Bob", "Carol"]
    scores = {
        frozenset(["Alice", "Bob"]):   32,
        frozenset(["Alice", "Carol"]): 28,
        frozenset(["Bob",   "Carol"]): 15,
    }
    result = eng.sweep_batch(
        now_ts=100,
        score_fn=lambda a, b: scores.get(frozenset([a, b]), 10),
        candidate_pool=pool,
    )
    # Alice–Bob and Alice–Carol qualified; Bob–Carol did not
    assert_eq(result.qualified, 2, "two qualifying pairs")
    assert_eq(result.not_qualified, 1, "one non-qualifying pair")

    # Find Alice-Bob and Alice-Carol match IDs
    ab_mid = next(mid for mid, r in me.records.items()
                  if {r.user_a, r.user_b} == {"Alice", "Bob"}
                  and r.state == MatchState.PENDING_CONSENT)
    ac_mid = next(mid for mid, r in me.records.items()
                  if {r.user_a, r.user_b} == {"Alice", "Carol"}
                  and r.state == MatchState.PENDING_CONSENT)

    # Both pairs consent
    me.consent(ab_mid, "Alice"); me.consent(ab_mid, "Bob")
    me.consent(ac_mid, "Alice"); me.consent(ac_mid, "Carol")
    assert_eq(me.records[ab_mid].state, MatchState.DECRYPTING, "AB decrypting")
    assert_eq(me.records[ac_mid].state, MatchState.DECRYPTING, "AC decrypting")

    # Alice–Bob reveal wins first
    me.on_decryption_fulfilled(ab_mid)
    assert_eq(me.records[ab_mid].state, MatchState.REVEALED, "AB revealed")

    # Alice–Carol should be superseded
    st, reason = me.on_decryption_fulfilled(ac_mid)
    assert_eq(st, MatchState.CLOSED, "AC closed after Alice already matched")
    assert_eq(reason, CloseReason.SUPERSEDED, "AC superseded")

    # DelayedStatus for Alice should now show Matched
    hb = eng.heartbeat
    hb.beat(200)
    ds = DelayedStatus(hb, sla_s=3600)
    status_r = ds.compute("Alice", activated_ts=0, now_ts=300, has_revealed=True)
    assert_eq(status_r.ui_status, ProfileUIStatus.MATCHED, "Alice shows MATCHED status")


# ──────────────────────────────────────────────────────────────────────────────
# Runner
# ──────────────────────────────────────────────────────────────────────────────

def run_all():
    print("\n── MatcherQueue ─────────────────────────────────")
    run("enqueue and dequeue ordered",      test_queue_enqueue_and_dequeue)
    run("lazy remove excludes evicted",     test_queue_lazy_remove)
    run("pending_count after remove",       test_queue_pending_count)

    print("\n── MatcherHeartbeat ──────────────────────────────")
    run("alive within SLA",                 test_heartbeat_alive)
    run("no beat => not alive",             test_heartbeat_no_beat)
    run("multiple beats / last_beat_ts",    test_heartbeat_multiple_beats)

    print("\n── DelayedStatus ─────────────────────────────────")
    run("Queued when no heartbeat",         test_status_queued)
    run("Processing when matcher alive",    test_status_processing)
    run("Delayed when SLA exceeded",        test_status_delayed)
    run("Matched when has_revealed",        test_status_matched)

    print("\n── RetryQueue ────────────────────────────────────")
    run("enqueue and due list",             test_retry_enqueue_and_due)
    run("exponential backoff",              test_retry_backoff)
    run("max_attempts exhaustion",          test_retry_max_attempts_exhausted)
    run("complete removes job",             test_retry_complete)

    print("\n── SweepEngine ───────────────────────────────────")
    run("sweep qualified + not_qualified",  test_sweep_qualified_and_not_qualified)
    run("sweep retry on score failure",     test_sweep_retry_on_score_failure)
    run("expire ConsensExpired",            test_expire_sweep_consent)
    run("expire DecryptFailed",             test_expire_sweep_stuck_decryption)

    print("\n── Full Integration ──────────────────────────────")
    run("activate→sweep→consent→reveal→supersede", test_full_integration_scenario)

    # Summary
    total  = len(results)
    passed = sum(1 for r in results if r["status"] == "pass")
    failed = total - passed
    print(f"\n─────────────────────────────────────────────────")
    print(f"Results: {passed}/{total} passed", "🎉" if failed == 0 else f"  ({failed} FAILED)")
    return results


if __name__ == "__main__":
    run_all()
    failed = [r for r in results if r["status"] == "fail"]
    sys.exit(1 if failed else 0)
