import { closeWithMotion } from './motion';
import { SYSTEM_THEME_ID, THEMES, type AppTheme } from './themes';

interface ThemePickerHooks {
  current: () => string;
  preview: (id: string) => void;
  commit: (id: string) => void;
  cancel: () => void;
}

interface ThemeEntry {
  id: string;
  name: string;
  mode: string;
  swatch: string[];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function toEntry(theme: AppTheme): ThemeEntry {
  return { id: theme.id, name: theme.name, mode: theme.mode, swatch: [theme.colors.bg, theme.colors.accent, theme.colors.ok, theme.colors.bad, theme.colors.wait] };
}

const MODE_ORDER: Record<string, number> = { auto: 0, dark: 1, light: 2 };
const ENTRIES: readonly ThemeEntry[] = [{ id: SYSTEM_THEME_ID, name: 'System (follow macOS)', mode: 'auto', swatch: ['#0f1011', '#ffffff'] }, ...THEMES.map(toEntry)]
  .map((entry, index) => ({ entry, index }))
  .sort((left, right) => (MODE_ORDER[left.entry.mode] ?? 9) - (MODE_ORDER[right.entry.mode] ?? 9) || left.index - right.index)
  .map(({ entry }) => entry);
const SECTION_LABELS: Record<string, string> = { auto: '', dark: 'Dark', light: 'Light' };

export class ThemePicker {
  private readonly dialog: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly hooks: ThemePickerHooks;
  private results: ThemeEntry[] = [];
  private activeIndex = 0;
  private isCommitted = false;

  constructor(hooks: ThemePickerHooks) {
    this.hooks = hooks;
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'theme-picker';
    this.dialog.innerHTML = '<input placeholder="Search themes…" spellcheck="false" autocomplete="off" /><div class="theme-list" role="listbox"></div><footer><span><kbd>↑</kbd><kbd>↓</kbd> preview</span><span><kbd>↵</kbd> apply</span><span><kbd>esc</kbd> cancel</span></footer>';
    document.body.append(this.dialog);
    this.input = this.dialog.querySelector('input') as HTMLInputElement;
    this.list = this.dialog.querySelector('.theme-list') as HTMLElement;
    this.input.addEventListener('input', () => this.render(0));
    this.input.addEventListener('keydown', this.handleKey);
    this.list.addEventListener('click', this.handleClick);
    this.list.addEventListener('pointermove', this.handleHover);
    this.dialog.addEventListener('close', () => {
      if (!this.isCommitted) this.hooks.cancel();
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    this.isCommitted = false;
    this.input.value = '';
    const currentIndex = ENTRIES.findIndex((entry) => entry.id === this.hooks.current());
    this.dialog.showModal();
    this.render(Math.max(0, currentIndex));
    this.input.focus();
  }

  private render(activeIndex: number): void {
    const query = this.input.value.trim().toLowerCase();
    this.results = ENTRIES.filter((entry) => query === '' || `${entry.name} ${entry.mode}`.toLowerCase().includes(query));
    this.activeIndex = Math.min(activeIndex, Math.max(0, this.results.length - 1));
    const current = this.hooks.current();
    let section = '';
    this.list.innerHTML = this.results
      .map((entry, index) => {
        const label = SECTION_LABELS[entry.mode] ?? '';
        const heading = label !== '' && label !== section ? `<div class="theme-section">${(section = label)}</div>` : '';
        return `${heading}<button type="button" class="theme-option${index === this.activeIndex ? ' active' : ''}" data-index="${index}" role="option"><span class="current">${entry.id === current ? '✓' : ''}</span><span class="swatch">${entry.swatch.map((color) => `<i style="background:${color}"></i>`).join('')}</span><span>${escapeHtml(entry.name)}</span></button>`;
      })
      .join('');
    this.previewActive();
  }

  private setActive(index: number): void {
    if (this.results.length === 0) return;
    this.activeIndex = (index + this.results.length) % this.results.length;
    this.list.querySelectorAll('.theme-option').forEach((row, rowIndex) => row.classList.toggle('active', rowIndex === this.activeIndex));
    this.list.querySelector('.theme-option.active')?.scrollIntoView({ block: 'nearest' });
    this.previewActive();
  }

  private previewActive(): void {
    const entry = this.results[this.activeIndex];
    if (entry != null) this.hooks.preview(entry.id);
  }

  private commit(): void {
    const entry = this.results[this.activeIndex];
    if (entry == null) return;
    this.isCommitted = true;
    this.hooks.commit(entry.id);
    closeWithMotion(this.dialog);
  }

  private readonly handleKey = (event: KeyboardEvent): void => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
    if (event.key in moves || (event.ctrlKey && (event.key === 'n' || event.key === 'p')) || (event.ctrlKey && (event.key === 'j' || event.key === 'k'))) {
      event.preventDefault();
      const delta = moves[event.key] ?? (event.key === 'n' || event.key === 'j' ? 1 : -1);
      this.setActive(this.activeIndex + delta);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commit();
    }
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const index = Number((event.target as HTMLElement).closest<HTMLElement>('.theme-option')?.dataset.index);
    if (!Number.isInteger(index)) return;
    this.activeIndex = index;
    this.commit();
  };

  private readonly handleHover = (event: PointerEvent): void => {
    const index = Number((event.target as HTMLElement).closest<HTMLElement>('.theme-option')?.dataset.index);
    if (Number.isInteger(index) && index !== this.activeIndex) this.setActive(index);
  };
}
