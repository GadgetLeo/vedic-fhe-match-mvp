"""
keeper.py
=========
Scheduler / keeper daemon for VedicAutoMatch.

Three job types (all configurable via env):
  1. HEARTBEAT    — every HEARTBEAT_INTERVAL_S seconds  (default 3 600 = 1 h)
  2. EXPIRY       — every EXPIRY_INTERVAL_S seconds     (default 300  = 5 min)
     close consent-expired + stuck-decrypt matches on-chain
  3. SWEEP        — every SWEEP_INTERVAL_S seconds      (default 120  = 2 min)
     process new profile pairs via processAutoMatchesBatch

Usage
─────
  python3 keeper.py --mock          # dry-run with mock chain calls
  python3 keeper.py                 # live (needs .env)
  python3 keeper.py --once          # run one cycle and exit (CI / cron)

Cron equivalent (once per sweep interval via system cron):
  */2 * * * * cd /path/to/backend && python3 keeper.py --once --mock >> keeper.log 2>&1
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Callable, List, Tuple

sys.path.insert(0, str(Path(__file__).parent))

from matcher_service import (
    build_pipeline, ChainInterface, IdempotencyStore,
    LiveMatcherPipeline, PersistentRetryQueue, _load_env,
)
from decryption_callback import (
    CallbackChainInterface, DecryptionCallbackMonitor,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  [keeper]  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("keeper")


# ─────────────────────────────────────────────────────────────────────────────
# Config helpers
# ─────────────────────────────────────────────────────────────────────────────

def _int_env(key: str, default: int) -> int:
    return int(os.environ.get(key, default))


# ─────────────────────────────────────────────────────────────────────────────
# KeeperScheduler
# ─────────────────────────────────────────────────────────────────────────────

class KeeperScheduler:
    """
    Lightweight time-based scheduler that runs three keeper jobs at
    configurable intervals without needing a third-party scheduler.
    """

    def __init__(
        self,
        pipeline:  LiveMatcherPipeline,
        monitor:   DecryptionCallbackMonitor,
        active_profile_ids_fn: Callable[[], List[int]],
        stale_match_ids_fn:    Callable[[], List[Tuple[int, str]]],
        sweep_interval_s:     int = 120,
        expiry_interval_s:    int = 300,
        heartbeat_interval_s: int = 3600,
    ):
        self.pipeline  = pipeline
        self.monitor   = monitor
        self.active_fn = active_profile_ids_fn
        self.stale_fn  = stale_match_ids_fn

        self._sw_interval  = sweep_interval_s
        self._ex_interval  = expiry_interval_s
        self._hb_interval  = heartbeat_interval_s

        self._last_sw = 0
        self._last_ex = 0
        self._last_hb = 0

        self._run = True
        self._cycle_count = 0
        self._stats = {
            "heartbeats": 0, "sweeps": 0, "expiry_runs": 0, "retries_resolved": 0
        }

    def _should_run(self, last_ts: int, interval: int, now: int) -> bool:
        return (now - last_ts) >= interval

    def run_cycle(self, now: int | None = None):
        now = now or int(time.time())
        self._cycle_count += 1
        log.info("── Keeper cycle #%d ──", self._cycle_count)

        # 1. Heartbeat
        if self._should_run(self._last_hb, self._hb_interval, now):
            ok = self.pipeline.maybe_heartbeat()
            if ok:
                self._stats["heartbeats"] += 1
                self._last_hb = now

        # 2. Expiry closure (consent-expired + stuck-decrypt)
        if self._should_run(self._last_ex, self._ex_interval, now):
            stale = self.stale_fn()
            self.pipeline.expiry_sweep(stale)
            # Also run the stuck-decrypt monitor
            closed = self.monitor.check_once(now)
            if closed:
                log.info("Monitor closed stuck matches: %s", closed)
            self._stats["expiry_runs"] += 1
            self._last_ex = now

        # 3. Matcher sweep (processAutoMatchesBatch + drain retries)
        if self._should_run(self._last_sw, self._sw_interval, now):
            active_ids = self.active_fn()
            result = self.pipeline.process_auto_matches_batch(active_ids)
            resolved = self.pipeline.drain_retries()
            self._stats["sweeps"] += 1
            self._stats["retries_resolved"] += resolved
            self._last_sw = now
            log.info("Sweep result: %s | retries resolved: %d", result, resolved)

        log.info("Stats: %s", json.dumps(self._stats))

    def run(self):
        log.info("KeeperScheduler running (sweep=%ds, expiry=%ds, hb=%ds)",
                 self._sw_interval, self._ex_interval, self._hb_interval)
        while self._run:
            try:
                self.run_cycle()
            except KeyboardInterrupt:
                log.info("Keeper shutdown.")
                self._run = False
                break
            except Exception as e:
                log.error("Keeper cycle error: %s", e)
            time.sleep(min(self._sw_interval, self._ex_interval, 30))

    def stop(self):
        self._run = False


# ─────────────────────────────────────────────────────────────────────────────
# Factory
# ─────────────────────────────────────────────────────────────────────────────

def build_keeper(mock: bool) -> KeeperScheduler:
    pipeline = build_pipeline(mock=mock)
    cb_chain = CallbackChainInterface(mock=mock)
    monitor  = DecryptionCallbackMonitor(
        chain=cb_chain,
        poll_interval_s=_int_env("EXPIRY_INTERVAL_S", 300),
        grace_period_s=_int_env("DECRYPT_GRACE_S", 120),
    )
    # In production these come from on-chain event indexing.
    # For the demo we use a static pool; operator can override via env.
    demo_ids_env = os.environ.get("DEMO_PROFILE_IDS", "1,2,3,4,5")
    demo_ids = [int(x.strip()) for x in demo_ids_env.split(",") if x.strip()]

    return KeeperScheduler(
        pipeline=pipeline,
        monitor=monitor,
        active_profile_ids_fn=lambda: demo_ids,
        stale_match_ids_fn=lambda: [],
        sweep_interval_s=_int_env("SWEEP_INTERVAL_S", 120),
        expiry_interval_s=_int_env("EXPIRY_INTERVAL_S", 300),
        heartbeat_interval_s=_int_env("HEARTBEAT_INTERVAL_S", 3600),
    )


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    _load_env()
    mock_mode = "--mock" in sys.argv or os.environ.get("MOCK_MODE", "") == "1"
    once_mode = "--once" in sys.argv or "-1" in sys.argv

    keeper = build_keeper(mock=mock_mode)

    if once_mode:
        log.info("Running single keeper cycle (--once mode)")
        keeper.run_cycle()
        log.info("Done.")
    else:
        keeper.run()
