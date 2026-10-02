import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

const CHECK_EVERY_MS = 30 * 60_000;
const FIRST_CHECK_DELAY_MS = 8_000;

interface UpdaterHooks {
  onReady: (version: string, restart: () => void) => void;
  onError: (message: string) => void;
}

let ready: Update | null = null;
let isChecking = false;

async function checkOnce(hooks: UpdaterHooks, isManual: boolean): Promise<void> {
  if (isChecking || ready != null) return;
  isChecking = true;
  try {
    const update = await check();
    if (update == null) return;
    await update.downloadAndInstall();
    ready = update;
    hooks.onReady(update.version, () => void relaunch());
  } catch (error) {
    if (isManual) hooks.onError(error instanceof Error ? error.message : String(error));
  } finally {
    isChecking = false;
  }
}

/** Silently downloads and installs new releases in the background; the app restarts into them on demand or next launch. */
export function startAutoUpdate(hooks: UpdaterHooks): () => void {
  if (!('__TAURI_INTERNALS__' in window)) return () => undefined;
  window.setTimeout(() => void checkOnce(hooks, false), FIRST_CHECK_DELAY_MS);
  window.setInterval(() => void checkOnce(hooks, false), CHECK_EVERY_MS);
  window.addEventListener('focus', () => void checkOnce(hooks, false));
  return () => void checkOnce(hooks, true);
}
