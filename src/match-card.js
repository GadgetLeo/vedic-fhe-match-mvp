/**
 * match-card.js
 * =============
 * Renders on-chain match records into result cards, and generates share cards
 * for matches in the Revealed state.
 *
 * Exports
 * ───────
 *  renderResultCards(matches, contract, wallet) → void  (writes to #results)
 *  generateShareCard(cardData)                  → HTMLElement
 */

import { MatchState, CloseReason, canCloseExpiredMatch, canCloseStuckDecryption } from "./state-machine.js";
import { CONFIG } from "./config.js";
import { decodeText } from "./cofhe-bridge.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function short(addr) {
  if (!addr || addr === "0x0000000000000000000000000000000000000000") return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function tsToIso(ts) {
  if (!ts) return "—";
  const n = Number(ts);
  if (n === 0) return "—";
  return new Date(n * 1000).toLocaleString();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function statePill(state) {
  const map = {
    [MatchState.Computed]:       ["#4a5a90", "Computed"],
    [MatchState.PendingConsent]: ["#b87a00", "Pending Consent"],
    [MatchState.Decrypting]:     ["#1a7aab", "Decrypting"],
    [MatchState.Revealed]:       ["#1e8c5a", "Revealed ✨"],
    [MatchState.Closed]:         ["#7a3a3a", "Closed"]
  };
  const [bg, label] = map[state] ?? ["#333", state];
  return `<span style="background:${bg};border-radius:999px;padding:2px 10px;font-size:0.75rem;color:#fff;font-weight:600;">${label}</span>`;
}

function closeReasonBadge(reason) {
  if (!reason || reason === CloseReason.None) return "";
  const colors = {
    [CloseReason.NotQualified]:   "#555",
    [CloseReason.Declined]:       "#7a3a3a",
    [CloseReason.ConsentExpired]: "#7a5a00",
    [CloseReason.DecryptFailed]:  "#7a3a3a",
    [CloseReason.Superseded]:     "#4a3a7a"
  };
  const c = colors[reason] ?? "#555";
  return `<span style="background:${c};border-radius:999px;padding:1px 8px;font-size:0.72rem;color:#eee;">${reason}</span>`;
}

function consentBadge(flag, label) {
  const c = flag ? "#1e8c5a" : "#555";
  return `<span style="background:${c};padding:1px 7px;border-radius:999px;font-size:0.72rem;color:#eee;">${label}:${flag ? "✓" : "✗"}</span>`;
}

// ─── getMyMatchCardData wrapper ───────────────────────────────────────────────

/**
 * Fetch the rich card data for a revealed match.  Falls back gracefully if
 * the function is not yet deployed on the target contract version.
 */
export async function fetchMatchCardData(contract, matchId) {
  try {
    const raw = await contract.getMyMatchCardData(matchId);
    const counterpartNameNum = BigInt(raw.counterpartName ?? 0);
    const counterpartHandleNum = BigInt(raw.counterpartXHandle ?? 0);
    return {
      matchId: Number(matchId),
      score36: Number(raw.score ?? 0),
      counterpartName: counterpartNameNum,
      counterpartHandle: decodeText(counterpartHandleNum),
      shareCardUnlocked: Boolean(raw.ready),
      counterpartNameText: decodeText(counterpartNameNum)
    };
  } catch {
    // Function not yet deployed — return null and fall back to base record data
    return null;
  }
}

// ─── Share card generator ────────────────────────────────────────────────────

// ─── Compatibility tier (crypto-coded) ────────────────────────────────────

export function scoreTier(score) {
  const s = Number(score) || 0;
  if (s >= 34) return { label: "Diamond Pair",  subtitle: "Top-tier alignment. Hold forever.", glow: "#9be7ff", ring: "#5fc8ff", emoji: "💎" };
  if (s >= 31) return { label: "Alpha Match",   subtitle: "Rare signal. High conviction.",     glow: "#c9a0ff", ring: "#9b8cff", emoji: "🔮" };
  if (s >= 26) return { label: "Bullish AF",    subtitle: "Real chemistry. Long bias.",        glow: "#ff80b5", ring: "#ff5fa3", emoji: "🚀" };
  if (s >= 18) return { label: "Stable Pair",   subtitle: "Grounded. Steady accumulation.",    glow: "#3ddc97", ring: "#1e8c5a", emoji: "🪙" };
  return                { label: "Bearish",        subtitle: "Off-frequency. Wait for the cycle.", glow: "#9aa7c8", ring: "#4a5a90", emoji: "🐻" };
}

function avatarUrl(handle) {
  if (!handle) return null;
  const h = handle.replace(/^@/, "").trim();
  if (!h) return null;
  // unavatar with twitter fallback chain (returns first available source)
  const fallback = encodeURIComponent(`https://api.dicebear.com/7.x/identicon/svg?seed=${h}`);
  return `https://unavatar.io/twitter/${encodeURIComponent(h)}?fallback=${fallback}`;
}

function shortAddr(a) {
  if (!a) return "?";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * Build a self-contained share card element for a Revealed match.
 * Cosmic theme + score ring + tier + dual identity + download-as-PNG.
 *
 * @param {object} cardData   From fetchMatchCardData()
 * @param {object} baseMatch  Base match record (for fallback fields)
 * @param {string} myWallet   Connected wallet (for "you" badge)
 */
export function generateShareCard(cardData, baseMatch, myWallet, myProfile) {
  const score   = Number(cardData?.score36 ?? 0);
  const matchId = cardData?.matchId ?? baseMatch?.matchId ?? "?";
  const unlocked = cardData?.shareCardUnlocked ?? false;
  const tier    = scoreTier(score);

  // Counterpart vs me
  const me   = (myWallet || "").toLowerCase();
  const isA  = baseMatch?.userA?.toLowerCase() === me;
  const otherAddr = isA ? baseMatch?.userB : baseMatch?.userA;

  // ── You side ──
  const myNameRaw  = (myProfile?.name || "").trim();
  const myName     = myNameRaw || shortAddr(myWallet);
  const myHandleRaw = (myProfile?.xHandle || "").trim();
  const myHandle = myHandleRaw ? (myHandleRaw.startsWith("@") ? myHandleRaw : `@${myHandleRaw}`) : "";
  const myPfp = avatarUrl(myHandleRaw);
  const myInitial = (myName?.[0] || "Y").toUpperCase();

  // ── Counterpart side ──
  const themName  = unlocked && cardData?.counterpartNameText ? cardData.counterpartNameText : "—";
  const themHandleRaw = (cardData?.counterpartHandle || "").replace(/^@/, "");
  const themHandle = unlocked && themHandleRaw
    ? `@${themHandleRaw}`
    : (unlocked ? shortAddr(otherAddr) : "🔒 Private");
  const themPfp = unlocked ? avatarUrl(themHandleRaw) : null;
  const themInitial = (themName?.[0] && themName !== "—" ? themName[0] : "?").toUpperCase();

  // Score ring math (SVG)
  const pct     = Math.max(0, Math.min(36, score)) / 36;
  const R       = 92;
  const C       = 2 * Math.PI * R;
  const dash    = (pct * C).toFixed(2);
  const dashGap = (C - pct * C).toFixed(2);

  const revealedDate = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  const el = document.createElement("div");
  el.className = "share-card-v2";
  el.dataset.matchId = String(matchId);
  el.innerHTML = `
    <div class="sc2-canvas" style="--tier-glow:${tier.glow};--tier-ring:${tier.ring};">
      <div class="sc2-stars" aria-hidden="true"></div>
      <div class="sc2-orb sc2-orb-a"></div>
      <div class="sc2-orb sc2-orb-b"></div>

      <div class="sc2-head">
        <div class="sc2-brand">
          <span class="sc2-brand-dot">✦</span>
          <span class="sc2-brand-name">VEDIC&nbsp;MATCH</span>
        </div>
        <div class="sc2-tier-pill">${tier.emoji} ${tier.label}</div>
      </div>

      <div class="sc2-ring-wrap">
        <svg class="sc2-ring" viewBox="0 0 240 240" width="240" height="240" aria-hidden="true">
          <defs>
            <linearGradient id="sc2grad-${matchId}" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%"  stop-color="${tier.glow}"/>
              <stop offset="100%" stop-color="${tier.ring}"/>
            </linearGradient>
          </defs>
          <circle cx="120" cy="120" r="${R}" stroke="rgba(255,255,255,0.08)" stroke-width="16" fill="none"/>
          <circle cx="120" cy="120" r="${R}"
                  stroke="url(#sc2grad-${matchId})" stroke-width="16" fill="none"
                  stroke-linecap="round"
                  stroke-dasharray="${dash} ${dashGap}"
                  transform="rotate(-90 120 120)"/>
        </svg>
        <div class="sc2-ring-text">
          <div class="sc2-score">${score}</div>
          <div class="sc2-score-of">/ 36</div>
          <div class="sc2-score-tag">Ashtakoota</div>
        </div>
      </div>

      <div class="sc2-tier-sub">${tier.subtitle}</div>

      <div class="sc2-pair">
        <div class="sc2-person sc2-you">
          <div class="sc2-avatar-wrap">
            <div class="sc2-avatar-bg">${myInitial}</div>
            ${myPfp ? `<img class="sc2-avatar-img" src="${myPfp}" alt="" crossorigin="anonymous" referrerpolicy="no-referrer" onerror="this.style.display='none'"/>` : ""}
          </div>
          <div class="sc2-meta">
            <div class="sc2-label">You</div>
            <div class="sc2-name">${escapeHtml(myName)}</div>
            ${myHandle ? `<div class="sc2-handle">${escapeHtml(myHandle)}</div>` : `<div class="sc2-handle muted">${shortAddr(myWallet)}</div>`}
          </div>
        </div>
        <div class="sc2-link"><span>${tier.emoji}</span></div>
        <div class="sc2-person sc2-them">
          <div class="sc2-avatar-wrap">
            <div class="sc2-avatar-bg">${themInitial}</div>
            ${themPfp ? `<img class="sc2-avatar-img" src="${themPfp}" alt="" crossorigin="anonymous" referrerpolicy="no-referrer" onerror="this.style.display='none'"/>` : ""}
          </div>
          <div class="sc2-meta">
            <div class="sc2-label">Matched with</div>
            <div class="sc2-name">${escapeHtml(themName)}</div>
            ${unlocked ? `<div class="sc2-handle">${escapeHtml(themHandle)}</div>` : ""}
          </div>
        </div>
      </div>

      <div class="sc2-foot">
        <div class="sc2-foot-left">
          <div class="sc2-foot-k">Encrypted on-chain · Base Sepolia</div>
          <div class="sc2-foot-k">FHE-private · Dual consent · Match #${matchId}</div>
        </div>
        <div class="sc2-foot-right">${revealedDate}</div>
      </div>
    </div>

    <div class="sc2-actions">
      <button class="btn" data-action="downloadCard" data-id="${matchId}">⬇️ Download PNG</button>
      <a class="btn secondary" data-share-link="${matchId}"
         href="https://x.com/intent/tweet?text=${encodeURIComponent(
           `${tier.emoji} ${tier.label} — ${score}/36 on Vedic Match. Encrypted, dual-consent, on Base Sepolia.`
         )}"
         target="_blank" rel="noopener">Share on X</a>
    </div>
  `;
  return el;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// ─── Action buttons ───────────────────────────────────────────────────────────

function buildActionButtons(m) {
  const now = nowSec();
  const btns = [];

  if (m.state === MatchState.PendingConsent) {
    btns.push(`<button class="btn" data-action="consent" data-id="${m.matchId}">Consent to Reveal</button>`);
    btns.push(`<button class="btn secondary" data-action="decline" data-id="${m.matchId}">Decline</button>`);
    btns.push(`<button class="btn secondary" data-action="openCard" data-id="${m.matchId}">Open Match Card</button>`);
    if (canCloseExpiredMatch(m, now)) {
      btns.push(`<button class="btn secondary" data-action="closeExpired" data-id="${m.matchId}">Close Expired</button>`);
    }
  }
  if (m.state === MatchState.Decrypting) {
    btns.push(`<button class="btn secondary" data-action="openCard" data-id="${m.matchId}">Open Match Card</button>`);
    if (canCloseStuckDecryption(m, now)) {
      btns.push(`<button class="btn secondary" data-action="closeStuck" data-id="${m.matchId}">Close Stuck Decrypt</button>`);
    }
  }
  if (m.state === MatchState.Revealed) {
    btns.push(`<button class="btn" data-action="share" data-id="${m.matchId}">Generate Share Card</button>`);
    btns.push(`<button class="btn secondary" data-action="openCard" data-id="${m.matchId}">Open Match Card</button>`);
  }
  return btns;
}

// ─── Main renderer ────────────────────────────────────────────────────────────

/**
 * Render all match records into #results.
 * For Revealed matches, eagerly fetches getMyMatchCardData.
 */
export async function renderResultCards(matches, contract) {
  const root = document.getElementById("results");
  if (!root) return;

  const stateByIndex = [
    MatchState.Computed,
    MatchState.PendingConsent,
    MatchState.Decrypting,
    MatchState.Revealed,
    MatchState.Closed,
  ];

  const normalized = (matches || []).map((m) => ({
    ...m,
    stateLabel: stateByIndex[Number(m.state)] ?? String(m.state),
  }));

  const pending = normalized.filter((m) => m.stateLabel === MatchState.PendingConsent || m.stateLabel === MatchState.Decrypting);
  const revealed = normalized.filter((m) => m.stateLabel === MatchState.Revealed);

  // PRD Screen 3 state: No Match Yet (sad card)
  if (!pending.length && !revealed.length) {
    root.innerHTML = `
      <div class="result-card sad-card">
        <h3>No Match Yet</h3>
        <div class="kv">No qualifying compatibility found yet. Stay active in the pool and check again soon.</div>
      </div>`;
    return;
  }

  const cardDataMap = {};
  await Promise.all(
    revealed.map(async (m) => {
      if (contract) cardDataMap[m.matchId] = await fetchMatchCardData(contract, m.matchId);
    })
  );

  const pendingHtml = pending.map((m) => {
    const actionBtns = buildActionButtons({ ...m, state: m.stateLabel, consentDeadline: m.consentDeadline, decryptDeadline: m.decryptDeadline });
    const title = m.stateLabel === MatchState.Decrypting ? "Decrypting your match…" : "Match found — awaiting consent";
    return `
      <div class="result-card pending-card" data-match-id="${m.matchId}">
        <h3>${title}</h3>
        <div class="kv">Match #${m.matchId}</div>
        <div class="kv">${consentBadge(m.consentA, "You")} ${consentBadge(m.consentB, "Them")}</div>
        <div class="inline-row" style="margin-top:8px;">${actionBtns.join("")}</div>
      </div>`;
  }).join("");

  const revealedHtml = revealed.map((m) => {
    const cd = cardDataMap[m.matchId];
    const score = cd?.score36 ?? 0;
    const tier = scoreTier(score);
    const counterpartLabel = cd?.shareCardUnlocked && (cd?.counterpartHandle || cd?.counterpartNameText)
      ? (cd?.counterpartHandle?.startsWith("@") ? cd.counterpartHandle : (cd?.counterpartHandle ? `@${cd.counterpartHandle}` : cd.counterpartNameText))
      : "Private";
    return `
      <div class="result-card revealed-tile" data-match-id="${m.matchId}" style="--tier-glow:${tier.glow};--tier-ring:${tier.ring};">
        <div class="tile-row">
          <div class="tile-tier">${tier.emoji} ${tier.label}</div>
          <div class="tile-score">${score}<span>/36</span></div>
        </div>
        <div class="tile-meta">Matched with <strong>${escapeHtmlPlain(counterpartLabel)}</strong> · Match #${m.matchId}</div>
        <button class="btn tile-cta" data-action="seeCard" data-id="${m.matchId}">See Your Match Card →</button>
      </div>`;
  }).join("");

  root.innerHTML = `${pendingHtml}${revealedHtml}`;

  // Expose card data so the modal opener (in script.js) can render lazily
  if (typeof window !== "undefined") {
    window.__vedicCardData = cardDataMap;
  }
}

function escapeHtmlPlain(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
