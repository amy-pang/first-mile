/** Canvas artwork for every sign. Shared by the 3D world, the windshield pop-ups and the guide below the game. */
import { ROADS, TAU, type Road } from './constants';
import { tanAt } from './math';

type Ctx = CanvasRenderingContext2D;
type Painter = (g: Ctx, W: number, H: number) => void;

export interface SignSpec {
  /** Size in metres. */
  w: number;
  h: number;
  /** Outline path (used for the grey back of the sign). */
  shape: Painter;
  draw: Painter;
}

const INK = '#111111';
const WHITE = '#FFFFFF';
const YELLOW = '#F5C400';
const GREEN = '#00693E';
const RED = '#C8102E';

function rrPath(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const FONT = (weight: number, size: number): string => `${weight} ${Math.round(size)}px Overpass, "Arial Narrow", Arial, sans-serif`;
const rectShape: Painter = (g, W, H) => rrPath(g, 0, 0, W, H, Math.min(W, H) * 0.06);
const diamondShape: Painter = (g, W, H) => {
  g.beginPath();
  g.moveTo(W / 2, 0);
  g.lineTo(W, H / 2);
  g.lineTo(W / 2, H);
  g.lineTo(0, H / 2);
  g.closePath();
};
const yieldShape: Painter = (g, W, H) => {
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(W, 0);
  g.lineTo(W / 2, H);
  g.closePath();
};

function text(g: Ctx, t: string, x: number, y: number, font: string, color: string): void {
  g.font = font;
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(t, x, y);
}

function arrowHead(g: Ctx, x: number, y: number, ang: number, s: number): void {
  g.beginPath();
  g.moveTo(x + Math.cos(ang) * s, y + Math.sin(ang) * s);
  g.lineTo(x + Math.cos(ang + 2.4) * s, y + Math.sin(ang + 2.4) * s);
  g.lineTo(x + Math.cos(ang - 2.4) * s, y + Math.sin(ang - 2.4) * s);
  g.closePath();
  g.fill();
}

function maShield(g: Ctx, cx: number, cy: number, s: number, num: string): void {
  const w = num.length > 2 ? s * 1.25 : s;
  rrPath(g, cx - w / 2, cy - s / 2, w, s, s * 0.08);
  g.fillStyle = WHITE;
  g.fill();
  g.lineWidth = s * 0.07;
  g.strokeStyle = INK;
  rrPath(g, cx - w / 2 + s * 0.09, cy - s / 2 + s * 0.09, w - s * 0.18, s - s * 0.18, s * 0.05);
  g.stroke();
  text(g, num, cx, cy + s * 0.05, FONT(900, s * (num.length > 1 ? 0.5 : 0.62)), INK);
}

function usShield(g: Ctx, cx: number, cy: number, s: number, num: string): void {
  g.fillStyle = INK;
  g.fillRect(cx - s / 2, cy - s / 2, s, s);
  g.fillStyle = WHITE;
  g.beginPath();
  const t = cy - s * 0.42;
  g.moveTo(cx - s * 0.4, t);
  g.quadraticCurveTo(cx - s * 0.2, t + s * 0.08, cx, t);
  g.quadraticCurveTo(cx + s * 0.2, t + s * 0.08, cx + s * 0.4, t);
  g.quadraticCurveTo(cx + s * 0.46, cy + s * 0.15, cx, cy + s * 0.44);
  g.quadraticCurveTo(cx - s * 0.46, cy + s * 0.15, cx - s * 0.4, t);
  g.fill();
  text(g, num, cx, cy + s * 0.06, FONT(900, s * 0.42), INK);
}

function shield(g: Ctx, cx: number, cy: number, s: number, r: Road): void {
  if (r.us) usShield(g, cx, cy, s, r.route);
  else maShield(g, cx, cy, s, r.route);
}

function pedGlyph(g: Ctx, cx: number, cy: number, s: number, color: string): void {
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = s * 0.13;
  g.beginPath();
  g.arc(cx + s * 0.06, cy - s * 0.4, s * 0.11, 0, TAU);
  g.fill();
  g.beginPath();
  g.moveTo(cx + s * 0.02, cy - s * 0.24);
  g.lineTo(cx - s * 0.05, cy + s * 0.1);
  g.stroke();
  g.beginPath();
  g.moveTo(cx - s * 0.24, cy - s * 0.04);
  g.lineTo(cx + s * 0.01, cy - s * 0.2);
  g.lineTo(cx + s * 0.25, cy - s * 0.02);
  g.stroke();
  g.beginPath();
  g.moveTo(cx - s * 0.28, cy + s * 0.46);
  g.lineTo(cx - s * 0.05, cy + s * 0.1);
  g.lineTo(cx + s * 0.22, cy + s * 0.46);
  g.stroke();
}

function yellowDiamond(g: Ctx, W: number, H: number): void {
  diamondShape(g, W, H);
  g.fillStyle = YELLOW;
  g.fill();
  g.save();
  g.translate(W / 2, H / 2);
  g.scale(0.9, 0.9);
  g.translate(-W / 2, -H / 2);
  diamondShape(g, W, H);
  g.restore();
  g.lineWidth = W * 0.025;
  g.strokeStyle = INK;
  g.stroke();
}

function bordered(g: Ctx, W: number, H: number, fill: string, stroke: string, inset: number, lw: number): void {
  rectShape(g, W, H);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = lw;
  g.strokeStyle = stroke;
  rrPath(g, inset, inset, W - inset * 2, H - inset * 2, inset);
  g.stroke();
}

export const SIGNS = {
  speed: (n: number): SignSpec => ({
    w: 1.1,
    h: 1.35,
    shape: rectShape,
    draw(g, W, H) {
      bordered(g, W, H, WHITE, INK, W * 0.05, W * 0.035);
      text(g, 'SPEED', W / 2, H * 0.19, FONT(800, W * 0.2), INK);
      text(g, 'LIMIT', W / 2, H * 0.37, FONT(800, W * 0.2), INK);
      text(g, String(n), W / 2, H * 0.7, FONT(900, W * 0.48), INK);
    },
  }),

  plaque: (lines: string[], bg: string, w: number, h: number): SignSpec => ({
    w,
    h,
    shape: rectShape,
    draw(g, W, H) {
      bordered(g, W, H, bg, INK, H * 0.07, H * 0.06);
      const n = lines.length;
      const fs = H * (n > 1 ? 0.3 : 0.5);
      lines.forEach((t, k) => text(g, t, W / 2, H * ((k + 1) / (n + 1)) + H * 0.03, FONT(800, fs), INK));
    },
  }),

  rotaryWarn: (): SignSpec => ({
    w: 1.5,
    h: 1.5,
    shape: diamondShape,
    draw(g, W, H) {
      yellowDiamond(g, W, H);
      const cx = W / 2;
      const cy = H / 2;
      const r = W * 0.16;
      g.lineWidth = W * 0.055;
      g.fillStyle = INK;
      g.strokeStyle = INK;
      g.lineCap = 'butt';
      for (let k = 0; k < 3; k++) {
        const a0 = -Math.PI / 2 + (k * TAU) / 3 + 0.25;
        const a1 = a0 - 1.45;
        g.beginPath();
        g.arc(cx, cy, r, a0, a1, true);
        g.stroke();
        const t = tanAt(a1);
        arrowHead(g, cx + Math.cos(a1) * r + t.x * W * 0.01, cy + Math.sin(a1) * r + t.y * W * 0.01, Math.atan2(t.y, t.x), W * 0.07);
      }
    },
  }),

  /** Stop (R1-1): red octagon. */
  stopSign: (): SignSpec => ({
    w: 0.9,
    h: 0.9,
    shape: (g, W, H) => {
      g.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = Math.PI / 8 + (k * Math.PI) / 4;
        g.lineTo(W / 2 + Math.cos(a) * W / 2, H / 2 + Math.sin(a) * H / 2);
      }
      g.closePath();
    },
    draw(g, W, H) {
      const oct = (r: number) => {
        g.beginPath();
        for (let k = 0; k < 8; k++) {
          const a = Math.PI / 8 + (k * Math.PI) / 4;
          g.lineTo(W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r);
        }
        g.closePath();
      };
      oct(W / 2);
      g.fillStyle = WHITE;
      g.fill();
      oct(W * 0.46);
      g.fillStyle = RED;
      g.fill();
      text(g, 'STOP', W / 2, H * 0.53, FONT(900, W * 0.3), WHITE);
    },
  }),

  /** Railroad crossbuck (R15-1). */
  crossbuck: (): SignSpec => ({
    w: 1.3,
    h: 1.3,
    shape: (g, W, H) => {
      g.beginPath();
      g.rect(0, H * 0.42, W, H * 0.16);
      g.rect(W * 0.42, 0, W * 0.16, H);
    },
    draw(g, W, H) {
      for (const a of [Math.PI / 4, -Math.PI / 4]) {
        g.save();
        g.translate(W / 2, H / 2);
        g.rotate(a);
        g.fillStyle = INK;
        g.fillRect(-W * 0.5, -H * 0.085, W, H * 0.17);
        g.fillStyle = WHITE;
        g.fillRect(-W * 0.49, -H * 0.075, W * 0.98, H * 0.15);
        text(g, a > 0 ? 'RAILROAD' : 'CROSSING', 0, H * 0.005, FONT(900, H * 0.1), INK);
        g.restore();
      }
    },
  }),

  /** Signal ahead (W3-3): a traffic light on a yellow diamond. */
  signalAhead: (): SignSpec => ({
    w: 1.2,
    h: 1.2,
    shape: diamondShape,
    draw(g, W, H) {
      yellowDiamond(g, W, H);
      rrPath(g, W * 0.4, H * 0.24, W * 0.2, H * 0.52, W * 0.04);
      g.fillStyle = INK;
      g.fill();
      ['#E0302A', '#F5C400', '#2FB36F'].forEach((c, k) => {
        g.beginPath();
        g.arc(W / 2, H * (0.33 + k * 0.17), W * 0.065, 0, TAU);
        g.fillStyle = c;
        g.fill();
      });
    },
  }),

  /** Green street-name blade, as on Cambridge corners. */
  streetBlade: (name: string): SignSpec => ({
    w: Math.max(1.4, name.length * 0.13 + 0.4),
    h: 0.32,
    shape: rectShape,
    draw(g, W, H) {
      bordered(g, W, H, GREEN, WHITE, H * 0.08, H * 0.05);
      text(g, name.replace(/\bStreet\b/, 'St').replace(/\bAvenue\b/, 'Ave').toUpperCase(), W / 2, H * 0.55, FONT(800, H * 0.5), WHITE);
    },
  }),

  /** Lane ends (MUTCD W4-2): the right-hand lane line bends in to join the left one. */
  laneEnds: (): SignSpec => ({
    w: 1.5,
    h: 1.5,
    shape: diamondShape,
    draw(g, W, H) {
      yellowDiamond(g, W, H);
      g.strokeStyle = INK;
      g.lineWidth = W * 0.07;
      g.lineCap = 'butt';
      g.beginPath();
      g.moveTo(W * 0.4, H * 0.78);
      g.lineTo(W * 0.4, H * 0.22);
      g.stroke();
      g.beginPath();
      g.moveTo(W * 0.62, H * 0.78);
      g.lineTo(W * 0.62, H * 0.56);
      g.bezierCurveTo(W * 0.62, H * 0.44, W * 0.48, H * 0.4, W * 0.47, H * 0.3);
      g.stroke();
    },
  }),

  pedWarn: (): SignSpec => ({
    w: 1.5,
    h: 1.5,
    shape: diamondShape,
    draw(g, W, H) {
      yellowDiamond(g, W, H);
      pedGlyph(g, W / 2, H / 2, W * 0.42, INK);
    },
  }),

  yieldSign: (): SignSpec => ({
    w: 1.5,
    h: 1.3,
    shape: yieldShape,
    draw(g, W, H) {
      yieldShape(g, W, H);
      g.fillStyle = RED;
      g.fill();
      g.beginPath();
      g.moveTo(W * 0.2, H * 0.115);
      g.lineTo(W * 0.8, H * 0.115);
      g.lineTo(W / 2, H * 0.67);
      g.closePath();
      g.fillStyle = WHITE;
      g.fill();
      text(g, 'YIELD', W / 2, H * 0.27, FONT(900, W * 0.135), RED);
    },
  }),

  oneWay: (): SignSpec => ({
    w: 1.6,
    h: 0.55,
    shape: rectShape,
    draw(g, W, H) {
      rectShape(g, W, H);
      g.fillStyle = INK;
      g.fill();
      g.fillStyle = WHITE;
      g.beginPath();
      g.moveTo(W * 0.06, H * 0.3);
      g.lineTo(W * 0.74, H * 0.3);
      g.lineTo(W * 0.74, H * 0.12);
      g.lineTo(W * 0.95, H * 0.5);
      g.lineTo(W * 0.74, H * 0.88);
      g.lineTo(W * 0.74, H * 0.7);
      g.lineTo(W * 0.06, H * 0.7);
      g.closePath();
      g.fill();
      text(g, 'ONE WAY', W * 0.42, H * 0.53, FONT(900, H * 0.32), INK);
    },
  }),

  stateLaw: (): SignSpec => ({
    w: 0.75,
    h: 1.45,
    shape: rectShape,
    draw(g, W, H) {
      bordered(g, W, H, WHITE, INK, W * 0.05, W * 0.03);
      text(g, 'STATE', W / 2, H * 0.1, FONT(900, W * 0.19), RED);
      text(g, 'LAW', W / 2, H * 0.21, FONT(900, W * 0.19), RED);
      text(g, 'YIELD TO', W / 2, H * 0.34, FONT(800, W * 0.15), INK);
      pedGlyph(g, W / 2, H * 0.55, W * 0.4, INK);
      text(g, 'WITHIN', W / 2, H * 0.78, FONT(800, W * 0.13), INK);
      text(g, 'CROSSWALK', W / 2, H * 0.88, FONT(800, W * 0.12), INK);
    },
  }),

  /** Diagram sign as seen when entering from road `i`. */
  diagram: (i = 0): SignSpec => ({
    w: 4.2,
    h: 3.2,
    shape: rectShape,
    draw(g, W, H) {
      const E1 = ROADS[(i + 1) % 4];
      const E2 = ROADS[(i + 2) % 4];
      const E3 = ROADS[(i + 3) % 4];
      rectShape(g, W, H);
      g.fillStyle = GREEN;
      g.fill();
      g.lineWidth = W * 0.008;
      g.strokeStyle = WHITE;
      rrPath(g, W * 0.015, W * 0.015, W * 0.97, H - W * 0.03, W * 0.02);
      g.stroke();
      const cx = W / 2;
      const cy = H * 0.6;
      const r = H * 0.12;
      const lw = H * 0.035;
      g.strokeStyle = WHITE;
      g.fillStyle = WHITE;
      g.lineWidth = lw;
      g.lineCap = 'butt';
      g.beginPath();
      g.arc(cx, cy, r, 0, TAU);
      g.stroke();
      const ln = (x0: number, y0: number, x1: number, y1: number) => {
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
      };
      ln(cx, cy + r, cx, H * 0.95);
      ln(cx + r, cy, W * 0.64, cy);
      arrowHead(g, W * 0.64 + lw * 0.6, cy, 0, lw * 1.6);
      ln(cx, cy - r, cx, H * 0.34);
      arrowHead(g, cx, H * 0.34 - lw * 0.6, -Math.PI / 2, lw * 1.6);
      ln(cx - r, cy, W * 0.36, cy);
      arrowHead(g, W * 0.36 - lw * 0.6, cy, Math.PI, lw * 1.6);
      text(g, E2.town, cx, H * 0.075, FONT(800, H * 0.075), WHITE);
      shield(g, cx, H * 0.2, H * 0.13, E2);
      if (E1.dir) text(g, E1.dir, W * 0.82, cy - H * 0.18, FONT(800, H * 0.055), WHITE);
      shield(g, W * 0.82, cy - H * 0.07, H * 0.13, E1);
      text(g, E1.town, W * 0.82, cy + H * 0.08, FONT(800, H * 0.075), WHITE);
      if (E3.dir) text(g, E3.dir, W * 0.18, cy - H * 0.17, FONT(800, H * 0.055), WHITE);
      shield(g, W * 0.18, cy - H * 0.06, H * 0.13, E3);
      text(g, E3.town, W * 0.18, cy + H * 0.09, FONT(800, H * 0.075), WHITE);
      text(g, 'ROTARY', W * 0.13, H * 0.91, FONT(800, H * 0.05), WHITE);
    },
  }),

  exitGuide: (r: Road): SignSpec => ({
    w: 3.0,
    h: 1.5,
    shape: rectShape,
    draw(g, W, H) {
      bordered(g, W, H, GREEN, WHITE, H * 0.04, H * 0.025);
      if (r.dir) text(g, r.dir, W * 0.17, H * 0.17, FONT(800, H * 0.11), WHITE);
      shield(g, W * 0.17, H * 0.52, H * 0.42, r);
      text(g, r.town, W * 0.6, H * 0.4, FONT(800, H * 0.2), WHITE);
      g.strokeStyle = WHITE;
      g.fillStyle = WHITE;
      g.lineWidth = H * 0.06;
      g.beginPath();
      g.moveTo(W * 0.52, H * 0.86);
      g.lineTo(W * 0.66, H * 0.66);
      g.stroke();
      arrowHead(g, W * 0.68, H * 0.63, Math.atan2(-0.2, 0.14), H * 0.09);
    },
  }),

  teeth: (): SignSpec => ({
    w: 1.6,
    h: 1.6,
    shape: rectShape,
    draw(g, W, H) {
      rectShape(g, W, H);
      g.fillStyle = '#4A4E54';
      g.fill();
      g.fillStyle = '#E9EBE6';
      for (let k = 0; k < 4; k++) {
        const x = W * (0.16 + k * 0.23);
        g.beginPath();
        g.moveTo(x - W * 0.08, H * 0.36);
        g.lineTo(x + W * 0.08, H * 0.36);
        g.lineTo(x, H * 0.56);
        g.closePath();
        g.fill();
      }
      for (let k = 0; k < 6; k++) g.fillRect(W * (0.06 + k * 0.155), H * 0.66, W * 0.09, H * 0.26);
      g.fillStyle = '#D8A71C';
      g.fillRect(0, H * 0.06, W, H * 0.03);
    },
  }),

  shields: (): SignSpec => ({
    w: 2.4,
    h: 1.2,
    shape: rectShape,
    draw(g, W, H) {
      rectShape(g, W, H);
      g.fillStyle = GREEN;
      g.fill();
      const s = H * 0.56;
      const cy = H * 0.48;
      maShield(g, W * 0.2, cy, s, '2');
      usShield(g, W * 0.5, cy, s, '20');
      const x1 = W * 0.8;
      g.beginPath();
      g.moveTo(x1 - s * 0.45, cy - s * 0.4);
      g.quadraticCurveTo(x1, cy - s * 0.52, x1 + s * 0.45, cy - s * 0.4);
      g.quadraticCurveTo(x1 + s * 0.5, cy + s * 0.2, x1, cy + s * 0.48);
      g.quadraticCurveTo(x1 - s * 0.5, cy + s * 0.2, x1 - s * 0.45, cy - s * 0.4);
      g.closePath();
      g.fillStyle = '#1F4E9E';
      g.fill();
      g.save();
      g.clip();
      g.fillStyle = RED;
      g.fillRect(x1 - s, cy - s, s * 2, s * 0.68);
      g.restore();
      g.lineWidth = s * 0.05;
      g.strokeStyle = WHITE;
      g.stroke();
      text(g, '90', x1, cy + s * 0.13, FONT(900, s * 0.38), WHITE);
      text(g, 'MA', W * 0.2, H * 0.88, FONT(800, H * 0.1), WHITE);
      text(g, 'U.S.', W * 0.5, H * 0.88, FONT(800, H * 0.1), WHITE);
      text(g, 'Interstate', W * 0.8, H * 0.88, FONT(800, H * 0.1), WHITE);
    },
  }),
};

export type SignKey = 'speed' | 'lanes' | 'diagram' | 'warn' | 'ped' | 'law' | 'yield' | 'teeth' | 'oneway' | 'shields';

export interface SignInfo {
  spec: () => SignSpec;
  name: string;
  kind: string;
  meaning: string;
  rule: string;
}

export function diagramRule(i: number): string {
  const e = [1, 2, 3].map((k) => ROADS[(i + k) % 4]);
  return `Count your exit now: ${e[0].town} (Route ${e[0].route}) is the 1st exit, ${e[1].town} (Route ${e[1].route}) the 2nd, ${e[2].town} (Route ${e[2].route}) the 3rd.`;
}

export const SIGN_INFO: Record<SignKey, SignInfo> = {
  speed: {
    spec: () => SIGNS.speed(25),
    name: 'Speed Limit 25',
    kind: 'Regulatory · white',
    meaning: 'The legal maximum speed on this road.',
    rule: "Boston's default limit is 25 mph unless a sign says otherwise. Going over it can get you a ticket.",
  },
  lanes: {
    spec: () => SIGNS.laneEnds(),
    name: 'Right lane ends',
    kind: 'Warning · yellow',
    meaning: 'The lane you are in is about to end. The lane to your left keeps going.',
    rule: 'Merge left early: signal left (Z), check your left mirror, then hold Q to look over your shoulder for a car in your blind spot. Move over only into a safe gap.',
  },
  diagram: {
    spec: () => SIGNS.diagram(0),
    name: 'Rotary diagram sign',
    kind: 'Guide · green',
    meaning: 'A bird’s-eye map of the rotary ahead. Each exit shows its route shield and the town it leads to.',
    rule: diagramRule(0),
  },
  warn: {
    spec: () => SIGNS.rotaryWarn(),
    name: 'Rotary ahead, 20 MPH advisory',
    kind: 'Warning · yellow',
    meaning: 'The circular arrows warn of a rotary and show that traffic flows counterclockwise.',
    rule: 'The yellow 20 MPH plaque is an advisory speed, not the legal limit. It is the speed you should aim for inside the rotary.',
  },
  ped: {
    spec: () => SIGNS.pedWarn(),
    name: 'Pedestrian crossing ahead',
    kind: 'Warning · yellow',
    meaning: 'A marked crosswalk is coming up.',
    rule: 'Slow down and scan both curbs. People often step out at crosswalks that have no signal.',
  },
  law: {
    spec: () => SIGNS.stateLaw(),
    name: '"State Law" crosswalk sign',
    kind: 'In-street regulatory',
    meaning: 'Placed in the middle of the road at a crosswalk.',
    rule: 'Massachusetts law requires you to yield to people in the crosswalk. If someone is crossing, stop before the white bars.',
  },
  yield: {
    spec: () => SIGNS.yieldSign(),
    name: 'Yield to traffic in rotary',
    kind: 'Regulatory · red and white',
    meaning: 'Let other traffic go first, stopping if you need to.',
    rule: 'Cars already in the rotary have the right of way. Look left, wait at the white triangles, and enter only into a safe gap.',
  },
  teeth: {
    spec: () => SIGNS.teeth(),
    name: 'Yield line ("shark teeth")',
    kind: 'Pavement marking',
    meaning: 'The row of white triangles across your lane, pointing toward you.',
    rule: 'This is where you stop if you have to yield. The crosswalk bars sit just before it.',
  },
  oneway: {
    spec: () => SIGNS.oneWay(),
    name: 'One Way',
    kind: 'Regulatory · black and white',
    meaning: 'Traffic moves only in the arrow’s direction.',
    rule: 'On a rotary it tells you to turn right and travel counterclockwise. Never turn left into a rotary.',
  },
  shields: {
    spec: () => SIGNS.shields(),
    name: 'Route shields and exit signs',
    kind: 'Guide · green',
    meaning: 'Massachusetts routes use a white square, U.S. routes a shield shape, and Interstates a red-and-blue shield.',
    rule: 'Inside the rotary, green exit signs show the route and town. When you see yours, signal right and exit.',
  },
};

export const GUIDE_ORDER: SignKey[] = ['speed', 'lanes', 'diagram', 'warn', 'ped', 'law', 'yield', 'teeth', 'oneway', 'shields'];

export function signCanvas(spec: SignSpec, ppm: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(spec.w * ppm);
  c.height = Math.round(spec.h * ppm);
  const g = c.getContext('2d');
  if (g) spec.draw(g, c.width, c.height);
  return c;
}

const imgCache = new Map<string, string>();
/** PNG data URL of a sign, cached by key. */
export function signImg(key: string, spec: SignSpec): string {
  let url = imgCache.get(key);
  if (!url) {
    url = signCanvas(spec, 90).toDataURL('image/png');
    imgCache.set(key, url);
  }
  return url;
}
