import { BirthForm, ChartFeatures, MatchTier } from './types';

const signCount = 12;
const nakshatraCount = 27;

function hashString(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function wrap(value: number, size: number) {
  return ((value % size) + size) % size;
}

function locationBucket(location: string) {
  return hashString(location.trim().toLowerCase()) % 3;
}

export function deriveChartFeatures(birth: BirthForm): ChartFeatures {
  const [year, month, day] = birth.date.split('-').map((part) => Number(part) || 0);
  const [hour, minute] = birth.time.split(':').map((part) => Number(part) || 0);
  const placeBand = locationBucket(birth.location);
  const timeBand = Math.floor(hour / 2);
  const minuteBand = Math.floor(minute / 20);

  const solarBase = wrap(month - 1, signCount);
  const lunarBase = wrap(day + timeBand, signCount);
  const ascBase = wrap(timeBand + minuteBand + placeBand, signCount);

  return {
    moonSign: lunarBase,
    nakshatra: wrap(day + Math.floor(hour / 3), nakshatraCount),
    ascSign: ascBase,
    sunSign: solarBase,
    venusSign: wrap(solarBase + 1 + (month % 2), signCount),
    marsSign: wrap(lunarBase + 5 + Math.floor(day / 15), signCount),
    jupiterSign: wrap(year + month, signCount),
    saturnSign: wrap(Math.floor(year / 2) + month, signCount),
    seventhHouseSign: wrap(ascBase + 6, signCount),
    venusHouse: wrap(month + timeBand, signCount) + 1,
    marsHouse: wrap(day + minuteBand, signCount) + 1,
  };
}

export function getTier(score: number): MatchTier {
  if (score >= 90) return 'Cosmic Match';
  if (score >= 75) return 'Rare Match';
  if (score >= 50) return 'Strong Match';
  return 'No Reveal';
}

export function getBadges(score: number) {
  if (score >= 90) return ['Emotional Sync', 'Chemistry Signal', 'House Alignment'];
  if (score >= 75) return ['Emotional Sync', 'House Alignment'];
  if (score >= 50) return ['Chemistry Signal', 'Encrypted Match'];
  return ['Soft Signal', 'Private Result'];
}

export const signNames = [
  'Mesha',
  'Vrishabha',
  'Mithuna',
  'Karka',
  'Simha',
  'Kanya',
  'Tula',
  'Vrischika',
  'Dhanu',
  'Makara',
  'Kumbha',
  'Meena',
];

export const nakshatraNames = [
  'Ashwini',
  'Bharani',
  'Krittika',
  'Rohini',
  'Mrigashira',
  'Ardra',
  'Punarvasu',
  'Pushya',
  'Ashlesha',
  'Magha',
  'Purva Phalguni',
  'Uttara Phalguni',
  'Hasta',
  'Chitra',
  'Swati',
  'Vishakha',
  'Anuradha',
  'Jyeshtha',
  'Mula',
  'Purva Ashadha',
  'Uttara Ashadha',
  'Shravana',
  'Dhanishta',
  'Shatabhisha',
  'Purva Bhadrapada',
  'Uttara Bhadrapada',
  'Revati',
];
