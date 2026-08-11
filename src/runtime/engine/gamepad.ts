/**
 * Virtual gamepad.
 *
 * Touch is the primary input for an Android build, so it gets a real control
 * surface rather than a few buttons: analogue sticks with configurable dead
 * zones and return-to-centre, a steering wheel with pedals for driving, a
 * d-pad, an action cluster, shoulder triggers with analogue travel, and haptic
 * feedback where the device supports it.
 *
 * Controls are laid out in viewport units and respect the safe-area insets, so
 * they stay reachable on notched and gesture-navigation devices. The whole
 * layer hides automatically when a physical gamepad is connected or when a
 * mouse is detected, and it is fully keyboard-shadowed for desktop play.
 */

export type ControlKind = 'stick' | 'button' | 'dpad' | 'wheel' | 'pedal' | 'trigger';

export interface ControlBase {
  readonly id: string;
  readonly kind: ControlKind;
  /** Anchor corner the control is positioned from. */
  readonly anchor: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'bottom-center';
  /** Offset from the anchor, in viewport-relative units (0..1 of min dimension). */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly label?: string;
}

export interface StickControl extends ControlBase {
  readonly kind: 'stick';
  /** Axis pair reported as `${id}X` / `${id}Y` in -1..1. */
  readonly deadZone?: number;
  /** When true the stick base follows the initial touch point. */
  readonly floating?: boolean;
}

export interface ButtonControl extends ControlBase {
  readonly kind: 'button' | 'trigger' | 'pedal';
  readonly action: string;
  /** Triggers and pedals report analogue travel from the press distance. */
  readonly analogue?: boolean;
  readonly haptic?: number;
}

export interface WheelControl extends ControlBase {
  readonly kind: 'wheel';
  /** Axis reported as `${id}` in -1..1. */
  readonly maxAngleDegrees?: number;
  readonly returnToCentre?: number;
}

export interface DpadControl extends ControlBase {
  readonly kind: 'dpad';
}

export type VirtualControl = StickControl | ButtonControl | WheelControl | DpadControl;

export interface GamepadLayout {
  readonly name: string;
  readonly controls: readonly VirtualControl[];
}

/** Twin-stick layout: movement left, look right, actions bottom-right. */
export const LAYOUT_TWIN_STICK: GamepadLayout = {
  name: 'twin-stick',
  controls: [
    { id: 'move', kind: 'stick', anchor: 'bottom-left', x: 0.14, y: 0.16, size: 0.19, floating: true, deadZone: 0.14 },
    { id: 'look', kind: 'stick', anchor: 'bottom-right', x: 0.14, y: 0.16, size: 0.17, floating: true, deadZone: 0.1 },
    { id: 'jump', kind: 'button', anchor: 'bottom-right', x: 0.34, y: 0.3, size: 0.1, action: 'jump', label: 'A', haptic: 12 },
    { id: 'primary', kind: 'button', anchor: 'bottom-right', x: 0.34, y: 0.14, size: 0.11, action: 'primary', label: '●', haptic: 18 },
    { id: 'interact', kind: 'button', anchor: 'bottom-right', x: 0.5, y: 0.24, size: 0.09, action: 'interact', label: 'E', haptic: 10 },
    { id: 'sprint', kind: 'trigger', anchor: 'top-left', x: 0.1, y: 0.1, size: 0.11, action: 'sprint', analogue: true },
    { id: 'menu', kind: 'button', anchor: 'top-right', x: 0.08, y: 0.07, size: 0.075, action: 'menu', label: '≡' },
  ],
};

/** Driving layout: steering wheel left, pedals right, gear buttons above. */
export const LAYOUT_DRIVING: GamepadLayout = {
  name: 'driving',
  controls: [
    { id: 'steer', kind: 'wheel', anchor: 'bottom-left', x: 0.2, y: 0.2, size: 0.3, maxAngleDegrees: 130, returnToCentre: 6 },
    { id: 'throttle', kind: 'pedal', anchor: 'bottom-right', x: 0.12, y: 0.2, size: 0.15, action: 'throttle', analogue: true, haptic: 6 },
    { id: 'brake', kind: 'pedal', anchor: 'bottom-right', x: 0.32, y: 0.16, size: 0.13, action: 'brake', analogue: true, haptic: 12 },
    { id: 'handbrake', kind: 'button', anchor: 'bottom-right', x: 0.5, y: 0.13, size: 0.1, action: 'handbrake', label: 'H', haptic: 24 },
    { id: 'shiftUp', kind: 'button', anchor: 'top-right', x: 0.1, y: 0.22, size: 0.085, action: 'shiftUp', label: '+' },
    { id: 'shiftDown', kind: 'button', anchor: 'top-right', x: 0.1, y: 0.38, size: 0.085, action: 'shiftDown', label: '−' },
    { id: 'lookBack', kind: 'button', anchor: 'top-left', x: 0.09, y: 0.09, size: 0.075, action: 'lookBack', label: '↺' },
  ],
};

/** Platformer/arcade layout: d-pad left, two-button cluster right. */
export const LAYOUT_ARCADE: GamepadLayout = {
  name: 'arcade',
  controls: [
    { id: 'dpad', kind: 'dpad', anchor: 'bottom-left', x: 0.16, y: 0.17, size: 0.22 },
    { id: 'jump', kind: 'button', anchor: 'bottom-right', x: 0.14, y: 0.15, size: 0.12, action: 'jump', label: 'A', haptic: 12 },
    { id: 'primary', kind: 'button', anchor: 'bottom-right', x: 0.33, y: 0.24, size: 0.12, action: 'primary', label: 'B', haptic: 16 },
  ],
};

export const LAYOUTS: Record<string, GamepadLayout> = {
  'twin-stick': LAYOUT_TWIN_STICK,
  driving: LAYOUT_DRIVING,
  arcade: LAYOUT_ARCADE,
};

export interface VirtualGamepadOptions {
  readonly layout?: GamepadLayout;
  readonly container?: HTMLElement;
  readonly opacity?: number;
  readonly accent?: string;
  /** Hides the overlay when a physical gamepad or a mouse is detected. */
  readonly autoHide?: boolean;
  readonly haptics?: boolean;
}

interface ActivePointer {
  readonly controlId: string;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
}

export class VirtualGamepad {
  private readonly root: HTMLElement;
  private readonly style: HTMLStyleElement;
  private readonly elements = new Map<string, HTMLElement>();
  private readonly pointers = new Map<number, ActivePointer>();
  private readonly axes = new Map<string, number>();
  private readonly buttons = new Map<string, number>();
  private readonly pressedThisFrame = new Set<string>();
  private readonly releasedThisFrame = new Set<string>();
  private layout: GamepadLayout;
  private readonly options: VirtualGamepadOptions;
  private visible = true;

  constructor(options: VirtualGamepadOptions = {}) {
    this.options = options;
    this.layout = options.layout ?? LAYOUT_TWIN_STICK;

    this.style = document.createElement('style');
    this.style.textContent = this.css(options.accent ?? '#7fd1ff', options.opacity ?? 0.42);
    document.head.appendChild(this.style);

    this.root = document.createElement('div');
    this.root.className = 'adaf-pad';
    (options.container ?? document.body).appendChild(this.root);

    this.build();
    window.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('gamepadconnected', this.onPhysicalGamepad);
    window.addEventListener('resize', this.onResize, { passive: true });

    if (options.autoHide !== false && !isTouchPrimary()) this.setVisible(false);
  }

  setLayout(layout: GamepadLayout): void {
    this.layout = layout;
    this.axes.clear();
    this.buttons.clear();
    this.build();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.style.display = visible ? 'block' : 'none';
  }

  /** Analogue axis in -1..1. Stick axes are suffixed X / Y. */
  axis(id: string): number {
    return this.axes.get(id) ?? 0;
  }

  /** Analogue button travel in 0..1; digital buttons report 0 or 1. */
  value(action: string): number {
    return this.buttons.get(action) ?? 0;
  }

  isHeld(action: string): boolean {
    return this.value(action) > 0.02;
  }

  wasPressed(action: string): boolean {
    return this.pressedThisFrame.has(action);
  }

  wasReleased(action: string): boolean {
    return this.releasedThisFrame.has(action);
  }

  /** Call once at the end of each simulation step. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();

    // Wheels self-centre when nothing is touching them.
    for (const control of this.layout.controls) {
      if (control.kind !== 'wheel') continue;
      const held = [...this.pointers.values()].some((p) => p.controlId === control.id);
      if (held) continue;
      const current = this.axes.get(control.id) ?? 0;
      if (Math.abs(current) < 0.002) {
        this.axes.set(control.id, 0);
      } else {
        const rate = (control as WheelControl).returnToCentre ?? 6;
        this.axes.set(control.id, current * Math.exp(-rate / 60));
      }
      this.paintWheel(control.id);
    }
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('gamepadconnected', this.onPhysicalGamepad);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
    this.style.remove();
  }

  // ------------------------------------------------------------ rendering --

  private unit(): number {
    return Math.min(window.innerWidth, window.innerHeight);
  }

  private build(): void {
    this.root.replaceChildren();
    this.elements.clear();
    const unit = this.unit();

    for (const control of this.layout.controls) {
      const element = document.createElement('div');
      element.className = `adaf-ctl adaf-${control.kind}`;
      element.dataset.control = control.id;
      const size = control.size * unit;
      element.style.width = `${size}px`;
      element.style.height = control.kind === 'pedal' ? `${size * 1.5}px` : `${size}px`;

      const offsetX = `${control.x * unit}px`;
      const offsetY = `${control.y * unit}px`;
      if (control.anchor.includes('bottom')) element.style.bottom = `calc(${offsetY} + env(safe-area-inset-bottom))`;
      else element.style.top = `calc(${offsetY} + env(safe-area-inset-top))`;
      if (control.anchor.includes('left')) element.style.left = `calc(${offsetX} + env(safe-area-inset-left))`;
      else if (control.anchor.includes('right')) element.style.right = `calc(${offsetX} + env(safe-area-inset-right))`;
      else {
        element.style.left = '50%';
        element.style.transform = 'translateX(-50%)';
      }

      if (control.kind === 'stick') element.innerHTML = '<i class="adaf-knob"></i>';
      else if (control.kind === 'wheel') element.innerHTML = '<i class="adaf-rim"></i><i class="adaf-spoke"></i>';
      else if (control.kind === 'dpad') element.innerHTML = '<b data-dir="up"></b><b data-dir="down"></b><b data-dir="left"></b><b data-dir="right"></b>';
      else if (control.kind === 'pedal') element.innerHTML = `<i class="adaf-travel"></i><span>${control.label ?? (control as ButtonControl).action}</span>`;
      else element.innerHTML = `<span>${control.label ?? ''}</span>`;

      this.root.appendChild(element);
      this.elements.set(control.id, element);
    }
  }

  private readonly onResize = (): void => this.build();

  private readonly onPhysicalGamepad = (): void => {
    if (this.options.autoHide !== false) this.setVisible(false);
  };

  private controlAt(x: number, y: number): VirtualControl | null {
    for (const control of this.layout.controls) {
      const element = this.elements.get(control.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      // Floating sticks claim their whole quadrant, which is how a good mobile
      // shooter feels: you put your thumb down anywhere and it works.
      if (control.kind === 'stick' && (control as StickControl).floating) {
        const leftHalf = control.anchor.includes('left');
        const inHalf = leftHalf ? x < window.innerWidth / 2 : x >= window.innerWidth / 2;
        if (inHalf && y > window.innerHeight * 0.28) return control;
        continue;
      }
      const pad = rect.width * 0.15;
      if (x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad) return control;
    }
    return null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.visible) return;
    const control = this.controlAt(event.clientX, event.clientY);
    if (!control) return;
    event.preventDefault();

    this.pointers.set(event.pointerId, {
      controlId: control.id,
      originX: event.clientX,
      originY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });

    const element = this.elements.get(control.id);
    element?.classList.add('is-active');

    if (control.kind === 'stick' && (control as StickControl).floating && element) {
      element.style.left = `${event.clientX - element.offsetWidth / 2}px`;
      element.style.top = `${event.clientY - element.offsetHeight / 2}px`;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    }
    this.applyPointer(control, event.clientX, event.clientY, true);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    pointer.currentX = event.clientX;
    pointer.currentY = event.clientY;
    const control = this.layout.controls.find((c) => c.id === pointer.controlId);
    if (control) this.applyPointer(control, event.clientX, event.clientY, false);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    this.pointers.delete(event.pointerId);
    const control = this.layout.controls.find((c) => c.id === pointer.controlId);
    if (!control) return;

    const element = this.elements.get(control.id);
    element?.classList.remove('is-active');

    if (control.kind === 'stick') {
      this.axes.set(`${control.id}X`, 0);
      this.axes.set(`${control.id}Y`, 0);
      this.paintStick(control.id, 0, 0);
      if ((control as StickControl).floating) this.build();
    } else if (control.kind === 'dpad') {
      for (const direction of ['up', 'down', 'left', 'right']) this.release(direction);
      this.axes.set('dpadX', 0);
      this.axes.set('dpadY', 0);
    } else if (control.kind !== 'wheel') {
      this.release((control as ButtonControl).action);
      const travel = element?.querySelector<HTMLElement>('.adaf-travel');
      if (travel) travel.style.height = '0%';
    }
  };

  private applyPointer(control: VirtualControl, x: number, y: number, initial: boolean): void {
    const element = this.elements.get(control.id);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2;

    switch (control.kind) {
      case 'stick': {
        const radius = rect.width / 2;
        let dx = (x - centreX) / radius;
        let dy = -(y - centreY) / radius;
        const magnitude = Math.hypot(dx, dy);
        if (magnitude > 1) {
          dx /= magnitude;
          dy /= magnitude;
        }
        const dead = (control as StickControl).deadZone ?? 0.12;
        const scaled = magnitude <= dead ? 0 : (magnitude - dead) / (1 - dead);
        const nx = magnitude > 0 ? (dx / Math.max(magnitude, 1e-4)) * scaled : 0;
        const ny = magnitude > 0 ? (dy / Math.max(magnitude, 1e-4)) * scaled : 0;
        this.axes.set(`${control.id}X`, nx);
        this.axes.set(`${control.id}Y`, ny);
        this.paintStick(control.id, dx, dy);
        break;
      }
      case 'wheel': {
        const angle = Math.atan2(y - centreY, x - centreX);
        const maximum = ((control as WheelControl).maxAngleDegrees ?? 120) * (Math.PI / 180);
        // Measured from the horizontal so grabbing either side steers naturally.
        const steer = Math.max(-1, Math.min(1, (angle > Math.PI / 2 ? angle - Math.PI : angle < -Math.PI / 2 ? angle + Math.PI : angle) / maximum));
        this.axes.set(control.id, steer);
        this.paintWheel(control.id);
        break;
      }
      case 'dpad': {
        const dx = (x - centreX) / (rect.width / 2);
        const dy = (y - centreY) / (rect.height / 2);
        const threshold = 0.25;
        this.setDirection('right', dx > threshold);
        this.setDirection('left', dx < -threshold);
        this.setDirection('down', dy > threshold);
        this.setDirection('up', dy < -threshold);
        this.axes.set('dpadX', Math.max(-1, Math.min(1, dx)));
        this.axes.set('dpadY', Math.max(-1, Math.min(1, -dy)));
        break;
      }
      case 'pedal':
      case 'trigger':
      case 'button':
      default: {
        const button = control as ButtonControl;
        let travel = 1;
        if (button.analogue) {
          const pointer = [...this.pointers.values()].find((p) => p.controlId === control.id);
          if (pointer) {
            const distance = (pointer.currentY - rect.top) / rect.height;
            travel = Math.max(0.08, Math.min(1, distance));
          }
          const bar = element.querySelector<HTMLElement>('.adaf-travel');
          if (bar) bar.style.height = `${travel * 100}%`;
        }
        this.press(button.action, travel, initial, button.haptic);
        break;
      }
    }
  }

  private setDirection(direction: string, active: boolean): void {
    if (active) this.press(direction, 1, !this.isHeld(direction));
    else this.release(direction);
    const dpad = this.elements.get('dpad');
    dpad?.querySelector(`[data-dir="${direction}"]`)?.classList.toggle('is-on', active);
  }

  private press(action: string, value: number, initial: boolean, haptic?: number): void {
    const previous = this.buttons.get(action) ?? 0;
    this.buttons.set(action, value);
    if (previous <= 0.02 && value > 0.02) {
      this.pressedThisFrame.add(action);
      if (initial && haptic && this.options.haptics !== false) navigator.vibrate?.(haptic);
    }
  }

  private release(action: string): void {
    if ((this.buttons.get(action) ?? 0) > 0.02) this.releasedThisFrame.add(action);
    this.buttons.set(action, 0);
  }

  private paintStick(id: string, dx: number, dy: number): void {
    const knob = this.elements.get(id)?.querySelector<HTMLElement>('.adaf-knob');
    if (knob) knob.style.transform = `translate(${dx * 34}%, ${-dy * 34}%)`;
  }

  private paintWheel(id: string): void {
    const spoke = this.elements.get(id)?.querySelector<HTMLElement>('.adaf-spoke');
    if (!spoke) return;
    const control = this.layout.controls.find((c) => c.id === id) as WheelControl | undefined;
    const maximum = control?.maxAngleDegrees ?? 120;
    spoke.style.transform = `rotate(${(this.axes.get(id) ?? 0) * maximum}deg)`;
  }

  private css(accent: string, opacity: number): string {
    return `
    .adaf-pad{position:fixed;inset:0;z-index:40;pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none}
    .adaf-ctl{position:absolute;pointer-events:auto;touch-action:none;display:grid;place-items:center;
      border-radius:50%;border:2px solid rgba(255,255,255,${opacity * 0.7});background:rgba(255,255,255,${opacity * 0.16});
      backdrop-filter:blur(6px);color:#fff;font:600 clamp(13px,3.4vw,20px)/1 system-ui,sans-serif;transition:background .12s}
    .adaf-ctl.is-active{background:${accent}55;border-color:${accent}}
    .adaf-stick .adaf-knob{width:44%;height:44%;border-radius:50%;background:rgba(255,255,255,${opacity + 0.2});
      transition:transform .05s linear;pointer-events:none}
    .adaf-wheel{border-width:0;background:none;backdrop-filter:none}
    .adaf-wheel .adaf-rim{position:absolute;inset:0;border-radius:50%;border:clamp(8px,2.4vw,16px) solid rgba(255,255,255,${opacity * 0.75})}
    .adaf-wheel .adaf-spoke{position:absolute;left:50%;top:50%;width:78%;height:clamp(6px,1.8vw,12px);
      transform-origin:50% 50%;translate:-50% -50%;background:rgba(255,255,255,${opacity + 0.15});border-radius:99px}
    .adaf-pedal{border-radius:18px;overflow:hidden;position:relative;flex-direction:column}
    .adaf-pedal .adaf-travel{position:absolute;left:0;right:0;bottom:0;height:0%;background:${accent}88;transition:height .05s linear}
    .adaf-pedal span{position:relative;z-index:1;text-transform:uppercase;letter-spacing:.06em;font-size:clamp(10px,2.4vw,13px)}
    .adaf-dpad{border-radius:22%;background:rgba(255,255,255,${opacity * 0.12})}
    .adaf-dpad b{position:absolute;background:rgba(255,255,255,${opacity * 0.55});border-radius:6px}
    .adaf-dpad b.is-on{background:${accent}}
    .adaf-dpad b[data-dir="up"]{left:36%;top:6%;width:28%;height:30%}
    .adaf-dpad b[data-dir="down"]{left:36%;bottom:6%;width:28%;height:30%}
    .adaf-dpad b[data-dir="left"]{top:36%;left:6%;height:28%;width:30%}
    .adaf-dpad b[data-dir="right"]{top:36%;right:6%;height:28%;width:30%}
    .adaf-trigger{border-radius:22%}
    @media (prefers-reduced-motion: reduce){.adaf-ctl,.adaf-stick .adaf-knob,.adaf-pedal .adaf-travel{transition:none}}`;
  }
}

export function isTouchPrimary(): boolean {
  return (navigator.maxTouchPoints ?? 0) > 0 && window.matchMedia?.('(pointer: coarse)').matches === true;
}
