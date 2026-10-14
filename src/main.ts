import { unsupportedReason } from './client/capabilities.ts';
import { GameClient } from './client/game-client.ts';
import { WebGLUnavailableError } from './client/render/renderer.ts';
import { SidePanel } from './client/side-panel.ts';
import { forgetCache, importCache, storedCacheMeta } from './storage/cache-import.ts';
import { downloadLatestCache } from './storage/openrs2.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function show(id: 'setup' | 'loading' | 'unsupported' | 'game'): void {
  for (const s of ['setup', 'loading', 'unsupported', 'game']) $(s).hidden = s !== id;
}

function setProgress(container: HTMLElement, message: string, fraction: number): void {
  container.hidden = false;
  (container.querySelector('.bar') as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  (container.querySelector('.label') as HTMLElement).textContent = message;
}

/** Recursively collects files from a dropped folder (Chrome and Firefox both expose webkitGetAsEntry). */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns batches (100 at a time in Chrome) until an empty batch.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

async function runImport(files: File[]): Promise<void> {
  const err = $('setup-error');
  err.hidden = true;
  const progress = $('import-progress');
  try {
    await importCache(files, (m, f) => setProgress(progress, m, f));
    startGame();
  } catch (e) {
    progress.hidden = true;
    err.textContent = (e as Error).message;
    err.hidden = false;
  }
}

async function runDownload(): Promise<void> {
  const button = $<HTMLButtonElement>('download-latest');
  const err = $('setup-error');
  const progress = $('import-progress');
  button.disabled = true;
  err.hidden = true;
  try {
    const { files } = await downloadLatestCache((m, f) => setProgress(progress, m, f));
    await importCache(files, (m, f) => setProgress(progress, m, 0.9 + f * 0.1));
    startGame();
  } catch (e) {
    progress.hidden = true;
    const msg = (e as Error).message;
    err.textContent =
      e instanceof TypeError
        ? `Couldn't reach the OpenRS2 archive (${msg}). Check your connection, or import a cache manually below.`
        : msg;
    err.hidden = false;
    (document.querySelector('details.manual') as HTMLDetailsElement).open = true;
  } finally {
    button.disabled = false;
  }
}

function setupScreen(): void {
  show('setup');
  $('download-latest').onclick = () => void runDownload();
  for (const id of ['pick-zip', 'pick-dir']) {
    const input = $<HTMLInputElement>(id);
    input.onchange = () => {
      if (input.files?.length) void runImport([...input.files]);
      input.value = '';
    };
  }
  const drop = $('drop');
  const prevent = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => {
      prevent(e);
      drop.classList.add('over');
    });
  }
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    prevent(e);
    drop.classList.remove('over');
    if (e.dataTransfer) void runImport(await filesFromDrop(e.dataTransfer));
  });
  // Dropping anywhere else would navigate away from the page.
  window.addEventListener('dragover', prevent);
  window.addEventListener('drop', prevent);
}

let client: GameClient | null = null;

function startGame(): void {
  show('loading');
  const progress = $('loading').querySelector('.progress') as HTMLElement;
  setProgress(progress, 'Starting engine…', 0.02);
  const worker = new Worker(new URL('./engine/engine.worker.ts', import.meta.url), { type: 'module', name: 'engine' });
  const fail = (message: string) => {
    $('loading-error').textContent = message;
    $('loading-error').hidden = false;
    $('loading-actions').hidden = false;
    show('loading');
  };
  let panel: SidePanel | null = null;
  try {
    client = new GameClient({
      worker,
      onStatus: (m, f) => setProgress(progress, m, f),
      onFatal: fail,
      onReady: () => show('game'),
      onPanel: (msg) => panel?.handle(msg),
    });
    const c = client;
    panel = new SidePanel(
      (msg) => c.send(msg),
      (x, y, slot) => c.openItemMenu(x, y, slot),
    );
    panel.show('inventory');
  } catch (e) {
    worker.terminate();
    if (e instanceof WebGLUnavailableError) {
      $('unsupported-reason').textContent = e.message;
      show('unsupported');
      return;
    }
    fail((e as Error).message);
    return;
  }
  worker.postMessage({ t: 'init', drawRadius: client.initialRadius });
  (window as unknown as { __game: ReturnType<GameClient['debug']> }).__game = client.debug();
}

async function main(): Promise<void> {
  const reason = unsupportedReason();
  if (reason) {
    $('unsupported-reason').textContent = reason;
    show('unsupported');
    return;
  }
  $('reimport').addEventListener('click', async () => {
    await forgetCache();
    location.reload();
  });
  $('btn-forget').addEventListener('click', async () => {
    if (!confirm('Remove the imported cache from this browser? Your save is kept.')) return;
    await forgetCache();
    location.reload();
  });
  let meta;
  try {
    meta = await storedCacheMeta();
  } catch (e) {
    $('unsupported-reason').textContent = `Browser storage is unavailable: ${(e as Error).message}`;
    show('unsupported');
    return;
  }
  if (meta) startGame();
  else setupScreen();
}

void main();
