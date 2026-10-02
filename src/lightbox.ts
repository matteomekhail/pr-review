export type MediaKind = 'image' | 'video' | 'html';

export interface MediaItem {
  kind: MediaKind;
  url: string;
  label: string;
  source: HTMLElement;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;
const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v)(\?|#|$)/i;
const HTML_EXTENSIONS = /\.html?(\?|#|$)/i;
const GITHUB_ATTACHMENT = /^https:\/\/(github\.com\/user-attachments\/assets\/|private-user-images\.githubusercontent\.com\/|user-images\.githubusercontent\.com\/)/i;

function isHttps(url: string): boolean {
  return url.startsWith('https://');
}

function linkKind(url: string): MediaKind | null {
  if (!isHttps(url)) return null;
  if (VIDEO_EXTENSIONS.test(url)) return 'video';
  if (IMAGE_EXTENSIONS.test(url)) return 'image';
  if (HTML_EXTENSIONS.test(url)) return 'html';
  return null;
}

function labelFor(element: Element, fallback: string): string {
  const text = element.getAttribute('alt') ?? element.getAttribute('title') ?? element.textContent ?? '';
  return text.trim().slice(0, 120) || fallback;
}

export function collectMedia(root: HTMLElement): MediaItem[] {
  const items: MediaItem[] = [];
  const seen = new Set<string>();
  const add = (item: MediaItem): void => {
    if (seen.has(item.url)) return;
    seen.add(item.url);
    items.push(item);
  };
  root.querySelectorAll<HTMLElement>('img, video, a[href]').forEach((element) => {
    if (element instanceof HTMLImageElement) {
      if (element.closest('.avatar, .byline') != null || !isHttps(element.src) || element.classList.contains('emoji')) return;
      const link = element.closest('a');
      const linked = link?.href != null ? linkKind(link.href) : null;
      if (linked === 'video' || linked === 'html') add({ kind: linked, url: link?.href ?? '', label: labelFor(element, 'Linked media'), source: element });
      else add({ kind: 'image', url: element.currentSrc || element.src, label: labelFor(element, 'Image'), source: element });
      return;
    }
    if (element instanceof HTMLVideoElement) {
      const url = element.currentSrc || element.src || element.querySelector('source')?.src || '';
      if (isHttps(url)) add({ kind: 'video', url, label: labelFor(element, 'Video'), source: element });
      return;
    }
    if (element instanceof HTMLAnchorElement) {
      if (element.querySelector('img') != null) return;
      const kind = linkKind(element.href) ?? (GITHUB_ATTACHMENT.test(element.href) ? 'video' : null);
      if (kind != null) add({ kind, url: element.href, label: labelFor(element, element.href.split('/').pop() ?? 'Link'), source: element });
    }
  });
  return items;
}

export class Lightbox {
  private readonly dialog: HTMLDialogElement;
  private readonly stage: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly counter: HTMLElement;
  private items: MediaItem[] = [];
  private index = 0;
  private zoomed = false;

  constructor(private readonly openExternal: (url: string) => void) {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'lightbox';
    this.dialog.innerHTML = `
      <div class="lb-top"><span class="lb-actions"><button class="lb-open" title="Open in browser  O">Open <kbd>O</kbd></button><button class="lb-close" title="Close  esc / Q">Close <kbd>esc</kbd></button></span></div>
      <div class="lb-stage"></div>
      <div class="lb-footer"><span class="lb-counter"></span><span class="lb-caption"></span></div>
      <button class="lb-nav lb-prev" title="Previous  ← / H">‹</button><button class="lb-nav lb-next" title="Next  → / L">›</button>`;
    document.body.append(this.dialog);
    this.stage = this.dialog.querySelector('.lb-stage') as HTMLElement;
    this.caption = this.dialog.querySelector('.lb-caption') as HTMLElement;
    this.counter = this.dialog.querySelector('.lb-counter') as HTMLElement;
    this.dialog.querySelector('.lb-close')?.addEventListener('click', () => this.close());
    this.dialog.querySelector('.lb-open')?.addEventListener('click', () => this.openCurrent());
    this.dialog.querySelector('.lb-prev')?.addEventListener('click', () => this.step(-1));
    this.dialog.querySelector('.lb-next')?.addEventListener('click', () => this.step(1));
    this.stage.addEventListener('click', (event) => {
      if (event.target === this.stage) this.close();
      else if (event.target instanceof HTMLImageElement) this.toggleZoom();
    });
    this.dialog.addEventListener('keydown', this.handleKey);
    this.dialog.addEventListener('close', () => this.stage.replaceChildren());
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(items: MediaItem[], index = 0): boolean {
    if (items.length === 0) return false;
    this.items = items;
    this.index = Math.max(0, Math.min(items.length - 1, index));
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    return true;
  }

  close(): void {
    this.dialog.close();
  }

  private jump(index: number): void {
    if (this.items.length === 0) return;
    this.index = Math.max(0, Math.min(this.items.length - 1, index));
    this.render();
  }

  private scrollOrStep(delta: 1 | -1): void {
    const stage = this.stage;
    const max = stage.scrollHeight - stage.clientHeight;
    const canScroll = delta > 0 ? stage.scrollTop < max - 1 : stage.scrollTop > 1;
    if (max > 1 && canScroll) {
      stage.scrollBy({ top: delta * Math.round(stage.clientHeight * 0.4), behavior: 'smooth' });
      return;
    }
    this.step(delta);
    if (delta < 0 && this.stage.scrollHeight > this.stage.clientHeight) this.stage.scrollTop = this.stage.scrollHeight;
  }

  private step(delta: number): void {
    if (this.items.length < 2) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.render();
  }

  private openCurrent(): void {
    const item = this.items[this.index];
    if (item != null) this.openExternal(item.url);
  }

  private toggleZoom(): void {
    this.zoomed = !this.zoomed;
    this.stage.classList.toggle('zoomed', this.zoomed);
  }

  private render(): void {
    const item = this.items[this.index];
    if (item == null) return;
    this.zoomed = false;
    this.stage.classList.remove('zoomed');
    this.counter.textContent = `${this.index + 1} / ${this.items.length}`;
    this.caption.textContent = item.label;
    this.dialog.classList.toggle('single', this.items.length < 2);
    this.stage.replaceChildren(this.createView(item));
    this.stage.scrollTop = 0;
    item.source.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  private createView(item: MediaItem): HTMLElement {
    switch (item.kind) {
      case 'image': {
        const image = document.createElement('img');
        image.src = item.url;
        image.alt = item.label;
        image.draggable = false;
        return image;
      }
      case 'video': {
        const video = document.createElement('video');
        video.src = item.url;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        return video;
      }
      case 'html': {
        const frame = document.createElement('iframe');
        frame.src = item.url;
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.title = item.label;
        return frame;
      }
      default:
        return item.kind satisfies never;
    }
  }

  private pendingG = false;

  private readonly handleKey = (event: KeyboardEvent): void => {
    const half = Math.max(1, Math.floor(this.items.length / 2));
    const ctrlHandlers: Record<string, () => void> = { d: () => this.step(half), u: () => this.step(-half), f: () => this.jump(this.items.length - 1), b: () => this.jump(0) };
    const handlers: Record<string, () => void> = {
      ArrowRight: () => this.step(1),
      ArrowDown: () => this.scrollOrStep(1),
      l: () => this.step(1),
      j: () => this.scrollOrStep(1),
      n: () => this.step(1),
      ArrowLeft: () => this.step(-1),
      ArrowUp: () => this.scrollOrStep(-1),
      h: () => this.step(-1),
      k: () => this.scrollOrStep(-1),
      p: () => this.step(-1),
      G: () => this.jump(this.items.length - 1),
      Home: () => this.jump(0),
      End: () => this.jump(this.items.length - 1),
      o: () => this.openCurrent(),
      z: () => this.toggleZoom(),
      ' ': () => this.toggleZoom(),
      q: () => this.close(),
    };
    if (event.metaKey || event.altKey) return;
    const key = event.key.length === 1 && !event.shiftKey ? event.key.toLowerCase() : event.key;
    let handler: (() => void) | undefined;
    if (event.ctrlKey) handler = ctrlHandlers[event.key.toLowerCase()];
    else if (key === 'g') {
      if (this.pendingG) handler = () => this.jump(0);
      this.pendingG = !this.pendingG;
      window.setTimeout(() => (this.pendingG = false), 900);
      event.preventDefault();
    } else handler = handlers[key];
    if (handler == null) return;
    this.pendingG = false;
    event.preventDefault();
    event.stopPropagation();
    handler();
  };
}
