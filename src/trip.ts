export type Traffic = 'rush' | 'moderate' | 'light';
export type Phase = 'day' | 'dawn' | 'dusk' | 'night';
export type Weather = 'clear' | 'rain';

export interface Trip {
  /** Minutes after midnight. */
  leave: number;
  arrive: number;
  phase: Phase;
}

export const TRAFFIC_LABEL: Record<Traffic, string> = {
  rush: 'Rush hour traffic',
  moderate: 'Moderate traffic',
  light: 'Light traffic',
};

export const WEATHER_LABEL: Record<Weather, string> = {
  clear: 'Dry roads',
  rain: 'Rain, wipers on',
};

export const PHASE_LABEL: Record<Phase, string> = {
  day: 'Daylight',
  dawn: 'Sunrise',
  dusk: 'Sunset',
  night: 'Dark, headlights on',
};

/** "08:30" → 510. Returns null for anything unparseable. */
export function parseT(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 510 → "8:30 AM". */
export function fmtT(min: number): string {
  const m0 = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m0 / 60);
  const m = m0 % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * Rough weekday conditions for late-October Boston.
 * Rush hour 7:00–9:30 and 16:00–18:30; sunrise around 7:15, sunset around 17:50.
 */
export function conditionsFor(min: number): { traffic: Traffic; phase: Phase } {
  const traffic: Traffic =
    (min >= 420 && min < 570) || (min >= 960 && min < 1110) ? 'rush' : min >= 360 && min < 1260 ? 'moderate' : 'light';
  const phase: Phase = min < 390 || min >= 1110 ? 'night' : min < 450 ? 'dawn' : min >= 1050 ? 'dusk' : 'day';
  return { traffic, phase };
}
