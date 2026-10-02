function updateFade(element: HTMLElement): void {
  const max = element.scrollWidth - element.clientWidth;
  const atStart = element.scrollLeft <= 1;
  const atEnd = element.scrollLeft >= max - 1;
  const fade = max <= 1 ? '' : atStart ? 'end' : atEnd ? 'start' : 'both';
  if (element.dataset.fade !== fade) element.dataset.fade = fade;
}

export function attachScrollFade(element: HTMLElement): void {
  let frame = 0;
  const schedule = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => updateFade(element));
  };
  element.addEventListener('scroll', schedule, { passive: true });
  element.addEventListener(
    'wheel',
    (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || element.scrollWidth <= element.clientWidth) return;
      element.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false },
  );
  new ResizeObserver(schedule).observe(element);
  new MutationObserver(schedule).observe(element, { childList: true, subtree: true, characterData: true });
  schedule();
}
