import { BirthForm, ChartFeatures, MatchTier } from './types';

const signCount = 12;
const nakshatraCount = 27;
export const revealThreshold = 45;

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
  return hashString(location.trim().toLowerCase()) % 12;
}

function timezoneOffsetMinutes(timezone: string) {
  const normalized = timezone.trim();
  const upper = normalized.toUpperCase();
  const explicitOffset = upper.match(/^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/);

  if (explicitOffset) {
    const sign = explicitOffset[1] === '-' ? -1 : 1;
    const hours = Number(explicitOffset[2]) || 0;
    const minutes = Number(explicitOffset[3]) || 0;
    return sign * (hours * 60 + minutes);
  }

  const offsets: Record<string, number> = {
    'Asia/Kolkata': 330,
    'Asia/Calcutta': 330,
    'Asia/Dubai': 240,
    'Asia/Singapore': 480,
    'Asia/Tokyo': 540,
    'Asia/Bangkok': 420,
    'Asia/Hong_Kong': 480,
    'Europe/London': 0,
    'Europe/Paris': 60,
    'Europe/Berlin': 60,
    'Europe/Madrid': 60,
    'America/New_York': -300,
    'America/Chicago': -360,
    'America/Denver': -420,
    'America/Los_Angeles': -480,
    'America/Toronto': -300,
    'Australia/Sydney': 600,
    'Africa/Johannesburg': 120,
  };

  return offsets[normalized] ?? 0;
}

function locationRegion(location: string) {
  const normalized = location.toLowerCase();

  if (/(india|mumbai|delhi|bangalore|bengaluru|kolkata|chennai|pune|hyderabad)/.test(normalized)) return 0;
  if (/(singapore|tokyo|japan|bangkok|thailand|hong kong|china|seoul|korea)/.test(normalized)) return 1;
  if (/(dubai|uae|qatar|doha|saudi|riyadh|kuwait|oman|bahrain)/.test(normalized)) return 2;
  if (/(london|paris|berlin|madrid|rome|europe|uk|france|germany|italy|spain)/.test(normalized)) return 3;
  if (/(new york|los angeles|chicago|toronto|america|usa|canada|vancouver|san francisco)/.test(normalized)) return 4;
  if (/(sydney|melbourne|australia|auckland|new zealand)/.test(normalized)) return 5;
  if (/(cape town|johannesburg|africa|nairobi|lagos|cairo)/.test(normalized)) return 6;

  return locationBucket(location) % 7;
}

export function deriveChartFeatures(birth: BirthForm): ChartFeatures {
  const [year, month, day] = birth.date.split('-').map((part) => Number(part) || 0);
  const [hour, minute] = birth.time.split(':').map((part) => Number(part) || 0);
  const regionBand = locationRegion(birth.location);
  const offsetMinutes = timezoneOffsetMinutes(birth.timezone);
  const timeBand = Math.floor(hour / 2);
  const minuteBand = Math.floor(minute / 20);
  const timezoneBand = wrap(Math.floor(offsetMinutes / 180), 4);

  const solarBase = wrap(month - 1, signCount);
  const lunarBase = wrap(day + timeBand, signCount);
  const ascBase = wrap(Math.floor(hour / 3) + minuteBand + regionBand, signCount);
  const nakshatra = wrap(day + Math.floor(hour / 3) + regionBand, nakshatraCount);
  const moonHarmonyGroup = wrap(lunarBase + Math.floor(nakshatra / 9), 4);
  const temperamentGroup = nakshatra % 3;
  const bhakootGroup = wrap(lunarBase + solarBase, 4);
  const yoniGroup = nakshatra % 4;
  const timeChemistryGroup = wrap(Math.floor(hour / 6) + timezoneBand, 6);

  return {
    moonSign: lunarBase,
    nakshatra,
    ascSign: ascBase,
    sunSign: solarBase,
    venusSign: wrap(solarBase + 1 + (month % 2), signCount),
    marsSign: wrap(lunarBase + 5 + Math.floor(day / 15), signCount),
    jupiterSign: moonHarmonyGroup,
    saturnSign: temperamentGroup,
    seventhHouseSign: bhakootGroup,
    venusHouse: yoniGroup + 1,
    marsHouse: timeChemistryGroup + 1,
  };
}

export function getTier(score: number): MatchTier {
  if (score >= 90) return 'Cosmic Match';
  if (score >= 75) return 'Rare Match';
  if (score >= revealThreshold) return 'Strong Match';
  return 'No Reveal';
}

export function getBadges(score: number) {
  if (score >= 90) return ['Emotional Sync', 'Chemistry Signal', 'House Alignment'];
  if (score >= 75) return ['Emotional Sync', 'House Alignment'];
  if (score >= revealThreshold) return ['Chemistry Signal', 'Encrypted Match'];
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
