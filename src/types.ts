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
  exists: boolean;
  hasChart: boolean;
};

export type MatchTier = 'No Reveal' | 'Strong Match' | 'Rare Match' | 'Cosmic Match';

export type MatchResult = {
  score: number;
  tier: MatchTier;
  badges: string[];
};
