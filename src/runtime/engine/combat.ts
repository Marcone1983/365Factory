import * as THREE from 'three';
import { SpatialHash, sphereOverlap, type Collider } from './physics';

/**
 * Combat systems.
 *
 * Everything a fight needs, expressed so that generated gameplay code composes
 * it rather than reimplements it: health with armour and damage types, hit
 * reaction and invulnerability frames, melee arcs resolved against a swept
 * capsule, ballistic projectiles with gravity and drag, hitscan with penetration
 * falloff, and a damage-number/impact event stream the presentation layer reads.
 *
 * Deterministic under a fixed timestep, so the automated combat test can assert
 * exact outcomes.
 */

export type DamageType = 'physical' | 'piercing' | 'explosive' | 'energy' | 'fire' | 'true';

export interface Resistances {
  readonly physical?: number;
  readonly piercing?: number;
  readonly explosive?: number;
  readonly energy?: number;
  readonly fire?: number;
}

export interface CombatantOptions {
  readonly id: string;
  readonly maxHealth: number;
  readonly armour?: number;
  readonly resistances?: Resistances;
  readonly invulnerableSeconds?: number;
  readonly team: string;
}

export interface DamageEvent {
  readonly targetId: string;
  readonly sourceId: string;
  readonly amount: number;
  readonly mitigated: number;
  readonly type: DamageType;
  readonly critical: boolean;
  readonly position: THREE.Vector3;
  readonly lethal: boolean;
}

export class Combatant {
  health: number;
  readonly maxHealth: number;
  readonly id: string;
  readonly team: string;
  armour: number;
  invulnerableFor = 0;
  alive = true;
  private readonly resistances: Resistances;
  private readonly invulnerableSeconds: number;

  constructor(options: CombatantOptions) {
    this.id = options.id;
    this.team = options.team;
    this.maxHealth = options.maxHealth;
    this.health = options.maxHealth;
    this.armour = options.armour ?? 0;
    this.resistances = options.resistances ?? {};
    this.invulnerableSeconds = options.invulnerableSeconds ?? 0.35;
  }

  update(dt: number): void {
    if (this.invulnerableFor > 0) this.invulnerableFor = Math.max(0, this.invulnerableFor - dt);
  }

  /**
   * Applies damage. Armour subtracts a flat amount (with a floor so a heavily
   * armoured target is still chippable), resistance scales what remains, and
   * `true` damage bypasses both.
   */
  applyDamage(amount: number, type: DamageType, sourceId: string, position: THREE.Vector3, critical = false): DamageEvent | null {
    if (!this.alive || this.invulnerableFor > 0) return null;

    let final = amount;
    if (type !== 'true') {
      const armourReduction = type === 'piercing' ? this.armour * 0.35 : this.armour;
      final = Math.max(amount * 0.12, amount - armourReduction);
      const resistance = this.resistances[type as keyof Resistances] ?? 0;
      final *= 1 - Math.max(-1, Math.min(0.95, resistance));
    }
    if (critical) final *= 2;

    const mitigated = amount - final;
    this.health -= final;
    this.invulnerableFor = this.invulnerableSeconds;
    const lethal = this.health <= 0;
    if (lethal) {
      this.health = 0;
      this.alive = false;
    }
    return { targetId: this.id, sourceId, amount: final, mitigated, type, critical, position: position.clone(), lethal };
  }

  heal(amount: number): void {
    if (!this.alive) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  revive(fraction = 1): void {
    this.alive = true;
    this.health = this.maxHealth * Math.max(0.05, Math.min(1, fraction));
    this.invulnerableFor = this.invulnerableSeconds * 2;
  }
}

export interface MeleeSwing {
  readonly origin: THREE.Vector3;
  readonly direction: THREE.Vector3;
  readonly reach: number;
  /** Half-angle of the arc in radians. */
  readonly arc: number;
  readonly damage: number;
  readonly type: DamageType;
  readonly knockback: number;
  readonly sourceId: string;
  readonly team: string;
  /** Chance of a critical hit, 0..1, resolved against the supplied RNG. */
  readonly criticalChance?: number;
}

export interface CombatTarget {
  readonly collider: Collider;
  readonly combatant: Combatant;
  /** Applied knockback impulse; the gameplay layer integrates it. */
  applyImpulse?(impulse: THREE.Vector3): void;
}

/**
 * Resolves a melee swing against everything inside the arc.
 *
 * The arc test is a cone: within reach, and within the half-angle of the swing
 * direction. Targets are sorted nearest-first so a single-target weapon hits the
 * closest thing rather than an arbitrary one.
 */
export function resolveMelee(
  swing: MeleeSwing,
  targets: readonly CombatTarget[],
  hash: SpatialHash,
  random: () => number = Math.random,
  maxTargets = Number.POSITIVE_INFINITY,
): DamageEvent[] {
  const events: DamageEvent[] = [];
  const direction = swing.direction.clone().normalize();
  const probe = swing.origin.clone().addScaledVector(direction, swing.reach * 0.5);
  const nearby = new Set(hash.query(probe, swing.reach).map((c) => c.id));

  const candidates = targets
    .filter((t) => t.combatant.alive && t.combatant.team !== swing.team && nearby.has(t.collider.id))
    .map((t) => ({ target: t, distance: t.collider.position.distanceTo(swing.origin) }))
    .filter(({ target, distance }) => {
      if (distance > swing.reach + target.collider.radius) return false;
      const toTarget = target.collider.position.clone().sub(swing.origin).normalize();
      return Math.acos(Math.max(-1, Math.min(1, toTarget.dot(direction)))) <= swing.arc;
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxTargets);

  for (const { target } of candidates) {
    const critical = random() < (swing.criticalChance ?? 0);
    const event = target.combatant.applyDamage(swing.damage, swing.type, swing.sourceId, target.collider.position, critical);
    if (!event) continue;
    events.push(event);
    if (swing.knockback > 0 && target.applyImpulse) {
      const push = target.collider.position.clone().sub(swing.origin).setY(0).normalize();
      target.applyImpulse(push.multiplyScalar(swing.knockback).setY(swing.knockback * 0.35));
    }
  }
  return events;
}

export interface BallisticProjectile {
  readonly id: string;
  readonly sourceId: string;
  readonly team: string;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly radius: number;
  readonly damage: number;
  readonly type: DamageType;
  /** Explosion radius; 0 means a direct-hit-only projectile. */
  readonly splashRadius: number;
  readonly knockback: number;
  life: number;
  /** Air drag coefficient; 0 for an idealised bullet. */
  readonly drag: number;
}

export interface ProjectileImpact {
  readonly projectile: BallisticProjectile;
  readonly position: THREE.Vector3;
  readonly hitTargetId: string | null;
  readonly events: readonly DamageEvent[];
}

/**
 * Advances projectiles with gravity and quadratic drag, using swept-sphere
 * collision so a fast projectile cannot tunnel through a target between steps.
 */
export function stepBallistics(
  projectiles: BallisticProjectile[],
  dt: number,
  gravity: number,
  targets: readonly CombatTarget[],
  groundHeight: (x: number, z: number) => number,
  onImpact: (impact: ProjectileImpact) => void,
): void {
  for (let i = projectiles.length - 1; i >= 0; i -= 1) {
    const projectile = projectiles[i] as BallisticProjectile;
    const start = projectile.position.clone();

    if (projectile.drag > 0) {
      const speed = projectile.velocity.length();
      projectile.velocity.addScaledVector(projectile.velocity.clone().normalize(), -projectile.drag * speed * speed * dt);
    }
    projectile.velocity.y -= gravity * dt;
    projectile.position.addScaledVector(projectile.velocity, dt);
    projectile.life -= dt;

    const segment = projectile.position.clone().sub(start);
    const travelled = segment.length();
    let hit: CombatTarget | null = null;
    let hitDistance = Number.POSITIVE_INFINITY;

    if (travelled > 1e-5) {
      const direction = segment.clone().divideScalar(travelled);
      for (const target of targets) {
        if (!target.combatant.alive || target.combatant.team === projectile.team) continue;
        const toCentre = target.collider.position.clone().sub(start);
        const along = toCentre.dot(direction);
        if (along < -target.collider.radius || along > travelled + target.collider.radius) continue;
        const closest = start.clone().addScaledVector(direction, Math.max(0, Math.min(travelled, along)));
        const gap = closest.distanceTo(target.collider.position);
        if (gap <= target.collider.radius + projectile.radius && along < hitDistance) {
          hit = target;
          hitDistance = along;
        }
      }
    }

    const ground = groundHeight(projectile.position.x, projectile.position.z);
    const hitGround = projectile.position.y <= ground;
    if (!hit && !hitGround && projectile.life > 0) continue;

    const impactPoint = hit
      ? start.clone().addScaledVector(segment.clone().normalize(), hitDistance)
      : hitGround
        ? new THREE.Vector3(projectile.position.x, ground, projectile.position.z)
        : projectile.position.clone();

    const events: DamageEvent[] = [];
    if (hit) {
      const event = hit.combatant.applyDamage(projectile.damage, projectile.type, projectile.sourceId, impactPoint);
      if (event) events.push(event);
      if (projectile.knockback > 0 && hit.applyImpulse) {
        hit.applyImpulse(projectile.velocity.clone().normalize().multiplyScalar(projectile.knockback));
      }
    }

    if (projectile.splashRadius > 0) {
      for (const target of targets) {
        if (!target.combatant.alive || target.combatant.team === projectile.team) continue;
        if (hit && target === hit) continue;
        const distance = target.collider.position.distanceTo(impactPoint);
        if (distance > projectile.splashRadius) continue;
        // Linear falloff to the edge of the blast.
        const falloff = 1 - distance / projectile.splashRadius;
        const event = target.combatant.applyDamage(projectile.damage * falloff, 'explosive', projectile.sourceId, target.collider.position);
        if (event) events.push(event);
        if (target.applyImpulse) {
          const push = target.collider.position.clone().sub(impactPoint).normalize();
          target.applyImpulse(push.multiplyScalar(projectile.knockback * falloff).setY(projectile.knockback * falloff * 0.6));
        }
      }
    }

    onImpact({ projectile, position: impactPoint, hitTargetId: hit?.combatant.id ?? null, events });
    projectiles.splice(i, 1);
  }
}

export interface HitscanShot {
  readonly origin: THREE.Vector3;
  readonly direction: THREE.Vector3;
  readonly range: number;
  readonly damage: number;
  readonly type: DamageType;
  readonly sourceId: string;
  readonly team: string;
  /** Damage retained at maximum range, 0..1. */
  readonly falloff?: number;
  /** How many targets the shot passes through. */
  readonly penetration?: number;
  readonly spread?: number;
  readonly criticalChance?: number;
}

export interface HitscanResult {
  readonly endPoint: THREE.Vector3;
  readonly events: readonly DamageEvent[];
}

/** Instant-hit weapons: ray against target spheres with falloff and penetration. */
export function resolveHitscan(
  shot: HitscanShot,
  targets: readonly CombatTarget[],
  groundHeight: (x: number, z: number) => number,
  random: () => number = Math.random,
): HitscanResult {
  const direction = shot.direction.clone().normalize();
  if (shot.spread && shot.spread > 0) {
    direction
      .add(new THREE.Vector3((random() - 0.5) * shot.spread, (random() - 0.5) * shot.spread, (random() - 0.5) * shot.spread))
      .normalize();
  }

  const hits = targets
    .filter((t) => t.combatant.alive && t.combatant.team !== shot.team)
    .map((target) => {
      const toCentre = target.collider.position.clone().sub(shot.origin);
      const along = toCentre.dot(direction);
      if (along < 0 || along > shot.range) return null;
      const closest = shot.origin.clone().addScaledVector(direction, along);
      const gap = closest.distanceTo(target.collider.position);
      return gap <= target.collider.radius ? { target, distance: along } : null;
    })
    .filter((hit): hit is { target: CombatTarget; distance: number } => hit !== null)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(1, shot.penetration ?? 1));

  const events: DamageEvent[] = [];
  for (const [index, hit] of hits.entries()) {
    const rangeFactor = 1 - (hit.distance / shot.range) * (1 - (shot.falloff ?? 1));
    // Each additional target costs the shot 35% of what remains.
    const penetrationFactor = 0.65 ** index;
    const critical = random() < (shot.criticalChance ?? 0);
    const event = hit.target.combatant.applyDamage(
      shot.damage * rangeFactor * penetrationFactor,
      shot.type,
      shot.sourceId,
      hit.target.collider.position,
      critical,
    );
    if (event) events.push(event);
  }

  // The tracer stops at the last penetrated target, the ground, or maximum range.
  let endDistance = hits.length > 0 ? (hits[hits.length - 1] as { distance: number }).distance : shot.range;
  const steps = 24;
  for (let i = 1; i <= steps; i += 1) {
    const distance = (i / steps) * Math.min(endDistance, shot.range);
    const point = shot.origin.clone().addScaledVector(direction, distance);
    if (point.y <= groundHeight(point.x, point.z)) {
      endDistance = distance;
      break;
    }
  }
  return { endPoint: shot.origin.clone().addScaledVector(direction, endDistance), events };
}

export interface WeaponProfile {
  readonly name: string;
  readonly mode: 'melee' | 'projectile' | 'hitscan';
  readonly damage: number;
  readonly type: DamageType;
  /** Shots per second. */
  readonly fireRate: number;
  readonly magazine: number;
  readonly reloadSeconds: number;
  readonly muzzleVelocity?: number;
  readonly spread?: number;
  readonly range?: number;
  readonly reach?: number;
  readonly arc?: number;
  readonly splashRadius?: number;
  readonly knockback?: number;
  readonly criticalChance?: number;
}

/** Fire-rate, magazine and reload bookkeeping shared by every weapon mode. */
export class WeaponState {
  ammo: number;
  private cooldown = 0;
  private reloading = 0;

  constructor(readonly profile: WeaponProfile) {
    this.ammo = profile.magazine;
  }

  get isReloading(): boolean {
    return this.reloading > 0;
  }

  get reloadProgress(): number {
    return this.reloading <= 0 ? 1 : 1 - this.reloading / this.profile.reloadSeconds;
  }

  update(dt: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloading > 0) {
      this.reloading = Math.max(0, this.reloading - dt);
      if (this.reloading === 0) this.ammo = this.profile.magazine;
    }
  }

  canFire(): boolean {
    return this.cooldown <= 0 && this.reloading <= 0 && (this.profile.magazine === 0 || this.ammo > 0);
  }

  /** Consumes a shot. Returns false when the weapon could not fire. */
  fire(): boolean {
    if (!this.canFire()) return false;
    this.cooldown = 1 / Math.max(0.01, this.profile.fireRate);
    if (this.profile.magazine > 0) {
      this.ammo -= 1;
      if (this.ammo <= 0) this.reload();
    }
    return true;
  }

  reload(): void {
    if (this.reloading > 0 || this.ammo === this.profile.magazine) return;
    this.reloading = this.profile.reloadSeconds;
  }
}

void sphereOverlap;
