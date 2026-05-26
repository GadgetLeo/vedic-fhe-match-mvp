import { CONFIG } from "./config.js";
import { MatchState, CloseReason } from "./state-machine.js";
import { VEDIC_AUTO_MATCH_ABI } from "./abi-vedic.js";
import { connectCofhe, encryptProfileInputs, encryptedBlobSummary, fetchMyProfileData } from "./cofhe-bridge.js";
import { renderResultCards, generateShareCard } from "./match-card.js";

// ─── App state ────────────────────────────────────────────────────────────────

const app = {
  wallet:     null,
  chainId:    null,
  provider:   null,
  signer:     null,
  contract:   null,
  profile:    null,            // { owner, profileId, profileVersion, encrypted }
  onchainMatches: []
};

// ─── DOM handles ─────────────────────────────────────────────────────────────

const connectBtn     = document.getElementById("connectBtn");
const walletBadge    = document.getElementById("walletBadge");
const profileForm    = document.getElementById("profileForm");
const clearBtn       = document.getElementById("clearBtn");
const withdrawBtn    = document.getElementById("withdrawBtn");
const createStatus   = document.getElementById("createStatus");
const matchingStatus = document.getElementById("matchingStatus");
const syncBtn        = document.getElementById("syncBtn");
const heartbeatBtn   = document.getElementById("heartbeatBtn"); // optional in PRD UI mode
const results        = document.getElementById("results");
const runCountdown   = document.getElementById("runCountdown");

const matchModal       = document.getElementById("matchModal");
const matchModalTitle  = document.getElementById("matchModalTitle");
const matchModalBody   = document.getElementById("matchModalBody");
const matchModalShare  = document.getElementById("matchModalShare");
const matchModalClose  = document.getElementById("matchModalClose");
const matchModalDismiss= document.getElementById("matchModalDismiss");

const CHAIN_HEX = `0x${CONFIG.network.chainId.toString(16)}`;
const MATCHER_RUN_INTERVAL_S = 60; // scheduled keeper runs every minute
const AUTO_POLL_INTERVAL_MS = 5000; // background sync when waiting on consent/reveal
let countdownTimer = null;
let autoPollTimer  = null;
let nextRunAtSec = Math.floor(Date.now() / 1000) + MATCHER_RUN_INTERVAL_S;

// Tracks per-match notification flags so we only popup once per state transition
const matchNotifiedState = new Map(); // matchId -> last shown stateKey
const SHOWN_MODAL_KEY = "vedic_shown_modals_v1";
const shownModalKeys = new Set(safeJsonParse(localStorage.getItem(SHOWN_MODAL_KEY), []));

function safeJsonParse(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function persistShownModalKey(key) {
  shownModalKeys.add(key);
  try { localStorage.setItem(SHOWN_MODAL_KEY, JSON.stringify([...shownModalKeys])); } catch {}
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function short(addr) {
  if (!addr) return "?";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function updateCreateStatus(text, cls = "") {
  createStatus.className = `notice ${cls}`.trim();
  createStatus.textContent = text;
}

function setMatchingStatus(text, cls = "") {
  matchingStatus.className = `state-card ${cls}`.trim();
  matchingStatus.textContent = text;
}

function formatMmSs(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function updateRunCountdownUI() {
  if (!runCountdown) return;
  const remaining = Math.max(0, nextRunAtSec - nowSec());
  runCountdown.textContent = `Next matcher run in ${formatMmSs(remaining)}`;
}

function alignNextRunToMinute() {
  const now = nowSec();
  nextRunAtSec = Math.floor(now / MATCHER_RUN_INTERVAL_S) * MATCHER_RUN_INTERVAL_S + MATCHER_RUN_INTERVAL_S;
}

function startRunCountdown() {
  if (!runCountdown) return;
  alignNextRunToMinute();
  updateRunCountdownUI();

  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const remaining = nextRunAtSec - nowSec();
    if (remaining <= 0) {
      alignNextRunToMinute();
    }
    updateRunCountdownUI();
  }, 1000);
}

function startAutoPolling() {
  if (autoPollTimer) return;
  autoPollTimer = setInterval(() => {
    if (!app.contract || !app.wallet) return;
    const interesting = app.onchainMatches.some((m) => {
      const s = Number(m.state);
      return s === 1 || s === 2; // PendingConsent or Decrypting
    });
    if (interesting) {
      syncOnchain().catch(() => {});
    }
  }, AUTO_POLL_INTERVAL_MS);
}

function showMatchModal({ title, body, shareText, oncePerKey }) {
  if (!matchModal) return;
  if (oncePerKey) {
    if (shownModalKeys.has(oncePerKey)) return;
    persistShownModalKey(oncePerKey);
  }
  matchModalTitle.textContent = title || "It's a Match!";
  matchModalBody.innerHTML = body || "";
  if (shareText) {
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
    matchModalShare.href = url;
    matchModalShare.hidden = false;
  } else {
    matchModalShare.hidden = true;
  }
  matchModal.hidden = false;
}

function hideMatchModal() {
  if (matchModal) matchModal.hidden = true;
}

function evaluateMatchNotifications(matches) {
  for (const m of matches) {
    const id = m.matchId;
    const state = Number(m.state);
    const both = m.consentA && m.consentB;
    const prev = matchNotifiedState.get(id);

    if (state === 3 && prev !== "revealed") {
      matchNotifiedState.set(id, "revealed");
      showMatchModal({
        title: "✨ Match Revealed!",
        body: `<p>Match #${id} unlocked. Both of you consented and the score is decrypted.</p><p>Pop your Share on X card and tell the world.</p>`,
        shareText: `We matched on Private Vedic Auto-Matching ✨ Compatibility unlocked.`,
        oncePerKey: `revealed-${id}`,
      });
    } else if (state === 2 && prev !== "decrypting") {
      matchNotifiedState.set(id, "decrypting");
      showMatchModal({
        title: "🔐 Both Consented",
        body: `<p>Match #${id} is now decrypting on the FHE network.</p><p>Hang tight — identity will appear here shortly.</p>`,
        oncePerKey: `decrypting-${id}`,
      });
    } else if (state === 1 && both && prev !== "both-consented") {
      // Edge case: contract may still report PendingConsent for a brief window even after both sides signed
      matchNotifiedState.set(id, "both-consented");
      showMatchModal({
        title: "🤝 Both Consented",
        body: `<p>Match #${id} — both wallets agreed to reveal.</p><p>Waiting for decrypt to finalize.</p>`,
        oncePerKey: `both-${id}`,
      });
    } else if (state === 1 && prev === undefined) {
      matchNotifiedState.set(id, "pending");
    }
  }
}

async function importEthers() {
  return import("https://esm.sh/ethers@6.13.5");
}

// ─── Network guard ────────────────────────────────────────────────────────────

async function ensureCorrectNetwork() {
  if (!window.ethereum) return;
  const chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
  if (Number(chainIdHex) === CONFIG.network.chainId) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_HEX }]
    });
  } catch {
    setMatchingStatus(`Switch network to ${CONFIG.network.name} (${CONFIG.network.chainId}).`, "state-warn");
    throw new Error("Wrong network");
  }
}

// ─── Wallet connect ───────────────────────────────────────────────────────────

async function connectWallet() {
  if (!window.ethereum) {
    walletBadge.textContent = "No wallet detected";
    return;
  }
  try {
    await ensureCorrectNetwork();
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    app.wallet  = accounts[0] || null;
    const { BrowserProvider, Contract } = await importEthers();
    app.provider = new BrowserProvider(window.ethereum);
    app.signer   = await app.provider.getSigner();
    const network = await app.provider.getNetwork();
    app.chainId  = Number(network.chainId);
    app.contract = new Contract(CONFIG.contracts.vedicAutoMatch, VEDIC_AUTO_MATCH_ABI, app.signer);
    window.__vedicWallet = app.wallet;
    // Restore per-wallet display name + handle into the form (localStorage first)
    try { window.__vedicRestoreProfile?.(); } catch {}

    // NEW: Try to fetch decrypted profile from chain (works across devices)
    try {
      const onchainProfile = await fetchMyProfileData(app.contract);
      if (onchainProfile.name || onchainProfile.xHandle) {
        if (nameInput && !nameInput.value) nameInput.value = onchainProfile.name;
        if (xHandleInput && !xHandleInput.value) xHandleInput.value = onchainProfile.xHandle;
        // persist so share cards work immediately
        persistDisplayProfile();
        updateCreateStatus("Profile loaded from chain ✓", "state-ok");
      }
    } catch (e) {
      // silent – not critical
    }

    // Initialize CoFHE SDK bridge via viem clients
    const { createPublicClient, createWalletClient, custom, http } = await import("https://esm.sh/viem@2.22.16");
    const publicClient = createPublicClient({ chain: { id: CONFIG.network.chainId, name: CONFIG.network.name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [CONFIG.network.rpc] } } }, transport: http(CONFIG.network.rpc) });
    const walletClient = createWalletClient({ chain: { id: CONFIG.network.chainId, name: CONFIG.network.name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [CONFIG.network.rpc] } } }, transport: custom(window.ethereum) });
    await connectCofhe(publicClient, walletClient);

    walletBadge.textContent = app.wallet ? short(app.wallet) : "Not connected";
    setMatchingStatus("Wallet connected. Contract + CoFHE linked.", "state-ok");
    await syncOnchain();
  } catch (e) {
    walletBadge.textContent = "Connection failed";
    setMatchingStatus(e?.message || "Wallet connection failed.", "state-err");
  }
}

// ─── Koota derivation ─────────────────────────────────────────────────────────

async function deriveKootaAttributes({ name, xHandle, dob, tob, birthplace }) {
  const seed  = `${dob}|${tob}|${birthplace}`;
  const hash  = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const view  = Array.from(new Uint8Array(hash));
  return {
    name,
    xHandle,
    kootaAttrs: {
      varna:       view[0] % 4,
      vashya:      view[1] % 5,
      tara:        view[2] % 4,
      yoni:        view[3] % 8,
      grahaMaitri: view[4] % 6,
      gana:        view[5] % 3,
      bhakoot:     view[6] % 8,
      nadi:        view[7] % 3,
    },
    seedHex: view.slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

// ─── Form validation ──────────────────────────────────────────────────────────

function validateInput(data) {
  if (!data.name.trim())                       return "Name is required.";
  if (!data.xHandle.trim().startsWith("@"))    return "X handle must start with @.";
  if (!data.dob)                               return "Date of birth is required.";
  if (!data.tob)                               return "Time of birth is required.";
  if (!data.birthplace.trim())                 return "Birthplace is required.";
  return null;
}

// ─── txAndWait helper ─────────────────────────────────────────────────────────

async function txAndWait(txPromise) {
  const tx = await txPromise;
  await tx.wait();
  return tx;
}

// ─── Profile writes (real contract + CoFHE encryption) ───────────────────────

/**
 * createProfile — encrypts Koota attrs via CoFHE bridge and submits on-chain.
 * Stores the returned profileId in app.profile.
 */
async function createProfileOnChain(derived) {
  if (!app.contract || !app.signer) {
    setMatchingStatus("Connect wallet first.", "state-err");
    return;
  }
  updateCreateStatus("Encrypting profile data via CoFHE SDK…", "state-warn");
  let encryptedInputs;
  try {
    encryptedInputs = await encryptProfileInputs(derived.kootaAttrs, derived.name, derived.xHandle);
  } catch (e) {
    updateCreateStatus(`Encryption failed: ${e?.message || e}`, "state-err");
    return;
  }

  updateCreateStatus(`Submitting createProfile… (${encryptedBlobSummary(encryptedInputs)})`, "state-warn");
  try {
    const tx   = await app.contract.createProfile(...encryptedInputs);
    const receipt = await tx.wait();

    // Parse ProfileCreated event to extract profileId
    let profileId = null;
    for (const log of receipt.logs || []) {
      try {
        const parsed = app.contract.interface.parseLog(log);
        if (parsed?.name === "ProfileCreated") {
          profileId = Number(parsed.args.profileId);
          break;
        }
      } catch { /* skip */ }
    }

    app.profile = {
      owner: app.wallet,
      profileId: profileId ?? "unknown",
      profileVersion: 1,
      encryptedSummary: encryptedBlobSummary(encryptedInputs)
    };

    updateCreateStatus(
      `Profile created on-chain ✓ · ID: ${profileId ?? "?"} · payload: ${encryptedBlobSummary(encryptedInputs)}`,
      "state-ok"
    );
    setMatchingStatus("Profile active. Matcher will sweep and score you.", "state-ok");
    await syncOnchain();
  } catch (e) {
    updateCreateStatus(e?.shortMessage || e?.message || "createProfile tx failed.", "state-err");
  }
}

/**
 * updateProfile — re-encrypts and submits with incremented version.
 */
async function updateProfileOnChain(derived) {
  if (!app.contract || !app.signer || !app.profile?.profileId) {
    updateCreateStatus("No active profile to update. Create one first.", "state-err");
    return;
  }
  updateCreateStatus("Encrypting updated profile via CoFHE SDK…", "state-warn");
  let encryptedInputs;
  try {
    encryptedInputs = await encryptProfileInputs(derived.kootaAttrs, derived.name, derived.xHandle);
  } catch (e) {
    updateCreateStatus(`Encryption failed: ${e?.message || e}`, "state-err");
    return;
  }

  const newVersion = (app.profile.profileVersion || 1) + 1;
  updateCreateStatus(`Submitting updateProfile v${newVersion}…`, "state-warn");
  try {
    await txAndWait(app.contract.updateProfile(...encryptedInputs));
    app.profile.profileVersion = newVersion;
    app.profile.encryptedSummary = encryptedBlobSummary(encryptedInputs);
    updateCreateStatus(
      `Profile updated ✓ · ID: ${app.profile.profileId} · v${newVersion} · ${app.profile.encryptedSummary}`,
      "state-ok"
    );
    await syncOnchain();
  } catch (e) {
    updateCreateStatus(e?.shortMessage || e?.message || "updateProfile tx failed.", "state-err");
  }
}

/**
 * withdrawProfile — removes profile from matching pool.
 */
async function withdrawProfileOnChain() {
  if (!app.contract || !app.profile?.profileId) {
    setMatchingStatus("No active profile to withdraw.", "state-err");
    return;
  }
  try {
    setMatchingStatus("Submitting withdrawProfile…", "state-warn");
    await txAndWait(app.contract.withdrawProfile());
    app.profile = null;
    updateCreateStatus("Profile withdrawn ✓ · No longer in matching pool.", "state-ok");
    setMatchingStatus("Profile withdrawn.", "state-warn");
    await syncOnchain();
  } catch (e) {
    setMatchingStatus(e?.shortMessage || e?.message || "withdrawProfile tx failed.", "state-err");
  }
}

// ─── On-chain sync ────────────────────────────────────────────────────────────

async function syncOnchain() {
  if (!app.contract || !app.wallet) {
    setMatchingStatus("Connect wallet first.", "state-err");
    return;
  }
  try {
    const [profileId, rows, hb] = await Promise.all([
      app.contract.activeProfileIdByOwner ? app.contract.activeProfileIdByOwner(app.wallet) : Promise.resolve(0),
      app.contract.getMyResult ? app.contract.getMyResult() : Promise.resolve([]),
      app.contract.matcherLastSeen()
    ]);

    app.onchainMatches = rows.map((m) => ({
      matchId:         Number(m.matchId),
      scoreSubmitted:  m.scoreSubmitted,
      consentA:        m.consentA,
      consentB:        m.consentB,
      consentDeadline: Number(m.consentDeadline),
      decryptDeadline: Number(m.decryptDeadline),
      state:           Number(m.state),
      closeReason:     Number(m.closeReason),
      profileVersionA: Number(m.profileVersionA),
      profileVersionB: Number(m.profileVersionB),
      userA:           m.userA,
      userB:           m.userB,
      createdAt:       Number(m.createdAt)
    }));

    const hbSec = Number(hb);
    const stale = hbSec > 0 && (nowSec() - hbSec > CONFIG.constants.MATCHER_SLA_HOURS * 3600);
    const activeProfileId = Number(profileId);

    // Reconcile local profile ID if we missed the create event
    if (activeProfileId > 0 && !app.profile) {
      app.profile = { owner: app.wallet, profileId: activeProfileId, profileVersion: 1 };
    }

      if (!activeProfileId && app.onchainMatches.length === 0) {
      setMatchingStatus("Finding compatibility...", "state-warn");
    } else if (stale) {
      setMatchingStatus("Finding compatibility... (matcher delayed)", "state-warn");
    } else {
      const hasRevealed = app.onchainMatches.some((m) => Number(m.state) === 3);
      const hasPending = app.onchainMatches.some((m) => Number(m.state) === 1 || Number(m.state) === 2);
      if (hasRevealed) {
        setMatchingStatus("Result ready: revealed match available.", "state-ok");
      } else if (hasPending) {
        setMatchingStatus("Match found. Waiting for consent/reveal flow.", "state-ok");
      } else {
        setMatchingStatus("No Match Yet.", "state-warn");
      }
    }

    await renderResultCards(app.onchainMatches, app.contract);
    evaluateMatchNotifications(app.onchainMatches);
  } catch (e) {
    setMatchingStatus(e?.shortMessage || e?.message || "Failed to sync on-chain results.", "state-err");
  }
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

async function sendHeartbeat() {
  if (!app.contract) {
    setMatchingStatus("Connect wallet first.", "state-err");
    return;
  }
  try {
    setMatchingStatus("Submitting heartbeat…", "state-warn");
    await txAndWait(app.contract.heartbeat());
    setMatchingStatus("Heartbeat sent ✓", "state-ok");
    await syncOnchain();
  } catch (e) {
    setMatchingStatus(e?.shortMessage || e?.message || "Heartbeat failed (matcher role required).", "state-err");
  }
}

// ─── Result action handler ────────────────────────────────────────────────────

async function handleResultAction(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn || !app.contract) return;

  const action  = btn.dataset.action;
  const matchId = Number(btn.dataset.id);

  try {
    setMatchingStatus("Submitting transaction…", "state-warn");

    if (action === "consent") {
      await txAndWait(app.contract.consentToReveal(matchId));
    } else if (action === "decline") {
      await txAndWait(app.contract.declineReveal(matchId));
    } else if (action === "closeExpired") {
      await txAndWait(app.contract.closeExpiredMatch(matchId));
    } else if (action === "closeStuck") {
      await txAndWait(app.contract.closeStuckDecryption(matchId));
    } else if (action === "share") {
      // Share card is already rendered by renderResultCards; scroll to it
      const card = document.querySelector(`[data-match-id="${matchId}"] .share-card`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        setMatchingStatus(`Share card displayed for match #${matchId} ✓`, "state-ok");
      } else {
        setMatchingStatus("Share card not available (match not yet revealed or contract version mismatch).", "state-warn");
      }
      return;
    } else if (action === "downloadCard") {
      try {
        const cardEl = document.querySelector(`#cardModalMount .sc2-canvas`)
          || document.querySelector(`[data-match-id="${matchId}"] .sc2-canvas`);
        if (!cardEl) {
          setMatchingStatus("Card not ready yet — wait for reveal.", "state-warn");
          return;
        }
        const htmlToImage = window.htmlToImage;
        if (!htmlToImage) {
          setMatchingStatus("Image library not loaded — refresh the page.", "state-err");
          return;
        }
        const dataUrl = await htmlToImage.toPng(cardEl, {
          pixelRatio: 2,
          backgroundColor: "#0a0d1f",
          cacheBust: true,
        });
        const link = document.createElement("a");
        link.download = `vedic-match-${matchId}.png`;
        link.href = dataUrl;
        link.click();
        setMatchingStatus(`Card downloaded ✓ — share it on X!`, "state-ok");
      } catch (err) {
        setMatchingStatus(`Download failed: ${err?.message || err}`, "state-err");
      }
      return;
    } else if (action === "seeCard") {
      const cardData = window.__vedicCardData?.[matchId];
      const row = app.onchainMatches.find((m) => Number(m.matchId) === Number(matchId));
      if (!cardData || !cardData.shareCardUnlocked) {
        setMatchingStatus("Card unlocks after reveal completes — give it a moment.", "state-warn");
        return;
      }
      // Read profile: prefer live form values, then per-wallet storage, then legacy
      const formName   = document.getElementById("name")?.value?.trim() || "";
      const formHandle = document.getElementById("xHandle")?.value?.trim() || "";
      const w = (app.wallet || "").toLowerCase();
      const storedW = w ? safeJsonParse(localStorage.getItem(`vedic_profile_${w}`), null) : null;
      const storedL = safeJsonParse(localStorage.getItem("vedic_my_profile"), null) || {};
      const myProfile = {
        name:    formName   || storedW?.name    || storedL.name    || "",
        xHandle: formHandle || storedW?.xHandle || storedL.xHandle || "",
      };
      const mount = document.getElementById("cardModalMount");
      const cardModal = document.getElementById("cardModal");
      if (!mount || !cardModal) return;
      mount.innerHTML = "";
      if (!myProfile.name && !myProfile.xHandle) {
        const hint = document.createElement("div");
        hint.style.cssText = "padding:14px 18px;margin-bottom:14px;border-radius:12px;background:rgba(255,200,80,0.12);border:1px solid rgba(255,200,80,0.35);color:#ffd66a;font-size:0.9rem;";
        hint.innerHTML = `💡 Type your name and @handle into the <strong>Your Profile</strong> form above (no need to resubmit) — they'll show on the card here.`;
        mount.appendChild(hint);
      }
      mount.appendChild(generateShareCard(cardData, row, app.wallet, myProfile));
      cardModal.hidden = false;
      return;
    } else if (action === "openCard") {
      const row = app.onchainMatches.find((m) => Number(m.matchId) === Number(matchId));
      const card = document.querySelector(`[data-match-id="${matchId}"] .share-card`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        showMatchModal({
          title: "Match Card Ready",
          body: `<p>Match #${matchId} card is shown below.</p><p>You can regenerate/share anytime.</p>`,
          shareText: `We matched on Private Vedic Auto-Matching ✨`,
        });
        setMatchingStatus(`Match card opened for #${matchId} ✓`, "state-ok");
      } else if (row && Number(row.state) === 2) {
        showMatchModal({
          title: "Decrypting in progress",
          body: `<p>Match #${matchId} exists, but card unlock waits for reveal callback.</p><p>Try again shortly.</p>`,
        });
        setMatchingStatus(`Match #${matchId} is decrypting. Card unlocks after reveal.`, "state-warn");
      } else {
        showMatchModal({
          title: "Match found",
          body: `<p>Match #${matchId} is active.</p><p>Card appears once reveal is completed.</p>`,
        });
        setMatchingStatus(`Match #${matchId} is active. Card will unlock after reveal.`, "state-warn");
      }
      return;
    }

    await syncOnchain();
  } catch (e2) {
    setMatchingStatus(e2?.shortMessage || e2?.message || "Transaction failed.", "state-err");
  }
}

// ─── Form submit → create OR update ──────────────────────────────────────────

profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!app.wallet) {
    updateCreateStatus("Connect wallet before submitting profile.", "state-err");
    return;
  }
  const formData = {
    name:       document.getElementById("name").value,
    xHandle:    document.getElementById("xHandle").value,
    dob:        document.getElementById("dob").value,
    tob:        document.getElementById("tob").value,
    birthplace: document.getElementById("birthplace").value
  };
  const err = validateInput(formData);
  if (err) { updateCreateStatus(err, "state-err"); return; }

  // Save my own profile locally (wallet-keyed) so the share card can show name + X handle for "You"
  try {
    const w = (app.wallet || "").toLowerCase();
    if (w) localStorage.setItem(`vedic_profile_${w}`, JSON.stringify({
      name: formData.name.trim(),
      xHandle: formData.xHandle.trim(),
    }));
    // Legacy key (read-only fallback)
    localStorage.setItem("vedic_my_profile", JSON.stringify({
      name: formData.name.trim(),
      xHandle: formData.xHandle.trim(),
    }));
  } catch {}

  const derived = await deriveKootaAttributes(formData);

  if (app.profile?.profileId) {
    // Already have a profile → update path
    await updateProfileOnChain(derived);
  } else {
    // New profile → create path
    await createProfileOnChain(derived);
  }
});

// ─── Withdraw button ──────────────────────────────────────────────────────────

withdrawBtn?.addEventListener("click", async () => {
  if (!confirm("Withdraw your profile from the matching pool?")) return;
  await withdrawProfileOnChain();
});

// ─── Clear ────────────────────────────────────────────────────────────────────

clearBtn.addEventListener("click", () => {
  profileForm.reset();
  app.profile = null;
  app.onchainMatches = [];
  updateCreateStatus("No active profile.");
  setMatchingStatus("Finding compatibility...");
  renderResultCards([], app.contract);
});

// ─── Wire events ──────────────────────────────────────────────────────────────

connectBtn.addEventListener("click",  connectWallet);
syncBtn.addEventListener("click",     syncOnchain);
heartbeatBtn?.addEventListener("click", sendHeartbeat);
results.addEventListener("click",     handleResultAction);

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => connectWallet());
  window.ethereum.on?.("chainChanged",    () => connectWallet());
}

// Modal close handlers
matchModalClose?.addEventListener("click", hideMatchModal);
matchModalDismiss?.addEventListener("click", hideMatchModal);
matchModal?.addEventListener("click", (e) => { if (e.target === matchModal) hideMatchModal(); });

// ── Auto-save + restore display-name profile fields ──
const nameInput = document.getElementById("name");
const xHandleInput = document.getElementById("xHandle");

function persistDisplayProfile() {
  const payload = JSON.stringify({
    name: nameInput?.value?.trim() || "",
    xHandle: xHandleInput?.value?.trim() || "",
  });
  try {
    localStorage.setItem("vedic_my_profile", payload);
    const w = (app.wallet || "").toLowerCase();
    if (w) localStorage.setItem(`vedic_profile_${w}`, payload);
  } catch {}
}
function restoreDisplayProfile() {
  const w = (app.wallet || "").toLowerCase();
  const p = (w && safeJsonParse(localStorage.getItem(`vedic_profile_${w}`), null))
          || safeJsonParse(localStorage.getItem("vedic_my_profile"), null);
  if (!p) return;
  if (nameInput && !nameInput.value && p.name)       nameInput.value = p.name;
  if (xHandleInput && !xHandleInput.value && p.xHandle) xHandleInput.value = p.xHandle;
}
nameInput?.addEventListener("input", persistDisplayProfile);
xHandleInput?.addEventListener("input", persistDisplayProfile);
restoreDisplayProfile();
// Expose for connectWallet to call after wallet is set
window.__vedicRestoreProfile = restoreDisplayProfile;

// Card-viewer modal
const cardModalEl = document.getElementById("cardModal");
const cardModalCloseEl = document.getElementById("cardModalClose");
function hideCardModal() {
  if (cardModalEl) cardModalEl.hidden = true;
  const mount = document.getElementById("cardModalMount");
  if (mount) mount.innerHTML = "";
}
cardModalCloseEl?.addEventListener("click", hideCardModal);
cardModalEl?.addEventListener("click", (e) => { if (e.target === cardModalEl) hideCardModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && cardModalEl && !cardModalEl.hidden) hideCardModal();
});
// Delegate clicks inside the card modal (download/share buttons live there)
cardModalEl?.addEventListener("click", handleResultAction);

// Init
setMatchingStatus("Finding compatibility...");
startRunCountdown();
startAutoPolling();
renderResultCards([], null);
