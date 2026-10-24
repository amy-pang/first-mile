/**
 * Hourly pedestrian/cyclist activity multipliers derived from the Cambridge
 * Broadway Eco-Totem bicycle counter (2024 weekday data).
 * Index = hour 0–23. Value 1.0 = midday baseline (11:00 AM).
 * Source: data/cambridge-broadway-bicycle/data.csv
 */
export const BIKE_HOUR_MULT: readonly number[] = [
  0.10, 0.05, 0.04, 0.01, 0.04, 0.22, // 00-05
  0.71, 1.76, 3.95, 2.68, 1.22, 1.00, // 06-11
  1.06, 0.98, 1.08, 1.34, 2.31, 4.03, // 12-17
  2.74, 1.49, 0.88, 0.61, 0.45, 0.27, // 18-23
];

/**
 * Returns a [lo, hi] pedestrian spawn interval in seconds for the given
 * minute-of-day in simulation time. Base interval (mult=1.0) is 7 seconds;
 * at peak hours (mult≈4.0) it drops to ~1.75 s for very dense activity.
 * Uses weekday profile only (weekend peaks are roughly 3× lower).
 */
export function pedSpawnInterval(minuteOfDay: number): [number, number] {
  const mult = BIKE_HOUR_MULT[Math.floor(minuteOfDay / 60) % 24];
  const base = 7;
  const lo = Math.max(1.5, base / mult);
  const hi = Math.max(2.5, lo * 1.6);
  return [lo, hi];
}

/**
 * Returns the cyclist activity multiplier (relative to midday) for the given
 * minute-of-day. Used to annotate trip conditions in the UI.
 */
export function bikeMultiplierAt(minuteOfDay: number): number {
  return BIKE_HOUR_MULT[Math.floor(minuteOfDay / 60) % 24];
}
