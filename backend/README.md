# Backend workbench (MVP scaffolding)

This folder contains backend simulation and test harness code for the
Private Vedic Auto-Matching MVP.

## Modules

| File | Purpose |
|---|---|
| `state_machine.py` | Core consent/decrypt state machine + MatchEngine |
| `sim_test.py` | 7 deterministic state-machine transition tests |
| `matcher_sweep.py` | M2 matcher components: MatcherQueue, MatcherHeartbeat, DelayedStatus, RetryQueue, SweepEngine |
| `sweep_test.py` | 19 deterministic tests for all sweep components + full integration |
| `export_results.py` | Runs both suites, writes `../src/sim-results.json` for frontend display |

## Run all tests

```bash
cd backend/
python3 sim_test.py          # 7 state-machine tests
python3 sweep_test.py        # 19 sweep tests
python3 export_results.py    # runs both + writes sim-results.json → frontend
```

## What's tested

### State Machine (sim_test.py)
1. Qualified match → PendingConsent
2. Non-qualified → Closed(NotQualified)
3. Second consent → Decrypting
4. closeExpiredMatch cannot close Decrypting state
5. on_decryption_fulfilled → Revealed + profiles Matched
6. Supersede: first reveal wins, sibling closes
7. closeStuckDecryption → Closed(DecryptFailed)

### Matcher Sweep (sweep_test.py)
**MatcherQueue** — enqueue ordering, lazy removal, pending_count

**MatcherHeartbeat** — alive/dead within SLA, multiple beats, seconds_since_last_beat

**DelayedStatus** — Queued (no heartbeat), Processing (fresh beat), Delayed (SLA exceeded), Matched (has revealed)

**RetryQueue** — enqueue/due, exponential backoff, max_attempts exhaustion, complete

**SweepEngine** — sweep_batch (qualified + not_qualified, score failure → retry), expire_sweep (ConsentExpired + DecryptFailed)

**Full integration** — activate → sweep → both-pairs consent → first reveal wins → sibling superseded → DelayedStatus shows Matched

## Next backend steps

1. Replace in-memory store with real contract/indexer adapters.
2. Add callback-auth verification integration tests.
3. Add latency metrics capture for M2 tuning (DECRYPT_WINDOW / PERMIT_TTL calibration).
4. Integrate ACTIVE_POOL_CAP bound check into SweepEngine.activate_profile.
5. Wire retry queue consumer loop with configurable backoff multiplier.
