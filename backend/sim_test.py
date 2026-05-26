from state_machine import (
    MatchEngine,
    MatchRecord,
    MatchState,
    CloseReason,
)


def assert_eq(actual, expected, msg):
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected}, got {actual}")


def run_tests():
    engine = MatchEngine(consent_window_s=100, decrypt_window_s=10)

    engine.add_profile("A", 1)
    engine.add_profile("B", 2)
    engine.add_profile("C", 3)

    # 1) Qualified path => PendingConsent
    r1 = MatchRecord(
        match_id=1,
        user_a="A",
        user_b="B",
        profile_id_a=1,
        profile_id_b=2,
        profile_version_a=1,
        profile_version_b=1,
        score36=29,
    )
    engine.add_scored_match(r1)
    assert_eq(engine.records[1].state, MatchState.PENDING_CONSENT, "qualified match should enter PendingConsent")

    # 2) Non-qualified => Closed(NotQualified)
    r2 = MatchRecord(
        match_id=2,
        user_a="A",
        user_b="C",
        profile_id_a=1,
        profile_id_b=3,
        profile_version_a=1,
        profile_version_b=1,
        score36=21,
    )
    engine.add_scored_match(r2)
    assert_eq(engine.records[2].state, MatchState.CLOSED, "non-qualified should close")
    assert_eq(engine.records[2].close_reason, CloseReason.NOT_QUALIFIED, "close reason should be NotQualified")

    # 3) second consent => Decrypting
    engine.consent(1, "A")
    assert_eq(engine.records[1].state, MatchState.PENDING_CONSENT, "single consent stays PendingConsent")
    engine.consent(1, "B")
    assert_eq(engine.records[1].state, MatchState.DECRYPTING, "second consent moves to Decrypting")

    # 4) closeExpiredMatch cannot close Decrypting
    engine.close_expired_match(1, now_ts=1000)
    assert_eq(engine.records[1].state, MatchState.DECRYPTING, "expired consent should not close Decrypting")

    # 5) decryption callback success => Revealed and profiles Matched
    st, reason = engine.on_decryption_fulfilled(1)
    assert_eq(st, MatchState.REVEALED, "callback should reveal when both active")
    assert_eq(reason, CloseReason.NONE, "revealed should have close reason None")
    assert_eq(engine.profiles["A"].status, "Matched", "A should be Matched")
    assert_eq(engine.profiles["B"].status, "Matched", "B should be Matched")

    # 6) supersede test: create two pending for D, first reveal wins, second superseded
    engine2 = MatchEngine(consent_window_s=100, decrypt_window_s=10)
    for owner, pid in [("D", 10), ("E", 11), ("F", 12)]:
        engine2.add_profile(owner, pid)

    mde = MatchRecord(11, "D", "E", 10, 11, 1, 1, score36=30)
    mdf = MatchRecord(12, "D", "F", 10, 12, 1, 1, score36=31)
    engine2.add_scored_match(mde)
    engine2.add_scored_match(mdf)

    engine2.consent(11, "D")
    engine2.consent(11, "E")
    assert_eq(engine2.records[11].state, MatchState.DECRYPTING, "DE pair decrypting")

    engine2.consent(12, "D")
    engine2.consent(12, "F")
    assert_eq(engine2.records[12].state, MatchState.DECRYPTING, "DF pair decrypting")

    engine2.on_decryption_fulfilled(11)
    assert_eq(engine2.records[11].state, MatchState.REVEALED, "first callback reveals")

    st2, reason2 = engine2.on_decryption_fulfilled(12)
    assert_eq(st2, MatchState.CLOSED, "second callback closes")
    assert_eq(reason2, CloseReason.SUPERSEDED, "second callback superseded")

    # 7) close stuck decryption
    engine3 = MatchEngine(consent_window_s=100, decrypt_window_s=10)
    engine3.add_profile("X", 50)
    engine3.add_profile("Y", 51)
    mxy = MatchRecord(99, "X", "Y", 50, 51, 1, 1, score36=30)
    engine3.add_scored_match(mxy)
    engine3.consent(99, "X")
    engine3.consent(99, "Y")
    assert_eq(engine3.records[99].state, MatchState.DECRYPTING, "XY decrypting")
    engine3.close_stuck_decryption(99, now_ts=1000)
    assert_eq(engine3.records[99].state, MatchState.CLOSED, "stuck decrypt should close")
    assert_eq(engine3.records[99].close_reason, CloseReason.DECRYPT_FAILED, "close reason DecryptFailed")

    print("All backend state-machine simulation tests passed.")
    print("Snapshot sample:", engine2.snapshot())


if __name__ == "__main__":
    run_tests()
