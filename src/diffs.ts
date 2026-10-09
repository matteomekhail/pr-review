import { glideScrollBy, glideScrollTo, prefersReducedMotion } from './motion';
import { CodeView, parsePatchFiles, type CodeViewDiffItem, type DiffLineAnnotation, type FileDiffLoadedFiles, type FileDiffMetadata, type SelectedLineRange } from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker';
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';
import { oldContents } from './hidden-lines';

export type DiffStyle = 'split' | 'unified';

/** How many unmodified lines one click on a separator reveals; `all` opens the whole gap. Shift-click always opens it all. */
export type ExpandLines = 'all' | number;

export interface ParsedFile {
  id: string;
  diff: FileDiffMetadata;
  additions: number;
  deletions: number;
  /** Decided once at parse time: expanding unchanged lines grows the diff in place, and should not collapse it on a revisit. */
  startsCollapsed: boolean;
}

/** The file's contents at the pull request's head, by path. */
export type HeadFileLoader = (path: string) => Promise<string>;

/** What sits under a line: a key the owner renders from. Keep the object for as long as its content is unchanged, so the element is reused. */
export interface AnnotationRef {
  key: string;
}

export type DiffAnnotation = DiffLineAnnotation<AnnotationRef>;

interface DiffViewCallbacks {
  onToggle(id: string, isCollapsed: boolean): void;
  /** A right-click on an "unmodified lines" separator, at these viewport coordinates. */
  onSeparatorMenu(x: number, y: number): void;
  /** The gutter "+" was clicked (or dragged over several lines) in this file. */
  onCommentLines(path: string, range: SelectedLineRange): void;
  renderAnnotation(ref: AnnotationRef): HTMLElement | undefined;
}

type ViewOptions = NonNullable<ConstructorParameters<typeof CodeView<AnnotationRef, undefined>>[0]>;

const WORKER_COUNT = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
const LARGE_FILE_LINES = 1500;
const GENERATED_FILE = /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$|\.snap$|\.min\.(js|css)$/;

const HEADER_CSS = `
:host { border: 1px solid var(--diffs-card-border, #23252a); border-radius: 8px; }
[data-diffs-header], [data-separator], [data-column-number] { -webkit-user-select: none; user-select: none; }
[data-diffs-header=default] { border-radius: 8px 8px 0 0; cursor: pointer; user-select: none; padding-inline: 12px; }
[data-diffs-header=default]:hover { background: color-mix(in srgb, var(--diffs-bg) 92%, var(--diffs-mixer)); }
`;

const FLUSH_CSS = `
:host { border-width: 0 0 1px; border-radius: 0; }
[data-diffs-header=default] { border-radius: 0; }
`;

const workerPool = getOrCreateWorkerPoolSingleton({
  poolOptions: { workerFactory: () => new DiffWorker(), poolSize: WORKER_COUNT },
  highlighterOptions: { theme: { dark: 'pierre-dark', light: 'pierre-light' }, lineDiffType: 'word-alt' },
});

function countChanges(diff: FileDiffMetadata): { additions: number; deletions: number } {
  return diff.hunks.reduce(
    (total, hunk) => ({ additions: total.additions + hunk.additionLines, deletions: total.deletions + hunk.deletionLines }),
    { additions: 0, deletions: 0 },
  );
}

export function parseDiff(cacheKey: string, patch: string): ParsedFile[] {
  return parsePatchFiles(patch, cacheKey)
    .flatMap((parsed) => parsed.files)
    .map((diff, index) => ({ id: `${index}:${diff.name}`, diff, ...countChanges(diff), startsCollapsed: shouldStartCollapsed(diff) }));
}

function shouldStartCollapsed(diff: FileDiffMetadata): boolean {
  return GENERATED_FILE.test(diff.name) || diff.unifiedLineCount > LARGE_FILE_LINES;
}

function chevron(id: string, isCollapsed: boolean): HTMLElement {
  const icon = document.createElement('span');
  icon.dataset.fileId = id;
  icon.textContent = '›';
  icon.style.cssText = `display:inline-flex;width:14px;justify-content:center;color:#8a8f98;font-size:15px;transition:transform .12s;transform:rotate(${isCollapsed ? 0 : 90}deg)`;
  return icon;
}

export class DiffView {
  private readonly view: CodeView<AnnotationRef, undefined>;
  private readonly root: HTMLElement;
  private readonly callbacks: DiffViewCallbacks;
  private header: HTMLElement | undefined;
  private isFlush = false;
  private themeType: 'dark' | 'light' = 'dark';
  private themeNames: Record<'dark' | 'light', string> = { dark: 'pierre-dark', light: 'pierre-light' };
  private diffStyle: DiffStyle;
  private expandLines: ExpandLines = 'all';
  private collapsed = new Set<string>();
  private ids: string[] = [];
  private readonly headFiles = new WeakMap<FileDiffMetadata, HeadFileLoader>();
  private annotations = new Map<string, DiffAnnotation[]>();
  private paths = new Map<string, string>();

  constructor(root: HTMLElement, diffStyle: DiffStyle, callbacks: DiffViewCallbacks) {
    this.root = root;
    this.diffStyle = diffStyle;
    this.callbacks = callbacks;
    this.view = new CodeView<AnnotationRef, undefined>(this.options(), workerPool);
    this.view.setup(root);
    root.addEventListener('click', this.handleHeaderClick);
    root.addEventListener('contextmenu', this.handleContextMenu);
  }

  setHeader(header: HTMLElement | undefined): void {
    this.header = header;
    this.view.setOptions(this.options());
  }

  /** `loadHeadFile` lets the separators expand; the files are only asked for when a separator is clicked (or prefetched). */
  show(files: readonly ParsedFile[], loadHeadFile?: HeadFileLoader): void {
    if (loadHeadFile != null) files.forEach((file) => this.headFiles.set(file.diff, loadHeadFile));
    this.ids = files.map((file) => file.id);
    this.collapsed = new Set(files.filter((file) => file.startsCollapsed).map((file) => file.id));
    this.paths = new Map(files.map((file) => [file.id, file.diff.name]));
    this.view.setItems(files.map((file): CodeViewDiffItem<AnnotationRef> => ({ id: file.id, type: 'diff', fileDiff: file.diff, collapsed: this.collapsed.has(file.id), annotations: this.annotations.get(file.diff.name) })));
    this.root.scrollTop = 0;
  }

  /** Comment threads and drafts, by file path; only files whose list changed are re-rendered. */
  setAnnotations(byPath: Map<string, DiffAnnotation[]>): void {
    const previous = this.annotations;
    this.annotations = byPath;
    for (const [id, path] of this.paths) {
      const before = previous.get(path) ?? [];
      const after = byPath.get(path) ?? [];
      if (before.length === after.length && before.every((annotation, index) => annotation.metadata === after[index]?.metadata && annotation.lineNumber === after[index]?.lineNumber && annotation.side === after[index]?.side)) continue;
      const item = this.view.getItem(id);
      if (item?.type === 'diff') this.view.updateItem({ ...item, annotations: after, version: (item.version ?? 0) + 1 });
    }
  }

  /** The lines the gutter "+" highlighted stay marked while their comment is written; this lets them go. */
  clearSelection(): void {
    this.view.clearSelectedLines();
  }

  isCollapsed(id: string): boolean {
    return this.collapsed.has(id);
  }

  collapsedCount(): number {
    return this.collapsed.size;
  }

  setTheme(themeType: 'dark' | 'light', themeName: string): void {
    if (this.themeType === themeType && this.themeNames[themeType] === themeName) return;
    this.themeType = themeType;
    this.themeNames = { ...this.themeNames, [themeType]: themeName };
    void workerPool.setRenderOptions({ theme: this.themeNames });
    this.view.setOptions(this.options());
  }

  setFlush(isFlush: boolean): void {
    if (this.isFlush === isFlush) return;
    this.isFlush = isFlush;
    this.root.classList.toggle('flush', isFlush);
    this.view.setOptions(this.options());
  }

  setStyle(diffStyle: DiffStyle): void {
    this.diffStyle = diffStyle;
    this.view.setOptions(this.options());
  }

  setExpandLines(expandLines: ExpandLines): void {
    if (this.expandLines === expandLines) return;
    this.expandLines = expandLines;
    this.view.setOptions(this.options());
  }

  scrollToTop(): void {
    this.view.scrollTo({ type: 'position', position: 0, behavior: 'instant' });
  }

  scrollBy(pixels: number): void {
    this.root.scrollTop = Math.max(0, Math.min(this.root.scrollHeight - this.root.clientHeight, this.root.scrollTop + pixels));
  }

  glideBy(pixels: number): void {
    glideScrollTo(this.root, this.root.scrollTop + pixels);
  }

  stepBy(pixels: number): void {
    glideScrollBy(this.root, pixels);
  }

  scrollByPage(fraction: number): void {
    this.scrollBy(this.root.clientHeight * fraction);
  }

  scrollToBottom(): void {
    this.view.scrollTo({ type: 'position', position: this.root.scrollHeight, behavior: 'instant' });
  }

  scrollToFile(id: string): void {
    this.view.scrollTo({ type: 'item', id, align: 'start', behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
  }

  toggle(id: string, isCollapsed = !this.collapsed.has(id)): void {
    const item = this.view.getItem(id);
    if (item?.type !== 'diff') return;
    if (isCollapsed) this.collapsed.add(id);
    else this.collapsed.delete(id);
    this.view.updateItem({ ...item, collapsed: isCollapsed, version: (item.version ?? 0) + 1 });
    this.callbacks.onToggle(id, isCollapsed);
  }

  setAllCollapsed(isCollapsed: boolean): void {
    this.ids.forEach((id) => {
      if (this.collapsed.has(id) !== isCollapsed) this.toggle(id, isCollapsed);
    });
  }

  private options(): ViewOptions {
    const header = this.header;
    return {
      theme: this.themeNames,
      themeType: this.themeType,
      diffStyle: this.diffStyle,
      diffIndicators: 'bars',
      lineDiffType: 'word-alt',
      hunkSeparators: 'line-info',
      expansionLineCount: this.expandLines === 'all' ? Number.POSITIVE_INFINITY : this.expandLines,
      loadDiffFiles: this.loadDiffFiles,
      overflow: 'scroll',
      stickyHeaders: true,
      unsafeCSS: this.isFlush ? `${HEADER_CSS}${FLUSH_CSS}` : HEADER_CSS,
      layout: { paddingTop: 0, paddingBottom: 320, gap: this.isFlush ? 0 : 10 },
      renderCodeViewHeader: header == null ? undefined : () => header,
      renderHeaderPrefix: (_fileDiff, context) => chevron(context.item.id, this.collapsed.has(context.item.id)),
      enableGutterUtility: true,
      onGutterUtilityClick: (range, context) => {
        const path = this.paths.get(context.item.id);
        if (path != null) this.callbacks.onCommentLines(path, range);
      },
      renderAnnotation: (annotation) => (annotation.metadata == null ? undefined : this.callbacks.renderAnnotation(annotation.metadata)),
    };
  }

  private readonly loadDiffFiles = async (diff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const load = this.headFiles.get(diff);
    if (load == null) throw new Error(`No head file for ${diff.name}`);
    const contents = await load(diff.name);
    return { oldFile: { name: diff.prevName ?? diff.name, contents: oldContents(diff, contents) }, newFile: { name: diff.name, contents } };
  };

  private readonly handleContextMenu = (event: MouseEvent): void => {
    const isSeparator = event.composedPath().some((node) => node instanceof HTMLElement && (node.dataset.separator === 'line-info' || node.dataset.separator === 'line-info-basic'));
    if (!isSeparator) return;
    event.preventDefault();
    this.callbacks.onSeparatorMenu(event.clientX, event.clientY);
  };

  private readonly handleHeaderClick = (event: MouseEvent): void => {
    const path = event.composedPath();
    const isHeader = path.some((node) => node instanceof HTMLElement && node.dataset.diffsHeader === 'default');
    if (!isHeader) return;
    const host = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'DIFFS-CONTAINER');
    const id = host?.querySelector<HTMLElement>('[data-file-id]')?.dataset.fileId;
    if (id != null) this.toggle(id);
  };
}
