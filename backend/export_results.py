"""
export_results.py
=================
Runs all three test suites and serialises results to ../src/sim-results.json
so the static frontend can load them without a server.
"""
import sys, json, subprocess, io
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
OUT_FILE = Path(__file__).parent.parent / "src" / "sim-results.json"


def run_sim_test():
    result = subprocess.run(
        [sys.executable, "sim_test.py"],
        capture_output=True, text=True, cwd=str(Path(__file__).parent)
    )
    passed = "All backend state-machine simulation tests passed." in result.stdout
    tests = [
        "Qualified match → PendingConsent",
        "Non-qualified → Closed(NotQualified)",
        "Second consent → Decrypting",
        "closeExpiredMatch skips Decrypting",
        "on_decryption_fulfilled → Revealed",
        "Supersede: sibling closed",
        "closeStuckDecryption → DecryptFailed",
    ]
    return {
        "suite":   "State Machine Simulation (sim_test.py)",
        "total":   len(tests),
        "passed":  len(tests) if passed else 0,
        "failed":  0 if passed else len(tests),
        "status":  "pass" if passed else "fail",
        "output":  result.stdout.strip() or result.stderr.strip(),
        "tests":   [{"label": t, "status": "pass" if passed else "fail"} for t in tests],
    }


def _run_module_suite(module_name: str):
    """Import module and call run_all(); return structured results list."""
    old_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        for mod in list(sys.modules.keys()):
            if mod in {module_name, "matcher_sweep", "state_machine",
                       "matcher_service", "decryption_callback", "keeper"}:
                del sys.modules[mod]
        mod = __import__(module_name)
        raw_results = mod.run_all()
    finally:
        captured = sys.stdout.getvalue()
        sys.stdout = old_stdout
    return raw_results, captured


def run_sweep_test():
    raw, captured = _run_module_suite("sweep_test")
    total  = len(raw)
    passed = sum(1 for r in raw if r["status"] == "pass")
    return {
        "suite":  "Matcher Sweep Extension (sweep_test.py)",
        "total":  total,
        "passed": passed,
        "failed": total - passed,
        "status": "pass" if passed == total else "fail",
        "output": captured.strip(),
        "tests":  [{"label": r["label"], "status": r["status"], "error": r.get("error")}
                   for r in raw],
    }


def run_integration_test():
    raw, captured = _run_module_suite("integration_test")
    total  = len(raw)
    passed = sum(1 for r in raw if r["status"] == "pass")
    return {
        "suite":  "Integration Tests (integration_test.py)",
        "total":  total,
        "passed": passed,
        "failed": total - passed,
        "status": "pass" if passed == total else "fail",
        "output": captured.strip(),
        "tests":  [{"label": r["label"], "status": r["status"], "error": r.get("error")}
                   for r in raw],
    }


def main():
    sim         = run_sim_test()
    sweep       = run_sweep_test()
    integration = run_integration_test()
    suites      = [sim, sweep, integration]
    payload     = {
        "generated_at": "2026-05-26",
        "suites": suites,
        "summary": {
            "total":  sum(s["total"]  for s in suites),
            "passed": sum(s["passed"] for s in suites),
            "failed": sum(s["failed"] for s in suites),
        },
    }
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(payload, indent=2))
    print(f"Written → {OUT_FILE}")
    t = payload["summary"]
    print(f"Overall: {t['passed']}/{t['total']} passed {'🎉' if t['failed'] == 0 else '❌'}")


if __name__ == "__main__":
    main()
