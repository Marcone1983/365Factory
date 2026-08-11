import * as THREE from 'three';

/**
 * Vehicle dynamics.
 *
 * A raycast-suspension car model: each wheel casts a ray at the ground, the
 * spring/damper produces a normal load, and that load feeds a simplified
 * Pacejka tyre model which converts slip into longitudinal and lateral force.
 * Those forces are integrated on the chassis body.
 *
 * This is the standard architecture used by driving games because it captures
 * what players feel — weight transfer under braking, understeer as the front
 * tyres saturate, power-on oversteer, a handbrake that breaks the rear away —
 * without the cost and instability of full rigid-body wheel simulation.
 *
 * Everything is expressed in SI units so the tuning numbers mean something:
 * masses in kg, forces in N, torque in Nm, speeds in m/s.
 */

export interface TyreModel {
  /** Peak friction coefficient. ~1.0 road, ~1.6 slick, ~0.6 gravel, ~0.25 ice. */
  readonly grip: number;
  /** Pacejka stiffness: how quickly force builds with slip. */
  readonly stiffness: number;
  /** Pacejka shape factor. */
  readonly shape: number;
  /** Pacejka curvature: how sharply force falls away past the peak. */
  readonly curvature: number;
  /** Rolling resistance coefficient. */
  readonly rollingResistance: number;
}

export const TYRE_PRESETS: Record<'road' | 'sport' | 'slick' | 'gravel' | 'ice', TyreModel> = {
  road: { grip: 1.0, stiffness: 10, shape: 1.9, curvature: 0.97, rollingResistance: 0.014 },
  sport: { grip: 1.25, stiffness: 12, shape: 1.9, curvature: 0.97, rollingResistance: 0.013 },
  slick: { grip: 1.6, stiffness: 14, shape: 2.0, curvature: 0.98, rollingResistance: 0.011 },
  gravel: { grip: 0.68, stiffness: 7, shape: 1.6, curvature: 0.9, rollingResistance: 0.035 },
  ice: { grip: 0.22, stiffness: 5, shape: 1.4, curvature: 0.85, rollingResistance: 0.02 },
};

export interface SuspensionSpec {
  /** Uncompressed length in metres. */
  readonly restLength: number;
  /** Maximum travel from rest. */
  readonly travel: number;
  /** Spring rate in N/m. */
  readonly stiffness: number;
  /** Damping in Ns/m; separate values give real rebound control. */
  readonly compressionDamping: number;
  readonly reboundDamping: number;
  /** Anti-roll bar rate in N/m; resists differential compression across an axle. */
  readonly antiRoll: number;
}

export interface DrivetrainSpec {
  /** Peak engine torque in Nm. */
  readonly peakTorque: number;
  /** Engine speed of peak torque, rpm. */
  readonly peakTorqueRpm: number;
  readonly redlineRpm: number;
  readonly idleRpm: number;
  readonly gearRatios: readonly number[];
  readonly finalDrive: number;
  readonly reverseRatio: number;
  readonly drive: 'fwd' | 'rwd' | 'awd';
  /** 0 = open differential, 1 = fully locked. */
  readonly differentialLock: number;
  readonly shiftUpRpm: number;
  readonly shiftDownRpm: number;
  readonly shiftTimeSeconds: number;
}

export interface ChassisSpec {
  readonly mass: number;
  readonly wheelbase: number;
  readonly track: number;
  readonly wheelRadius: number;
  /** Height of the centre of gravity above the ground. Drives weight transfer. */
  readonly centreOfGravityHeight: number;
  /** Front weight distribution, 0..1. */
  readonly frontWeightBias: number;
  /** Yaw inertia in kg·m². */
  readonly yawInertia: number;
  /** Drag area: 0.5 · ρ · Cd · A. Multiply by v² for drag force. */
  readonly dragCoefficient: number;
  /** Downforce coefficient; multiply by v² for downward force. */
  readonly downforceCoefficient: number;
  readonly maxSteerAngle: number;
  readonly brakeTorque: number;
  readonly handbrakeTorque: number;
}

export interface VehicleInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  handbrake: boolean;
  /** Manual gear request; null leaves the automatic in control. */
  gearRequest: number | null;
}

export interface WheelState {
  readonly index: number;
  readonly isFront: boolean;
  readonly isLeft: boolean;
  /** Local mount position relative to the centre of gravity. */
  readonly localPosition: THREE.Vector3;
  worldPosition: THREE.Vector3;
  contact: boolean;
  suspensionLength: number;
  suspensionVelocity: number;
  load: number;
  slipRatio: number;
  slipAngle: number;
  angularVelocity: number;
  rotation: number;
  steerAngle: number;
  /** 0..1 how far into the friction circle this tyre is. */
  saturation: number;
  surfaceGrip: number;
}

export interface VehicleTelemetry {
  readonly speedKph: number;
  readonly rpm: number;
  readonly gear: number;
  readonly gearLabel: string;
  readonly throttle: number;
  readonly brake: number;
  readonly lateralG: number;
  readonly longitudinalG: number;
  readonly driftAngleDegrees: number;
  readonly wheelsOnGround: number;
  readonly airborne: boolean;
}

export type GroundSampler = (x: number, z: number) => { height: number; normal: THREE.Vector3; grip: number };

const RPM_TO_RAD = (2 * Math.PI) / 60;

/**
 * Simplified Pacejka magic formula.
 * F = D · sin(C · atan(B·slip − E·(B·slip − atan(B·slip))))
 */
function pacejka(slip: number, tyre: TyreModel, load: number): number {
  const B = tyre.stiffness;
  const C = tyre.shape;
  const D = tyre.grip * load;
  const E = tyre.curvature;
  const Bs = B * slip;
  return D * Math.sin(C * Math.atan(Bs - E * (Bs - Math.atan(Bs))));
}

export class VehicleController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  yaw = 0;
  yawRate = 0;
  pitch = 0;
  roll = 0;

  readonly wheels: WheelState[] = [];
  gear = 1;
  rpm: number;
  private shiftTimer = 0;
  private readonly acceleration = new THREE.Vector3();
  private lastVelocity = new THREE.Vector3();

  constructor(
    readonly chassis: ChassisSpec,
    readonly drivetrain: DrivetrainSpec,
    readonly suspension: SuspensionSpec,
    readonly tyre: TyreModel = TYRE_PRESETS.sport,
  ) {
    this.rpm = drivetrain.idleRpm;
    const halfBase = chassis.wheelbase / 2;
    const halfTrack = chassis.track / 2;
    const layout: Array<[boolean, boolean]> = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ];
    layout.forEach(([isFront, isLeft], index) => {
      this.wheels.push({
        index,
        isFront,
        isLeft,
        localPosition: new THREE.Vector3(isLeft ? -halfTrack : halfTrack, 0, isFront ? halfBase : -halfBase),
        worldPosition: new THREE.Vector3(),
        contact: false,
        suspensionLength: suspension.restLength,
        suspensionVelocity: 0,
        load: (chassis.mass * 9.81) / 4,
        slipRatio: 0,
        slipAngle: 0,
        angularVelocity: 0,
        rotation: 0,
        steerAngle: 0,
        saturation: 0,
        surfaceGrip: 1,
      });
    });
  }

  get speed(): number {
    return this.velocity.length();
  }

  /** Signed forward speed: negative when reversing. */
  get forwardSpeed(): number {
    return this.velocity.x * Math.sin(this.yaw) + this.velocity.z * Math.cos(this.yaw);
  }

  get lateralSpeed(): number {
    return this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw);
  }

  /** Engine torque at the current rpm, from a smooth torque curve. */
  engineTorque(throttle: number): number {
    const { peakTorque, peakTorqueRpm, redlineRpm, idleRpm } = this.drivetrain;
    if (this.rpm >= redlineRpm) return 0;
    const normalised = (this.rpm - idleRpm) / Math.max(1, peakTorqueRpm - idleRpm);
    // Rises to the peak, then falls away toward the limiter.
    const curve =
      this.rpm <= peakTorqueRpm
        ? 0.55 + 0.45 * Math.sin(Math.min(1, Math.max(0, normalised)) * Math.PI * 0.5)
        : 1 - 0.42 * ((this.rpm - peakTorqueRpm) / Math.max(1, redlineRpm - peakTorqueRpm)) ** 1.5;
    // Engine braking when off-throttle.
    const braking = (1 - throttle) * -0.09 * peakTorque * (this.rpm / redlineRpm);
    return peakTorque * Math.max(0, curve) * throttle + braking;
  }

  private currentRatio(): number {
    if (this.gear === 0) return 0;
    if (this.gear < 0) return -this.drivetrain.reverseRatio;
    return this.drivetrain.gearRatios[this.gear - 1] ?? (this.drivetrain.gearRatios[this.drivetrain.gearRatios.length - 1] as number);
  }

  private updateGearbox(dt: number, input: VehicleInput): void {
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      return;
    }
    if (input.gearRequest !== null) {
      if (input.gearRequest !== this.gear) {
        this.gear = input.gearRequest;
        this.shiftTimer = this.drivetrain.shiftTimeSeconds;
      }
      return;
    }
    // Automatic: reverse when asking to brake at a standstill, otherwise shift
    // on rpm thresholds.
    if (this.forwardSpeed < 0.6 && input.brake > 0.5 && this.gear > 0) {
      this.gear = -1;
      this.shiftTimer = this.drivetrain.shiftTimeSeconds;
      return;
    }
    if (this.gear < 0 && input.throttle > 0.5 && this.forwardSpeed > -0.4) {
      this.gear = 1;
      this.shiftTimer = this.drivetrain.shiftTimeSeconds;
      return;
    }
    if (this.gear > 0) {
      if (this.rpm > this.drivetrain.shiftUpRpm && this.gear < this.drivetrain.gearRatios.length) {
        this.gear += 1;
        this.shiftTimer = this.drivetrain.shiftTimeSeconds;
      } else if (this.rpm < this.drivetrain.shiftDownRpm && this.gear > 1) {
        this.gear -= 1;
        this.shiftTimer = this.drivetrain.shiftTimeSeconds;
      }
    }
  }

  /** One fixed simulation step. */
  update(dt: number, input: VehicleInput, ground: GroundSampler): void {
    const { chassis, suspension, drivetrain } = this;
    this.lastVelocity.copy(this.velocity);
    this.updateGearbox(dt, input);

    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    this.forward.set(sinYaw, 0, cosYaw);
    const right = new THREE.Vector3(cosYaw, 0, -sinYaw);

    // Speed-sensitive steering: full lock at parking speed, progressively less
    // at velocity, which is what stops a keyboard input from spinning the car.
    const speed = this.speed;
    const steerScale = 1 / (1 + speed * 0.045);
    const targetSteer = input.steer * chassis.maxSteerAngle * steerScale;

    // --- suspension ------------------------------------------------------
    let totalLoad = 0;
    let wheelsDown = 0;
    for (const wheel of this.wheels) {
      const offset = right.clone().multiplyScalar(wheel.localPosition.x).add(this.forward.clone().multiplyScalar(wheel.localPosition.z));
      wheel.worldPosition.copy(this.position).add(offset);
      wheel.steerAngle = wheel.isFront ? ackermann(targetSteer, wheel, chassis) : 0;

      const sample = ground(wheel.worldPosition.x, wheel.worldPosition.z);
      wheel.surfaceGrip = sample.grip;
      const rayStart = this.position.y + wheel.localPosition.z * Math.sin(this.pitch) - wheel.localPosition.x * Math.sin(this.roll);
      const distance = rayStart - sample.height - chassis.wheelRadius;
      const previousLength = wheel.suspensionLength;
      const compressed = Math.min(suspension.restLength + suspension.travel, Math.max(0, distance));

      wheel.contact = distance < suspension.restLength + suspension.travel;
      wheel.suspensionLength = compressed;
      wheel.suspensionVelocity = (previousLength - compressed) / Math.max(1e-4, dt);

      if (wheel.contact) {
        const compression = suspension.restLength - compressed;
        const damping = wheel.suspensionVelocity > 0 ? suspension.compressionDamping : suspension.reboundDamping;
        wheel.load = Math.max(0, compression * suspension.stiffness + wheel.suspensionVelocity * damping);
        wheelsDown += 1;
      } else {
        wheel.load = 0;
      }
      totalLoad += wheel.load;
    }

    // Anti-roll bars couple the wheels on each axle.
    for (const axleFront of [true, false]) {
      const left = this.wheels.find((w) => w.isFront === axleFront && w.isLeft) as WheelState;
      const rightWheel = this.wheels.find((w) => w.isFront === axleFront && !w.isLeft) as WheelState;
      const delta = left.suspensionLength - rightWheel.suspensionLength;
      const transfer = delta * suspension.antiRoll;
      left.load = Math.max(0, left.load - transfer);
      rightWheel.load = Math.max(0, rightWheel.load + transfer);
    }

    // Aerodynamic downforce adds load without adding mass.
    const downforce = chassis.downforceCoefficient * speed * speed;
    if (totalLoad > 0) {
      for (const wheel of this.wheels) wheel.load += (wheel.load / totalLoad) * downforce;
    }

    // --- drivetrain ------------------------------------------------------
    const ratio = this.currentRatio() * drivetrain.finalDrive;
    const drivenWheels = this.wheels.filter((w) =>
      drivetrain.drive === 'awd' ? true : drivetrain.drive === 'fwd' ? w.isFront : !w.isFront,
    );
    const throttle = this.shiftTimer > 0 ? 0 : Math.max(0, Math.min(1, input.throttle));
    const torque = ratio === 0 ? 0 : this.engineTorque(throttle) * Math.abs(ratio) * Math.sign(ratio);
    const perWheelTorque = drivenWheels.length > 0 ? torque / drivenWheels.length : 0;

    // --- tyre forces ------------------------------------------------------
    const force = new THREE.Vector3();
    let yawMoment = 0;

    for (const wheel of this.wheels) {
      if (!wheel.contact || wheel.load <= 0) {
        wheel.slipRatio = 0;
        wheel.slipAngle = 0;
        wheel.saturation = 0;
        // Free-spinning wheels still rotate for the visual.
        wheel.rotation += wheel.angularVelocity * dt;
        continue;
      }

      const wheelForward = wheel.steerAngle === 0
        ? this.forward.clone()
        : this.forward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), wheel.steerAngle);
      const wheelRight = new THREE.Vector3(wheelForward.z, 0, -wheelForward.x);

      // Contact-patch velocity includes the yaw contribution at this corner.
      const lever = wheel.worldPosition.clone().sub(this.position);
      const patchVelocity = this.velocity.clone().add(new THREE.Vector3(-lever.z, 0, lever.x).multiplyScalar(this.yawRate));
      const vForward = patchVelocity.dot(wheelForward);
      const vLateral = patchVelocity.dot(wheelRight);

      const isDriven = drivenWheels.includes(wheel);
      const driveTorque = isDriven ? perWheelTorque : 0;
      const braking = (input.brake * chassis.brakeTorque) / 4 + (input.handbrake && !wheel.isFront ? chassis.handbrakeTorque / 2 : 0);

      // Wheel spin integration: drive torque accelerates it, road reaction and
      // braking slow it. This is what produces wheelspin and lockup.
      const inertia = 1.6;
      const roadReaction = -wheel.slipRatio * wheel.load * this.tyre.grip * chassis.wheelRadius * 0.06;
      const brakeSign = wheel.angularVelocity > 0 ? -1 : wheel.angularVelocity < 0 ? 1 : 0;
      wheel.angularVelocity += ((driveTorque + roadReaction + braking * brakeSign) / inertia) * dt;
      if (braking > 0 && Math.abs(wheel.angularVelocity) < 0.6) wheel.angularVelocity = 0;
      wheel.rotation += wheel.angularVelocity * dt;

      const wheelSurfaceSpeed = wheel.angularVelocity * chassis.wheelRadius;
      const denominator = Math.max(1.2, Math.abs(vForward));
      wheel.slipRatio = Math.max(-1.5, Math.min(1.5, (wheelSurfaceSpeed - vForward) / denominator));
      wheel.slipAngle = Math.atan2(-vLateral, denominator);

      const grip = this.tyre.grip * wheel.surfaceGrip;
      const scaledTyre: TyreModel = { ...this.tyre, grip };
      let longitudinal = pacejka(wheel.slipRatio, scaledTyre, wheel.load);
      let lateral = pacejka(wheel.slipAngle * 3, scaledTyre, wheel.load);

      // Friction circle: a tyre cannot deliver full grip in both axes at once.
      const limit = grip * wheel.load;
      const magnitude = Math.hypot(longitudinal, lateral);
      wheel.saturation = limit > 0 ? Math.min(1.5, magnitude / limit) : 0;
      if (magnitude > limit && magnitude > 0) {
        const scale = limit / magnitude;
        longitudinal *= scale;
        lateral *= scale;
      }

      const rolling = -Math.sign(vForward) * this.tyre.rollingResistance * wheel.load;
      const wheelForce = wheelForward.clone().multiplyScalar(longitudinal + rolling).add(wheelRight.clone().multiplyScalar(lateral));
      force.add(wheelForce);
      // Yaw moment about the centre of gravity.
      yawMoment += lever.x * wheelForce.z - lever.z * wheelForce.x;
    }

    // --- aerodynamics and integration ------------------------------------
    if (speed > 0.01) {
      force.addScaledVector(this.velocity.clone().normalize(), -chassis.dragCoefficient * speed * speed);
    }

    this.velocity.addScaledVector(force, dt / chassis.mass);
    this.yawRate += (yawMoment / chassis.yawInertia) * dt;
    // Yaw damping keeps the model stable at the fixed timestep.
    this.yawRate *= Math.exp(-2.4 * dt);
    this.yaw += this.yawRate * dt;

    if (wheelsDown === 0) {
      this.velocity.y -= 9.81 * dt;
    } else {
      const support = this.wheels.reduce((sum, w) => sum + w.load, 0);
      this.velocity.y += (support / chassis.mass - 9.81) * dt;
      this.velocity.y *= Math.exp(-6 * dt);
    }

    this.position.addScaledVector(this.velocity, dt);

    const centre = ground(this.position.x, this.position.z);
    const rideHeight = centre.height + suspension.restLength + chassis.wheelRadius;
    if (this.position.y < rideHeight) {
      this.position.y = rideHeight;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }

    // Body attitude from weight transfer, purely visual but read as feel.
    this.acceleration.copy(this.velocity).sub(this.lastVelocity).divideScalar(Math.max(1e-4, dt));
    const longitudinalG = this.acceleration.dot(this.forward) / 9.81;
    const lateralG = this.acceleration.dot(right) / 9.81;
    const targetPitch = THREE.MathUtils.clamp(-longitudinalG * 0.045, -0.12, 0.12);
    const targetRoll = THREE.MathUtils.clamp(lateralG * 0.055, -0.14, 0.14);
    this.pitch += (targetPitch - this.pitch) * Math.min(1, 8 * dt);
    this.roll += (targetRoll - this.roll) * Math.min(1, 8 * dt);

    // Engine speed follows the driven wheels through the gearbox.
    if (ratio !== 0) {
      const drivenSpeed = drivenWheels.reduce((sum, w) => sum + Math.abs(w.angularVelocity), 0) / Math.max(1, drivenWheels.length);
      const target = (drivenSpeed * Math.abs(ratio)) / RPM_TO_RAD;
      this.rpm += (Math.max(drivetrain.idleRpm, Math.min(drivetrain.redlineRpm, target)) - this.rpm) * Math.min(1, 9 * dt);
    } else {
      const target = drivetrain.idleRpm + throttle * (drivetrain.redlineRpm - drivetrain.idleRpm) * 0.75;
      this.rpm += (target - this.rpm) * Math.min(1, 5 * dt);
    }
  }

  telemetry(): VehicleTelemetry {
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wheelsOnGround = this.wheels.filter((w) => w.contact).length;
    const drift = Math.abs(this.forwardSpeed) < 0.5 ? 0 : Math.atan2(this.lateralSpeed, Math.abs(this.forwardSpeed));
    return {
      speedKph: this.speed * 3.6,
      rpm: Math.round(this.rpm),
      gear: this.gear,
      gearLabel: this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : String(this.gear),
      throttle: 0,
      brake: 0,
      lateralG: this.acceleration.dot(right) / 9.81,
      longitudinalG: this.acceleration.dot(this.forward) / 9.81,
      driftAngleDegrees: THREE.MathUtils.radToDeg(drift),
      wheelsOnGround,
      airborne: wheelsOnGround === 0,
    };
  }

  /** Applies the body transform and wheel poses to a loaded vehicle model. */
  applyToModel(body: THREE.Object3D, wheelNodes: readonly (THREE.Object3D | undefined)[]): void {
    body.position.copy(this.position);
    body.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    wheelNodes.forEach((node, index) => {
      const wheel = this.wheels[index];
      if (!node || !wheel) return;
      node.position.y = this.chassis.wheelRadius - (wheel.suspensionLength - this.suspension.restLength);
      node.rotation.set(-wheel.rotation, wheel.steerAngle, 0, 'YXZ');
    });
  }

  /** Chase camera with speed-dependent pull-back and drift-aware framing. */
  applyChaseCamera(camera: THREE.PerspectiveCamera, dt: number, distance = 7.5, height = 2.9): void {
    const pullback = distance + Math.min(4, this.speed * 0.09);
    const target = new THREE.Vector3(
      this.position.x - Math.sin(this.yaw) * pullback,
      this.position.y + height,
      this.position.z - Math.cos(this.yaw) * pullback,
    );
    camera.position.lerp(target, Math.min(1, 6 * dt));
    camera.lookAt(this.position.x, this.position.y + 0.8, this.position.z);
    camera.fov = THREE.MathUtils.lerp(camera.fov, 62 + Math.min(18, this.speed * 0.36), Math.min(1, 3 * dt));
    camera.updateProjectionMatrix();
  }
}

/**
 * Ackermann steering: the inner wheel turns more than the outer one, which is
 * what stops a car from scrubbing its tyres through slow corners.
 */
function ackermann(steer: number, wheel: WheelState, chassis: ChassisSpec): number {
  if (Math.abs(steer) < 1e-4) return 0;
  const radius = chassis.wheelbase / Math.tan(Math.abs(steer));
  const half = chassis.track / 2;
  const inner = steer > 0 ? !wheel.isLeft : wheel.isLeft;
  const adjusted = Math.atan(chassis.wheelbase / (radius + (inner ? -half : half)));
  return Math.sign(steer) * adjusted;
}

/** Preset chassis/drivetrain packages matching the vehicle model generator. */
export const VEHICLE_PRESETS: Record<'hypercar' | 'rally' | 'muscle' | 'formula' | 'offroad', {
  chassis: ChassisSpec;
  drivetrain: DrivetrainSpec;
  suspension: SuspensionSpec;
  tyre: TyreModel;
}> = {
  hypercar: {
    chassis: { mass: 1420, wheelbase: 2.65, track: 1.68, wheelRadius: 0.35, centreOfGravityHeight: 0.42, frontWeightBias: 0.42, yawInertia: 1900, dragCoefficient: 0.44, downforceCoefficient: 1.9, maxSteerAngle: 0.55, brakeTorque: 9200, handbrakeTorque: 4200 },
    drivetrain: { peakTorque: 780, peakTorqueRpm: 5600, redlineRpm: 8600, idleRpm: 900, gearRatios: [3.1, 2.15, 1.62, 1.28, 1.03, 0.84, 0.7], finalDrive: 3.4, reverseRatio: 2.9, drive: 'awd', differentialLock: 0.6, shiftUpRpm: 8100, shiftDownRpm: 3200, shiftTimeSeconds: 0.11 },
    suspension: { restLength: 0.34, travel: 0.16, stiffness: 62_000, compressionDamping: 5200, reboundDamping: 7400, antiRoll: 26_000 },
    tyre: TYRE_PRESETS.slick,
  },
  rally: {
    chassis: { mass: 1250, wheelbase: 2.5, track: 1.6, wheelRadius: 0.34, centreOfGravityHeight: 0.52, frontWeightBias: 0.55, yawInertia: 1650, dragCoefficient: 0.62, downforceCoefficient: 0.5, maxSteerAngle: 0.68, brakeTorque: 7400, handbrakeTorque: 6800 },
    drivetrain: { peakTorque: 520, peakTorqueRpm: 4600, redlineRpm: 7600, idleRpm: 950, gearRatios: [3.4, 2.3, 1.7, 1.32, 1.06, 0.88], finalDrive: 3.9, reverseRatio: 3.2, drive: 'awd', differentialLock: 0.85, shiftUpRpm: 7200, shiftDownRpm: 3000, shiftTimeSeconds: 0.09 },
    suspension: { restLength: 0.42, travel: 0.26, stiffness: 44_000, compressionDamping: 4600, reboundDamping: 6200, antiRoll: 14_000 },
    tyre: TYRE_PRESETS.gravel,
  },
  muscle: {
    chassis: { mass: 1720, wheelbase: 2.9, track: 1.7, wheelRadius: 0.37, centreOfGravityHeight: 0.5, frontWeightBias: 0.54, yawInertia: 2500, dragCoefficient: 0.68, downforceCoefficient: 0.22, maxSteerAngle: 0.5, brakeTorque: 8200, handbrakeTorque: 5200 },
    drivetrain: { peakTorque: 900, peakTorqueRpm: 4200, redlineRpm: 6800, idleRpm: 750, gearRatios: [2.97, 1.92, 1.35, 1.0, 0.78], finalDrive: 3.55, reverseRatio: 2.8, drive: 'rwd', differentialLock: 0.4, shiftUpRpm: 6400, shiftDownRpm: 2400, shiftTimeSeconds: 0.18 },
    suspension: { restLength: 0.38, travel: 0.18, stiffness: 48_000, compressionDamping: 4200, reboundDamping: 5800, antiRoll: 16_000 },
    tyre: TYRE_PRESETS.sport,
  },
  formula: {
    chassis: { mass: 795, wheelbase: 3.6, track: 1.6, wheelRadius: 0.34, centreOfGravityHeight: 0.28, frontWeightBias: 0.45, yawInertia: 1150, dragCoefficient: 0.9, downforceCoefficient: 4.6, maxSteerAngle: 0.36, brakeTorque: 13_500, handbrakeTorque: 0 },
    drivetrain: { peakTorque: 610, peakTorqueRpm: 10_500, redlineRpm: 14_500, idleRpm: 3500, gearRatios: [2.9, 2.2, 1.8, 1.52, 1.31, 1.14, 1.0, 0.88], finalDrive: 3.1, reverseRatio: 3.0, drive: 'rwd', differentialLock: 0.75, shiftUpRpm: 14_000, shiftDownRpm: 8000, shiftTimeSeconds: 0.04 },
    suspension: { restLength: 0.2, travel: 0.07, stiffness: 128_000, compressionDamping: 9000, reboundDamping: 12_000, antiRoll: 52_000 },
    tyre: TYRE_PRESETS.slick,
  },
  offroad: {
    chassis: { mass: 2350, wheelbase: 3.0, track: 1.82, wheelRadius: 0.45, centreOfGravityHeight: 0.78, frontWeightBias: 0.52, yawInertia: 3900, dragCoefficient: 0.95, downforceCoefficient: 0.1, maxSteerAngle: 0.6, brakeTorque: 9000, handbrakeTorque: 5600 },
    drivetrain: { peakTorque: 1050, peakTorqueRpm: 3200, redlineRpm: 5600, idleRpm: 700, gearRatios: [4.2, 2.6, 1.7, 1.24, 0.95, 0.75], finalDrive: 4.3, reverseRatio: 4.0, drive: 'awd', differentialLock: 0.95, shiftUpRpm: 5200, shiftDownRpm: 1800, shiftTimeSeconds: 0.22 },
    suspension: { restLength: 0.52, travel: 0.34, stiffness: 52_000, compressionDamping: 6200, reboundDamping: 8200, antiRoll: 9000 },
    tyre: TYRE_PRESETS.gravel,
  },
};
