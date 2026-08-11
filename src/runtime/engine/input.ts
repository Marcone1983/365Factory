import * as THREE from 'three';
import type { Engine, System } from './core';

/**
 * Unified input: keyboard, mouse/pointer, touch (with an on-screen stick and
 * action pad) and gamepad, normalised into a single action state so gameplay
 * code never branches on device type.
 */

export type ActionName = string;

export interface InputBindings {
  readonly keyboard: Readonly<Record<string, ActionName>>;
  readonly gamepadButtons: Readonly<Record<number, ActionName>>;
}

export const DEFAULT_BINDINGS: InputBindings = {
  keyboard: {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    Space: 'jump',
    ShiftLeft: 'sprint', ShiftRight: 'sprint',
    KeyE: 'interact',
    KeyF: 'primary',
    KeyQ: 'secondary',
    Tab: 'inventory',
    Escape: 'menu',
  },
  gamepadButtons: { 0: 'jump', 1: 'secondary', 2: 'interact', 3: 'inventory', 7: 'primary', 9: 'menu', 10: 'sprint' },
};

export interface PointerState {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly down: boolean;
  readonly locked: boolean;
}

export class InputSystem implements System {
  readonly name = 'input';

  readonly move = new THREE.Vector2();
  readonly look = new THREE.Vector2();
  pointer: PointerState = { x: 0, y: 0, deltaX: 0, deltaY: 0, down: false, locked: false };

  private readonly held = new Set<ActionName>();
  private readonly pressed = new Set<ActionName>();
  private readonly released = new Set<ActionName>();
  private readonly bindings: InputBindings;
  private readonly touchState = { stickId: -1, originX: 0, originY: 0, lookId: -1, lookX: 0, lookY: 0 };
  private canvas: HTMLCanvasElement | null = null;
  private touchUi: HTMLElement | null = null;
  private accumulatedLook = new THREE.Vector2();

  constructor(bindings: Partial<InputBindings> = {}) {
    this.bindings = {
      keyboard: { ...DEFAULT_BINDINGS.keyboard, ...(bindings.keyboard ?? {}) },
      gamepadButtons: { ...DEFAULT_BINDINGS.gamepadButtons, ...(bindings.gamepadButtons ?? {}) },
    };
  }

  init(app: Engine): void {
    this.canvas = app.canvas;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.addEventListener('contextmenu', this.preventDefault);
    if (isTouchDevice()) this.mountTouchControls(app.container);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas?.removeEventListener('contextmenu', this.preventDefault);
    this.touchUi?.remove();
  }

  /** Runs before gameplay systems so they observe a coherent snapshot. */
  update(): void {
    this.pollGamepad();
    this.move.set(
      (this.isHeld('right') ? 1 : 0) - (this.isHeld('left') ? 1 : 0),
      (this.isHeld('forward') ? 1 : 0) - (this.isHeld('back') ? 1 : 0),
    );
    if (this.touchState.stickId !== -1) this.move.copy(this.touchVector);
    if (this.move.lengthSq() > 1) this.move.normalize();
    if (this.gamepadAxes.lengthSq() > 0.02) this.move.copy(this.gamepadAxes);

    this.look.copy(this.accumulatedLook);
    this.accumulatedLook.set(0, 0);
    this.pointer = { ...this.pointer, deltaX: 0, deltaY: 0 };
  }

  /** Must be called at the very end of a frame by the game's last system. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
  }

  isHeld(action: ActionName): boolean {
    return this.held.has(action);
  }

  wasPressed(action: ActionName): boolean {
    return this.pressed.has(action);
  }

  wasReleased(action: ActionName): boolean {
    return this.released.has(action);
  }

  requestPointerLock(): void {
    this.canvas?.requestPointerLock?.();
  }

  private readonly touchVector = new THREE.Vector2();
  private readonly gamepadAxes = new THREE.Vector2();

  private press(action: ActionName): void {
    if (!this.held.has(action)) this.pressed.add(action);
    this.held.add(action);
  }

  private release(action: ActionName): void {
    if (this.held.delete(action)) this.released.add(action);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const action = this.bindings.keyboard[event.code];
    if (!action) return;
    if (event.code === 'Tab' || event.code === 'Space') event.preventDefault();
    this.press(action);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const action = this.bindings.keyboard[event.code];
    if (action) this.release(action);
  };

  private readonly onBlur = (): void => {
    for (const action of [...this.held]) this.release(action);
  };

  private readonly preventDefault = (event: Event): void => event.preventDefault();

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointer = { ...this.pointer, down: true, x: event.clientX, y: event.clientY };
    if (event.pointerType === 'touch') {
      const half = window.innerWidth / 2;
      if (event.clientX < half && this.touchState.stickId === -1) {
        this.touchState.stickId = event.pointerId;
        this.touchState.originX = event.clientX;
        this.touchState.originY = event.clientY;
      } else if (this.touchState.lookId === -1) {
        this.touchState.lookId = event.pointerId;
        this.touchState.lookX = event.clientX;
        this.touchState.lookY = event.clientY;
      }
      return;
    }
    this.press('primary');
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId === this.touchState.stickId) {
      const dx = event.clientX - this.touchState.originX;
      const dy = event.clientY - this.touchState.originY;
      const radius = 70;
      this.touchVector.set(
        Math.max(-1, Math.min(1, dx / radius)),
        Math.max(-1, Math.min(1, -dy / radius)),
      );
      return;
    }
    if (event.pointerId === this.touchState.lookId) {
      this.accumulatedLook.x += (event.clientX - this.touchState.lookX) * 0.006;
      this.accumulatedLook.y += (event.clientY - this.touchState.lookY) * 0.006;
      this.touchState.lookX = event.clientX;
      this.touchState.lookY = event.clientY;
      return;
    }
    if (this.pointer.locked) {
      this.accumulatedLook.x += event.movementX * 0.0022;
      this.accumulatedLook.y += event.movementY * 0.0022;
    }
    this.pointer = {
      ...this.pointer,
      x: event.clientX,
      y: event.clientY,
      deltaX: event.movementX,
      deltaY: event.movementY,
    };
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.touchState.stickId) {
      this.touchState.stickId = -1;
      this.touchVector.set(0, 0);
      return;
    }
    if (event.pointerId === this.touchState.lookId) {
      this.touchState.lookId = -1;
      return;
    }
    this.pointer = { ...this.pointer, down: false };
    this.release('primary');
  };

  private readonly onPointerLockChange = (): void => {
    this.pointer = { ...this.pointer, locked: document.pointerLockElement === this.canvas };
  };

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find((p): p is Gamepad => Boolean(p?.connected));
    if (!pad) {
      this.gamepadAxes.set(0, 0);
      return;
    }
    const deadzone = 0.18;
    const axis = (index: number): number => {
      const value = pad.axes[index] ?? 0;
      return Math.abs(value) < deadzone ? 0 : value;
    };
    this.gamepadAxes.set(axis(0), -axis(1));
    this.accumulatedLook.x += axis(2) * 0.05;
    this.accumulatedLook.y += axis(3) * 0.05;
    pad.buttons.forEach((button, index) => {
      const action = this.bindings.gamepadButtons[index];
      if (!action) return;
      if (button.pressed) this.press(action);
      else this.release(action);
    });
  }

  /** Creates the on-screen stick and action pad used on touch devices. */
  private mountTouchControls(container: HTMLElement): void {
    const layer = document.createElement('div');
    layer.className = 'adaf-touch-controls';
    layer.innerHTML = `
      <div class="adaf-stick" aria-hidden="true"><span></span></div>
      <div class="adaf-actions">
        <button type="button" data-action="jump" aria-label="Jump">A</button>
        <button type="button" data-action="interact" aria-label="Interact">E</button>
        <button type="button" data-action="primary" aria-label="Primary action">●</button>
      </div>`;
    const style = document.createElement('style');
    style.textContent = `
      .adaf-touch-controls{position:fixed;inset:0;pointer-events:none;z-index:20}
      .adaf-stick{position:absolute;left:5vw;bottom:8vh;width:34vw;max-width:150px;aspect-ratio:1;border-radius:50%;
        border:2px solid rgba(255,255,255,.28);background:rgba(255,255,255,.06)}
      .adaf-stick span{position:absolute;inset:32%;border-radius:50%;background:rgba(255,255,255,.32)}
      .adaf-actions{position:absolute;right:4vw;bottom:8vh;display:grid;gap:10px;justify-items:end;pointer-events:auto}
      .adaf-actions button{width:64px;height:64px;border-radius:50%;border:2px solid rgba(255,255,255,.3);
        background:rgba(12,16,28,.55);color:#fff;font:600 18px/1 system-ui,sans-serif;touch-action:none}
      .adaf-actions button:active{background:rgba(90,140,255,.55)}
      @media (pointer:fine){.adaf-touch-controls{display:none}}`;
    document.head.appendChild(style);
    container.appendChild(layer);
    this.touchUi = layer;

    layer.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
      const action = button.dataset.action as ActionName;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.press(action);
      });
      const stop = (event: Event): void => {
        event.preventDefault();
        this.release(action);
      };
      button.addEventListener('pointerup', stop);
      button.addEventListener('pointercancel', stop);
      button.addEventListener('pointerleave', stop);
    });
  }
}

export function isTouchDevice(): boolean {
  return (navigator.maxTouchPoints ?? 0) > 0 || window.matchMedia?.('(pointer: coarse)').matches === true;
}
