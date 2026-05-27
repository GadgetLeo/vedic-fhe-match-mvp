import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, LockKeyhole, RefreshCw, Search, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { toPng } from 'html-to-image';
import { getAddress, isAddress } from 'viem';
import {
  connectWallet,
  computeAndDecryptMatch,
  CONTRACT_ADDRESS,
  encryptAndSaveProfile,
  fetchMatchedProfilesForWallet,
  fetchProfileByAddress,
} from './contract';
import { deriveChartFeatures, getBadges, getTier, nakshatraNames, signNames } from './chart';
import { BirthForm, MatchResult, ProfileForm, PublicProfile } from './types';

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
  const [profiles, setProfiles] = useState<PublicProfile[]>(demoProfiles);
  const [selectedProfile, setSelectedProfile] = useState<PublicProfile | null>(demoProfiles[0]);
  const [partnerAddress, setPartnerAddress] = useState('');
  const [status, setStatus] = useState('Ready to seal your chart');
  const [isBusy, setIsBusy] = useState(false);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const chart = useMemo(() => deriveChartFeatures(birth), [birth]);
  const hasContract = Boolean(CONTRACT_ADDRESS);

  useEffect(() => {
    if (!account) {
      setProfiles(demoProfiles);
      setSelectedProfile(demoProfiles[0]);
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
      await refreshProfiles(address);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Wallet connection failed');
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSave() {
    setIsBusy(true);
    setMatch(null);
    try {
      await encryptAndSaveProfile(profile, chart, setStatus);
      setStatus('Encrypted chart stored');
      await refreshProfiles(account);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Encrypted profile failed');
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshProfiles(viewer: `0x${string}` | null = account) {
    if (!viewer) {
      setProfiles(demoProfiles);
      setSelectedProfile(demoProfiles[0]);
      setStatus('Demo matches visible until a wallet connects');
      return;
    }

    setStatus('Refreshing your private match list');
    try {
      const liveProfiles = await fetchMatchedProfilesForWallet(viewer);
      setProfiles(liveProfiles);
      setSelectedProfile(liveProfiles[0] ?? null);
      setStatus(liveProfiles.length > 0 ? 'Your private matches loaded' : 'No private matches for this wallet yet');
    } catch (error) {
      setProfiles([]);
      setSelectedProfile(null);
      setStatus(error instanceof Error ? error.message : 'Could not load private matches');
    }
  }

  async function runMatch() {
    if (!account) {
      setStatus('Connect wallet first');
      return;
    }
    const directAddress = partnerAddress.trim();
    const otherAddress = selectedProfile?.address ?? (isAddress(directAddress) ? (getAddress(directAddress) as `0x${string}`) : null);
    if (!otherAddress) {
      setStatus('Choose a private match or paste a partner wallet');
      return;
    }
    if (otherAddress.toLowerCase() === account.toLowerCase()) {
      setStatus('Use a different wallet for matching');
      return;
    }

    setIsBusy(true);
    setMatch(null);
    try {
      const partnerProfile = selectedProfile?.address.toLowerCase() === otherAddress.toLowerCase()
        ? selectedProfile
        : await fetchProfileByAddress(otherAddress);
      if (!partnerProfile?.hasChart) {
        throw new Error('That wallet has no sealed profile yet');
      }
      setSelectedProfile(partnerProfile);
      const score = await computeAndDecryptMatch(partnerProfile.address, account, setStatus);
      setMatch({ score, tier: getTier(score), badges: getBadges(score) });
      setStatus(score >= 70 ? 'Match revealed' : 'Private score below reveal threshold');
      await refreshProfiles(account);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Private synastry failed');
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
          <span>FHE.select(score &gt;= 70)</span>
          <span>nakshatra.signal.locked</span>
        </div>
      </section>

      <section className="workspace-grid">
        <ProfilePanel
          profile={profile}
          birth={birth}
          chart={chart}
          isBusy={isBusy}
          onProfileChange={setProfile}
          onBirthChange={setBirth}
          onSave={handleSave}
        />

        <MatchPanel
          account={account}
          profiles={profiles}
          selected={selectedProfile}
          partnerAddress={partnerAddress}
          isBusy={isBusy}
          status={status}
          hasContract={hasContract}
          onRefresh={refreshProfiles}
          onPartnerAddressChange={setPartnerAddress}
          onSelect={setSelectedProfile}
          onRunMatch={runMatch}
        />

        <ShareCardPanel
          cardRef={cardRef}
          self={profile}
          other={selectedProfile ?? demoProfiles[0]}
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
  isBusy,
  onProfileChange,
  onBirthChange,
  onSave,
}: {
  profile: ProfileForm;
  birth: BirthForm;
  chart: ReturnType<typeof deriveChartFeatures>;
  isBusy: boolean;
  onProfileChange: (profile: ProfileForm) => void;
  onBirthChange: (birth: BirthForm) => void;
  onSave: () => void;
}) {
  return (
    <section className="panel profile-panel">
      <div className="panel-title">
        <LockKeyhole size={18} />
        <h2>Seal Profile</h2>
      </div>
      <div className="form-grid">
        <label>
          Display name
          <input value={profile.displayName} onChange={(event) => onProfileChange({ ...profile, displayName: event.target.value })} />
        </label>
        <label>
          X handle
          <input value={profile.xHandle} onChange={(event) => onProfileChange({ ...profile, xHandle: event.target.value })} />
        </label>
        <label>
          Aura color
          <input
            type="color"
            value={profile.avatarColor}
            onChange={(event) => onProfileChange({ ...profile, avatarColor: event.target.value })}
          />
        </label>
        <label>
          Birth date
          <input type="date" value={birth.date} onChange={(event) => onBirthChange({ ...birth, date: event.target.value })} />
        </label>
        <label>
          Birth time
          <input type="time" value={birth.time} onChange={(event) => onBirthChange({ ...birth, time: event.target.value })} />
        </label>
        <label>
          Birth city / country
          <input value={birth.location} onChange={(event) => onBirthChange({ ...birth, location: event.target.value })} />
        </label>
        <label className="span-two">
          Timezone
          <input value={birth.timezone} onChange={(event) => onBirthChange({ ...birth, timezone: event.target.value })} />
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

      <button className="primary-action" disabled={isBusy} onClick={onSave}>
        <ShieldCheck size={18} />
        Encrypt chart & store profile
      </button>
    </section>
  );
}

function MatchPanel({
  account,
  profiles,
  selected,
  partnerAddress,
  isBusy,
  status,
  hasContract,
  onRefresh,
  onPartnerAddressChange,
  onSelect,
  onRunMatch,
}: {
  account: `0x${string}` | null;
  profiles: PublicProfile[];
  selected: PublicProfile | null;
  partnerAddress: string;
  isBusy: boolean;
  status: string;
  hasContract: boolean;
  onRefresh: () => void;
  onPartnerAddressChange: (address: string) => void;
  onSelect: (profile: PublicProfile | null) => void;
  onRunMatch: () => void;
}) {
  const showDemo = !account;

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
      {account && (
        <label className="partner-address">
          Partner wallet
          <input
            value={partnerAddress}
            onChange={(event) => {
              onPartnerAddressChange(event.target.value);
              onSelect(null);
            }}
            placeholder="0x..."
          />
        </label>
      )}
      <div className="profile-list">
        {profiles.length === 0 && (
          <div className="empty-private-list">
            {showDemo ? 'Demo cards only. Connect to load your private match list.' : 'No private matches found for this wallet yet.'}
          </div>
        )}
        {profiles.map((publicProfile) => (
          <button
            className={`profile-card ${selected?.address === publicProfile.address ? 'selected' : ''}`}
            key={publicProfile.address}
            onClick={() => {
              onPartnerAddressChange(publicProfile.address);
              onSelect(publicProfile);
            }}
          >
            <span className="avatar" style={{ background: publicProfile.avatarColor }} />
            <span>
              <strong>{publicProfile.displayName}</strong>
              <small>{publicProfile.xHandle}</small>
            </span>
            <em>{publicProfile.hasChart ? 'sealed' : 'open'}</em>
          </button>
        ))}
      </div>
      <div className="match-actions">
        <button className="secondary-action" disabled={isBusy} onClick={onRefresh}>
          <RefreshCw size={17} />
          Refresh
        </button>
        <button className="primary-action" disabled={isBusy || !account} onClick={onRunMatch}>
          <Sparkles size={18} />
          Run match
        </button>
      </div>
      {!account && (
        <p className="helper-copy">Only sample cards are shown publicly. Wallet-specific matches load after connection.</p>
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
  match,
  onExport,
}: {
  cardRef: React.RefObject<HTMLDivElement>;
  self: ProfileForm;
  other: PublicProfile;
  match: MatchResult | null;
  onExport: () => void;
}) {
  const visibleScore = match?.score ?? 0;
  const visibleTier = match?.tier ?? 'No Match Yet';
  const visibleBadges = match?.badges ?? ['Encrypted', 'Pending Match'];
  const unlocked = Boolean(match && visibleScore >= 70);

  return (
    <section className="panel share-panel">
      <div className="panel-title">
        <Sparkles size={18} />
        <h2>Share Card</h2>
      </div>
      <div className={`share-card ${unlocked ? 'unlocked' : 'locked'}`} ref={cardRef}>
        <div className="card-noise">ctHash::nakshatra::fhe.select::0xMATCH</div>
        <div className="vedic-ring" />
        <div className="card-header">
          <FhenixLogo />
          <span>Vedic x FHE</span>
        </div>
        <div className="match-names">
          <span>
            <strong>{self.displayName}</strong>
            <small>{self.xHandle}</small>
          </span>
          <span className="match-glyph">×</span>
          <span>
            <strong>{other.displayName}</strong>
            <small>{other.xHandle}</small>
          </span>
        </div>
        <div className="score-orb">
          <strong>{unlocked ? visibleScore : 0}%</strong>
          <span>{unlocked ? visibleTier : 'No Reveal'}</span>
        </div>
        <div className="badge-row">
          {visibleBadges.map((badge) => (
            <span key={badge}>{badge}</span>
          ))}
        </div>
        <p>Birth charts encrypted with FHE. Only this match score was revealed.</p>
      </div>
      <button className="primary-action" onClick={onExport}>
        <Download size={18} />
        Export for X
      </button>
    </section>
  );
}
