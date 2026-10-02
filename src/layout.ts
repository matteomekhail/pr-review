export type PaneId = 'list' | 'inspector' | 'description';
export type LayoutPreset = 'review' | 'diff' | 'read';

interface PaneSpec {
  variable: string;
  defaultWidth: number;
  minWidth: number;
  side: 'left' | 'right';
}

interface LayoutState {
  widths: Record<PaneId, number>;
  hidden: Record<PaneId, boolean>;
}

const STORAGE_KEY = 'layout.v3';
const MIN_CONTENT_WIDTH = 320;
const KEYBOARD_STEP = 24;

const PANES: Record<PaneId, PaneSpec> = {
  list: { variable: '--list-w', defaultWidth: 440, minWidth: 260, side: 'left' },
  inspector: { variable: '--inspector-w', defaultWidth: 300, minWidth: 220, side: 'right' },
  description: { variable: '--desc-w', defaultWidth: 520, minWidth: 260, side: 'left' },
};

const PANE_IDS = Object.keys(PANES) as PaneId[];

function defaultState(): LayoutState {
  return {
    widths: { list: PANES.list.defaultWidth, inspector: PANES.inspector.defaultWidth, description: PANES.description.defaultWidth },
    hidden: { list: false, inspector: false, description: false },
  };
}

function isFiniteWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function loadState(): LayoutState {
  const fallback = defaultState();
  try {
    const saved: Partial<LayoutState> = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const widths = { ...fallback.widths };
    PANE_IDS.forEach((pane) => {
      const width = saved.widths?.[pane];
      if (isFiniteWidth(width)) widths[pane] = Math.max(PANES[pane].minWidth, width);
    });
    return { widths, hidden: { ...fallback.hidden, ...saved.hidden } };
  } catch {
    return fallback;
  }
}

export class Layout {
  private state = loadState();
  private readonly root: HTMLElement;
  private readonly onChange: () => void;

  constructor(root: HTMLElement, onChange: () => void) {
    this.root = root;
    this.onChange = onChange;
    this.apply();
    root.querySelectorAll<HTMLElement>('[data-resize]').forEach((handle) => this.bindHandle(handle));
    window.addEventListener('resize', () => this.fitToWindow());
  }

  isHidden(pane: PaneId): boolean {
    return this.state.hidden[pane];
  }

  isFocused(): boolean {
    return (['list', 'inspector'] as const).every((pane) => this.state.hidden[pane]);
  }

  toggle(pane: PaneId): void {
    this.state.hidden[pane] = !this.state.hidden[pane];
    this.commit();
  }

  toggleFocus(): void {
    const shouldHide = !this.isFocused();
    (['list', 'inspector'] as const).forEach((pane) => (this.state.hidden[pane] = shouldHide));
    this.commit();
  }

  applyPreset(preset: LayoutPreset): void {
    const total = this.root.clientWidth;
    const plans: Record<LayoutPreset, { list: number | 'min'; description: number }> = {
      review: { list: 0.24, description: 0.36 },
      diff: { list: 'min', description: 0.26 },
      read: { list: 'min', description: 0.62 },
    };
    const plan = plans[preset];
    this.state.hidden = { list: false, inspector: false, description: false };
    this.state.widths.list = plan.list === 'min' ? PANES.list.minWidth : Math.max(PANES.list.minWidth, Math.round(total * plan.list));
    this.state.widths.description = Math.max(PANES.description.minWidth, Math.round(total * plan.description));
    this.commit();
  }

  reset(): void {
    this.state = defaultState();
    this.commit();
  }

  refit(): void {
    this.fitToWindow();
  }

  private row(): PaneId[] {
    return this.root.classList.contains('mode-side') ? ['list', 'description'] : ['list', 'inspector'];
  }

  private visibleRow(): PaneId[] {
    return this.row().filter((pane) => !this.state.hidden[pane]);
  }

  private followers(pane: PaneId): PaneId[] {
    const row = this.visibleRow();
    return row.slice(row.indexOf(pane) + 1);
  }

  private maxWidthFor(pane: PaneId, snapshot: Record<PaneId, number>): number {
    const row = this.visibleRow();
    const before = row.slice(0, row.indexOf(pane)).reduce((total, candidate) => total + snapshot[candidate], 0);
    const afterMin = this.followers(pane).reduce((total, candidate) => total + PANES[candidate].minWidth, 0);
    return Math.max(PANES[pane].minWidth, this.root.clientWidth - before - afterMin - MIN_CONTENT_WIDTH);
  }

  private clamp(pane: PaneId, width: number, snapshot: Record<PaneId, number> = this.state.widths): number {
    return Math.round(Math.min(this.maxWidthFor(pane, snapshot), Math.max(PANES[pane].minWidth, width)));
  }

  private resizeTo(pane: PaneId, requested: number, snapshot: Record<PaneId, number>): void {
    const width = this.clamp(pane, requested, snapshot);
    const next = { ...snapshot, [pane]: width };
    const row = this.visibleRow();
    let overflow = row.reduce((total, candidate) => total + next[candidate], 0) + MIN_CONTENT_WIDTH - this.root.clientWidth;
    for (const follower of this.followers(pane)) {
      if (overflow <= 0) break;
      const take = Math.min(next[follower] - PANES[follower].minWidth, overflow);
      next[follower] -= take;
      overflow -= take;
    }
    this.state.widths = next;
  }

  private fitToWindow(): void {
    const panes = this.visibleRow();
    let overflow = panes.reduce((total, pane) => total + this.state.widths[pane], 0) + MIN_CONTENT_WIDTH - this.root.clientWidth;
    for (const pane of [...panes].reverse()) {
      if (overflow <= 0) break;
      const spare = this.state.widths[pane] - PANES[pane].minWidth;
      const take = Math.min(spare, overflow);
      this.state.widths[pane] -= take;
      overflow -= take;
    }
    this.apply();
  }

  private commit(): void {
    this.fitToWindow();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    this.onChange();
  }

  private apply(): void {
    PANE_IDS.forEach((pane) => {
      this.root.style.setProperty(PANES[pane].variable, `${this.state.widths[pane]}px`);
      this.root.classList.toggle(`hide-${pane}`, this.state.hidden[pane]);
    });
  }

  private bindHandle(handle: HTMLElement): void {
    const pane = handle.dataset.resize as PaneId;
    handle.tabIndex = -1;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.resizeTo(pane, PANES[pane].defaultWidth, { ...this.state.widths });
      this.commit();
    });
    handle.addEventListener('keydown', (event) => {
      const delta = event.key === 'ArrowLeft' ? -KEYBOARD_STEP : event.key === 'ArrowRight' ? KEYBOARD_STEP : 0;
      if (delta === 0) return;
      event.preventDefault();
      const direction = PANES[pane].side === 'left' ? 1 : -1;
      this.resizeTo(pane, this.state.widths[pane] + delta * direction, { ...this.state.widths });
      this.commit();
    });
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.state.hidden[pane]) return;
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const snapshot = { ...this.state.widths };
      const startWidth = snapshot[pane];
      const direction = PANES[pane].side === 'left' ? 1 : -1;
      document.body.classList.add('resizing');
      handle.classList.add('dragging');
      let frame = 0;
      const move = (moveEvent: PointerEvent): void => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          this.resizeTo(pane, startWidth + (moveEvent.clientX - startX) * direction, snapshot);
          this.apply();
        });
      };
      const end = (endEvent: PointerEvent): void => {
        cancelAnimationFrame(frame);
        if (handle.hasPointerCapture(endEvent.pointerId)) handle.releasePointerCapture(endEvent.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        document.body.classList.remove('resizing');
        handle.classList.remove('dragging');
        this.commit();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }
}
