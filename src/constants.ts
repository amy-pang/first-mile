/** World units are metres. The rotary is centred on the origin; +x is east, +y (three.js +z) is south. */

export interface Pt {
  x: number;
  y: number;
}

export interface Pose extends Pt {
  /** Heading in radians, measured from +x toward +y. */
  h: number;
}

export interface Road {
  /** Direction of the road's axis, pointing away from the rotary. */
  phi: number;
  town: string;
  route: string;
  /** True for a U.S. route (shield shape); false/undefined for a Massachusetts route (white square). */
  us?: boolean;
  /** Cardinal direction printed above the shield, when signed. */
  dir?: string;
}

export const RC = 24; // ring centreline radius
export const RH = 4; // half-width of the circulating roadway
export const LANE = 2; // lane centre offset from the road's centreline
export const RW = 4; // half-width of an approach road
export const R_IN = RC - RH;
export const R_OUT = RC + RH;
export const DY = R_OUT + 4; // yield line distance from centre
export const DCW = R_OUT + 8; // crosswalk distance from centre
export const DS = 190; // where approach paths start
export const DEND = 215; // where exit paths end

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;
/** Angular offset of the entry/exit points from each road axis. */
export const OFF = 18 * DEG;

export const MPHF = 2.237; // m/s → mph
export const LIMIT_RING = 22 / MPHF;
export const LIMIT_APP = 30 / MPHF;
/** Trip clock speed relative to real time. */
export const TIME_SCALE = 20;

/** Roads in counterclockwise order (as seen from above), so (i + 1) % 4 is the next exit after entering from i. */
export const ROADS: readonly Road[] = [
  { phi: Math.PI / 2, town: 'Allston', route: '20', us: true },
  { phi: 0, town: 'Cambridge', route: '2A' },
  { phi: -Math.PI / 2, town: 'Somerville', route: '16' },
  { phi: Math.PI, town: 'Arlington', route: '2', dir: 'WEST' },
];

export const ORD = ['1st', '2nd', '3rd'] as const;

export const AI_COLORS = ['#D9DDE1', '#7F8D9B', '#A23A3A', '#2F5D8C', '#59684F', '#C9C1B1', '#25292E', '#8B6D9C', '#E9EAEA'];
export const PED_COLORS = ['#D9573E', '#3E8FD9', '#E3BE3C', '#9E6FCB', '#56B07A'];
