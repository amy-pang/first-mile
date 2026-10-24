/**
 * Pre-aggregated Cambridge crash statistics.
 * Source: data/cambridge-crashes/data.csv (17,230 records)
 * Coordinates available for 8,877 rows; cyclist/pedestrian flags on all rows.
 */
export const CRASH_STATS = {
  totalCrashes: 17230,
  cyclistCrashes: 1939,
  pedestrianCrashes: 1169,
  /** Cyclist or pedestrian crashes that occurred in dark, dusk, or dawn conditions. */
  darkCyclistPed: 568,
  cyclistPct: 11.3,
  pedestrianPct: 6.8,
  /** % of cyclist+ped crashes that happen in low-light conditions. */
  darkPct: 18.3,
  /** Hour (0–23) with the highest number of cyclist-involved crashes. */
  peakCyclistHour: 18,
} as const;
