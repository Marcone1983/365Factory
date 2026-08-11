/**
 * DOM overlay UI toolkit.
 *
 * 3D products keep their interface in the DOM rather than in the WebGL canvas:
 * text stays crisp at every density, the OS reports it to accessibility
 * services, and it costs no draw calls. This module provides the primitives
 * (screens, HUD elements, dialogs, toasts) that generated games compose.
 */

export interface UiTheme {
  readonly accent: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly danger: string;
  readonly radius: string;
  readonly fontFamily: string;
}

export const DEFAULT_THEME: UiTheme = {
  accent: '#5ac8fa',
  surface: 'rgba(10, 14, 24, 0.86)',
  text: '#f2f5fb',
  muted: 'rgba(242, 245, 251, 0.62)',
  danger: '#ff5c6c',
  radius: '14px',
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};

function styleSheet(theme: UiTheme): string {
  return `
  .adaf-ui{position:fixed;inset:0;pointer-events:none;z-index:30;font-family:${theme.fontFamily};color:${theme.text}}
  .adaf-ui *{box-sizing:border-box}
  .adaf-hud{position:absolute;inset:0;padding:max(14px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))}
  .adaf-hud-top{display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
  .adaf-chip{background:${theme.surface};border:1px solid rgba(255,255,255,.12);border-radius:${theme.radius};
    padding:8px 12px;font-size:13px;line-height:1.3;backdrop-filter:blur(8px)}
  .adaf-chip b{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${theme.muted};font-weight:600}
  .adaf-bar{height:8px;border-radius:999px;background:rgba(255,255,255,.14);overflow:hidden;min-width:120px;margin-top:6px}
  .adaf-bar>i{display:block;height:100%;background:${theme.accent};transition:width .18s ease-out}
  .adaf-screen{position:absolute;inset:0;display:none;place-items:center;background:rgba(4,7,14,.72);
    backdrop-filter:blur(10px);pointer-events:auto;padding:24px}
  .adaf-screen[data-open="true"]{display:grid}
  .adaf-panel{width:min(520px,100%);background:${theme.surface};border:1px solid rgba(255,255,255,.14);
    border-radius:calc(${theme.radius} + 6px);padding:26px;box-shadow:0 24px 70px rgba(0,0,0,.55)}
  .adaf-panel h2{margin:0 0 6px;font-size:24px;letter-spacing:-.01em}
  .adaf-panel p{margin:0 0 18px;color:${theme.muted};font-size:14px;line-height:1.55}
  .adaf-actions{display:grid;gap:10px}
  .adaf-btn{appearance:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:${theme.text};
    border-radius:${theme.radius};padding:13px 16px;font-size:15px;font-weight:600;cursor:pointer;text-align:left}
  .adaf-btn:hover{background:rgba(255,255,255,.12)}
  .adaf-btn[data-variant="primary"]{background:${theme.accent};color:#04070e;border-color:transparent}
  .adaf-btn[data-variant="danger"]{border-color:${theme.danger};color:${theme.danger}}
  .adaf-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;
    border-bottom:1px solid rgba(255,255,255,.08)}
  .adaf-row:last-child{border-bottom:0}
  .adaf-row label{font-size:14px}
  .adaf-toasts{position:absolute;left:50%;transform:translateX(-50%);bottom:12%;display:grid;gap:8px;justify-items:center}
  .adaf-toast{background:${theme.surface};border:1px solid rgba(255,255,255,.14);border-radius:${theme.radius};
    padding:10px 16px;font-size:14px;animation:adaf-in .18s ease-out}
  .adaf-center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center}
  @keyframes adaf-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){.adaf-toast{animation:none}.adaf-bar>i{transition:none}}`;
}

export interface HudChip {
  readonly id: string;
  label: string;
  value: string;
  /** When present the chip renders a progress bar with this 0..1 fill. */
  progress?: number;
}

export class UiLayer {
  readonly root: HTMLElement;
  private readonly hudLeft: HTMLElement;
  private readonly hudRight: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly centre: HTMLElement;
  private readonly screens = new Map<string, HTMLElement>();
  private readonly chips = new Map<string, HTMLElement>();

  constructor(container: HTMLElement = document.body, theme: UiTheme = DEFAULT_THEME) {
    const style = document.createElement('style');
    style.textContent = styleSheet(theme);
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'adaf-ui';
    this.root.innerHTML = `
      <div class="adaf-hud">
        <div class="adaf-hud-top">
          <div class="adaf-hud-left" style="display:grid;gap:8px"></div>
          <div class="adaf-hud-right" style="display:grid;gap:8px;justify-items:end"></div>
        </div>
        <div class="adaf-center" hidden></div>
      </div>
      <div class="adaf-toasts"></div>`;
    container.appendChild(this.root);

    this.hudLeft = this.root.querySelector('.adaf-hud-left') as HTMLElement;
    this.hudRight = this.root.querySelector('.adaf-hud-right') as HTMLElement;
    this.toasts = this.root.querySelector('.adaf-toasts') as HTMLElement;
    this.centre = this.root.querySelector('.adaf-center') as HTMLElement;
  }

  setChip(chip: HudChip, side: 'left' | 'right' = 'left'): void {
    let element = this.chips.get(chip.id);
    if (!element) {
      element = document.createElement('div');
      element.className = 'adaf-chip';
      (side === 'left' ? this.hudLeft : this.hudRight).appendChild(element);
      this.chips.set(chip.id, element);
    }
    const bar = chip.progress === undefined ? '' : `<div class="adaf-bar"><i style="width:${Math.round(Math.max(0, Math.min(1, chip.progress)) * 100)}%"></i></div>`;
    element.innerHTML = `<b>${escapeHtml(chip.label)}</b>${escapeHtml(chip.value)}${bar}`;
  }

  removeChip(id: string): void {
    this.chips.get(id)?.remove();
    this.chips.delete(id);
  }

  setCentreMessage(html: string | null): void {
    if (html === null) {
      this.centre.hidden = true;
      this.centre.innerHTML = '';
      return;
    }
    this.centre.hidden = false;
    this.centre.innerHTML = html;
  }

  toast(message: string, durationMs = 2600): void {
    const element = document.createElement('div');
    element.className = 'adaf-toast';
    element.textContent = message;
    this.toasts.appendChild(element);
    window.setTimeout(() => element.remove(), durationMs);
  }

  /** Declares a modal screen (menu, settings, game over) and returns handles. */
  screen(
    id: string,
    definition: { title: string; body?: string; actions: Array<{ label: string; variant?: 'primary' | 'danger'; onSelect: () => void }> },
  ): { open: () => void; close: () => void; element: HTMLElement } {
    let element = this.screens.get(id);
    if (!element) {
      element = document.createElement('div');
      element.className = 'adaf-screen';
      element.dataset.screen = id;
      this.root.appendChild(element);
      this.screens.set(id, element);
    }
    const panel = document.createElement('div');
    panel.className = 'adaf-panel';
    panel.innerHTML = `<h2>${escapeHtml(definition.title)}</h2>${definition.body ? `<p>${definition.body}</p>` : ''}<div class="adaf-actions"></div>`;
    const actions = panel.querySelector('.adaf-actions') as HTMLElement;
    for (const action of definition.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'adaf-btn';
      if (action.variant) button.dataset.variant = action.variant;
      button.textContent = action.label;
      button.addEventListener('click', action.onSelect);
      actions.appendChild(button);
    }
    element.replaceChildren(panel);

    return {
      element,
      open: () => {
        for (const other of this.screens.values()) other.dataset.open = 'false';
        (element as HTMLElement).dataset.open = 'true';
      },
      close: () => {
        (element as HTMLElement).dataset.open = 'false';
      },
    };
  }

  closeAllScreens(): void {
    for (const screen of this.screens.values()) screen.dataset.open = 'false';
  }

  anyScreenOpen(): boolean {
    return [...this.screens.values()].some((s) => s.dataset.open === 'true');
  }

  /** Builds a settings row bound to a value, used by the settings screen. */
  static settingsRow(
    label: string,
    control: { kind: 'toggle'; value: boolean; onChange: (value: boolean) => void } | { kind: 'range'; value: number; min: number; max: number; step: number; onChange: (value: number) => void } | { kind: 'select'; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void },
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'adaf-row';
    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    row.appendChild(labelElement);

    if (control.kind === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = control.value;
      input.addEventListener('change', () => control.onChange(input.checked));
      row.appendChild(input);
    } else if (control.kind === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.value = String(control.value);
      input.addEventListener('input', () => control.onChange(Number(input.value)));
      row.appendChild(input);
    } else {
      const select = document.createElement('select');
      for (const option of control.options) {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        select.appendChild(element);
      }
      select.value = control.value;
      select.addEventListener('change', () => control.onChange(select.value));
      row.appendChild(select);
    }
    return row;
  }

  dispose(): void {
    this.root.remove();
    this.screens.clear();
    this.chips.clear();
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
