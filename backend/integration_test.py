"""
integration_test.py
===================
End-to-end integration tests for all new backend modules:
  - matcher_service: LiveMatcherPipeline (batch + retry + heartbeat + expiry)
  - decryption_callback: simulate_decryption_callback + DecryptionCallbackMonitor
  - keeper: KeeperScheduler single-cycle

All tests run in mock mode (no network / chain calls).
"""
from __future__ import annotations

import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from state_machine import MatchEngine, MatchRecord, MatchState, CloseReason
from matcher_sweep import MatcherHeartbeat, RetryQueue, SweepEngine

from matcher_service import (
    IdempotencyStore, ChainInterface, LiveMatcherPipeline,
    PersistentRetryQueue, compute_koota_score, abi_encode_score,
)
from decryption_callback import (
    CallbackChainInterface, DecryptionCallbackMonitor,
    build_sim_proof, simulate_decryption_callback,
)
from keeper import KeeperScheduler, build_keeper

# ─────────────────────────────────────────────────────────────────────────────
# Test harness
# ─────────────────────────────────────────────────────────────────────────────

PASS, FAIL = "✅", "❌"
results: list[dict] = []


def assert_eq(actual, expected, msg: str):
    if actual != expected:
        raise AssertionError(f"{msg}\n  expected: {expected!r}\n  got:      {actual!r}")


def assert_true(val, msg: str):
    if not val:
        raise AssertionError(f"{msg}: expected truthy, got {val!r}")


def assert_false(val, msg: str):
    if val:
        raise AssertionError(f"{msg}: expected falsy, got {val!r}")


def run(label: str, fn):
    try:
        fn()
        results.append({"label": label, "status": "pass", "error": None})
        print(f"  {PASS}  {label}")
    except Exception as exc:
        results.append({"label": label, "status": "fail", "error": str(exc)})
        print(f"  {FAIL}  {label}")
        print(f"      {exc}")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers — build mock pipeline
# ─────────────────────────────────────────────────────────────────────────────

import tempfile
from pathlib import Path as _Path


def _make_pipeline():
    """Build a fully mocked LiveMatcherPipeline with temp store paths."""
    tmp  = _Path(tempfile.mkdtemp())
    me   = MatchEngine(consent_window_s=600, decrypt_window_s=60)
    hb   = MatcherHeartbeat(sla_s=3600)
    rq   = PersistentRetryQueue(path=tmp / "rq.json", max_attempts=3, backoff_s=10)
    sw   = SweepEngine(me, hb, rq, max_per_tx=10)
    iso  = IdempotencyStore(path=tmp / "iso.json")
    chain = ChainInterface(mock=True)
    return LiveMatcherPipeline(
        chain=chain, sweep_engine=sw, idempotency=iso, retry_queue=rq,
        batch_size=10, sweep_interval_s=1, heartbeat_interval_s=0,
    )


def _make_cb_chain():
    return CallbackChainInterface(mock=True)


# ─────────────────────────────────────────────────────────────────────────────
# compute_koota_score
# ─────────────────────────────────────────────────────────────────────────────

def test_score_range():
    for a in range(1, 10):
        for b in range(a + 1, 10):
            s = compute_koota_score(a, b)
            assert 0 <= s <= 36, f"score out of range for ({a},{b}): {s}"


def test_score_symmetric():
    assert_eq(compute_koota_score(3, 7), compute_koota_score(7, 3), "score symmetric")


# ─────────────────────────────────────────────────────────────────────────────
# IdempotencyStore
# ─────────────────────────────────────────────────────────────────────────────

def test_idempotency_seen_mark():
    tmp = _Path(tempfile.mkdtemp())
    iso = IdempotencyStore(path=tmp / "iso.json")
    assert_false(iso.seen(1, 2), "not seen before mark")
    iso.mark(1, 2)
    assert_true(iso.seen(1, 2),  "seen after mark")
    assert_true(iso.seen(2, 1),  "symmetric seen")


def test_idempotency_persist():
    tmp = _Path(tempfile.mkdtemp())
    p   = tmp / "iso.json"
    iso1 = IdempotencyStore(path=p)
    iso1.mark(10, 20)
    iso2 = IdempotencyStore(path=p)   # re-load
    assert_true(iso2.seen(10, 20), "persisted across instances")


# ─────────────────────────────────────────────────────────────────────────────
# process_auto_matches_batch
# ─────────────────────────────────────────────────────────────────────────────

def test_batch_no_pairs():
    pl = _make_pipeline()
    res = pl.process_auto_matches_batch([])
    assert_eq(res["pairs"], 0, "empty pool → 0 pairs")
    assert_eq(res["tx"],    None, "empty pool → no tx")


def test_batch_new_pairs():
    pl  = _make_pipeline()
    res = pl.process_auto_matches_batch([1, 2, 3])
    assert_true(res["pairs"] > 0, "new pairs processed")
    assert_true(res["tx"] is not None, "tx returned")


def test_batch_idempotent():
    pl  = _make_pipeline()
    r1  = pl.process_auto_matches_batch([1, 2])
    r2  = pl.process_auto_matches_batch([1, 2])
    assert_eq(r1["pairs"], 1, "first run: 1 pair")
    assert_eq(r2["pairs"], 0, "second run: idempotent, 0 new pairs")


def test_batch_respects_batch_size():
    pl  = _make_pipeline()
    pl.batch_size = 2
    # 5 profiles → 10 unique pairs, but batch_size=2 limits first run
    res = pl.process_auto_matches_batch([1, 2, 3, 4, 5])
    assert_true(res["pairs"] <= 2, "batch_size cap respected")


# ─────────────────────────────────────────────────────────────────────────────
# submit_match_score with retry
# ─────────────────────────────────────────────────────────────────────────────

def test_submit_score_success():
    pl = _make_pipeline()
    ok = pl.submit_match_score(match_id=42, plain_score=29)
    assert_true(ok, "submit returns True on success")


def test_submit_score_retry_on_failure():
    pl = _make_pipeline()
    # Monkey-patch chain to fail
    def fail(*a, **kw): raise RuntimeError("rpc error")
    pl.chain.submit_match_score = fail
    ok = pl.submit_match_score(42, 29)
    assert_false(ok, "returns False on failure")
    assert_true(pl.retry_queue.pending_count() >= 1, "retry enqueued")


def test_drain_retries_resolves():
    pl = _make_pipeline()
    # Pre-populate a due retry job
    now = int(time.time())
    pl.retry_queue.enqueue(99, "test", now - 100)   # already due
    resolved = pl.drain_retries()
    assert_true(resolved >= 1, "drain resolved at least 1 job")


# ─────────────────────────────────────────────────────────────────────────────
# Heartbeat
# ─────────────────────────────────────────────────────────────────────────────

def test_heartbeat_fires_when_due():
    pl = _make_pipeline()
    pl.hb_interval_s  = 0   # always due
    pl._last_hb_ts    = 0
    ok = pl.maybe_heartbeat()
    assert_true(ok, "heartbeat fires when due")
    assert_true(pl.sweep.heartbeat.beat_count >= 1, "sweep heartbeat recorded")


def test_heartbeat_skipped_when_not_due():
    pl = _make_pipeline()
    pl.hb_interval_s = 9999
    pl._last_hb_ts   = int(time.time())
    ok = pl.maybe_heartbeat()
    assert_false(ok, "heartbeat skipped when not due")


# ─────────────────────────────────────────────────────────────────────────────
# Expiry sweep
# ─────────────────────────────────────────────────────────────────────────────

def test_expiry_sweep_mock():
    pl = _make_pipeline()
    stale = [(101, "consent_expired"), (102, "decrypt_stuck")]
    # Should not raise even in mock mode
    pl.expiry_sweep(stale)
    assert_true(True, "expiry_sweep completed without error")


# ─────────────────────────────────────────────────────────────────────────────
# build_sim_proof
# ─────────────────────────────────────────────────────────────────────────────

def test_sim_proof_length():
    proof = build_sim_proof(42, 29, "0x11E8B83EEF9D8C36bC616014165F61a3b1739dc0")
    assert_eq(len(proof), 32, "sim proof is 32 bytes")


def test_sim_proof_deterministic():
    p1 = build_sim_proof(1, 30, "0xABCD")
    p2 = build_sim_proof(1, 30, "0xABCD")
    assert_eq(p1, p2, "proof is deterministic")


def test_sim_proof_different_inputs():
    p1 = build_sim_proof(1, 30, "0xABCD")
    p2 = build_sim_proof(1, 31, "0xABCD")
    assert_true(p1 != p2, "different score → different proof")


# ─────────────────────────────────────────────────────────────────────────────
# simulate_decryption_callback
# ─────────────────────────────────────────────────────────────────────────────

def test_simulate_decryption_callback_mock():
    chain = _make_cb_chain()
    tx = simulate_decryption_callback(42, 29, chain)
    assert_true("mock" in tx.lower() or tx.startswith("0x"), "returns a tx-like string")


# ─────────────────────────────────────────────────────────────────────────────
# DecryptionCallbackMonitor
# ─────────────────────────────────────────────────────────────────────────────

def test_monitor_close_stuck_match():
    chain   = _make_cb_chain()
    monitor = DecryptionCallbackMonitor(chain, poll_interval_s=1, grace_period_s=0)

    # Monkey-patch get_decrypting_matches to return an overdue match
    now = int(time.time())
    chain.get_decrypting_matches = lambda: [(55, now - 3600)]  # 1h overdue

    closed = monitor.check_once(now_ts=now)
    assert_true(55 in closed, "overdue match closed by monitor")


def test_monitor_skips_fresh_match():
    chain   = _make_cb_chain()
    monitor = DecryptionCallbackMonitor(chain, poll_interval_s=1, grace_period_s=60)
    now = int(time.time())
    # deadline 30s in the future → within grace period
    chain.get_decrypting_matches = lambda: [(99, now + 30)]
    closed = monitor.check_once(now_ts=now)
    assert_eq(closed, [], "fresh match not closed")


# ─────────────────────────────────────────────────────────────────────────────
# KeeperScheduler
# ─────────────────────────────────────────────────────────────────────────────

def test_keeper_single_cycle():
    keeper = build_keeper(mock=True)
    keeper._sw_interval = 0   # force all jobs to run
    keeper._ex_interval = 0
    keeper._hb_interval = 0
    keeper.pipeline._last_hb_ts = 0
    keeper.run_cycle()
    stats = keeper._stats
    assert_true(stats["sweeps"] >= 1,      "sweep ran")
    assert_true(stats["expiry_runs"] >= 1, "expiry ran")
    assert_true(stats["heartbeats"] >= 1,  "heartbeat ran")


def test_keeper_respects_intervals():
    keeper = build_keeper(mock=True)
    # Very long intervals — none should fire
    keeper._sw_interval = 9999
    keeper._ex_interval = 9999
    keeper._hb_interval = 9999
    keeper._last_sw = int(time.time())
    keeper._last_ex = int(time.time())
    keeper._last_hb = int(time.time())
    keeper.pipeline._last_hb_ts = int(time.time())
    keeper.run_cycle()
    stats = keeper._stats
    assert_eq(stats["sweeps"],     0, "sweep skipped when not due")
    assert_eq(stats["expiry_runs"], 0, "expiry skipped when not due")
    assert_eq(stats["heartbeats"], 0, "heartbeat skipped when not due")


# ─────────────────────────────────────────────────────────────────────────────
# Runner
# ─────────────────────────────────────────────────────────────────────────────

def run_all():
    print("\n── Koota Scorer ──────────────────────────────────────")
    run("score in range 0-36",              test_score_range)
    run("score symmetric",                  test_score_symmetric)

    print("\n── IdempotencyStore ──────────────────────────────────")
    run("seen / mark lifecycle",            test_idempotency_seen_mark)
    run("persists across instances",        test_idempotency_persist)

    print("\n── processAutoMatchesBatch ───────────────────────────")
    run("empty pool → zero pairs",          test_batch_no_pairs)
    run("new pairs → tx returned",          test_batch_new_pairs)
    run("idempotent: second run skips",     test_batch_idempotent)
    run("batch_size cap respected",         test_batch_respects_batch_size)

    print("\n── submitMatchScore + retry ──────────────────────────")
    run("success returns True",             test_submit_score_success)
    run("failure enqueues retry",           test_submit_score_retry_on_failure)
    run("drain_retries resolves due jobs",  test_drain_retries_resolves)

    print("\n── Heartbeat ─────────────────────────────────────────")
    run("fires when due",                   test_heartbeat_fires_when_due)
    run("skipped when not due",             test_heartbeat_skipped_when_not_due)

    print("\n── Expiry Sweep ──────────────────────────────────────")
    run("expiry_sweep mock no error",       test_expiry_sweep_mock)

    print("\n── Sim Proof ─────────────────────────────────────────")
    run("proof is 32 bytes",                test_sim_proof_length)
    run("proof is deterministic",           test_sim_proof_deterministic)
    run("different input → different proof", test_sim_proof_different_inputs)

    print("\n── onDecryptionFulfilled callback ────────────────────")
    run("simulate callback mock",           test_simulate_decryption_callback_mock)

    print("\n── DecryptionCallbackMonitor ─────────────────────────")
    run("closes overdue stuck match",       test_monitor_close_stuck_match)
    run("skips fresh match in grace period", test_monitor_skips_fresh_match)

    print("\n── KeeperScheduler ───────────────────────────────────")
    run("single cycle runs all jobs",       test_keeper_single_cycle)
    run("respects intervals (skip all)",    test_keeper_respects_intervals)

    total  = len(results)
    passed = sum(1 for r in results if r["status"] == "pass")
    failed = total - passed
    print(f"\n─────────────────────────────────────────────────────")
    print(f"Integration results: {passed}/{total} passed",
          "🎉" if not failed else f"  ({failed} FAILED)")
    return results


if __name__ == "__main__":
    run_all()
    failed = [r for r in results if r["status"] == "fail"]
    sys.exit(1 if failed else 0)
