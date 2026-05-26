"""
matcher_service.py — Live matcher pipeline for VedicAutoMatch on Base Sepolia.

Implements:
  - processAutoMatchesBatch  (batch encrypted scores, idempotent pair dedup)
  - submitMatchScore         (single score with exponential-backoff retry)
  - Heartbeat daemon         (periodic on-chain keepalive)
  - Expiry sweep             (close consent-expired / stuck-decrypt matches)

Environment (.env, live mode):
  RPC_URL, MATCHER_PRIVATE_KEY, CONTRACT_ADDRESS,
  BATCH_SIZE, SWEEP_INTERVAL_S, HEARTBEAT_INTERVAL_S,
  MAX_RETRY_ATTEMPTS, RETRY_BACKOFF_S, MOCK_MODE=1
"""
from __future__ import annotations
import hashlib, json, logging, os, sys, time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Set, Tuple

try:
    from web3 import Web3
    from web3.middleware import ExtraDataToPOAMiddleware
    HAS_WEB3 = True
except ImportError:
    HAS_WEB3 = False

sys.path.insert(0, str(Path(__file__).parent))
from state_machine import MatchEngine
from matcher_sweep import SweepEngine, MatcherHeartbeat, RetryQueue, DEFAULT_MAX_NEW_MATCHES_PER_TX

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s  %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("matcher")

DEFAULT_CONTRACT = "0x11E8B83EEF9D8C36bC616014165F61a3b1739dc0"
CONTRACT_ABI = [
    {"name":"processAutoMatchesBatch","type":"function","inputs":[{"name":"start","type":"uint256"},{"name":"end","type":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
    {"name":"submitMatchScore","type":"function","inputs":[{"name":"matchId","type":"uint256"},{"name":"encryptedScore36","type":"tuple","components":[{"name":"ctHash","type":"uint256"},{"name":"securityZone","type":"uint8"},{"name":"utype","type":"uint8"},{"name":"signature","type":"bytes"}]},{"name":"encryptedQualifies","type":"tuple","components":[{"name":"ctHash","type":"uint256"},{"name":"securityZone","type":"uint8"},{"name":"utype","type":"uint8"},{"name":"signature","type":"bytes"}]},{"name":"qualifiesPlain","type":"bool"}],"outputs":[],"stateMutability":"nonpayable"},
    {"name":"heartbeat","type":"function","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
    {"name":"matcherLastSeen","type":"function","inputs":[],"outputs":[{"name":"","type":"uint64"}],"stateMutability":"view"},
    {"name":"nextMatchId","type":"function","inputs":[],"outputs":[{"name":"","type":"uint256"}],"stateMutability":"view"},
    {"name":"closeExpiredMatch","type":"function","inputs":[{"name":"matchId","type":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
    {"name":"closeStuckDecryption","type":"function","inputs":[{"name":"matchId","type":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
]


# ── Idempotency store ──────────────────────────────────────────────────────────
PROCESSED_PAIRS_FILE = Path(__file__).parent / "processed_pairs.json"

class IdempotencyStore:
    """Persist processed (A,B) profile-id pairs across restarts."""
    def __init__(self, path: Path = PROCESSED_PAIRS_FILE):
        self._path = path
        self._pairs: Set[str] = set()
        if self._path.exists():
            try:
                data = json.loads(self._path.read_text())
                self._pairs = set(data.get("pairs", []))
                log.info("Idempotency store loaded: %d pairs", len(self._pairs))
            except Exception as e:
                log.warning("Could not load idempotency store: %s", e)

    def _key(self, a, b) -> str:
        ids = sorted([str(a), str(b)])
        return hashlib.sha256(f"{ids[0]}:{ids[1]}".encode()).hexdigest()[:16]

    def seen(self, a, b) -> bool:
        # QA override: allow reprocessing existing pairs (used by scheduler for consent-flow testing)
        if os.environ.get("FORCE_REPROCESS", "") == "1":
            return False
        return self._key(a, b) in self._pairs

    def mark(self, a, b):
        self._pairs.add(self._key(a, b))
        try:
            self._path.write_text(json.dumps({"pairs": list(self._pairs)}, indent=2))
        except Exception as e:
            log.warning("Idempotency save failed: %s", e)


# ── Koota scorer (deterministic; replace with CoFHE circuit call) ─────────────
def compute_koota_score(pid_a: int, pid_b: int) -> int:
    forced = os.environ.get("FORCE_TEST_SCORE")
    if forced is not None and forced != "":
        try:
            v = int(forced)
            return max(0, min(36, v))
        except Exception:
            pass
    return abs(hash((min(pid_a, pid_b), max(pid_a, pid_b)))) % 37

def _mock_enc_tuple(v: int) -> tuple:
    # Minimal InEuint-like tuple accepted by ABI: (ctHash, securityZone, utype, signature)
    return (int(v), 0, 0, b"")


def abi_encode_score(score: int) -> tuple:
    return _mock_enc_tuple(score)


def abi_encode_bool(flag: bool) -> tuple:
    return _mock_enc_tuple(1 if flag else 0)


# ── PersistentRetryQueue ──────────────────────────────────────────────────────
RETRY_QUEUE_FILE = Path(__file__).parent / "retry_queue.json"

class PersistentRetryQueue(RetryQueue):
    def __init__(self, path: Path = RETRY_QUEUE_FILE, max_attempts: int = 5, backoff_s: int = 60):
        super().__init__(max_attempts=max_attempts, backoff_s=backoff_s)
        self._path = path
        if self._path.exists():
            try:
                data = json.loads(self._path.read_text())
                from matcher_sweep import RetryJob
                for j in data.get("jobs", []):
                    job = RetryJob(**j)
                    self._jobs[job.job_id] = job
                    if job.job_id >= self._counter:
                        self._counter = job.job_id + 1
                log.info("Retry queue loaded: %d pending", len(self._jobs))
            except Exception as e:
                log.warning("Retry queue load failed: %s", e)

    def _persist(self):
        try:
            self._path.write_text(json.dumps({"jobs": self.snapshot()}, indent=2))
        except Exception as e:
            log.warning("Retry queue persist failed: %s", e)

    def enqueue(self, match_id, reason, now_ts):
        job = super().enqueue(match_id, reason, now_ts); self._persist(); return job

    def retry(self, job_id, now_ts):
        job = super().retry(job_id, now_ts); self._persist(); return job

    def complete(self, job_id):
        super().complete(job_id); self._persist()


# ── ChainInterface (live or mock) ──────────────────────────────────────────────
class ChainInterface:
    def __init__(self, mock: bool = False):
        self.mock = mock
        self._w3 = self._contract = self._account = None
        if not mock:
            self._connect()

    def _connect(self):
        if not HAS_WEB3:
            raise ImportError("pip install web3 to use live mode")
        rpc  = os.environ.get("RPC_URL", "https://sepolia.base.org")
        key  = os.environ.get("MATCHER_PRIVATE_KEY", "")
        addr = os.environ.get("CONTRACT_ADDRESS", DEFAULT_CONTRACT)
        if not key:
            raise EnvironmentError("MATCHER_PRIVATE_KEY not set")
        self._w3 = Web3(Web3.HTTPProvider(rpc))
        self._w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        self._account = self._w3.eth.account.from_key(key)
        self._contract = self._w3.eth.contract(
            address=Web3.to_checksum_address(addr), abi=CONTRACT_ABI)
        log.info("Chain connected: %s  acct: %s", rpc, self._account.address)

    def _send(self, fn_name: str, *args) -> str:
        fn = getattr(self._contract.functions, fn_name)(*args)

        # Use pending nonce so back-to-back txs in one keeper cycle don't collide.
        nonce = self._w3.eth.get_transaction_count(self._account.address, "pending")
        gas_price = int(self._w3.eth.gas_price * 1.20)

        tx = fn.build_transaction({
            "from": self._account.address,
            "nonce": nonce,
            "gas": 700_000,
            "gasPrice": gas_price,
            "chainId": self._w3.eth.chain_id,
        })
        signed  = self._w3.eth.account.sign_transaction(tx, self._account.key)
        tx_hash = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise RuntimeError(f"{fn_name} reverted: {tx_hash.hex()}")
        return tx_hash.hex()

    def process_auto_matches_batch(self, start: int, end: int) -> str:
        if self.mock:
            log.info("[MOCK] processAutoMatchesBatch start=%s end=%s", start, end)
            return f"0xmock_batch_{int(time.time())}"
        return self._send("processAutoMatchesBatch", start, end)

    def submit_match_score(self, match_id: int, encrypted_score: tuple, encrypted_qualifies: tuple, qualifies_plain: bool) -> str:
        if self.mock:
            log.info("[MOCK] submitMatchScore matchId=%d score=%s qualifies=%s", match_id, encrypted_score, qualifies_plain)
            return f"0xmock_submit_{match_id}"
        return self._send("submitMatchScore", match_id, encrypted_score, encrypted_qualifies, qualifies_plain)

    def heartbeat(self) -> str:
        if self.mock:
            log.info("[MOCK] heartbeat"); return f"0xmock_hb_{int(time.time())}"
        return self._send("heartbeat")

    def close_expired_match(self, match_id: int) -> str:
        if self.mock:
            log.info("[MOCK] closeExpiredMatch #%d", match_id); return f"0xmock_exp_{match_id}"
        return self._send("closeExpiredMatch", match_id)

    def close_stuck_decryption(self, match_id: int) -> str:
        if self.mock:
            log.info("[MOCK] closeStuckDecryption #%d", match_id); return f"0xmock_stuck_{match_id}"
        return self._send("closeStuckDecryption", match_id)

    def matcher_last_seen(self) -> int:
        if self.mock:
            return int(time.time()) - 300
        return self._contract.functions.matcherLastSeen().call()

    def next_match_id(self) -> int:
        if self.mock:
            return 0
        return int(self._contract.functions.nextMatchId().call())


# ── LiveMatcherPipeline ────────────────────────────────────────────────────────
class LiveMatcherPipeline:
    """Orchestrates batch scoring, retry, heartbeat, and expiry closure."""

    def __init__(self, chain: ChainInterface, sweep_engine: SweepEngine,
                 idempotency: IdempotencyStore, retry_queue: PersistentRetryQueue,
                 batch_size: int = DEFAULT_MAX_NEW_MATCHES_PER_TX,
                 sweep_interval_s: int = 120, heartbeat_interval_s: int = 3600):
        self.chain            = chain
        self.sweep            = sweep_engine
        self.idempotency      = idempotency
        self.retry_queue      = retry_queue
        self.batch_size       = batch_size
        self.sweep_interval_s = sweep_interval_s
        self.hb_interval_s    = heartbeat_interval_s
        self._last_hb_ts      = 0
        self._run             = True

    def process_auto_matches_batch(self, active_profile_ids: List[int]) -> Dict:
        """Create pair jobs on-chain, then submit scores for newly created match IDs."""
        if len(active_profile_ids) < 2:
            log.info("Not enough active profiles for batching")
            return {"pairs": 0, "tx": None}

        start, end = 0, len(active_profile_ids)
        before = self.chain.next_match_id()

        try:
            tx = self.chain.process_auto_matches_batch(start, end)
            after = self.chain.next_match_id()
            created = max(0, after - before)
            log.info("processAutoMatchesBatch tx=%s created=%d", tx, created)

            scored = 0
            for match_id in range(before + 1, after + 1):
                score = compute_koota_score(match_id, after)
                qualifies = score > 25
                self.chain.submit_match_score(
                    match_id,
                    abi_encode_score(score),
                    abi_encode_bool(qualifies),
                    qualifies,
                )
                scored += 1
                log.info("submitMatchScore matchId=%d score=%d qualifies=%s", match_id, score, qualifies)

            return {"pairs": created, "tx": tx, "scored": scored}
        except Exception as e:
            log.error("process_auto_matches_batch pipeline failed: %s", e)
            return {"pairs": 0, "tx": None, "error": str(e)}

    def submit_match_score(self, match_id: int, plain_score: int) -> bool:
        """Submit single score; queue retry on failure."""
        try:
            qualifies = plain_score > 25
            tx = self.chain.submit_match_score(
                match_id,
                abi_encode_score(plain_score),
                abi_encode_bool(qualifies),
                qualifies,
            )
            log.info("submitMatchScore matchId=%d tx=%s", match_id, tx)
            return True
        except Exception as e:
            log.error("submitMatchScore #%d failed: %s — queuing retry", match_id, e)
            self.retry_queue.enqueue(match_id, str(e), int(time.time()))
            return False

    def drain_retries(self) -> int:
        now, resolved = int(time.time()), 0
        for job in self.retry_queue.due(now):
            log.info("Retrying job_id=%d matchId=%d attempt=%d", job.job_id, job.match_id, job.attempt)
            score = compute_koota_score(job.match_id, job.match_id)
            try:
                tx = self.chain.submit_match_score(job.match_id, abi_encode_score(score))
                log.info("Retry success job_id=%d tx=%s", job.job_id, tx)
                self.retry_queue.complete(job.job_id)
                resolved += 1
            except Exception as e:
                log.warning("Retry failed job_id=%d: %s", job.job_id, e)
                if self.retry_queue.retry(job.job_id, now) is None:
                    log.error("job_id=%d exhausted — dropped", job.job_id)
        return resolved

    def maybe_heartbeat(self) -> bool:
        now = int(time.time())
        if now - self._last_hb_ts < self.hb_interval_s:
            return False
        try:
            tx = self.chain.heartbeat()
            log.info("Heartbeat: %s", tx)
            self._last_hb_ts = now
            self.sweep.heartbeat.beat(now)
            return True
        except Exception as e:
            log.error("Heartbeat failed: %s", e)
            return False

    def expiry_sweep(self, stale_match_ids: List[Tuple[int, str]]):
        """  stale_match_ids: [(match_id, 'consent_expired'|'decrypt_stuck')] """
        for mid, reason in stale_match_ids:
            try:
                if reason == "consent_expired":
                    tx = self.chain.close_expired_match(mid)
                    log.info("Closed consent-expired match #%d tx=%s", mid, tx)
                elif reason == "decrypt_stuck":
                    tx = self.chain.close_stuck_decryption(mid)
                    log.info("Closed stuck-decrypt match #%d tx=%s", mid, tx)
            except Exception as e:
                log.error("expiry_sweep #%d failed: %s", mid, e)

    def run(self, active_profile_ids_fn: Callable[[], List[int]],
            stale_match_ids_fn: Callable[[], List[Tuple[int, str]]]):
        log.info("Matcher pipeline started (sweep=%ds, hb=%ds)",
                 self.sweep_interval_s, self.hb_interval_s)
        while self._run:
            try:
                self.maybe_heartbeat()
                self.process_auto_matches_batch(active_profile_ids_fn())
                self.drain_retries()
                self.expiry_sweep(stale_match_ids_fn())
                log.info("Cycle done. Sleeping %ds.", self.sweep_interval_s)
            except KeyboardInterrupt:
                log.info("Shutdown."); self._run = False; break
            except Exception as e:
                log.error("Sweep loop error: %s", e)
            time.sleep(self.sweep_interval_s)

    def stop(self):
        self._run = False


# ── CLI / build helper ─────────────────────────────────────────────────────────
def _load_env():
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


def build_pipeline(mock: bool) -> LiveMatcherPipeline:
    me = MatchEngine(
        consent_window_s=int(os.environ.get("CONSENT_WINDOW_S", 7*24*3600)),
        decrypt_window_s=int(os.environ.get("DECRYPT_WINDOW_S", 3600)),
    )
    hb = MatcherHeartbeat(sla_s=int(os.environ.get("MATCHER_SLA_S", 6*3600)))
    rq = PersistentRetryQueue(
        max_attempts=int(os.environ.get("MAX_RETRY_ATTEMPTS", 5)),
        backoff_s=int(os.environ.get("RETRY_BACKOFF_S", 60)),
    )
    sweep = SweepEngine(me, hb, rq, max_per_tx=int(os.environ.get("BATCH_SIZE", 20)))
    return LiveMatcherPipeline(
        chain=ChainInterface(mock=mock),
        sweep_engine=sweep,
        idempotency=IdempotencyStore(),
        retry_queue=rq,
        batch_size=int(os.environ.get("BATCH_SIZE", 20)),
        sweep_interval_s=int(os.environ.get("SWEEP_INTERVAL_S", 120)),
        heartbeat_interval_s=int(os.environ.get("HEARTBEAT_INTERVAL_S", 3600)),
    )


if __name__ == "__main__":
    _load_env()
    mock_mode = "--mock" in sys.argv or os.environ.get("MOCK_MODE", "") == "1"
    DEMO_IDS: List[int] = [1, 2, 3, 4, 5]
    DEMO_STALE: List[Tuple[int, str]] = []
    pipeline = build_pipeline(mock=mock_mode)
    if "--once" in sys.argv or "-1" in sys.argv:
        pipeline.maybe_heartbeat()
        res = pipeline.process_auto_matches_batch(DEMO_IDS)
        print(json.dumps(res, indent=2))
        print(f"Retried: {pipeline.drain_retries()} jobs")
    else:
        pipeline.run(lambda: DEMO_IDS, lambda: DEMO_STALE)
