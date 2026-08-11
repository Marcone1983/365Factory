import { PolyMesh, loft, v3, type Station } from '@/lib/graphics/mesh-kernel';
import { bodySection, SECTION_POINTS, type ArchCut, type BodyProfile, type SectionPoint, type SectionZone } from './vehicle-section';

/**
 * Builds the car's outer skin as one lofted surface.
 *
 * The whole silhouette lives in the cross-sections: how wide the body is at
 * each station, where the belt line sits, how high the roof rises, and where
 * the wheel arches cut into it. Because it is a single skin there is no seam
 * between bonnet, roof and boot, and the wheel arches are openings in the sheet
 * metal rather than gaps between separate parts.
 *
 * Material assignment happens per face afterwards, from the zone each section
 * point belongs to: a face whose corners are all glass becomes glass, a face on
 * the rocker becomes trim, everything else is paint. Doing it here rather than
 * per-station is what allows a windscreen to exist on a surface that is
 * otherwise painted.
 */

export interface BodyLayout {
  readonly carLength: number;
  readonly carWidth: number;
  readonly carHeight: number;
  readonly rideHeight: number;
  readonly bodyHalfWidth: number;
  readonly wheelRadius: number;
  readonly wheelWidth: number;
  readonly wheelbase: number;
  readonly track: number;
  /** Longitudinal centre of each axle, in model space. */
  readonly frontAxleZ: number;
  readonly rearAxleZ: number;
  readonly archRadius: number;
  readonly archInnerHalfWidth: number;
  /** Cabin extent as fractions of the length, measured from the tail. */
  readonly cabinStart: number;
  readonly cabinEnd: number;
  readonly noseDrop: number;
  /** How far the boot deck falls below the belt line behind the cabin, 0..1. */
  readonly deckDrop: number;
  /** Half-width the body must reach over an axle so the arch covers the tyre. */
  readonly overWheelHalfWidth: number;
  /** Extra swell beyond tyre coverage, for classes that wear proud arches. */
  readonly fenderSwell: number;
  readonly roofRatio: number;
  readonly beltRatio: number;
}

export interface MaterialSlots {
  readonly paint: number;
  readonly glass: number;
  readonly trim: number;
}

export interface BuiltBody {
  readonly mesh: PolyMesh;
  /** Section outlines, kept so details can be placed on the real surface. */
  readonly sections: ReadonlyArray<{ z: number; points: readonly SectionPoint[] }>;
  readonly beltYAt: (z: number) => number;
}

const STATIONS = 42;

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** A bell centred on `centre`; used for the haunches over each axle. */
function bell(t: number, centre: number, width: number): number {
  return Math.exp(-((t - centre) ** 2) / (width * width));
}

function profileAt(t: number, layout: BodyLayout): BodyProfile {
  // Plan view: pinched at both ends, fullest through the middle, with a swell
  // over each axle. Real bodies are widest at the haunches, not at the doors.
  const taper = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.015) / 0.97))) ** 0.7;
  const frontT = (layout.frontAxleZ / layout.carLength) + 0.5;
  const rearT = (layout.rearAxleZ / layout.carLength) + 0.5;
  const wheelBell = Math.max(bell(t, frontT, 0.115), bell(t, rearT, 0.105));

  // Bumper closure. Without this the loft ends in a flat cap and the car reads
  // as a extruded block sawn off at both ends — the section has to contract in
  // both width and height over the last few percent so the nose and tail wrap
  // round into real bumpers.
  const close = smoothstep(0, 0.055, t) * (1 - smoothstep(0.945, 1, t));
  const widthClose = 0.17 + 0.83 * close;
  const heightClose = 0.52 + 0.48 * close;

  // Tyre coverage is a floor, not a multiplier. Scaling the tapered width by a
  // swell factor lets the taper cancel the swell exactly where it is needed
  // most — over the axles — and leaves the wheels standing outside a narrow
  // body on visible stilts. Blending toward an absolute target cannot.
  const base = layout.bodyHalfWidth * taper * widthClose;
  const target = (layout.overWheelHalfWidth + layout.bodyHalfWidth * layout.fenderSwell) * widthClose;
  const halfWidth = base + Math.max(0, target - base) * wheelBell;

  // Side view. The bonnet falls away toward the nose and the boot deck falls
  // away behind the cabin. Without the second fall the tail stays at cabin
  // height all the way to the bumper and the car reads as a pickup: a cabin
  // with a flat bed behind it.
  const noseFall = t > layout.cabinEnd ? 1 - ((t - layout.cabinEnd) / (1 - layout.cabinEnd)) ** 1.5 * (1 - layout.noseDrop) : 1;
  const deckFall = t < layout.cabinStart ? 1 - (1 - t / layout.cabinStart) ** 1.4 * layout.deckDrop : 1;

  const floorBase = layout.rideHeight * (0.85 + 0.3 * bell(t, 0.5, 0.4));
  const beltBase = layout.rideHeight + layout.carHeight * layout.beltRatio * noseFall * deckFall;

  // Contract the section's height about its own mid-height, so the bumper keeps
  // its centre line instead of sinking into the road or floating above it.
  const mid = (floorBase + beltBase) / 2;
  const floorY = mid + (floorBase - mid) * heightClose;
  const beltY = mid + (beltBase - mid) * heightClose;

  // The greenhouse rises and falls inside the cabin window, and is exactly flat
  // outside it — the same function produces bonnet, roof and boot lid.
  const inCabin = smoothstep(layout.cabinStart, layout.cabinStart + 0.1, t) * (1 - smoothstep(layout.cabinEnd - 0.12, layout.cabinEnd, t));
  const roofRise = layout.carHeight * layout.roofRatio * inCabin;
  const roofY = beltY + roofRise;

  // Tumblehome: the roof is narrower than the body, more so on lower cars.
  const roofHalfWidth = halfWidth * (0.72 + 0.1 * inCabin);

  return {
    halfWidth,
    floorY,
    beltY,
    roofY,
    roofHalfWidth,
    // Squarer near the ground, rounder at the shoulder.
    lowerExponent: 2.6 + 1.6 * (1 - t * (1 - t) * 4) * 0.3,
    upperExponent: 2.3,
  };
}

function archCutAt(z: number, axleZ: number, layout: BodyLayout): ArchCut {
  return {
    distanceToAxle: Math.abs(z - axleZ),
    archRadius: layout.archRadius,
    wheelCentreY: layout.wheelRadius,
    // The arch wall sits just inboard of the tyre's inner face.
    innerHalfWidth: layout.track / 2 - layout.wheelWidth * 0.62,
  };
}

export function buildBody(layout: BodyLayout, slots: MaterialSlots): BuiltBody {
  const stations: Station[] = [];
  const sections: Array<{ z: number; points: SectionPoint[] }> = [];
  const belts: Array<{ z: number; y: number }> = [];

  for (let i = 0; i < STATIONS; i += 1) {
    const t = i / (STATIONS - 1);
    const z = (t - 0.5) * layout.carLength;
    const profile = profileAt(t, layout);

    // Only one axle can cut a given station; take the nearer.
    const front = archCutAt(z, layout.frontAxleZ, layout);
    const rear = archCutAt(z, layout.rearAxleZ, layout);
    const cut = front.distanceToAxle <= rear.distanceToAxle ? front : rear;

    const points = bodySection(profile, cut.distanceToAxle < layout.archRadius ? cut : null);
    sections.push({ z, points });
    belts.push({ z, y: profile.beltY });

    stations.push({
      center: v3(0, 0, z),
      profile: points.map((p) => ({ x: p.x, y: p.y })),
      right: v3(1, 0, 0),
      up: v3(0, 1, 0),
      material: slots.paint,
    });
  }

  const mesh = loft(stations, { closeRing: true, capStart: true, capEnd: true, material: slots.paint });

  // --- per-face material assignment ---------------------------------------
  // The loft emits one quad per (station, ring) pair in order, so a face's ring
  // index recovers which zone its corners came from.
  const zones: SectionZone[] = (sections[0]?.points ?? []).map((p) => p.zone);
  const ring = SECTION_POINTS;
  // The cap fans append their centre vertices after every ring, so anything at
  // or beyond this index is a cap and has no section zone.
  const lastRingVertex = STATIONS * ring;

  for (const face of mesh.faces) {
    const zoneCounts = new Map<SectionZone, number>();
    let centroidZ = 0;
    let centroidY = 0;

    for (const index of face.vertices) {
      const vertex = mesh.vertices[index];
      if (!vertex) continue;
      centroidZ += vertex.position.z / face.vertices.length;
      centroidY += vertex.position.y / face.vertices.length;
      if (index >= lastRingVertex) continue;
      const zone = zones[index % ring];
      if (zone) zoneCounts.set(zone, (zoneCounts.get(zone) ?? 0) + 1);
    }

    const glassCorners = zoneCounts.get('glass') ?? 0;
    const rockerCorners = (zoneCounts.get('rocker') ?? 0) + (zoneCounts.get('floor') ?? 0);
    const tFace = centroidZ / layout.carLength + 0.5;

    // Glass only inside the cabin window: the same section zones exist fore and
    // aft of it, where they describe bonnet and boot rather than windows.
    const insideCabin = tFace > layout.cabinStart + 0.02 && tFace < layout.cabinEnd - 0.02;
    if (glassCorners >= 3 && insideCabin) {
      face.material = slots.glass;
      continue;
    }
    if (rockerCorners >= 3 && centroidY < layout.rideHeight + layout.carHeight * 0.2) {
      face.material = slots.trim;
    }
  }

  // --- creases -------------------------------------------------------------
  // The belt line and the arch lips stay crisp through subdivision; without
  // them the whole car softens into a bar of soap.
  creaseRing(mesh, sections, ring, (point) => point.zone === 'shoulder');
  creaseArchLips(mesh, sections, ring, layout);

  const beltYAt = (z: number): number => {
    let nearest = belts[0];
    for (const entry of belts) {
      if (!nearest || Math.abs(entry.z - z) < Math.abs(nearest.z - z)) nearest = entry;
    }
    return nearest?.y ?? layout.rideHeight;
  };

  return { mesh, sections, beltYAt };
}

/** Creases the longitudinal edge running through every point matching a test. */
function creaseRing(
  mesh: PolyMesh,
  sections: ReadonlyArray<{ points: readonly SectionPoint[] }>,
  ring: number,
  test: (point: SectionPoint) => boolean,
): void {
  const first = sections[0];
  if (!first) return;

  for (let index = 0; index < ring; index += 1) {
    const point = first.points[index];
    if (!point || !test(point)) continue;
    for (let station = 0; station + 1 < sections.length; station += 1) {
      mesh.crease(station * ring + index, (station + 1) * ring + index, 0.7);
    }
  }
}

/** Creases the ring edges around each wheel arch opening. */
function creaseArchLips(
  mesh: PolyMesh,
  sections: ReadonlyArray<{ z: number; points: readonly SectionPoint[] }>,
  ring: number,
  layout: BodyLayout,
): void {
  for (let station = 0; station < sections.length; station += 1) {
    const section = sections[station];
    if (!section) continue;
    const nearAxle =
      Math.abs(section.z - layout.frontAxleZ) < layout.archRadius ||
      Math.abs(section.z - layout.rearAxleZ) < layout.archRadius;
    if (!nearAxle) continue;

    for (let index = 0; index < ring; index += 1) {
      const a = section.points[index];
      const b = section.points[(index + 1) % ring];
      if (!a || !b) continue;
      // A sharp change in half-width along the ring is the arch lip.
      if (Math.abs(Math.abs(a.x) - Math.abs(b.x)) > layout.wheelWidth * 0.35) {
        mesh.crease(station * ring + index, station * ring + ((index + 1) % ring), 1);
      }
    }
  }
}
