import { icon } from './icons';

/** One choice in a popover menu. Picking it keeps the menu open, so several filters can be set in one go. */
export interface MenuItem {
  label: string;
  count?: string;
  hint?: string;
  checked?: boolean;
  run: () => void;
}

export interface MenuSection {
  title?: string;
  /** Items are checkboxes rather than radios: several can be on at once. */
  isMulti?: boolean;
  items: MenuItem[];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** A popover under a button: arrows or j/k move, Enter picks, Escape, Tab or a click elsewhere closes. */
export class PopoverMenu {
  private readonly root: HTMLElement;
  private anchor: HTMLElement | null = null;
  private align: 'start' | 'end' = 'start';
  private build: (() => MenuSection[]) | null = null;
  private items: MenuItem[] = [];
  private active = -1;

  constructor(label: string) {
    this.root = document.createElement('div');
    this.root.className = 'popover-menu';
    this.root.setAttribute('role', 'menu');
    this.root.setAttribute('aria-label', label);
    this.root.tabIndex = -1;
    this.root.hidden = true;
    document.body.append(this.root);
    this.root.addEventListener('keydown', (event) => this.handleKey(event));
    this.root.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (item != null) this.pick(Number(item.dataset.index));
    });
    this.root.addEventListener('pointermove', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (item != null) this.setActive(Number(item.dataset.index));
    });
    document.addEventListener(
      'pointerdown',
      (event) => {
        const target = event.target as Node;
        if (this.isOpen && !this.root.contains(target) && this.anchor?.contains(target) !== true) this.close();
      },
      true,
    );
    window.addEventListener('blur', () => this.close());
    window.addEventListener('resize', () => this.close());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** `align: 'end'` lines the menu's right edge up with the button's, for buttons at the right of a bar. */
  toggle(anchor: HTMLElement, build: () => MenuSection[], align: 'start' | 'end' = 'start'): void {
    if (this.isOpen && this.anchor === anchor) this.close();
    else this.open(anchor, build, align);
  }

  open(anchor: HTMLElement, build: () => MenuSection[], align: 'start' | 'end' = 'start'): void {
    this.anchor?.setAttribute('aria-expanded', 'false');
    this.anchor = anchor;
    this.align = align;
    this.build = build;
    anchor.setAttribute('aria-expanded', 'true');
    this.root.hidden = false;
    this.render();
    this.place(anchor);
    const checked = this.items.findIndex((item) => item.checked === true);
    this.setActive(Math.max(0, checked));
    this.root.focus({ preventScroll: true });
  }

  /** Re-reads labels, counts and checks while open, keeping the highlighted row. */
  refresh(): void {
    if (!this.isOpen) return;
    const active = this.active;
    this.render();
    this.setActive(Math.min(active, this.items.length - 1));
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.anchor?.setAttribute('aria-expanded', 'false');
    this.anchor = null;
    this.build = null;
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  private render(): void {
    const sections = this.build?.() ?? [];
    this.items = sections.flatMap((section) => section.items);
    let index = 0;
    this.root.innerHTML = sections
      .map((section) => {
        const title = section.title == null ? '' : `<div class="menu-title">${escapeHtml(section.title)}</div>`;
        const role = section.isMulti === true ? 'menuitemcheckbox' : 'menuitemradio';
        const items = section.items.map((item) => {
          const position = index++;
          const count = item.count == null ? '' : `<span class="menu-count">${escapeHtml(item.count)}</span>`;
          return `<button type="button" role="${role}" tabindex="-1" aria-checked="${item.checked === true}" class="menu-item${item.checked === true ? ' checked' : ''}" data-index="${position}"><span class="menu-check">${item.checked === true ? icon('check') : ''}</span><span class="menu-label">${escapeHtml(item.label)}</span>${count}<span class="menu-hint">${escapeHtml(item.hint ?? '')}</span></button>`;
        });
        return `${title}${items.join('')}`;
      })
      .join('');
  }

  private place(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    this.root.style.top = `${Math.round(rect.bottom + 4)}px`;
    this.root.style.maxHeight = `${Math.max(160, window.innerHeight - rect.bottom - 16)}px`;
    const left = this.align === 'end' ? rect.right - this.root.offsetWidth : rect.left;
    this.root.style.left = `${Math.round(Math.max(8, Math.min(left, window.innerWidth - this.root.offsetWidth - 8)))}px`;
  }

  private setActive(index: number): void {
    this.active = index;
    this.root.querySelectorAll<HTMLElement>('[data-index]').forEach((item) => item.classList.toggle('active', Number(item.dataset.index) === index));
    this.root.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private pick(index: number): void {
    const item = this.items[index];
    if (item == null) return;
    this.setActive(index);
    item.run();
    this.refresh();
  }

  private handleKey(event: KeyboardEvent): void {
    const last = this.items.length - 1;
    const moves: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };
    if (event.key in moves) this.setActive(Math.min(last, Math.max(0, this.active + (moves[event.key] ?? 0))));
    else if (event.key === 'Home') this.setActive(0);
    else if (event.key === 'End') this.setActive(last);
    else if (event.key === 'Enter' || event.key === ' ') this.pick(this.active);
    else if (event.key === 'Escape' || event.key === 'Tab') this.close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
}
