/**
 * Persistent game state: versioned save slots, settings, localisation,
 * progression, inventory and quests. All of it survives an app restart and is
 * exposed to the automated save/load test the QA agent runs.
 */

export interface SaveEnvelope<T> {
  readonly version: number;
  readonly savedAt: string;
  readonly data: T;
}

export class SaveStore<T extends Record<string, unknown>> {
  constructor(
    private readonly key: string,
    private readonly version: number,
    private readonly defaults: T,
    private readonly migrate: (data: Record<string, unknown>, fromVersion: number) => T = (d) => ({ ...defaults, ...d }) as T,
  ) {}

  load(): T {
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return { ...this.defaults };
      const envelope = JSON.parse(raw) as SaveEnvelope<Record<string, unknown>>;
      if (typeof envelope?.version !== 'number') return { ...this.defaults };
      if (envelope.version === this.version) return { ...this.defaults, ...(envelope.data as T) };
      return this.migrate(envelope.data, envelope.version);
    } catch {
      // A corrupt save must never brick the product: fall back to defaults.
      return { ...this.defaults };
    }
  }

  save(data: T): boolean {
    try {
      const envelope: SaveEnvelope<T> = { version: this.version, savedAt: new Date().toISOString(), data };
      window.localStorage.setItem(this.key, JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    try {
      window.localStorage.removeItem(this.key);
    } catch {
      /* storage disabled */
    }
  }
}

export interface SettingsState extends Record<string, unknown> {
  quality: 'low' | 'medium' | 'high' | 'auto';
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  invertY: boolean;
  lookSensitivity: number;
  language: string;
  reducedMotion: boolean;
}

export const DEFAULT_SETTINGS: SettingsState = {
  quality: 'auto',
  masterVolume: 0.8,
  sfxVolume: 1,
  musicVolume: 0.55,
  invertY: false,
  lookSensitivity: 1,
  language: 'en',
  reducedMotion: false,
};

export type Dictionary = Readonly<Record<string, string>>;

/**
 * Minimal ICU-free localisation with `{placeholder}` interpolation and a
 * guaranteed fallback chain: requested language → English → the key itself.
 */
export class Localisation {
  private language: string;

  constructor(
    private readonly dictionaries: Readonly<Record<string, Dictionary>>,
    initialLanguage = 'en',
  ) {
    this.language = dictionaries[initialLanguage] ? initialLanguage : 'en';
  }

  get current(): string {
    return this.language;
  }

  get available(): string[] {
    return Object.keys(this.dictionaries);
  }

  setLanguage(language: string): void {
    if (this.dictionaries[language]) this.language = language;
  }

  t(key: string, params: Readonly<Record<string, string | number>> = {}): string {
    const template = this.dictionaries[this.language]?.[key] ?? this.dictionaries.en?.[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`));
  }
}

export interface ItemStack {
  readonly id: string;
  quantity: number;
}

export class Inventory {
  private readonly slots = new Map<string, ItemStack>();

  constructor(readonly capacity = 24) {}

  add(id: string, quantity = 1): boolean {
    const existing = this.slots.get(id);
    if (existing) {
      existing.quantity += quantity;
      return true;
    }
    if (this.slots.size >= this.capacity) return false;
    this.slots.set(id, { id, quantity });
    return true;
  }

  remove(id: string, quantity = 1): boolean {
    const existing = this.slots.get(id);
    if (!existing || existing.quantity < quantity) return false;
    existing.quantity -= quantity;
    if (existing.quantity <= 0) this.slots.delete(id);
    return true;
  }

  count(id: string): number {
    return this.slots.get(id)?.quantity ?? 0;
  }

  entries(): ItemStack[] {
    return [...this.slots.values()].map((s) => ({ id: s.id, quantity: s.quantity }));
  }

  serialise(): Record<string, number> {
    return Object.fromEntries([...this.slots.values()].map((s) => [s.id, s.quantity]));
  }

  restore(data: Readonly<Record<string, number>>): void {
    this.slots.clear();
    for (const [id, quantity] of Object.entries(data)) {
      if (quantity > 0) this.slots.set(id, { id, quantity });
    }
  }
}

export type QuestStatus = 'locked' | 'available' | 'active' | 'completed' | 'failed';

export interface QuestObjective {
  readonly id: string;
  readonly description: string;
  readonly target: number;
  progress: number;
}

export interface Quest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly objectives: QuestObjective[];
  readonly requires: readonly string[];
  status: QuestStatus;
}

export class QuestLog {
  private readonly quests = new Map<string, Quest>();
  private readonly listeners = new Set<(quest: Quest) => void>();

  constructor(definitions: readonly Quest[]) {
    for (const quest of definitions) {
      this.quests.set(quest.id, { ...quest, objectives: quest.objectives.map((o) => ({ ...o })) });
    }
    this.refreshAvailability();
  }

  onChange(listener: (quest: Quest) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  all(): Quest[] {
    return [...this.quests.values()];
  }

  get(id: string): Quest | undefined {
    return this.quests.get(id);
  }

  active(): Quest[] {
    return this.all().filter((q) => q.status === 'active');
  }

  start(id: string): boolean {
    const quest = this.quests.get(id);
    if (!quest || quest.status !== 'available') return false;
    quest.status = 'active';
    this.emit(quest);
    return true;
  }

  advance(questId: string, objectiveId: string, amount = 1): boolean {
    const quest = this.quests.get(questId);
    if (!quest || quest.status !== 'active') return false;
    const objective = quest.objectives.find((o) => o.id === objectiveId);
    if (!objective) return false;
    objective.progress = Math.min(objective.target, objective.progress + amount);
    if (quest.objectives.every((o) => o.progress >= o.target)) {
      quest.status = 'completed';
      this.refreshAvailability();
    }
    this.emit(quest);
    return true;
  }

  serialise(): Record<string, { status: QuestStatus; progress: Record<string, number> }> {
    return Object.fromEntries(
      this.all().map((q) => [
        q.id,
        { status: q.status, progress: Object.fromEntries(q.objectives.map((o) => [o.id, o.progress])) },
      ]),
    );
  }

  restore(data: Readonly<Record<string, { status: QuestStatus; progress: Record<string, number> }>>): void {
    for (const [id, saved] of Object.entries(data)) {
      const quest = this.quests.get(id);
      if (!quest) continue;
      quest.status = saved.status;
      for (const objective of quest.objectives) objective.progress = saved.progress[objective.id] ?? 0;
    }
    this.refreshAvailability();
  }

  private refreshAvailability(): void {
    const completed = new Set(this.all().filter((q) => q.status === 'completed').map((q) => q.id));
    for (const quest of this.quests.values()) {
      if (quest.status !== 'locked') continue;
      if (quest.requires.every((r) => completed.has(r))) quest.status = 'available';
    }
    for (const quest of this.quests.values()) {
      if (quest.status === 'locked' && quest.requires.length === 0) quest.status = 'available';
    }
  }

  private emit(quest: Quest): void {
    for (const listener of this.listeners) listener(quest);
  }
}

export interface ProgressionCurve {
  readonly baseXp: number;
  readonly exponent: number;
}

export class Progression {
  level = 1;
  xp = 0;

  constructor(private readonly curve: ProgressionCurve = { baseXp: 120, exponent: 1.45 }) {}

  xpForLevel(level: number): number {
    return Math.round(this.curve.baseXp * level ** this.curve.exponent);
  }

  /** Adds experience and returns how many levels were gained. */
  award(amount: number): number {
    this.xp += Math.max(0, amount);
    let gained = 0;
    while (this.xp >= this.xpForLevel(this.level)) {
      this.xp -= this.xpForLevel(this.level);
      this.level += 1;
      gained += 1;
    }
    return gained;
  }

  serialise(): { level: number; xp: number } {
    return { level: this.level, xp: this.xp };
  }

  restore(data: { level?: number; xp?: number }): void {
    this.level = Math.max(1, Math.floor(data.level ?? 1));
    this.xp = Math.max(0, data.xp ?? 0);
  }
}
