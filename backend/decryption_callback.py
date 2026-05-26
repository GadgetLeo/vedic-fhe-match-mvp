"""
decryption_callback.py
======================
Integration path for onDecryptionFulfilled from the CoFHE coprocessor.

Auth assumptions
----------------
onDecryptionFulfilled(uint256 matchId, uint256 plainScore, bytes proof) is
callable ONLY by the address stored in coprocessorCallback() on-chain.
In testnet/sim mode we accept calls from the MATCHER_PRIVATE_KEY account
(acting as both matcher and mock coprocessor).

The `proof` field is a 32-byte opaque attestation from the FHE network.
In Sim-v1 we use a deterministic hash of (matchId, plainScore, CONTRACT_ADDRESS).

Fallback — closeStuckDecryption
--------------------------------
If the coprocessor callback has not fired within DECRYPT_WINDOW_HOURS (1 h),
the keeper calls closeStuckDecryption() to unblock the match.
This module provides:
  - simulate_decryption_callback()  — fire onDecryptionFulfilled on-chain
  - build_sim_proof()               — deterministic sim attestation bytes
  - DecryptionCallbackMonitor       — watches pending Decrypting matches and
      auto-closes stuck ones after the decrypt deadline

Usage
-----
  python3 decryption_callback.py --mock --match-id 42 --score 29
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

try:
    from web3 import Web3
    from web3.middleware import ExtraDataToPOAMiddleware
    HAS_WEB3 = True
except ImportError:
    HAS_WEB3 = False

sys.path.insert(0, str(Path(__file__).parent))

log = logging.getLogger("decrypt-cb")

DEFAULT_CONTRACT  = "0x11E8B83EEF9D8C36bC616014165F61a3b1739dc0"
DECRYPT_WINDOW_S  = int(os.environ.get("DECRYPT_WINDOW_S", 3600))

CALLBACK_ABI = [
    {
        "name": "onDecryptionFulfilled",
        "type": "function",
        "inputs": [
            {"name": "matchId",    "type": "uint256"},
            {"name": "plainScore", "type": "uint256"},
            {"name": "proof",      "type": "bytes"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "closeStuckDecryption",
        "type": "function",
        "inputs": [{"name": "matchId", "type": "uint256"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "coprocessorCallback",
        "type": "function",
        "inputs": [],
        "outputs": [{"name": "", "type": "address"}],
        "stateMutability": "view",
    },
    {
        "name": "getMyResult",
        "type": "function",
        "inputs": [],
        "outputs": [
            {
                "type": "tuple[]",
                "components": [
                    {"name": "matchId",         "type": "uint256"},
                    {"name": "userA",           "type": "address"},
                    {"name": "userB",           "type": "address"},
                    {"name": "profileIdA",      "type": "uint256"},
                    {"name": "profileIdB",      "type": "uint256"},
                    {"name": "profileVersionA", "type": "uint256"},
                    {"name": "profileVersionB", "type": "uint256"},
                    {"name": "scoreSubmitted",  "type": "bool"},
                    {"name": "consentA",        "type": "bool"},
                    {"name": "consentB",        "type": "bool"},
                    {"name": "consentDeadline", "type": "uint64"},
                    {"name": "decryptDeadline", "type": "uint64"},
                    {"name": "state",           "type": "uint8"},
                    {"name": "closeReason",     "type": "uint8"},
                    {"name": "createdAt",       "type": "uint64"},
                ],
            }
        ],
        "stateMutability": "view",
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# Simulation proof builder
# ─────────────────────────────────────────────────────────────────────────────

def build_sim_proof(match_id: int, plain_score: int, contract_address: str) -> bytes:
    """
    32-byte deterministic attestation for Sim-v1.
    Format: SHA-256(matchId ‖ plainScore ‖ contractAddress ‖ "vedic-sim-v1")
    """
    h = hashlib.sha256(
        f"{match_id}:{plain_score}:{contract_address.lower()}:vedic-sim-v1".encode()
    )
    return h.digest()  # 32 bytes


# ─────────────────────────────────────────────────────────────────────────────
# Chain interface (reused from matcher_service pattern)
# ─────────────────────────────────────────────────────────────────────────────

class CallbackChainInterface:
    def __init__(self, mock: bool = False):
        self.mock   = mock
        self._w3    = None
        self._ctr   = None
        self._acct  = None
        self._addr  = os.environ.get("CONTRACT_ADDRESS", DEFAULT_CONTRACT)
        if not mock:
            self._connect()

    def _connect(self):
        if not HAS_WEB3:
            raise ImportError("pip install web3")
        rpc  = os.environ.get("RPC_URL", "https://sepolia.base.org")
        key  = os.environ.get("MATCHER_PRIVATE_KEY", "")
        if not key:
            raise EnvironmentError("MATCHER_PRIVATE_KEY not set")
        self._w3   = Web3(Web3.HTTPProvider(rpc))
        self._w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        self._acct = self._w3.eth.account.from_key(key)
        self._ctr  = self._w3.eth.contract(
            address=Web3.to_checksum_address(self._addr),
            abi=CALLBACK_ABI
        )
        log.info("CallbackChain connected: %s  acct: %s", rpc, self._acct.address)

    def _send(self, fn_name: str, *args) -> str:
        fn = getattr(self._ctr.functions, fn_name)(*args)
        tx = fn.build_transaction({
            "from":  self._acct.address,
            "nonce": self._w3.eth.get_transaction_count(self._acct.address),
            "gas":   400_000,
        })
        signed  = self._w3.eth.account.sign_transaction(tx, self._acct.key)
        tx_hash = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status != 1:
            raise RuntimeError(f"{fn_name} reverted: {tx_hash.hex()}")
        return tx_hash.hex()

    def on_decryption_fulfilled(self, match_id: int, plain_score: int, proof: bytes) -> str:
        if self.mock:
            log.info("[MOCK] onDecryptionFulfilled matchId=%d score=%d proof=%s",
                     match_id, plain_score, proof.hex())
            return f"0xmock_dcb_{match_id}"
        return self._send("onDecryptionFulfilled", match_id, plain_score, proof)

    def close_stuck_decryption(self, match_id: int) -> str:
        if self.mock:
            log.info("[MOCK] closeStuckDecryption matchId=%d", match_id)
            return f"0xmock_stuck_{match_id}"
        return self._send("closeStuckDecryption", match_id)

    def get_decrypting_matches(self) -> List[Tuple[int, int]]:
        """Return [(matchId, decryptDeadline)] for all Decrypting matches."""
        if self.mock:
            return []  # caller supplies stubs in tests
        rows = self._ctr.functions.getMyResult().call({"from": self._acct.address})
        return [
            (int(r[0]), int(r[11]))  # matchId, decryptDeadline
            for r in rows
            if int(r[12]) == 2      # state == Decrypting
        ]

    def coprocessor_callback_address(self) -> str:
        if self.mock:
            return self._acct.address if self._acct else "0xMOCK"
        return self._ctr.functions.coprocessorCallback().call()


# ─────────────────────────────────────────────────────────────────────────────
# simulate_decryption_callback — fire onDecryptionFulfilled
# ─────────────────────────────────────────────────────────────────────────────

def simulate_decryption_callback(
    match_id: int,
    plain_score: int,
    chain: CallbackChainInterface,
) -> str:
    """
    Fire onDecryptionFulfilled for a match that has entered the Decrypting state.

    Auth: caller must be coprocessorCallback() address on-chain.
    In testnet/sim mode MATCHER_PRIVATE_KEY acts as the coprocessor.

    Returns the tx hash (or mock string).
    """
    proof = build_sim_proof(match_id, plain_score, chain._addr)
    log.info("Firing onDecryptionFulfilled matchId=%d score=%d proof=%s",
             match_id, plain_score, proof.hex())
    tx = chain.on_decryption_fulfilled(match_id, plain_score, proof)
    log.info("onDecryptionFulfilled tx: %s", tx)
    return tx


# ─────────────────────────────────────────────────────────────────────────────
# DecryptionCallbackMonitor
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class StuckMatchRecord:
    match_id:        int
    decrypt_deadline: int
    detected_at:     int


class DecryptionCallbackMonitor:
    """
    Polls on-chain for matches stuck in Decrypting state beyond their
    decrypt_deadline and calls closeStuckDecryption().

    In production the coprocessor fires onDecryptionFulfilled automatically;
    this is the fallback keeper path.
    """

    def __init__(self, chain: CallbackChainInterface,
                 poll_interval_s: int = 300,
                 grace_period_s: int = 120):
        self.chain          = chain
        self.poll_interval  = poll_interval_s
        self.grace_period   = grace_period_s
        self._seen_stuck:   dict = {}   # match_id → StuckMatchRecord
        self._run           = True

    def check_once(self, now_ts: Optional[int] = None) -> List[int]:
        """
        Single poll: detect stuck matches and close them.
        Returns list of match IDs closed.
        """
        now    = now_ts or int(time.time())
        pairs  = self.chain.get_decrypting_matches()
        closed = []

        for match_id, decrypt_deadline in pairs:
            if decrypt_deadline == 0 or now <= decrypt_deadline + self.grace_period:
                continue  # not yet overdue

            if match_id not in self._seen_stuck:
                self._seen_stuck[match_id] = StuckMatchRecord(
                    match_id=match_id,
                    decrypt_deadline=decrypt_deadline,
                    detected_at=now
                )
                log.warning("Stuck decryption detected: matchId=%d deadline=%d overdue=%ds",
                            match_id, decrypt_deadline, now - decrypt_deadline)

            try:
                tx = self.chain.close_stuck_decryption(match_id)
                log.info("closeStuckDecryption matchId=%d tx=%s", match_id, tx)
                closed.append(match_id)
                self._seen_stuck.pop(match_id, None)
            except Exception as e:
                log.error("closeStuckDecryption matchId=%d failed: %s", match_id, e)

        return closed

    def run(self):
        log.info("DecryptionCallbackMonitor running (poll=%ds, grace=%ds)",
                 self.poll_interval, self.grace_period)
        while self._run:
            try:
                closed = self.check_once()
                if closed:
                    log.info("Closed stuck matches: %s", closed)
            except KeyboardInterrupt:
                log.info("Monitor shutdown.")
                self._run = False
                break
            except Exception as e:
                log.error("Monitor error: %s", e)
            time.sleep(self.poll_interval)

    def stop(self):
        self._run = False


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s  %(levelname)-7s  %(message)s",
                        datefmt="%Y-%m-%d %H:%M:%S")

    parser = argparse.ArgumentParser(description="Decryption callback integration")
    parser.add_argument("--mock",     action="store_true")
    parser.add_argument("--match-id", type=int, default=None)
    parser.add_argument("--score",    type=int, default=29)
    parser.add_argument("--monitor",  action="store_true",
                        help="Run stuck-decryption monitor daemon")
    args = parser.parse_args()

    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

    chain = CallbackChainInterface(mock=args.mock)

    if args.monitor:
        monitor = DecryptionCallbackMonitor(chain)
        monitor.run()
    elif args.match_id is not None:
        tx = simulate_decryption_callback(args.match_id, args.score, chain)
        print(f"tx: {tx}")
    else:
        print("Use --match-id <id> --score <n> [--mock] to fire callback,")
        print("or --monitor [--mock] to run the stuck-decryption keeper.")
