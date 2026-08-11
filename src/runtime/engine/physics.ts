import * as THREE from 'three';
import type { Heightfield } from './world';

/**
 * Lightweight physics: a uniform spatial hash for broad-phase queries, sphere
 * and AABB colliders, and a capsule character controller that walks a
 * heightfield with slope limits, step-up, gravity, jumping and coyote time.
 *
 * Deliberately not a full rigid-body engine: a mobile 3D game needs reliable
 * character motion, triggers and projectiles at a fraction of the cost, and
 * everything here is deterministic under a fixed timestep.
 */

export interface Collider {
  readonly id: string;
  readonly position: THREE.Vector3;
  readonly radius: number;
  /** Height for capsule-like colliders; 0 makes it a sphere. */
  readonly height: number;
  readonly solid: boolean;
  readonly tag: string;
  userData?: Record<string, unknown>;
}

export class SpatialHash {
  private readonly cells = new Map<string, Collider[]>();

  constructor(private readonly cellSize = 8) {}

  private key(x: number, z: number): string {
    return `${Math.floor(x / this.cellSize)}:${Math.floor(z / this.cellSize)}`;
  }

  clear(): void {
    this.cells.clear();
  }

  insert(collider: Collider): void {
    const key = this.key(collider.position.x, collider.position.z);
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(collider);
    else this.cells.set(key, [collider]);
  }

  rebuild(colliders: Iterable<Collider>): void {
    this.clear();
    for (const collider of colliders) this.insert(collider);
  }

  query(centre: THREE.Vector3, radius: number): Collider[] {
    const out: Collider[] = [];
    const span = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(centre.x / this.cellSize);
    const cz = Math.floor(centre.z / this.cellSize);
    for (let dz = -span; dz <= span; dz += 1) {
      for (let dx = -span; dx <= span; dx += 1) {
        const bucket = this.cells.get(`${cx + dx}:${cz + dz}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }
}

export function sphereOverlap(a: THREE.Vector3, ra: number, b: THREE.Vector3, rb: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  const r = ra + rb;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

export interface CharacterOptions {
  readonly radius?: number;
  readonly height?: number;
  readonly walkSpeed?: number;
  readonly sprintMultiplier?: number;
  readonly acceleration?: number;
  readonly airControl?: number;
  readonly jumpVelocity?: number;
  readonly gravity?: number;
  readonly maxSlopeDegrees?: number;
  readonly stepHeight?: number;
  readonly coyoteTime?: number;
}

export interface CharacterState {
  readonly grounded: boolean;
  readonly speed: number;
  readonly verticalVelocity: number;
  readonly onSteepSlope: boolean;
}

export class CharacterController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;

  private readonly radius: number;
  private readonly height: number;
  private readonly walkSpeed: number;
  private readonly sprintMultiplier: number;
  private readonly acceleration: number;
  private readonly airControl: number;
  private readonly jumpVelocity: number;
  private readonly gravity: number;
  private readonly maxSlope: number;
  private readonly stepHeight: number;
  private readonly coyoteTime: number;

  private grounded = false;
  private timeSinceGrounded = 0;
  private jumpQueued = false;
  private onSteep = false;

  private readonly desired = new THREE.Vector3();
  private readonly horizontal = new THREE.Vector3();

  constructor(options: CharacterOptions = {}) {
    this.radius = options.radius ?? 0.42;
    this.height = options.height ?? 1.75;
    this.walkSpeed = options.walkSpeed ?? 5.4;
    this.sprintMultiplier = options.sprintMultiplier ?? 1.7;
    this.acceleration = options.acceleration ?? 34;
    this.airControl = options.airControl ?? 0.28;
    this.jumpVelocity = options.jumpVelocity ?? 6.4;
    this.gravity = options.gravity ?? 21;
    this.maxSlope = Math.cos(THREE.MathUtils.degToRad(options.maxSlopeDegrees ?? 52));
    this.stepHeight = options.stepHeight ?? 0.45;
    this.coyoteTime = options.coyoteTime ?? 0.12;
  }

  queueJump(): void {
    this.jumpQueued = true;
  }

  get state(): CharacterState {
    return {
      grounded: this.grounded,
      speed: Math.hypot(this.velocity.x, this.velocity.z),
      verticalVelocity: this.velocity.y,
      onSteepSlope: this.onSteep,
    };
  }

  /**
   * Integrates one fixed step. `moveInput` is in local space (x = strafe,
   * y = forward) and is rotated by the controller's yaw.
   */
  update(dt: number, moveInput: THREE.Vector2, sprinting: boolean, field: Heightfield, colliders: readonly Collider[]): void {
    const speed = this.walkSpeed * (sprinting ? this.sprintMultiplier : 1);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.desired.set(
      (moveInput.x * cos - moveInput.y * sin) * speed,
      0,
      (moveInput.x * sin + moveInput.y * cos) * speed,
    );

    const control = this.grounded ? 1 : this.airControl;
    const blend = Math.min(1, this.acceleration * control * dt);
    this.velocity.x += (this.desired.x - this.velocity.x) * blend;
    this.velocity.z += (this.desired.z - this.velocity.z) * blend;

    this.velocity.y -= this.gravity * dt;
    if (this.jumpQueued && (this.grounded || this.timeSinceGrounded < this.coyoteTime) && !this.onSteep) {
      this.velocity.y = this.jumpVelocity;
      this.grounded = false;
      this.timeSinceGrounded = this.coyoteTime;
    }
    this.jumpQueued = false;

    this.horizontal.set(this.velocity.x * dt, 0, this.velocity.z * dt);
    this.position.add(this.horizontal);
    this.resolveHorizontal(colliders);

    this.position.y += this.velocity.y * dt;

    const ground = field.heightAt(this.position.x, this.position.z);
    const normal = field.normalAt(this.position.x, this.position.z);
    this.onSteep = normal.y < this.maxSlope;

    if (this.position.y <= ground) {
      // Step-up: small ledges are climbed instead of blocking motion.
      const rise = ground - this.position.y;
      if (rise > this.stepHeight && this.velocity.y <= 0 && this.onSteep) {
        this.position.sub(this.horizontal);
      }
      this.position.y = ground;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.grounded = true;
      this.timeSinceGrounded = 0;
      if (this.onSteep) {
        // Slide down slopes that are too steep to stand on.
        this.velocity.x += normal.x * this.gravity * dt * 0.85;
        this.velocity.z += normal.z * this.gravity * dt * 0.85;
      }
    } else {
      this.grounded = false;
      this.timeSinceGrounded += dt;
    }

    const bounds = field.size / 2 - this.radius;
    this.position.x = THREE.MathUtils.clamp(this.position.x, -bounds, bounds);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -bounds, bounds);
  }

  /** Pushes the capsule out of solid colliders along the shortest axis. */
  private resolveHorizontal(colliders: readonly Collider[]): void {
    for (const collider of colliders) {
      if (!collider.solid) continue;
      const dx = this.position.x - collider.position.x;
      const dz = this.position.z - collider.position.z;
      const minDistance = this.radius + collider.radius;
      const distance = Math.hypot(dx, dz);
      if (distance >= minDistance || distance === 0) continue;
      const verticalGap = Math.abs(this.position.y + this.height / 2 - (collider.position.y + collider.height / 2));
      if (verticalGap > (this.height + collider.height) / 2) continue;
      const push = (minDistance - distance) / distance;
      this.position.x += dx * push;
      this.position.z += dz * push;
      const into = (this.velocity.x * dx + this.velocity.z * dz) / (distance || 1);
      if (into < 0) {
        this.velocity.x -= (dx / distance) * into;
        this.velocity.z -= (dz / distance) * into;
      }
    }
  }

  /** Positions a camera behind and above the character (third person). */
  applyThirdPersonCamera(camera: THREE.PerspectiveCamera, field: Heightfield, distance = 7.5, elevation = 3.6): void {
    const offsetX = Math.sin(this.yaw) * distance;
    const offsetZ = Math.cos(this.yaw) * distance;
    const target = new THREE.Vector3(this.position.x - offsetX, this.position.y + elevation - this.pitch * 3, this.position.z - offsetZ);
    const groundAtCamera = field.heightAt(target.x, target.z) + 1.1;
    target.y = Math.max(target.y, groundAtCamera);
    camera.position.lerp(target, 0.22);
    camera.lookAt(this.position.x, this.position.y + this.height * 0.75, this.position.z);
  }

  /** Positions a camera at eye height (first person). */
  applyFirstPersonCamera(camera: THREE.PerspectiveCamera): void {
    camera.position.set(this.position.x, this.position.y + this.height * 0.92, this.position.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(this.yaw + Math.PI);
    camera.rotateX(-this.pitch);
  }
}

export interface RaycastHit {
  readonly collider: Collider;
  readonly distance: number;
}

/** Ray/sphere test against the broad-phase, nearest hit first. */
export function raycastColliders(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  hash: SpatialHash,
  filter?: (collider: Collider) => boolean,
): RaycastHit | null {
  const dir = direction.clone().normalize();
  const midpoint = origin.clone().addScaledVector(dir, maxDistance / 2);
  const candidates = hash.query(midpoint, maxDistance / 2 + 4);
  let best: RaycastHit | null = null;

  for (const collider of candidates) {
    if (filter && !filter(collider)) continue;
    const toCentre = collider.position.clone().sub(origin);
    const projection = toCentre.dot(dir);
    if (projection < 0 || projection > maxDistance) continue;
    const closest = origin.clone().addScaledVector(dir, projection);
    const gap = closest.distanceTo(collider.position);
    if (gap > collider.radius) continue;
    const distance = projection - Math.sqrt(Math.max(0, collider.radius * collider.radius - gap * gap));
    if (!best || distance < best.distance) best = { collider, distance: Math.max(0, distance) };
  }
  return best;
}

export interface Projectile {
  readonly id: string;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  life: number;
  readonly radius: number;
  readonly tag: string;
}

/** Advances projectiles, applying gravity and reporting collisions. */
export function stepProjectiles(
  projectiles: Projectile[],
  dt: number,
  gravity: number,
  field: Heightfield,
  hash: SpatialHash,
  onHit: (projectile: Projectile, hit: Collider | null) => void,
): void {
  for (let i = projectiles.length - 1; i >= 0; i -= 1) {
    const projectile = projectiles[i] as Projectile;
    projectile.velocity.y -= gravity * dt;
    projectile.position.addScaledVector(projectile.velocity, dt);
    projectile.life -= dt;

    const ground = field.heightAt(projectile.position.x, projectile.position.z);
    let hit: Collider | null = null;
    for (const collider of hash.query(projectile.position, projectile.radius + 2)) {
      if (sphereOverlap(projectile.position, projectile.radius, collider.position, collider.radius)) {
        hit = collider;
        break;
      }
    }
    if (hit || projectile.position.y <= ground || projectile.life <= 0) {
      onHit(projectile, hit);
      projectiles.splice(i, 1);
    }
  }
}
