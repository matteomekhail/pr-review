const EXIT_MS = 120;

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function closeWithMotion(dialog: HTMLDialogElement, done?: () => void): void {
  if (!dialog.open || dialog.classList.contains('closing')) return;
  if (prefersReducedMotion()) {
    dialog.close();
    done?.();
    return;
  }
  dialog.classList.add('closing');
  window.setTimeout(() => {
    dialog.classList.remove('closing');
    dialog.close();
    done?.();
  }, EXIT_MS);
}

export class GlidingHighlight {
  private readonly container: HTMLElement;
  private readonly bar: HTMLElement;
  private lastTop: number | null = null;

  constructor(container: HTMLElement, className: string) {
    this.container = container;
    this.bar = document.createElement('div');
    this.bar.className = className;
    this.bar.setAttribute('aria-hidden', 'true');
  }

  moveTo(target: HTMLElement | null): void {
    if (target == null) {
      this.bar.style.opacity = '0';
      this.lastTop = null;
      return;
    }
    if (this.bar.parentElement !== this.container) this.container.prepend(this.bar);
    const top = target.offsetTop;
    const height = target.offsetHeight;
    const isJump = this.lastTop == null || Math.abs(top - this.lastTop) > height * 6 || prefersReducedMotion();
    this.bar.classList.toggle('instant', isJump);
    this.bar.style.height = `${height}px`;
    this.bar.style.transform = `translate3d(0, ${top}px, 0)`;
    this.bar.style.opacity = '1';
    this.lastTop = top;
  }
}

export function animateDialogCancel(root: Document = document): void {
  root.addEventListener(
    'cancel',
    (event) => {
      const dialog = event.target;
      if (!(dialog instanceof HTMLDialogElement) || event.defaultPrevented || prefersReducedMotion()) return;
      event.preventDefault();
      closeWithMotion(dialog);
    },
    true,
  );
}

const hideTimers = new WeakMap<HTMLElement, number>();

export function setVisibleWithMotion(element: HTMLElement, isVisible: boolean, exitMs = 140): void {
  window.clearTimeout(hideTimers.get(element));
  if (isVisible) {
    if (!element.hidden && !element.classList.contains('leaving')) return;
    element.classList.remove('leaving');
    element.hidden = false;
    element.classList.remove('entering');
    void element.offsetWidth;
    element.classList.add('entering');
    return;
  }
  if (element.hidden) return;
  if (prefersReducedMotion()) {
    element.hidden = true;
    return;
  }
  element.classList.remove('entering');
  element.classList.add('leaving');
  hideTimers.set(
    element,
    window.setTimeout(() => {
      element.classList.remove('leaving');
      element.hidden = true;
    }, exitMs),
  );
}

export function flash(element: HTMLElement): void {
  if (prefersReducedMotion()) return;
  element.classList.remove('flash');
  void element.offsetWidth;
  element.classList.add('flash');
  element.addEventListener('animationend', () => element.classList.remove('flash'), { once: true });
}

interface ScrollGlide {
  frame: number;
  from: number;
  to: number;
  began: number;
  duration: number;
}

const glides = new WeakMap<HTMLElement, ScrollGlide>();
const JUMP_MS = 180;
const STEP_MS = 110;

function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

function clampScroll(element: HTMLElement, value: number): number {
  return Math.max(0, Math.min(element.scrollHeight - element.clientHeight, value));
}

function run(element: HTMLElement, destination: number, duration: number): void {
  const previous = glides.get(element);
  if (previous != null) cancelAnimationFrame(previous.frame);
  const from = element.scrollTop;
  if (Math.abs(destination - from) < 1 || prefersReducedMotion()) {
    element.scrollTop = destination;
    glides.delete(element);
    return;
  }
  const glide: ScrollGlide = { frame: 0, from, to: destination, began: performance.now(), duration };
  const step = (now: number): void => {
    const progress = Math.min(1, (now - glide.began) / glide.duration);
    element.scrollTop = glide.from + (glide.to - glide.from) * easeOutCubic(progress);
    if (progress < 1) glide.frame = requestAnimationFrame(step);
    else glides.delete(element);
  };
  glide.frame = requestAnimationFrame(step);
  glides.set(element, glide);
}

/** Glide to an absolute position (half/full page, top/bottom). */
export function glideScrollTo(element: HTMLElement, target: number): void {
  run(element, clampScroll(element, target), JUMP_MS);
}

/** Glide by a delta that accumulates onto an in-flight glide, so held keys stay smooth. */
export function glideScrollBy(element: HTMLElement, delta: number, duration = STEP_MS): void {
  const inFlight = glides.get(element);
  const base = inFlight?.to ?? element.scrollTop;
  run(element, clampScroll(element, base + delta), duration);
}
