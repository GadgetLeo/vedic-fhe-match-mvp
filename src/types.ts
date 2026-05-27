export type BirthForm = {
  date: string;
  time: string;
  location: string;
  timezone: string;
};

export type ProfileForm = {
  displayName: string;
  xHandle: string;
  avatarColor: string;
};

export type ChartFeatures = {
  moonSign: number;
  nakshatra: number;
  ascSign: number;
  sunSign: number;
  venusSign: number;
  marsSign: number;
  jupiterSign: number;
  saturnSign: number;
  seventhHouseSign: number;
  venusHouse: number;
  marsHouse: number;
};

export type PublicProfile = {
  address: `0x${string}`;
  displayName: string;
  xHandle: string;
  avatarColor: string;
  createdAt: bigint;
  version?: bigint;
  exists: boolean;
  hasChart: boolean;
};

export type MatchRecord = {
  key: `0x${string}`;
  userA: `0x${string}`;
  userB: `0x${string}`;
  other: `0x${string}`;
  computedAt: bigint;
  profileVersionA: bigint;
  profileVersionB: bigint;
  computed: boolean;
  revealA: boolean;
  revealB: boolean;
  youRevealed: boolean;
  otherRevealed: boolean;
  bothRevealed: boolean;
  profile?: PublicProfile;
};

export type MatchTier = 'No Reveal' | 'Strong Match' | 'Rare Match' | 'Cosmic Match';

export type MatchResult = {
  score: number;
  tier: MatchTier;
  badges: string[];
};
