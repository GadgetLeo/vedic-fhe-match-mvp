import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, LockKeyhole, RefreshCw, Search, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { toPng } from 'html-to-image';
import {
  connectWallet,
  CONTRACT_ADDRESS,
  decryptRevealedMatch,
  encryptAndSaveProfile,
  fetchMatchRecordsForWallet,
  fetchProfileByAddress,
  requestMatchReveal,
  scanAndComputeMatchesForWallet,
} from './contract';
import { deriveChartFeatures, getBadges, getTier, nakshatraNames, signNames } from './chart';
import { BirthForm, MatchRecord, MatchResult, ProfileForm, PublicProfile } from './types';

const initialProfile: ProfileForm = {
  displayName: 'Anika',
  xHandle: '@anika_fhe',
  avatarColor: '#0AD9DC',
};

const initialBirth: BirthForm = {
  date: '1998-04-18',
  time: '08:24',
  location: 'Mumbai, India',
  timezone: 'Asia/Kolkata',
};

const demoProfiles: PublicProfile[] = [
  {
    address: '0x4fd5f2a74c8d3f23f19dfe9fb9aa2e97679afaaa',
    displayName: 'Riya',
    xHandle: '@riyaverse',
    avatarColor: '#e8b84a',
    createdAt: 0n,
    exists: true,
    hasChart: true,
  },
  {
    address: '0x7ed8ac0f983cfe1490e77d8f20df57bf0bfadc11',
    displayName: 'Dev',
    xHandle: '@devcrypted',
    avatarColor: '#7585ff',
    createdAt: 0n,
    exists: true,
    hasChart: true,
  },
];

export function App() {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [profile, setProfile] = useState(initialProfile);
  const [birth, setBirth] = useState(initialBirth);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<MatchRecord | null>(null);
  const [sealedProfile, setSealedProfile] = useState<PublicProfile | null>(null);
  const [status, setStatus] = useState('Ready to seal your chart');
  const [isBusy, setIsBusy] = useState(false);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const chart = useMemo(() => deriveChartFeatures(birth), [birth]);
  const hasContract = Boolean(CONTRACT_ADDRESS);

  useEffect(() => {
    if (!account) {
      setMatches([]);
      setSelectedMatch(null);
      setSealedProfile(null);
      setMatch(null);
      setStatus('Demo matches visible until a wallet connects');
    }
  }, [account]);

  async function handleConnect() {
    setIsBusy(true);
    setStatus('Opening wallet');
    try {
      const address = await connectWallet();
      setAccount(address);
      setStatus('Wallet connected on Base Sepolia');
      await loadSealedProfile(address);
      await refreshMatches(address, false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Wallet connection failed');
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSave() {
    if (!account) {
      setStatus('Connect your wallet before sealing a profile');
      return;
    }

    if (sealedProfile) {
      setStatus('This wallet already has a sealed profile');
      return;
    }

    setIsBusy(true);
    setMatch(null);
    try {
      await encryptAndSaveProfile(profile, chart, setStatus);
      await loadSealedProfile(account);
      setStatus('Profile sealed on-chain. Automatic matching can now scan your profile.');
      await refreshMatches(account, true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Encrypted profile failed');
    } finally {
      setIsBusy(false);
    }
  }

  async function loadSealedProfile(viewer: `0x${string}`) {
    const existingProfile = await fetchProfileByAddress(viewer);
    setSealedProfile(existingProfile);
    if (existingProfile) {
      setProfile({
        displayName: existingProfile.displayName,
        xHandle: existingProfile.xHandle,
        avatarColor: existingProfile.avatarColor,
      });
    }
    return existingProfile;
  }

  async function refreshMatches(viewer: `0x${string}` | null = account, shouldScan = true) {
    if (!viewer) {
      setMatches([]);
      setSelectedMatch(null);
      setStatus('Demo matches visible until a wallet connects');
      return;
    }

    setStatus(shouldScan ? 'Scanning sealed profiles for your wallet' : 'Checking your private match queue');
    try {
      const computedCount = shouldScan ? await scanAndComputeMatchesForWallet(viewer, setStatus) : 0;
      const nextMatches = await fetchMatchRecordsForWallet(viewer);
      setMatches(nextMatches);
      setSelectedMatch((current) => {
        const refreshed = current ? nextMatches.find((item) => item.key === current.key) : null;
        return refreshed ?? nextMatches[0] ?? null;
      });
      setStatus(
        nextMatches.length > 0
          ? computedCount > 0
            ? 'New encrypted match found'
            : 'Encrypted match found'
          : 'No sealed profiles ready to match yet',
      );
    } catch (error) {
      setMatches([]);
      setSelectedMatch(null);
      setStatus(error instanceof Error ? error.message : 'Could not load private matches');
    }
  }

  async function revealMatch() {
    if (!account || !selectedMatch) return;
    setIsBusy(true);
    setMatch(null);
    try {
      await requestMatchReveal(selectedMatch.other, setStatus);
      await refreshMatches(account, false);
      const score = await decryptRevealedMatch(selectedMatch.other, account, setStatus);
      setMatch({ score, tier: getTier(score), badges: getBadges(score) });
      setStatus(score >= 50 ? 'Match card revealed' : 'Candidate did not clear the match threshold');
    } catch (error) {
      await refreshMatches(account, false);
      setStatus(error instanceof Error ? error.message : 'Reveal request failed');
    } finally {
      setIsBusy(false);
    }
  }

  async function exportCard() {
    if (!cardRef.current) return;
    const image = await toPng(cardRef.current, { pixelRatio: 2, cacheBust: true });
    const link = document.createElement('a');
    link.download = 'fhe-horoscope-match.png';
    link.href = image;
    link.click();
  }

  return (
    <main className="app-shell">
      <Header account={account} isBusy={isBusy} onConnect={handleConnect} />

      <section className="hero-band">
        <div>
          <p className="eyebrow">Vedic synastry x confidential compute</p>
          <h1>Private compatibility. Public spark.</h1>
          <p className="hero-copy">
            Birth-chart factors are derived locally, encrypted with Fhenix CoFHE, and matched on-chain without exposing
            the chart. Only the compatibility result becomes content.
          </p>
        </div>
        <div className="cipher-panel" aria-label="Encrypted compute motif">
          <span>ctHash: 0x7f3a...9e11</span>
          <span>FHE.select(score &gt;= 50)</span>
          <span>nakshatra.signal.locked</span>
        </div>
      </section>

      <section className="workspace-grid">
        <ProfilePanel
          profile={profile}
          birth={birth}
          chart={chart}
          account={account}
          sealedProfile={sealedProfile}
          isBusy={isBusy}
          onProfileChange={setProfile}
          onBirthChange={setBirth}
          onSave={handleSave}
        />

        <MatchPanel
          account={account}
          matches={matches}
          selected={selectedMatch}
          isBusy={isBusy}
          status={status}
          hasContract={hasContract}
          onRefresh={() => refreshMatches(account, true)}
          onSelect={setSelectedMatch}
          onReveal={revealMatch}
        />

        <ShareCardPanel
          cardRef={cardRef}
          self={profile}
          other={selectedMatch?.profile ?? null}
          selectedMatch={selectedMatch}
          match={match}
          onExport={exportCard}
        />
      </section>

      <footer className="app-footer">
        <FhenixLogo />
        <span>Built with Fhenix CoFHE on Base Sepolia</span>
      </footer>
    </main>
  );
}

function Header({ account, isBusy, onConnect }: { account: string | null; isBusy: boolean; onConnect: () => void }) {
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <FhenixLogo />
        <div>
          <strong>FHE Horoscope Match</strong>
          <span>encrypted cosmic compatibility lab</span>
        </div>
      </div>
      <button className="wallet-button" disabled={isBusy} onClick={onConnect}>
        <Wallet size={18} />
        {account ? `${account.slice(0, 6)}...${account.slice(-4)}` : 'Connect'}
      </button>
    </header>
  );
}

function FhenixLogo() {
  return (
    <div className="fhenix-logo" aria-label="Fhenix">
      <img src="/brand/fhenix-logo-on-dark.svg" alt="Fhenix" />
    </div>
  );
}

function ProfilePanel({
  profile,
  birth,
  chart,
  account,
  sealedProfile,
  isBusy,
  onProfileChange,
  onBirthChange,
  onSave,
}: {
  profile: ProfileForm;
  birth: BirthForm;
  chart: ReturnType<typeof deriveChartFeatures>;
  account: `0x${string}` | null;
  sealedProfile: PublicProfile | null;
  isBusy: boolean;
  onProfileChange: (profile: ProfileForm) => void;
  onBirthChange: (birth: BirthForm) => void;
  onSave: () => void;
}) {
  const hasSealedProfile = Boolean(sealedProfile);
  const controlsDisabled = isBusy || hasSealedProfile;
  const actionLabel = !account ? 'Connect wallet to seal profile' : hasSealedProfile ? 'Profile already sealed' : 'Encrypt chart & store profile';

  return (
    <section className="panel profile-panel">
      <div className="panel-title">
        <LockKeyhole size={18} />
        <h2>Seal Profile</h2>
      </div>
      {sealedProfile && (
        <div className="sealed-profile-card">
          <span className="avatar" style={{ background: sealedProfile.avatarColor }} />
          <span>
            <strong>{sealedProfile.displayName}</strong>
            <small>{sealedProfile.xHandle}</small>
          </span>
          <em>sealed v{(sealedProfile.version ?? 1n).toString()}</em>
        </div>
      )}
      <div className="form-grid">
        <label>
          Display name
          <input
            value={profile.displayName}
            disabled={controlsDisabled}
            onChange={(event) => onProfileChange({ ...profile, displayName: event.target.value })}
          />
        </label>
        <label>
          X handle
          <input
            value={profile.xHandle}
            disabled={controlsDisabled}
            onChange={(event) => onProfileChange({ ...profile, xHandle: event.target.value })}
          />
        </label>
        <label>
          Aura color
          <input
            type="color"
            value={profile.avatarColor}
            disabled={controlsDisabled}
            onChange={(event) => onProfileChange({ ...profile, avatarColor: event.target.value })}
          />
        </label>
        <label>
          Birth date
          <input
            type="date"
            value={birth.date}
            disabled={controlsDisabled}
            onChange={(event) => onBirthChange({ ...birth, date: event.target.value })}
          />
        </label>
        <label>
          Birth time
          <input
            type="time"
            value={birth.time}
            disabled={controlsDisabled}
            onChange={(event) => onBirthChange({ ...birth, time: event.target.value })}
          />
        </label>
        <label>
          Birth city / country
          <input
            value={birth.location}
            disabled={controlsDisabled}
            onChange={(event) => onBirthChange({ ...birth, location: event.target.value })}
          />
        </label>
        <label className="span-two">
          Timezone
          <input
            value={birth.timezone}
            disabled={controlsDisabled}
            onChange={(event) => onBirthChange({ ...birth, timezone: event.target.value })}
          />
        </label>
      </div>

      <div className="chart-preview">
        <div>
          <span>Moon</span>
          <strong>{signNames[chart.moonSign]}</strong>
        </div>
        <div>
          <span>Nakshatra</span>
          <strong>{nakshatraNames[chart.nakshatra]}</strong>
        </div>
        <div>
          <span>Ascendant</span>
          <strong>{signNames[chart.ascSign]}</strong>
        </div>
      </div>

      <button className="primary-action" disabled={isBusy || hasSealedProfile} onClick={onSave}>
        <ShieldCheck size={18} />
        {actionLabel}
      </button>
    </section>
  );
}

function MatchPanel({
  account,
  matches,
  selected,
  isBusy,
  status,
  hasContract,
  onRefresh,
  onSelect,
  onReveal,
}: {
  account: `0x${string}` | null;
  matches: MatchRecord[];
  selected: MatchRecord | null;
  isBusy: boolean;
  status: string;
  hasContract: boolean;
  onRefresh: () => void;
  onSelect: (match: MatchRecord | null) => void;
  onReveal: () => void;
}) {
  const showDemo = !account;
  const revealLabel = selected?.bothRevealed
    ? 'Open card'
    : selected?.youRevealed
      ? 'Waiting for them'
      : 'Reveal match';

  return (
    <section className="panel match-panel">
      <div className="panel-title">
        <Search size={18} />
        <h2>Private Synastry</h2>
      </div>
      <div className="status-strip">
        <span className={hasContract ? 'live-dot' : 'warn-dot'} />
        {status}
      </div>
      <div className="profile-list">
        {showDemo &&
          demoProfiles.map((publicProfile) => (
            <div className="profile-card demo-card" key={publicProfile.address}>
              <span className="avatar" style={{ background: publicProfile.avatarColor }} />
              <span>
                <strong>{publicProfile.displayName}</strong>
                <small>{publicProfile.xHandle}</small>
              </span>
              <em>demo</em>
            </div>
          ))}
        {!showDemo && matches.length === 0 && (
          <div className="empty-private-list">
            No encrypted matches yet. Refresh scans sealed profiles and creates new private match records for this
            wallet.
          </div>
        )}
        {!showDemo && matches.map((matchRecord, index) => (
          <button
            className={`profile-card ${selected?.key === matchRecord.key ? 'selected' : ''}`}
            key={matchRecord.key}
            onClick={() => onSelect(matchRecord)}
          >
            <span className="avatar locked-avatar" />
            <span>
              <strong>{matchRecord.bothRevealed && matchRecord.profile ? matchRecord.profile.displayName : `Encrypted candidate ${index + 1}`}</strong>
              <small>
                {matchRecord.bothRevealed && matchRecord.profile
                  ? matchRecord.profile.xHandle
                  : `${matchRecord.other.slice(0, 6)}...${matchRecord.other.slice(-4)}`}
              </small>
            </span>
            <em>{matchRecord.bothRevealed ? 'revealed' : matchRecord.youRevealed ? 'pending' : 'candidate'}</em>
          </button>
        ))}
      </div>
      <div className="match-actions">
        <button className="secondary-action" disabled={isBusy} onClick={onRefresh}>
          <RefreshCw size={17} />
          Scan
        </button>
        <button className="primary-action" disabled={isBusy || !account || !selected || (selected.youRevealed && !selected.bothRevealed)} onClick={onReveal}>
          <Sparkles size={18} />
          {revealLabel}
        </button>
      </div>
      {!account && (
        <p className="helper-copy">Only sample cards are shown publicly. Your encrypted matches load after wallet connection.</p>
      )}
      {!hasContract && (
        <p className="helper-copy">
          Add the deployed contract address as <code>VITE_HOROSCOPE_MATCHER_ADDRESS</code> to switch from demo cards to
          live Fhenix matching.
        </p>
      )}
    </section>
  );
}

function ShareCardPanel({
  cardRef,
  self,
  other,
  selectedMatch,
  match,
  onExport,
}: {
  cardRef: React.RefObject<HTMLDivElement>;
  self: ProfileForm;
  other: PublicProfile | null;
  selectedMatch: MatchRecord | null;
  match: MatchResult | null;
  onExport: () => void;
}) {
  const visibleScore = match?.score ?? 0;
  const visibleTier = match ? (visibleScore >= 50 ? match.tier : 'Below Threshold') : 'No Match Yet';
  const visibleBadges = match?.badges ?? ['Encrypted', 'Pending Match'];
  const revealed = Boolean(match);
  const shareable = revealed && visibleScore >= 50;
  const otherName = revealed && other ? other.displayName : 'Locked candidate';
  const otherHandle = revealed && other ? other.xHandle : selectedMatch ? 'reveals after mutual consent' : 'waiting for scan';

  return (
    <section className="panel share-panel">
      <div className="panel-title">
        <Sparkles size={18} />
        <h2>Share Card</h2>
      </div>
      <div className={`share-card ${revealed ? 'unlocked' : 'locked'}`} ref={cardRef}>
        <div className="card-noise">ctHash::nakshatra::fhe.select::0xMATCH</div>
        <div className="vedic-ring" />
        <div className="card-header">
          <FhenixLogo />
          <span>Vedic x FHE</span>
        </div>
        <div className="match-names">
          <span>
            <strong>{revealed ? self.displayName : 'You'}</strong>
            <small>{revealed ? self.xHandle : 'sealed profile'}</small>
          </span>
          <span className="match-glyph">×</span>
          <span>
            <strong>{otherName}</strong>
            <small>{otherHandle}</small>
          </span>
        </div>
        <div className="score-orb">
          <strong>{revealed ? visibleScore : 0}%</strong>
          <span>{revealed ? visibleTier : 'No Reveal'}</span>
        </div>
        <div className="badge-row">
          {visibleBadges.map((badge) => (
            <span key={badge}>{badge}</span>
          ))}
        </div>
        <p>Birth charts encrypted with FHE. Only this compatibility score was revealed.</p>
      </div>
      <button className="primary-action" disabled={!shareable} onClick={onExport}>
        <Download size={18} />
        Export for X
      </button>
    </section>
  );
}
