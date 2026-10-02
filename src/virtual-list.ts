export interface VirtualRow {
  key: string;
  height: number;
  render(): string;
}

const OVERSCAN_PX = 480;

export class VirtualList {
  private rows: VirtualRow[] = [];
  private offsets: number[] = [0];
  private readonly root: HTMLElement;
  private readonly spacerTop: HTMLElement;
  private readonly spacerBottom: HTMLElement;
  private readonly window: HTMLElement;
  private renderedRange = '';
  private frame = 0;
  private readonly highlight: HTMLElement;
  private highlightedKey: string | null = null;
  private highlightTop: number | null = null;
  private highlightHeight = -1;

  constructor(root: HTMLElement) {
    this.root = root;
    this.spacerTop = document.createElement('li');
    this.spacerBottom = document.createElement('li');
    this.spacerTop.className = this.spacerBottom.className = 'vl-spacer';
    this.spacerTop.setAttribute('aria-hidden', 'true');
    this.spacerBottom.setAttribute('aria-hidden', 'true');
    this.window = document.createElement('div');
    this.window.style.display = 'contents';
    this.highlight = document.createElement('li');
    this.highlight.className = 'vl-highlight';
    this.highlight.setAttribute('aria-hidden', 'true');
    root.replaceChildren(this.highlight, this.spacerTop, this.window, this.spacerBottom);
    root.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(root);
  }

  setRows(rows: VirtualRow[]): void {
    this.rows = rows;
    this.offsets = [0];
    for (const row of rows) this.offsets.push((this.offsets.at(-1) ?? 0) + row.height);
    this.renderedRange = '';
    this.render();
    this.highlightTop = null;
    this.placeHighlight();
  }

  refresh(): void {
    this.renderedRange = '';
    this.render();
  }

  indexOf(key: string): number {
    return this.rows.findIndex((row) => row.key === key);
  }

  scrollToKey(key: string): void {
    const index = this.indexOf(key);
    if (index < 0) return;
    const top = this.offsets[index] ?? 0;
    const bottom = top + (this.rows[index]?.height ?? 0);
    const stickyOffset = 34;
    if (top - stickyOffset < this.root.scrollTop) this.root.scrollTop = Math.max(0, top - stickyOffset);
    else if (bottom > this.root.scrollTop + this.root.clientHeight) this.root.scrollTop = bottom - this.root.clientHeight;
    this.render();
  }

  rowTop(key: string): number | null {
    const index = this.indexOf(key);
    return index < 0 ? null : (this.offsets[index] ?? 0);
  }

  element(key: string): HTMLElement | null {
    return this.window.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  }

  highlightKey(key: string | null): void {
    this.highlightedKey = key;
    this.placeHighlight();
  }

  private placeHighlight(): void {
    const index = this.highlightedKey == null ? -1 : this.indexOf(this.highlightedKey);
    if (index < 0) {
      this.highlight.classList.remove('visible');
      this.highlightTop = null;
      return;
    }
    const top = this.offsets[index] ?? 0;
    if (top === this.highlightTop) return;
    const height = this.rows[index]?.height ?? 0;
    const isFirst = this.highlightTop == null;
    const distance = isFirst ? 0 : Math.abs(top - (this.highlightTop ?? 0));
    const viewport = this.root.clientHeight;
    const isOffscreenJump = distance > viewport * 1.5;
    const isInstant = isFirst || isOffscreenJump;
    if (this.highlight.classList.contains('instant') !== isInstant) this.highlight.classList.toggle('instant', isInstant);
    if (!isInstant) this.highlight.style.transitionDuration = `${Math.round(Math.min(260, 150 + distance / 12))}ms`;
    if (this.highlightHeight !== height) {
      this.highlight.style.height = `${height}px`;
      this.highlightHeight = height;
    }
    this.highlight.style.transform = `translate3d(0, ${top}px, 0)`;
    if (this.highlightTop == null) this.highlight.classList.add('visible');
    this.highlightTop = top;
  }

  forEachRendered(callback: (element: HTMLElement) => void): void {
    this.window.querySelectorAll<HTMLElement>('[data-key]').forEach(callback);
  }

  private schedule(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.render());
  }

  private findIndex(position: number): number {
    let low = 0;
    let high = this.rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.offsets[middle + 1] ?? 0) <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private render(): void {
    const total = this.offsets.at(-1) ?? 0;
    const start = this.findIndex(Math.max(0, this.root.scrollTop - OVERSCAN_PX));
    const end = Math.min(this.rows.length, this.findIndex(this.root.scrollTop + this.root.clientHeight + OVERSCAN_PX) + 1);
    const range = `${start}:${end}:${this.rows.length}`;
    if (range === this.renderedRange) return;
    this.renderedRange = range;
    this.spacerTop.style.height = `${this.offsets[start] ?? 0}px`;
    this.spacerBottom.style.height = `${Math.max(0, total - (this.offsets[end] ?? total))}px`;
    this.window.innerHTML = this.rows.slice(start, end).map((row) => row.render()).join('');
  }
}
