import { getCurrentWindow } from '@tauri-apps/api/window';

const DRAG_ZONES = '#pr-head, .pane-head, .status-bar, .titlebar-spacer, #empty';
const INTERACTIVE = 'button, a, input, select, textarea, label, [role=checkbox], [role=separator], .chip, .chip-meta, .resizer, kbd, code, img';

function isDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(DRAG_ZONES) != null && target.closest(INTERACTIVE) == null;
}

export function enableWindowDrag(): void {
  const appWindow = getCurrentWindow();
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !isDragTarget(event.target)) return;
    event.preventDefault();
    if (event.detail === 2) {
      void appWindow.toggleMaximize();
      return;
    }
    void appWindow.startDragging();
  });
}
