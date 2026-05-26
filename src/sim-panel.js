/**
 * sim-panel.js
 * Loads sim-results.json (baked in at build time) and renders:
 *   1. Backend simulation test results panel (suite cards + per-test rows)
 *   2. Milestone progress summary panel (progress arc + per-milestone bar)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Milestone progress summary (driven from milestones array in script.js)
// ─────────────────────────────────────────────────────────────────────────────

export function renderMilestoneProgressSummary(milestones, containerId) {
  const root = document.getElementById(containerId);
  if (!root) return;

  const all  = milestones.flatMap((m) => m.tasks);
  const done = all.filter((t) => t.done).length;
  const pct  = Math.round((done / all.length) * 100);

  const circumference = 2 * Math.PI * 36;
  const offset = circumference - (pct / 100) * circumference;

  root.innerHTML = `
    <div class="sim-progress-wrap">
      <div class="sim-arc-wrap">
        <svg width="88" height="88" viewBox="0 0 88 88">
          <circle cx="44" cy="44" r="36" fill="none" stroke="#1e2d55" stroke-width="8"/>
          <circle cx="44" cy="44" r="36" fill="none"
            stroke="#7c9cff" stroke-width="8"
            stroke-dasharray="${circumference.toFixed(2)}"
            stroke-dashoffset="${offset.toFixed(2)}"
            stroke-linecap="round"
            transform="rotate(-90 44 44)"
          />
          <text x="44" y="48" text-anchor="middle"
            font-size="15" font-weight="700" fill="#e9eefc">${pct}%</text>
        </svg>
        <div class="sim-arc-label">${done}/${all.length} tasks</div>
      </div>
      <div class="sim-milestone-bars">
        ${milestones.map((m) => {
          const mDone = m.tasks.filter((t) => t.done).length;
          const mPct  = Math.round((mDone / m.tasks.length) * 100);
          const color = mPct === 100 ? "var(--ok)" : mPct > 0 ? "var(--accent)" : "var(--line)";
          return `
            <div class="sim-mbar">
              <div class="sim-mbar-label">
                <span>${m.key}</span>
                <span class="sim-mbar-count">${mDone}/${m.tasks.length}</span>
              </div>
              <div class="sim-mbar-bg">
                <div class="sim-mbar-fill" style="width:${mPct}%;background:${color}"></div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend sim results (loaded from sim-results.json)
// ─────────────────────────────────────────────────────────────────────────────

function statusBadge(status) {
  return status === "pass"
    ? `<span class="sim-badge ok">PASS</span>`
    : `<span class="sim-badge fail">FAIL</span>`;
}

function renderSuite(suite) {
  const suiteOk = suite.status === "pass";
  const rows = suite.tests.map((t) => `
    <div class="sim-row ${t.status}">
      <span class="sim-icon">${t.status === "pass" ? "✅" : "❌"}</span>
      <span class="sim-row-label">${t.label}</span>
      ${t.error ? `<span class="sim-row-error">${t.error}</span>` : ""}
    </div>
  `).join("");

  return `
    <div class="sim-suite ${suiteOk ? "ok" : "fail"}">
      <div class="sim-suite-head">
        <span class="sim-suite-name">${suite.suite}</span>
        <span class="sim-suite-count">${suite.passed}/${suite.total}</span>
        ${statusBadge(suite.status)}
      </div>
      <div class="sim-suite-rows">${rows}</div>
    </div>
  `;
}

export async function renderSimResults(containerId) {
  const root = document.getElementById(containerId);
  if (!root) return;

  root.innerHTML = `<div class="sim-loading">Loading results…</div>`;

  let data;
  try {
    const res = await fetch("sim-results.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    root.innerHTML = `
      <div class="sim-error">
        Could not load sim-results.json (${err.message}).<br/>
        Run <code>python3 backend/export_results.py</code> to regenerate.
      </div>`;
    return;
  }

  const { summary, suites, generated_at } = data;
  const allPass = summary.failed === 0;

  root.innerHTML = `
    <div class="sim-summary-bar ${allPass ? "ok" : "fail"}">
      <div class="sim-summary-title">
        ${allPass ? "🎉" : "❌"}
        Backend simulation: ${summary.passed}/${summary.total} tests passed
      </div>
      <div class="sim-summary-meta">
        Generated: ${generated_at} ·
        ${summary.failed === 0
          ? "all suites green"
          : `${summary.failed} failing`}
      </div>
    </div>
    ${suites.map(renderSuite).join("")}
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extra CSS injected once at runtime
// ─────────────────────────────────────────────────────────────────────────────

const SIM_CSS = `
.sim-progress-wrap {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.sim-arc-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.sim-arc-label {
  font-size: 0.78rem;
  color: var(--muted);
}
.sim-milestone-bars {
  flex: 1;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  justify-content: center;
}
.sim-mbar {}
.sim-mbar-label {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  color: var(--muted);
  margin-bottom: 3px;
}
.sim-mbar-count { color: var(--text); }
.sim-mbar-bg {
  background: #1a2640;
  border-radius: 999px;
  height: 8px;
  overflow: hidden;
}
.sim-mbar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.4s ease;
}

.sim-loading, .sim-error {
  color: var(--muted);
  font-size: 0.88rem;
  padding: 8px;
}
.sim-error { border: 1px dashed var(--danger); border-radius: 8px; padding: 10px; }
.sim-error code { background: #1e2d55; padding: 2px 6px; border-radius: 4px; font-size: 0.82rem; }

.sim-summary-bar {
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--line);
}
.sim-summary-bar.ok  { border-color: rgba(61,220,151,0.45); background: rgba(61,220,151,0.06); }
.sim-summary-bar.fail { border-color: rgba(255,107,107,0.45); background: rgba(255,107,107,0.06); }
.sim-summary-title { font-weight: 700; font-size: 0.96rem; }
.sim-summary-meta  { font-size: 0.8rem; color: var(--muted); margin-top: 3px; }

.sim-suite {
  border: 1px solid var(--line);
  border-radius: 10px;
  margin-bottom: 10px;
  overflow: hidden;
}
.sim-suite.ok   { border-color: rgba(61,220,151,0.3); }
.sim-suite.fail { border-color: rgba(255,107,107,0.35); }
.sim-suite-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: #0e1828;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.sim-suite-name  { flex: 1; font-size: 0.88rem; font-weight: 600; }
.sim-suite-count { font-size: 0.8rem; color: var(--muted); }
.sim-badge {
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 700;
}
.sim-badge.ok   { background: rgba(61,220,151,0.18); color: #9ef2cc; }
.sim-badge.fail { background: rgba(255,107,107,0.18); color: #ffb3b3; }

.sim-suite-rows { padding: 8px 12px; display: flex; flex-direction: column; gap: 5px; }
.sim-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 0.84rem;
  padding: 4px 0;
}
.sim-row.fail { color: var(--danger); }
.sim-row.pass { color: var(--text); }
.sim-icon { flex-shrink: 0; }
.sim-row-label { flex: 1; }
.sim-row-error { font-size: 0.8rem; color: var(--warn); }
`;

export function injectSimStyles() {
  if (document.getElementById("sim-panel-css")) return;
  const style = document.createElement("style");
  style.id = "sim-panel-css";
  style.textContent = SIM_CSS;
  document.head.appendChild(style);
}
