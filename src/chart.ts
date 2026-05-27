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

export function deriveChartFeatures(birth: BirthForm): ChartFeatures {
  const seed = hashString(`${birth.date}|${birth.time}|${birth.location}|${birth.timezone}`);
  const [year, month, day] = birth.date.split('-').map((part) => Number(part) || 0);
  const [hour, minute] = birth.time.split(':').map((part) => Number(part) || 0);
  const locationSeed = hashString(birth.location.toLowerCase());
  const tzSeed = hashString(birth.timezone.toLowerCase());

  const solarBase = wrap(year + month * 3 + day + Math.floor(seed / 97), signCount);
  const lunarBase = wrap(day * 2 + hour + Math.floor(seed / 31), signCount);
  const ascBase = wrap(hour + Math.floor(minute / 10) + locationSeed, signCount);

  return {
    moonSign: lunarBase,
    nakshatra: wrap(day + hour + Math.floor(seed / 11), nakshatraCount),
    ascSign: ascBase,
    sunSign: solarBase,
    venusSign: wrap(solarBase + 2 + Math.floor(seed / 101), signCount),
    marsSign: wrap(lunarBase + 5 + Math.floor(seed / 211), signCount),
    jupiterSign: wrap(solarBase + 9 + Math.floor(tzSeed / 17), signCount),
    saturnSign: wrap(lunarBase + 10 + Math.floor(seed / 307), signCount),
    seventhHouseSign: wrap(ascBase + 6, signCount),
    venusHouse: wrap(month + hour + Math.floor(seed / 401), signCount) + 1,
    marsHouse: wrap(day + minute + Math.floor(seed / 503), signCount) + 1,
  };
}

export function getTier(score: number): MatchTier {
  if (score >= 95) return 'Cosmic Match';
  if (score >= 85) return 'Rare Match';
  if (score >= 70) return 'Strong Match';
  return 'No Reveal';
}

export function getBadges(score: number) {
  if (score >= 95) return ['Emotional Sync', 'Chemistry Signal', 'House Alignment'];
  if (score >= 85) return ['Emotional Sync', 'House Alignment'];
  if (score >= 70) return ['Chemistry Signal', 'Encrypted Match'];
  return ['Private Result'];
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
