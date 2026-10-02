type Opener = (url: string) => Promise<void>;

function linkFromEvent(event: Event): HTMLAnchorElement | null {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement && node.getAttribute('href') != null) return node;
  }
  return null;
}

export function routeLinksToBrowser(open: Opener, onError: (message: string) => void): void {
  const handle = (event: MouseEvent): void => {
    const link = linkFromEvent(event);
    if (link == null || event.defaultPrevented) return;
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    event.preventDefault();
    event.stopPropagation();
    if (!link.href.startsWith('https://')) {
      onError('Only https links can be opened');
      return;
    }
    void open(link.href).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
  };
  document.addEventListener('click', handle);
  document.addEventListener('auxclick', (event) => {
    if (event.button === 1) handle(event);
  });
  window.addEventListener('dragstart', (event) => {
    if (event.target instanceof HTMLAnchorElement) event.preventDefault();
  });
  window.open = ((url?: string | URL) => {
    const href = url?.toString() ?? '';
    if (href.startsWith('https://')) void open(href);
    return null;
  }) as typeof window.open;
}
