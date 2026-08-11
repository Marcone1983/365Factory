/**
 * Vehicle cross-section geometry.
 *
 * A car body is one continuous skin. Modelling it as a hull with a separate
 * cabin volume dropped on top produces exactly what it sounds like — a lump
 * with a second lump balanced on it — so the section itself carries the whole
 * silhouette: floor, rocker, flank, shoulder, glass and roof, plus the wheel
 * arch cut where the section crosses an axle.
 *
 * Every section returns the same number of points in the same order, so a
 * sequence of them lofts directly into a closed skin.
 */

export type SectionZone = 'floor' | 'rocker' | 'flank' | 'shoulder' | 'glass' | 'roof';

export interface SectionPoint {
  readonly x: number;
  readonly y: number;
  readonly zone: SectionZone;
}

export interface BodyProfile {
  /** Body half-width at this station, before the arch cut. */
  readonly halfWidth: number;
  /** Underbody height above the ground. */
  readonly floorY: number;
  /** Top of the lower body — the belt line, where glass starts. */
  readonly beltY: number;
  /** Top of the greenhouse. Equal to beltY where there is no cabin. */
  readonly roofY: number;
  /** Roof half-width. Narrower than the body: that difference is tumblehome. */
  readonly roofHalfWidth: number;
  /** Lower corner sharpness. 2 is elliptical; higher reads as a harder edge. */
  readonly lowerExponent: number;
  readonly upperExponent: number;
}

export interface ArchCut {
  /** Longitudinal distance from this station to the axle centre. */
  readonly distanceToAxle: number;
  readonly archRadius: number;
  readonly wheelCentreY: number;
  /** The body may not extend past this half-width inside the arch. */
  readonly innerHalfWidth: number;
}

const LOWER_STEPS = 14;
const UPPER_STEPS = 12;

/** Points per section: one half, plus its mirror minus the two shared centre points. */
export const SECTION_POINTS = 2 * (LOWER_STEPS + UPPER_STEPS) - 2;

/** Fraction of the greenhouse height that is side glass rather than roof turn. */
const GLASS_FRACTION = 0.7;

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Applies the wheel arch opening.
 *
 * At a station crossing an axle the arch reaches `wheelCentreY + √(R² − dz²)` —
 * the arch circle seen edge-on. Below that height the body may not extend past
 * the arch's inner wall, or it clips through the tyre. The cut fades in
 * vertically rather than stepping, so the lip is a curve in the sheet metal and
 * not a notch that subdivision turns into a dent.
 */
function applyArch(x: number, y: number, cut: ArchCut | null): number {
  if (!cut || cut.distanceToAxle >= cut.archRadius) return x;

  const reach = Math.sqrt(Math.max(0, cut.archRadius ** 2 - cut.distanceToAxle ** 2));
  const archTopY = cut.wheelCentreY + reach;
  if (y >= archTopY) return x;

  const fade = smoothstep(archTopY, archTopY - cut.archRadius * 0.3, y);
  const clipped = Math.min(x, cut.innerHalfWidth);
  return x + (clipped - x) * fade;
}

/**
 * The lower half-section, from the bottom centreline out to the shoulder.
 *
 * Parametrised so the floor starts flat and the flank rises vertically — the
 * shape a car section actually has. A plain ellipse would round the underbody
 * away and leave the car looking inflated.
 */
function lowerPoint(profile: BodyProfile, s: number): { x: number; y: number } {
  const theta = (s * Math.PI) / 2;
  const p = 2 / profile.lowerExponent;
  const height = Math.max(0.001, profile.beltY - profile.floorY);
  return {
    x: profile.halfWidth * Math.sin(theta) ** p,
    y: profile.floorY + height * (1 - Math.cos(theta) ** p),
  };
}

/**
 * The upper half-section, from the shoulder to the roof centreline.
 *
 * Two arcs: side glass leaning inward, then the roof turning over. Where there
 * is no cabin this collapses into a shallow deck — the bonnet and boot lid —
 * which is why the body needs no separate greenhouse volume and therefore has
 * no seam where one would meet it.
 */
function upperPoint(profile: BodyProfile, s: number): { x: number; y: number } {
  const rise = Math.max(0, profile.roofY - profile.beltY);
  const lowerHeight = Math.max(0.001, profile.beltY - profile.floorY);

  if (rise <= lowerHeight * 0.06) {
    // Flat deck: taper to the centreline over a very shallow crown.
    const crown = Math.max(rise, lowerHeight * 0.04);
    const theta = (s * Math.PI) / 2;
    const p = 2 / 4.5;
    return {
      x: profile.halfWidth * Math.cos(theta) ** p,
      y: profile.beltY + crown * Math.sin(theta) ** p,
    };
  }

  if (s <= GLASS_FRACTION) {
    const u = s / GLASS_FRACTION;
    // Tumblehome: the glass leans in, accelerating as it rises.
    const lean = u ** 1.25;
    return {
      x: profile.halfWidth + (profile.roofHalfWidth - profile.halfWidth) * lean,
      y: profile.beltY + rise * GLASS_FRACTION * u,
    };
  }

  const u = (s - GLASS_FRACTION) / (1 - GLASS_FRACTION);
  const theta = (u * Math.PI) / 2;
  const p = 2 / profile.upperExponent;
  return {
    x: profile.roofHalfWidth * Math.cos(theta) ** p,
    y: profile.beltY + rise * GLASS_FRACTION + rise * (1 - GLASS_FRACTION) * Math.sin(theta) ** p,
  };
}

function lowerZone(s: number): SectionZone {
  if (s < 0.14) return 'floor';
  if (s < 0.4) return 'rocker';
  if (s < 0.85) return 'flank';
  return 'shoulder';
}

/**
 * Builds one closed cross-section outline, anticlockwise seen from the front:
 * bottom centre, out along the floor and up the right flank, over the roof,
 * then the mirror image down the left side.
 */
export function bodySection(profile: BodyProfile, cut: ArchCut | null): SectionPoint[] {
  const rise = Math.max(0, profile.roofY - profile.beltY);
  const lowerHeight = Math.max(0.001, profile.beltY - profile.floorY);
  const hasGreenhouse = rise > lowerHeight * 0.06;

  const half: SectionPoint[] = [];

  for (let i = 0; i < LOWER_STEPS; i += 1) {
    const s = i / (LOWER_STEPS - 1);
    const point = lowerPoint(profile, s);
    half.push({ x: applyArch(point.x, point.y, cut), y: point.y, zone: lowerZone(s) });
  }

  for (let i = 1; i <= UPPER_STEPS; i += 1) {
    const s = i / UPPER_STEPS;
    const point = upperPoint(profile, s);
    const zone: SectionZone = !hasGreenhouse ? 'shoulder' : s > GLASS_FRACTION ? 'roof' : 'glass';
    half.push({ x: applyArch(point.x, point.y, cut), y: point.y, zone });
  }

  const outline: SectionPoint[] = [...half];
  for (let i = half.length - 2; i >= 1; i -= 1) {
    const point = half[i] as SectionPoint;
    outline.push({ x: -point.x, y: point.y, zone: point.zone });
  }
  return outline;
}

/** The section's widest half-width, used to place details on the real surface. */
export function sectionHalfWidth(points: readonly SectionPoint[]): number {
  return Math.max(...points.map((p) => Math.abs(p.x)));
}

/** Half-width nearest a given height, so a detail can sit flush in the flank. */
export function halfWidthAt(points: readonly SectionPoint[], y: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (const point of points) {
    const distance = Math.abs(point.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = Math.abs(point.x);
    }
  }
  return best;
}
