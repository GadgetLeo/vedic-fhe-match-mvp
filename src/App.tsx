import { CSSProperties, PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Download, HeartHandshake, LockKeyhole, RefreshCw, Search, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { toPng } from 'html-to-image';
import {
  connectWallet,
  CONTRACT_ADDRESS,
  decryptRevealedMatch,
  encryptAndSaveProfile,
  fetchMatchRecordsForWallet,
  fetchProfileByAddress,
  fetchProfileCount,
  requestMatchReveal,
  scanAndComputeMatchesForWallet,
  waitForProfileByAddress,
} from './contract';
import { deriveChartFeatures, getBadges, getTier, nakshatraNames, revealThreshold, signNames } from './chart';
import { BirthForm, MatchRecord, MatchResult, ProfileForm, PublicProfile } from './types';

const initialProfile: ProfileForm = {
  displayName: 'Anika',
  xHandle: '@anika_moon',
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

const zodiacLabels = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];

function timeToMinutes(time: string) {
  const [hours, minutes] = time.split(':').map((value) => Number(value) || 0);
  return Math.min(1439, Math.max(0, hours * 60 + minutes));
}

function minutesToTime(totalMinutes: number) {
  const normalizedMinutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function angleDistance(firstAngle: number, secondAngle: number) {
  const difference = Math.abs(firstAngle - secondAngle) % 360;
  return Math.min(difference, 360 - difference);
}

export function App() {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [profile, setProfile] = useState(initialProfile);
  const [birth, setBirth] = useState(initialBirth);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<MatchRecord | null>(null);
  const [sealedProfile, setSealedProfile] = useState<PublicProfile | null>(null);
  const [status, setStatus] = useState('Ready to seal your chart');
  const [profileCount, setProfileCount] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const chart = useMemo(() => deriveChartFeatures(birth), [birth]);
  const hasContract = Boolean(CONTRACT_ADDRESS);

  useEffect(() => {
    void refreshProfileCount();
  }, []);

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
      const sealed = await waitForProfileByAddress(account, setStatus);
      applySealedProfile(sealed);
      setStatus('Profile sealed on-chain. Automatic matching can now scan your profile.');
      await refreshProfileCount();
      await refreshMatches(account, true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Encrypted profile failed');
    } finally {
      setIsBusy(false);
    }
  }

  async function loadSealedProfile(viewer: `0x${string}`) {
    const existingProfile = await fetchProfileByAddress(viewer);
    applySealedProfile(existingProfile);
    return existingProfile;
  }

  function applySealedProfile(existingProfile: PublicProfile | null) {
    setSealedProfile(existingProfile);
    if (existingProfile) {
      setProfile({
        displayName: existingProfile.displayName,
        xHandle: existingProfile.xHandle,
        avatarColor: existingProfile.avatarColor,
      });
    }
  }

  async function refreshProfileCount() {
    try {
      const count = await fetchProfileCount();
      setProfileCount(count);
    } catch {
      setProfileCount(null);
    }
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
          : shouldScan
            ? 'Profile sealed. No other sealed profiles ready to match yet'
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
      setStatus(score >= revealThreshold ? 'Match card revealed' : 'Candidate did not clear the match threshold');
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
          <p className="eyebrow">Vedic matchmaking, made simple</p>
          <h1>Meet someone your stars already recognize.</h1>
          <p className="hero-copy">
            Add your birth details once and let the app look for chart chemistry in the background. When there is a
            promising connection, you can open a match card and reveal the score together.
          </p>
          <div className="hero-points" aria-label="App highlights">
            <span>Birth details in</span>
            <span>Compatible people out</span>
            <span>Reveal when it feels right</span>
          </div>
        </div>
        <HeroOrbitPreview />
      </section>

      <section className="workspace-grid">
        <ProfilePanel
          profile={profile}
          birth={birth}
          chart={chart}
          account={account}
          sealedProfile={sealedProfile}
          profileCount={profileCount}
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

      <HowToSection />

      <footer className="app-footer">
        <FhenixLogo />
        <span>Built with Fhenix CoFHE on Base Sepolia</span>
      </footer>
    </main>
  );
}

function HowToSection() {
  return (
    <section className="how-to-section" aria-labelledby="how-to-title">
      <div>
        <p className="eyebrow">Quick start</p>
        <h2 id="how-to-title">How to use MoonMatch on Base Sepolia</h2>
      </div>
      <ol className="how-to-list">
        <li>
          <strong>Get test ETH</strong>
          <span>
            Open the official{' '}
            <a href="https://docs.base.org/base-chain/tools/network-faucets" target="_blank" rel="noreferrer">
              Base Sepolia faucet list
            </a>
            , choose a faucet, and send test ETH to your wallet.
          </span>
        </li>
        <li>
          <strong>Connect on Base Sepolia</strong>
          <span>Use the Connect button. Your wallet should switch to Base Sepolia before you sign transactions.</span>
        </li>
        <li>
          <strong>Seal your chart</strong>
          <span>Enter your birth details, adjust the natal chart dial if needed, then seal your profile on-chain.</span>
        </li>
        <li>
          <strong>Scan and reveal</strong>
          <span>Scan for sealed profiles, then reveal a match card when both people are ready.</span>
        </li>
      </ol>
    </section>
  );
}

function HeroOrbitPreview() {
  return (
    <div className="hero-preview hero-orbit-preview" aria-label="Match preview">
      <div className="orbit-name orbit-name-left">
        <span>A</span>
        <strong>Anika</strong>
      </div>
      <div className="orbit-name orbit-name-right">
        <span>R</span>
        <strong>Riya</strong>
      </div>
      <div className="orbit-art" aria-hidden="true">
        <span className="orbit-ring orbit-ring-one" />
        <span className="orbit-ring orbit-ring-two" />
        <span className="orbit-ring orbit-ring-three" />
        <span className="orbit-streak orbit-streak-one" />
        <span className="orbit-streak orbit-streak-two" />
        <span className="orbit-planet orbit-planet-one" />
        <span className="orbit-planet orbit-planet-two" />
        <span className="orbit-planet orbit-planet-three" />
        <span className="orbit-moon" />
        <span className="orbit-sun" />
        <span className="orbit-zodiac orbit-zodiac-top">☾</span>
        <span className="orbit-zodiac orbit-zodiac-right">♌</span>
        <span className="orbit-zodiac orbit-zodiac-bottom">♓</span>
        <span className="orbit-zodiac orbit-zodiac-left">♉</span>
      </div>
      <div className="orbit-caption">
        <Sparkles size={18} />
        <span>
          <strong>Chart chemistry found</strong>
          <small>Reveal together to open the match score.</small>
        </span>
      </div>
    </div>
  );
}

function Header({ account, isBusy, onConnect }: { account: string | null; isBusy: boolean; onConnect: () => void }) {
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <Sparkles size={18} />
        </div>
        <div>
          <strong>MoonMatch</strong>
          <span>horoscope matching</span>
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
  profileCount,
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
  profileCount: number | null;
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

      <BirthChartDial birth={birth} chart={chart} disabled={controlsDisabled} onBirthChange={onBirthChange} />

      <button className="primary-action" disabled={isBusy || hasSealedProfile} onClick={onSave}>
        <ShieldCheck size={18} />
        {actionLabel}
      </button>
      <div className="profile-count-live" aria-live="polite">
        <span className="live-pulse" />
        <strong>Profiles Sealed: {profileCount ?? '...'}</strong>
      </div>
    </section>
  );
}

function BirthChartDial({
  birth,
  chart,
  disabled,
  onBirthChange,
}: {
  birth: BirthForm;
  chart: ReturnType<typeof deriveChartFeatures>;
  disabled: boolean;
  onBirthChange: (birth: BirthForm) => void;
}) {
  const minuteOfDay = timeToMinutes(birth.time);
  const timeAngle = (minuteOfDay / 1440) * 360;
  const moonAngle = chart.moonSign * 30 + 15;
  const ascAngle = chart.ascSign * 30 + 15;
  const sunAngle = chart.sunSign * 30 + 15;
  const ascMarkerAngle = angleDistance(ascAngle, sunAngle) < 22 ? ascAngle - 8 : ascAngle;
  const sunMarkerAngle = angleDistance(ascAngle, sunAngle) < 22 ? sunAngle + 8 : sunAngle;
  const dialStyle = {
    '--time-angle': `${timeAngle}deg`,
    '--moon-angle': `${moonAngle}deg`,
    '--asc-angle': `${ascMarkerAngle}deg`,
    '--sun-angle': `${sunMarkerAngle}deg`,
  } as CSSProperties;

  function updateTimeFromPointer(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    const degrees = (angle * 180) / Math.PI + 90;
    const normalizedDegrees = (degrees + 360) % 360;
    onBirthChange({ ...birth, time: minutesToTime((normalizedDegrees / 360) * 1440) });
  }

  function nudgeTime(minutes: number) {
    if (disabled) return;
    onBirthChange({ ...birth, time: minutesToTime(minuteOfDay + minutes) });
  }

  return (
    <div className="birth-chart-builder">
      <div className="chart-preview">
        <div>
          <span>Personality</span>
          <strong>{signNames[chart.ascSign]}</strong>
          <small>Rising sign</small>
        </div>
        <div>
          <span>Inner self</span>
          <strong>{signNames[chart.moonSign]}</strong>
          <small>Moon sign</small>
        </div>
        <div>
          <span>Outer self</span>
          <strong>{signNames[chart.sunSign]}</strong>
          <small>Sun sign</small>
        </div>
      </div>

      <div className="dial-heading">
        <span>Natal chart dial</span>
        <small>Drag the glowing marker to tune birth time, or use the time field above.</small>
      </div>

      <div
        className={`birth-dial ${disabled ? 'disabled' : ''}`}
        style={dialStyle}
        role="slider"
        aria-label="Birth time dial"
        aria-valuemin={0}
        aria-valuemax={1439}
        aria-valuenow={minuteOfDay}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateTimeFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) updateTimeFromPointer(event);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            nudgeTime(-10);
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            nudgeTime(10);
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            nudgeTime(60);
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            nudgeTime(-60);
          }
        }}
      >
        {zodiacLabels.map((label, index) => (
          <span
            className="zodiac-label"
            key={label}
            style={{ '--sign-angle': `${index * 30 + 15}deg` } as CSSProperties}
          >
            {label.slice(0, 3)}
          </span>
        ))}
        <span className="dial-marker moon-marker">Moon</span>
        <span className="dial-marker asc-marker">Asc</span>
        <span className="dial-marker sun-marker">Sun</span>
        <span className="time-hand" />
        <span className="dial-core">
          <strong>{birth.time}</strong>
          <small>{birth.date}</small>
          <em>{nakshatraNames[chart.nakshatra]}</em>
        </span>
      </div>
      <div className="dial-legend" aria-label="Chart marker legend">
        <span><i className="legend-dot moon-dot" />Moon</span>
        <span><i className="legend-dot asc-dot" />Rising</span>
        <span><i className="legend-dot sun-dot" />Sun</span>
      </div>
    </div>
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
          live matching.
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
  const visibleTier = match ? (visibleScore >= revealThreshold ? match.tier : 'Below Threshold') : 'No Match Yet';
  const visibleBadges = match?.badges ?? ['Encrypted', 'Pending Match'];
  const revealed = Boolean(match);
  const shareable = revealed && visibleScore >= revealThreshold;
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
