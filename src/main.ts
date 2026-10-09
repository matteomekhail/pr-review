import { hydrateIcons, icon } from './icons';
import { attachScrollFade } from './scroll-fade';
import { startAutoUpdate } from './updater';
import { StableOrder } from './stable-order';
import { watchKbdGlyphs } from './kbd-glyphs';
import { animateDialogCancel, flash, glideScrollBy, glideScrollTo, setVisibleWithMotion } from './motion';
import { ATTENTION_META, ATTENTION_ORDER, attentionReasons, buildAgentPrompt, describeBlockers, describeFailingChecks, isFailing, needsAttention, prStatus, type AttentionReason, type Blocker } from './status';
import { applyThemeColors, SYSTEM_THEME_ID, THEMES, themeById, type AppTheme } from './themes';
import { ThemePicker } from './theme-picker';
import './styles.css';
import { approvePull, commentOnLines, commentOnPull, replyToThread, resolveThread, submitReview, type ReviewCommentInput, type ReviewEvent, fetchViewerLogin, fetchViewerTeams, usesMergeQueue, fetchBody, fetchDiff, fetchMergeStates, fetchMerged, fetchPulls, fetchQueue, fetchReviewed, type MergeState, type SearchResult, mergePull, openInBrowser, type MergeMethod, type PullRequest, type QueueKind, type SearchKind } from './github';
import type { SelectedLineRange } from '@pierre/diffs';
import { DiffView, parseDiff, type AnnotationRef, type DiffAnnotation, type DiffStyle, type ExpandLines, type ParsedFile } from './diffs';
import { composerHtml, pendingHtml, replyRowHtml, threadHtml } from './inline-comments';
import { hasHiddenLines } from './hidden-lines';
import { cancelFullFilePrefetch, fullFile, prefetchFullFiles } from './full-files';
import { sanitizeHtml } from './sanitize';
import { CommandRegistry, renderShortcut, type Command } from './commands';
import { Layout, type LayoutPreset } from './layout';
import { Lightbox, collectMedia } from './lightbox';
import { enableWindowDrag } from './window-drag';
import { enableTooltips } from './tooltip';
import { groupPulls, type PullGroup } from './grouping';
import { imageUrlsInHtml, preloadImages } from './image-cache';
import { routeLinksToBrowser } from './external-links';
import { isSemanticMatch, semanticMatches } from './semantic-search';
import { VirtualList, type VirtualRow } from './virtual-list';
import { invalidateConversation, loadConversation, loadThreads, type ConversationItem, type ReviewThread } from './conversation';
import { isReady, isRecent, isSmall, matchesSmartFilter, sortPulls, type SmartFilter, type SortOrder } from './smart';
import { assessReadiness, isReadinessAvailable, type ReadinessResult } from './readiness';
import { computeTurn, type Turn } from './turn';
import { describeAsk, inAskScope, isStaleRequest, reviewAsk, type AskScope, type ReviewAsk } from './request';
import { verdictOf, withMyApproval } from './approval';
import { mergeSearch } from './sync';
import { PopoverMenu, type MenuSection } from './menu';
import { authorCounts, MERGED_PERIODS, mergedSince, type MergedPeriod } from './merged';
import { lastReviewAt, reviewerCounts, reviewsSince } from './reviews';
import { botReviews, describeBotReview } from './review-bots';

interface State {
  kind: QueueKind;
  pulls: PullRequest[];
  filter: string;
  smartFilter: SmartFilter;
  repoFilter: string;
  /** A PR shows when it has any of these; none means no label filter. */
  labelFilter: string[];
  askScope: AskScope;
  /** The period Merged and Reviews cover. */
  mergedPeriod: MergedPeriod;
  /** Whose merged PRs: empty for everyone, `@me`, or a login. */
  mergedAuthor: string;
  /** Whose reviews: empty for everyone, `@me`, or a login. */
  reviewer: string;
  sortOrder: SortOrder;
  checkedIds: Set<string>;
  selectedId: string | null;
  activeFileIndex: number;
  diffStyle: DiffStyle;
  expandLines: ExpandLines;
}

const PREFETCH_AHEAD = 5;
const DIFF_CACHE_LIMIT = 24;
/** Every tab syncs this often while the window is visible; a sync that finds nothing new leaves the screen alone. */
const SYNC_INTERVAL_MS = 60_000;
const VIEW_TITLES: Record<QueueKind, string> = { turn: 'My turn', review: 'Review', involved: 'Involved', mine: 'Mine', approved: 'Approved', merged: 'Merged', reviews: 'Reviews' };
const MERGE_LABELS: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Merge', rebase: 'Rebase and merge' };

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found == null) throw new Error(`missing #${id}`);
  return found as T;
};

hydrateIcons();

const dom = {
  list: element<HTMLOListElement>('pr-list'),
  filter: element<HTMLInputElement>('filter'),
  viewTitle: element('view-title'),
  empty: element('empty'),
  pr: element('pr'),
  crumbs: element('crumbs'),
  statusBar: element('status-bar'),
  descPane: element('desc-pane'),
  inspector: element('inspector'),
  bodySplit: element('pr-body-split'),
  files: element('files'),
  fileCount: element('file-count'),
  diffRoot: element('diff-root'),
  approve: element<HTMLButtonElement>('approve'),
  merge: element<HTMLButtonElement>('merge'),
  confirm: element<HTMLDialogElement>('confirm'),
  confirmTitle: element('confirm-title'),
  confirmText: element('confirm-text'),
  help: element<HTMLDialogElement>('help'),
  shortcutList: element('shortcut-list'),
  sliceButton: element<HTMLButtonElement>('slice-button'),
  sliceLabel: element('slice-button').querySelector<HTMLElement>('.slice-label') as HTMLElement,
  sliceCount: element('slice-button').querySelector<HTMLElement>('.slice-count') as HTMLElement,
  sortButton: element<HTMLButtonElement>('sort-button'),
  groupButton: element<HTMLButtonElement>('group-button'),
  fixButton: element<HTMLButtonElement>('fix-button'),
  labelButton: element<HTMLButtonElement>('label-button'),
  bulkBar: element('bulk-bar'),
  bulkCount: element('bulk-count'),
  bulkMerge: element<HTMLButtonElement>('bulk-merge'),
  bulkApprove: element<HTMLButtonElement>('bulk-approve'),
  commentDialog: element<HTMLDialogElement>('comment-dialog'),
  expandDialog: element<HTMLDialogElement>('expand-dialog'),
  reviewDialog: element<HTMLDialogElement>('review-dialog'),
  reviewBody: element<HTMLTextAreaElement>('review-body'),
  reviewNote: element('review-note'),
  reviewSubmit: element<HTMLButtonElement>('review-submit'),
  reviewBar: element('review-bar'),
  reviewBarCount: element('review-bar-count'),
  reviewDiscard: element<HTMLButtonElement>('review-discard'),
  expandInput: element<HTMLInputElement>('expand-input'),
  commentTitle: element('comment-title'),
  commentBody: element<HTMLTextAreaElement>('comment-body'),
  commentHint: element('comment-hint'),
  commentSend: element<HTMLButtonElement>('comment-send'),
  bulkConfirm: element<HTMLDialogElement>('bulk-confirm'),
  triage: element<HTMLDialogElement>('triage'),
  triageTitle: element('triage-title'),
  triageSections: element('triage-sections'),
  triageCopy: element<HTMLButtonElement>('triage-copy'),
  bulkConfirmTitle: element('bulk-confirm-title'),
  bulkConfirmList: element('bulk-confirm-list'),
  bulkConfirmNote: element('bulk-confirm-note'),
  toast: element('toast'),
};

const MAX_EXPAND_LINES = 100_000;

function storedExpandLines(): ExpandLines {
  const lines = Number(localStorage.getItem('expandLines'));
  return Number.isInteger(lines) && lines > 0 && lines <= MAX_EXPAND_LINES ? lines : 'all';
}

function storedLabels(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('labelFilter') ?? '[]');
    return Array.isArray(stored) ? stored.filter((label): label is string => typeof label === 'string') : [];
  } catch {
    return [];
  }
}

const state: State = {
  kind: 'mine',
  pulls: [],
  filter: '',
  smartFilter: ((['all', 'ready', 'attention', 'waiting', 'small', 'recent', 'tested'] as const).find((filter) => filter === localStorage.getItem('smartFilter')) ?? 'all') as SmartFilter,
  repoFilter: localStorage.getItem('repoFilter') ?? '',
  labelFilter: storedLabels(),
  askScope: (['me', 'team'] as const).find((scope) => scope === localStorage.getItem('askScope')) ?? 'all',
  mergedPeriod: (Object.keys(MERGED_PERIODS) as MergedPeriod[]).find((period) => period === localStorage.getItem('mergedPeriod')) ?? '7d',
  mergedAuthor: localStorage.getItem('mergedAuthor') ?? '',
  reviewer: localStorage.getItem('reviewer') ?? '',
  sortOrder: (localStorage.getItem('sortOrder') as SortOrder | null) ?? 'smart',
  checkedIds: new Set<string>(),
  selectedId: null,
  activeFileIndex: 0,
  diffStyle: localStorage.getItem('diffStyle') === 'unified' ? 'unified' : 'split',
  expandLines: storedExpandLines(),
};

let viewer: string | null = null;
/** My teams as lower-case `org/slug`, once GitHub has told us. */
let viewerTeams: Set<string> | null = null;
const diffCache = new Map<string, Promise<ParsedFile[]>>();
const queueCache = new Map<QueueKind, PullRequest[]>();
let isSelectedQueued = false;
const diffView = new DiffView(dom.diffRoot, state.diffStyle, {
  onToggle: (id, isCollapsed) => markFileCollapsed(id, isCollapsed),
  onSeparatorMenu: (x, y) => openExpandMenu(x, y),
  onCommentLines: (path, range) => startLineComment(path, range),
  renderAnnotation: (ref) => renderAnnotation(ref),
});
diffView.setExpandLines(state.expandLines);
let currentFiles: ParsedFile[] = [];
let renderToken = 0;
let toastTimer: number | undefined;

const MERGE_ICON = icon('merge');

const MERGE_METHOD: MergeMethod = 'squash';
syncMergeLabel();


function syncMergeLabel(): void {
  const selectedCount = state.checkedIds.size;
  const baseLabel = isSelectedQueued ? 'Merge when ready' : MERGE_LABELS[MERGE_METHOD];
  const label = selectedCount > 0 ? `${isSelectedQueued ? 'Queue' : 'Merge'} ${selectedCount} selected` : baseLabel;
  dom.merge.innerHTML = `${MERGE_ICON}${selectedCount > 0 ? `<span class="merge-count">${selectedCount}</span>` : ''}<kbd>⌘</kbd><kbd>↵</kbd>`;
  dom.merge.title = `${label}  ⌘↵`;
}

type ToastTone = 'info' | 'success' | 'error';

const TOAST_ICONS: Record<ToastTone, string> = {
  info: icon('info'),
  success: icon('circleCheck'),
  error: icon('circleAlert'),
};
const SUCCESS_PATTERN = /^(approved|merged|queued|copied|added|#\d+ (queued|added))/i;

function toast(message: string, isError = false): void {
  const tone: ToastTone = isError ? 'error' : SUCCESS_PATTERN.test(message) ? 'success' : 'info';
  dom.toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[tone]}</span><span class="toast-text"></span>`;
  const text = dom.toast.querySelector('.toast-text');
  if (text != null) text.textContent = message;
  dom.toast.className = `show ${tone}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (dom.toast.className = tone), isError ? 9000 : 4500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

/** A diff only changes with the code, so comments and reviews do not refetch it. */
function diffKey(pull: PullRequest): string {
  return `${pull.id}:${pull.headRefOid}`;
}

function bodyKey(pull: PullRequest): string {
  return `${pull.id}:${pull.updatedAt}`;
}

const bodyCache = new Map<string, Promise<string>>();

function loadBody(pull: PullRequest, isPriority = false): Promise<string> {
  const key = bodyKey(pull);
  const cached = bodyCache.get(key);
  if (cached != null) {
    void cached.then((html) => preloadImages(imageUrlsInHtml(html), isPriority), () => undefined);
    return cached;
  }
  const pending = fetchBody(pull).then((html) => {
    preloadImages(imageUrlsInHtml(html), isPriority);
    return html;
  });
  pending.catch(() => bodyCache.delete(key));
  bodyCache.set(key, pending);
  if (bodyCache.size > DIFF_CACHE_LIMIT) bodyCache.delete(bodyCache.keys().next().value ?? '');
  return pending;
}

function loadDiff(pull: PullRequest): Promise<ParsedFile[]> {
  const key = diffKey(pull);
  const cached = diffCache.get(key);
  if (cached != null) return cached;
  const pending = fetchDiff(pull).then(
    (patch) =>
      new Promise<ParsedFile[]>((resolve, reject) => {
        const parse = (): void => {
          try {
            resolve(parseDiff(key, patch));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        if (patch.length < 200_000) parse();
        else requestAnimationFrame(() => window.setTimeout(parse, 0));
      }),
  );
  pending.catch(() => diffCache.delete(key));
  diffCache.set(key, pending);
  if (diffCache.size > DIFF_CACHE_LIMIT) diffCache.delete(diffCache.keys().next().value ?? '');
  return pending;
}

const SEMANTIC_DEBOUNCE_MS = 450;
const SEMANTIC_MIN_CHARS = 3;
let semanticQuery = '';
let semanticScores = new Map<string, number>();
let isSemanticLoading = false;
let semanticTimer: number | undefined;
let semanticAbort: AbortController | null = null;

function literalMatch(pull: PullRequest, needle: string): boolean {
  return `${pull.title} ${pull.repository.nameWithOwner} #${pull.number} ${pull.author?.login ?? ''} ${pull.headRefName}`.toLowerCase().includes(needle);
}

function matchesText(pull: PullRequest, needle: string): boolean {
  if (needle === '') return true;
  if (literalMatch(pull, needle)) return true;
  return semanticQuery === needle && isSemanticMatch(semanticScores.get(pull.id));
}

function renderSearchState(): void {
  const box = dom.filter.closest('.search');
  box?.classList.toggle('searching', isSemanticLoading);
  renderListEmpty(filteredPulls().length, state.filter.trim().toLowerCase());
}

function scheduleSemanticSearch(): void {
  window.clearTimeout(semanticTimer);
  semanticAbort?.abort();
  const needle = state.filter.trim().toLowerCase();
  if (!isAiEnabled || needle.length < SEMANTIC_MIN_CHARS || /^#?\d+$/.test(needle)) {
    isSemanticLoading = false;
    renderSearchState();
    return;
  }
  semanticTimer = window.setTimeout(() => {
    const controller = new AbortController();
    semanticAbort = controller;
    isSemanticLoading = true;
    renderSearchState();
    void semanticMatches(needle, state.pulls, controller.signal)
      .then((scores) => {
        if (controller.signal.aborted || state.filter.trim().toLowerCase() !== needle) return;
        semanticQuery = needle;
        semanticScores = scores;
        renderList();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn('semantic search failed', errorMessage(error));
      })
      .finally(() => {
        if (semanticAbort === controller) {
          isSemanticLoading = false;
          renderSearchState();
        }
      });
  }, SEMANTIC_DEBOUNCE_MS);
}

const stableOrder = new StableOrder();
const leaving = new Map<string, { pull: PullRequest; label: string; isPending?: boolean }>();
let listCacheKey = '';
let filteredCache: PullRequest[] = [];
let visibleCache: PullRequest[] = [];
let listVersion = 0;

function invalidateList(): void {
  listVersion += 1;
}

/** PRs whose review is requested from me, including through a team (GitHub's search, less requests I already answered). */
let reviewRequestedIds = new Set<string>();
let turnCache = new WeakMap<PullRequest, Turn | null>();

function turnFor(pull: PullRequest): Turn | null {
  if (turnCache.has(pull)) return turnCache.get(pull) ?? null;
  const turn = computeTurn(pull, viewer, reviewRequestedIds.has(pull.id));
  turnCache.set(pull, turn);
  return turn;
}

function askFor(pull: PullRequest): ReviewAsk | null {
  return reviewAsk(pull, viewer, viewerTeams, reviewRequestedIds.has(pull.id));
}

function loadViewerTeams(): void {
  void fetchViewerTeams().then((teams) => {
    if (teams == null) return;
    viewerTeams = teams;
    resetTurns();
    const pull = selectedPull();
    if (pull != null) renderDetailMeta(pull);
  });
}

/** Who I am or which teams I am in changed: every tab built on that is rebuilt. */
function resetTurns(): void {
  publishQueues(QUEUE_KINDS);
  persistSearches();
  renderList();
}

function currentListKey(): string {
  return [listVersion, leaving.size, state.pulls, state.filter, state.smartFilter, state.repoFilter, state.labelFilter, state.askScope, state.sortOrder, isGroupingOn(), groups, semanticQuery, semanticScores, aiResults.size, collapsedGroups.size].map((part) => (typeof part === 'object' ? objectId(part) : String(part))).join('|');
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function objectId(value: object): string {
  let id = objectIds.get(value);
  if (id == null) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return String(id);
}

function withLeaving(ranked: PullRequest[]): PullRequest[] {
  if (leaving.size === 0) return ranked;
  const present = new Set(ranked.map((pull) => pull.id));
  return [...ranked, ...[...leaving.values()].filter((entry) => !present.has(entry.pull.id)).map((entry) => entry.pull)];
}

/** Merged and Reviews look back over a period rather than at open work: no sorting, grouping, smart filters or merge states. */
function isHistory(kind: QueueKind): kind is 'merged' | 'reviews' {
  return kind === 'merged' || kind === 'reviews';
}

/** Neither merged nor closed. */
function isOpen(pull: PullRequest): boolean {
  return pull.mergedAt == null && pull.closedAt == null;
}

/** My own PRs, and ones I already approved, have no open requests to scope, so the menu neither shows nor applies there. */
function hasAskScope(kind: QueueKind): boolean {
  return kind !== 'mine' && kind !== 'approved' && !isHistory(kind);
}

function matchesAskScope(pull: PullRequest, kind: QueueKind): boolean {
  return !hasAskScope(kind) || inAskScope(askFor(pull), state.askScope);
}

function matchesRepo(pull: PullRequest): boolean {
  return state.repoFilter === '' || pull.repository.nameWithOwner === state.repoFilter;
}

function matchesLabel(pull: PullRequest): boolean {
  return state.labelFilter.length === 0 || pull.labels.some((label) => state.labelFilter.includes(label));
}

/** The repository, label, review-request and smart filters, shared by the list and the tab counts; text search is left to the list. */
function matchesFilters(pull: PullRequest, now: number, kind: QueueKind = state.kind): boolean {
  if (!matchesRepo(pull) || !matchesLabel(pull)) return false;
  if (isHistory(kind)) return true;
  if (!matchesAskScope(pull, kind)) return false;
  if (state.smartFilter === 'waiting') return turnFor(pull)?.whose === 'theirs';
  if (state.smartFilter === 'attention') return isMergeStateSettled(pull) && needsAttention(pull);
  if (state.smartFilter === 'tested') return isTested(pull);
  return matchesSmartFilter(pull, state.smartFilter, now);
}

/** The current queue narrowed to the chosen repository and label, before any other filter. */
function repoPulls(): PullRequest[] {
  return state.repoFilter === '' && state.labelFilter.length === 0 ? state.pulls : state.pulls.filter((pull) => matchesRepo(pull) && matchesLabel(pull));
}

/** The current queue narrowed to the chosen repository and review requests: what the smart filters count from. */
function scopedPulls(): PullRequest[] {
  return repoPulls().filter((pull) => matchesAskScope(pull, state.kind));
}

function computeLists(): void {
  const key = currentListKey();
  if (key === listCacheKey) return;
  listCacheKey = key;
  const needle = state.filter.trim().toLowerCase();
  const now = Date.now();
  const matching = state.pulls.filter((pull) => matchesFilters(pull, now) && matchesText(pull, needle));
  const ranked = state.kind === 'merged' ? [...matching].sort((left, right) => Date.parse(right.mergedAt ?? '') - Date.parse(left.mergedAt ?? '')) : state.kind === 'reviews' ? byLastReview(matching) : sortPulls(matching, state.sortOrder, now, aiScoreFor);
  filteredCache = stableOrder.apply(withLeaving(ranked), [state.kind, state.kind === 'merged' ? mergedKey() : state.kind === 'reviews' ? `${reviewsKey()}:${state.reviewer}` : '', state.repoFilter, state.labelFilter.join(','), state.askScope, state.smartFilter, state.sortOrder, needle, isGroupingOn()].join('|'));
  visibleCache = !isGroupingOn() || groups.length === 0 ? filteredCache : listSections(filteredCache).flatMap((section) => (section.group != null && collapsedGroups.has(section.group.id) ? [] : section.pulls));
}

function filteredPulls(): PullRequest[] {
  computeLists();
  return filteredCache;
}

function visiblePulls(): PullRequest[] {
  computeLists();
  return visibleCache;
}

const sliceMenu = new PopoverMenu('What to show');
const labelMenu = new PopoverMenu('Labels');
const sortMenu = new PopoverMenu('Sort');

const SMART_LABELS: Record<SmartFilter, string> = { all: 'All', ready: 'Ready', attention: 'Unready', waiting: 'Waiting', small: 'Small', recent: 'Recent', tested: 'Tested' };
const SMART_KEYS: Partial<Record<SmartFilter, string>> = { all: '⌥0', ready: '⌥1', small: '⌥2', recent: '⌥3', attention: '⌥4', tested: '⌥5' };
const ASK_LABELS: Record<AskScope, string> = { all: 'Me + team', me: 'Only me', team: 'Only team' };
const SORT_LABELS: Record<SortOrder, string> = { smart: 'Smart', updated: 'Recently updated', size: 'Smallest first' };

/** A person filter on Merged or Reviews: empty for everyone, `@me`, or a login. */
function personLabel(person: string): string {
  return person === '' ? 'Everyone' : person === '@me' ? 'Me' : person;
}

/** The label filter has its own button, but the selector names it too: it narrows the count beside it, in every tab. */
function labelFilterLabel(): string {
  if (state.labelFilter.length === 0) return '';
  return state.labelFilter.length === 1 ? (state.labelFilter[0] ?? '') : `${state.labelFilter.length} labels`;
}

/** The selector names the filters in effect, or All; on Merged and Reviews, the period and person. The repository goes last, so a long name is what gets cut. */
function sliceLabel(): string {
  if (isHistory(state.kind)) return [MERGED_PERIODS[state.mergedPeriod], personLabel(state.kind === 'merged' ? state.mergedAuthor : state.reviewer), labelFilterLabel()].filter((part) => part !== '').join(' · ');
  const parts = [hasAskScope(state.kind) && state.askScope !== 'all' ? ASK_LABELS[state.askScope] : '', state.smartFilter === 'all' ? '' : SMART_LABELS[state.smartFilter], labelFilterLabel(), state.repoFilter === '' ? '' : (state.repoFilter.split('/')[1] ?? state.repoFilter)];
  return parts.filter((part) => part !== '').join(' · ') || 'All';
}

function renderSlice(): void {
  dom.sliceLabel.textContent = sliceLabel();
  dom.sliceCount.textContent = String(filteredPulls().length);
  dom.sortButton.hidden = isHistory(state.kind);
  dom.groupButton.hidden = isHistory(state.kind);
  dom.fixButton.hidden = isHistory(state.kind);
  dom.groupButton.setAttribute('aria-pressed', String(isGrouped));
  dom.groupButton.dataset.tip = `${isGrouped ? 'Ungroup' : 'Group related work'}  ⇧T`;
  dom.labelButton.setAttribute('aria-pressed', String(state.labelFilter.length > 0));
  dom.labelButton.dataset.tip = `${state.labelFilter.length === 0 ? 'Filter by label' : `Labels: ${state.labelFilter.join(', ')}`}  ⇧L`;
  sliceMenu.refresh();
  labelMenu.refresh();
  sortMenu.refresh();
}

/** What the selector offers: open work filters by requests (where they apply), state and repository; Merged by period and author, Reviews by period and reviewer. Labels have their own menu. */
function sliceSections(): MenuSection[] {
  if (state.kind === 'merged') return [periodSection(), authorSection(), repoSection()];
  if (state.kind === 'reviews') return [periodSection(), reviewerSection(), repoSection()];
  return [...(hasAskScope(state.kind) ? [requestSection()] : []), showSection(), repoSection()];
}

function requestSection(): MenuSection {
  const pulls = repoPulls();
  const team = pulls.filter((pull) => askFor(pull)?.to === 'team').length;
  const counts: Record<AskScope, number> = { all: pulls.length, me: pulls.length - team, team };
  const hints: Record<AskScope, string> = { all: '', me: '⌥6', team: '⌥7' };
  return { title: 'Requests', items: (['all', 'me', 'team'] as const).map((scope) => ({ label: ASK_LABELS[scope], count: String(counts[scope]), hint: hints[scope], checked: state.askScope === scope, run: () => setAskScope(scope, false) })) };
}

function showSection(): MenuSection {
  const pulls = scopedPulls();
  const now = Date.now();
  const counts: Record<SmartFilter, number> = {
    all: pulls.length,
    ready: pulls.filter(isReady).length,
    attention: pulls.filter((pull) => isMergeStateSettled(pull) && needsAttention(pull)).length,
    waiting: pulls.filter((pull) => turnFor(pull)?.whose === 'theirs').length,
    small: pulls.filter(isSmall).length,
    recent: pulls.filter((pull) => isRecent(pull, now)).length,
    tested: pulls.filter(isTested).length,
  };
  return { title: 'Show', items: (Object.keys(SMART_LABELS) as SmartFilter[]).map((filter) => ({ label: SMART_LABELS[filter], count: String(counts[filter]), hint: SMART_KEYS[filter], checked: state.smartFilter === filter, run: () => setSmartFilter(filter, false) })) };
}

/** Repositories in the current tab, busiest first, counted within the label filter like every other section; the chosen one stays listed even when it has no PRs here. */
function repoSection(): MenuSection {
  const counts = new Map<string, number>();
  const pulls = state.pulls.filter(matchesLabel);
  pulls.forEach((pull) => counts.set(pull.repository.nameWithOwner, (counts.get(pull.repository.nameWithOwner) ?? 0) + 1));
  if (state.repoFilter !== '' && !counts.has(state.repoFilter)) counts.set(state.repoFilter, 0);
  const repos = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const shortNames = repos.map(([repo]) => repo.split('/')[1] ?? repo);
  const label = (repo: string, index: number): string => (shortNames.filter((name) => name === shortNames[index]).length > 1 ? repo : (shortNames[index] ?? repo));
  return {
    title: 'Repository',
    items: [{ label: 'All repos', count: String(pulls.length), checked: state.repoFilter === '', run: () => setRepoFilter('') }, ...repos.map(([repo, count], index) => ({ label: label(repo, index), count: String(count), checked: state.repoFilter === repo, run: () => setRepoFilter(repo) }))],
  };
}

/** Labels on the chosen repository's PRs here, commonest first; picking one adds it to the filter or takes it out. Chosen labels stay listed at zero. */
function labelSections(): MenuSection[] {
  const pulls = state.pulls.filter(matchesRepo);
  const counts = new Map<string, number>();
  pulls.forEach((pull) => pull.labels.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1)));
  state.labelFilter.forEach((label) => counts.has(label) || counts.set(label, 0));
  if (counts.size === 0) return [{ items: [{ label: 'No labels in this view', run: () => undefined }] }];
  const labels = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return [
    { items: [{ label: 'Any label', count: String(pulls.length), checked: state.labelFilter.length === 0, run: () => setLabelFilter([]) }] },
    { title: 'Has any of', isMulti: true, items: labels.map(([label, count]) => ({ label, count: String(count), checked: state.labelFilter.includes(label), run: () => toggleLabel(label) })) },
  ];
}

/**
 * GitHub's count for each period searched so far. With a repository or label chosen it counts the PRs loaded for that
 * period instead, so it matches the list; a "+" means GitHub stopped at 1,000 and there may be more. On Reviews, the PRs
 * the chosen reviewer reviewed in each period loaded so far.
 */
function periodSection(): MenuSection {
  if (state.kind === 'reviews') {
    return {
      title: 'Period',
      items: (Object.keys(MERGED_PERIODS) as MergedPeriod[]).map((period) => {
        const known = searches.get(reviewsKey(period));
        const count = known == null ? undefined : String(reviewedPulls(known.pulls, period).filter((pull) => matchesRepo(pull) && matchesLabel(pull)).length);
        return { label: MERGED_PERIODS[period], count, checked: state.mergedPeriod === period, run: () => setReviewsFilter(period, state.reviewer) };
      }),
    };
  }
  const isNarrowed = state.repoFilter !== '' || state.labelFilter.length > 0;
  const count = (known: SearchResult | undefined): string | undefined => {
    if (known == null) return undefined;
    if (!isNarrowed) return String(known.total);
    const matching = known.pulls.filter((pull) => matchesRepo(pull) && matchesLabel(pull)).length;
    return known.total > known.pulls.length ? `${matching}+` : String(matching);
  };
  return {
    title: 'Period',
    items: (Object.keys(MERGED_PERIODS) as MergedPeriod[]).map((period) => {
      const known = searches.get(`${MERGED_PREFIX}${period}:${state.mergedAuthor}`);
      return { label: MERGED_PERIODS[period], count: count(known), checked: state.mergedPeriod === period, run: () => setMergedFilter(period, state.mergedAuthor) };
    }),
  };
}

/** Everyone, me, then whoever merged in the period, most first (counted from everyone's search once it has run). */
function authorSection(): MenuSection {
  const repoMatch = (pull: PullRequest): boolean => matchesRepo(pull) && matchesLabel(pull);
  const everyone = searches.get(mergedKey(''));
  const counts = authorCounts((everyone?.pulls ?? state.pulls).filter(repoMatch));
  const isMe = (login: string): boolean => login.toLowerCase() === viewer?.toLowerCase();
  const others = counts.filter(([login]) => !isMe(login));
  if (state.mergedAuthor !== '' && state.mergedAuthor !== '@me' && !others.some(([login]) => login === state.mergedAuthor)) others.unshift([state.mergedAuthor, state.pulls.filter(repoMatch).length]);
  const known = everyone != null;
  const item = (author: string, count: number | null) => ({ label: personLabel(author), count: count == null ? undefined : String(count), checked: state.mergedAuthor === author, run: () => setMergedFilter(state.mergedPeriod, author) });
  return { title: 'Author', items: [item('', known ? counts.reduce((sum, [, count]) => sum + count, 0) : null), item('@me', known ? (counts.find(([login]) => isMe(login))?.[1] ?? 0) : null), ...others.map(([login, count]) => item(login, count))] };
}

/** Everyone (PRs anyone reviewed), me, then whoever reviewed in the period, most PRs first: who reviewed the most. */
function reviewerSection(): MenuSection {
  const known = searches.get(reviewsKey());
  const since = periodStart();
  const pulls = (known?.pulls ?? []).filter((pull) => matchesRepo(pull) && matchesLabel(pull));
  const counts = reviewerCounts(pulls, since);
  const isMe = (login: string): boolean => login.toLowerCase() === viewer?.toLowerCase();
  const others = counts.filter(([login]) => !isMe(login));
  if (state.reviewer !== '' && state.reviewer !== '@me' && !others.some(([login]) => login === state.reviewer)) others.unshift([state.reviewer, 0]);
  const count = (value: number): string | undefined => (known == null ? undefined : String(value));
  const item = (reviewer: string, value: number) => ({ label: personLabel(reviewer), count: count(value), checked: state.reviewer === reviewer, run: () => setReviewsFilter(state.mergedPeriod, reviewer) });
  return { title: 'Reviewer', items: [item('', reviewedPulls(pulls, state.mergedPeriod, '').length), item('@me', counts.find(([login]) => isMe(login))?.[1] ?? 0), ...others.map(([login, value]) => item(login, value))] };
}

function sortSections(): MenuSection[] {
  return [{ title: 'Sort', items: (Object.keys(SORT_LABELS) as SortOrder[]).map((order) => ({ label: SORT_LABELS[order], hint: '', checked: state.sortOrder === order, run: () => setSortOrder(order) })) }];
}

function openSliceMenu(): void {
  sortMenu.close();
  labelMenu.close();
  sliceMenu.toggle(dom.sliceButton, sliceSections);
}

function openLabelMenu(): void {
  sliceMenu.close();
  sortMenu.close();
  labelMenu.toggle(dom.labelButton, labelSections, 'end');
}

/** GitHub returns at most 1,000 results; say so when a merged search was cut short. */
function mergedNote(): string {
  const entry = searches.get(mergedKey());
  if (entry == null || entry.total <= entry.pulls.length) return '';
  return `Showing the latest ${entry.pulls.length.toLocaleString()} of ${entry.total.toLocaleString()} · pick a person or a shorter period`;
}

/** Changing period or author shows its cached list at once, or an empty one while GitHub answers. */
function setMergedFilter(period: MergedPeriod, author: string): void {
  state.mergedPeriod = period;
  state.mergedAuthor = author;
  localStorage.setItem('mergedPeriod', period);
  localStorage.setItem('mergedAuthor', author);
  stableOrder.reset();
  queueCache.set('merged', searchPulls(mergedKey()));
  applyQueue(queueCache.get('merged') ?? []);
  renderCounts();
  void refresh('merged');
}

/** Changing period shows its cached reviews at once, or none while GitHub answers; changing reviewer only narrows the list. */
function setReviewsFilter(period: MergedPeriod, reviewer: string): void {
  const isNewPeriod = period !== state.mergedPeriod;
  state.mergedPeriod = period;
  state.reviewer = reviewer;
  localStorage.setItem('mergedPeriod', period);
  localStorage.setItem('reviewer', reviewer);
  stableOrder.reset();
  queueCache.set('reviews', deriveQueue('reviews'));
  applyQueue(queueCache.get('reviews') ?? []);
  renderCounts();
  if (isNewPeriod) void refresh('reviews');
}

/** From a shortcut, picking the scope already shown goes back to both, like the smart filters. */
function setAskScope(scope: AskScope, isToggle = true): void {
  state.askScope = isToggle && state.askScope === scope && scope !== 'all' ? 'all' : scope;
  localStorage.setItem('askScope', state.askScope);
  renderList();
  const first = visiblePulls()[0];
  if (first != null && !visiblePulls().some((pull) => pull.id === state.selectedId)) void select(first);
}

function setRepoFilter(repo: string): void {
  state.repoFilter = repo;
  localStorage.setItem('repoFilter', repo);
  renderList();
  const first = visiblePulls()[0];
  if (first != null && !visiblePulls().some((pull) => pull.id === state.selectedId)) void select(first);
}

function toggleLabel(label: string): void {
  setLabelFilter(state.labelFilter.includes(label) ? state.labelFilter.filter((chosen) => chosen !== label) : [...state.labelFilter, label]);
}

/** Always a fresh array: the list cache notices the filter changed by identity. */
function setLabelFilter(labels: string[]): void {
  state.labelFilter = labels;
  localStorage.setItem('labelFilter', JSON.stringify(labels));
  renderList();
  const first = visiblePulls()[0];
  if (first != null && !visiblePulls().some((pull) => pull.id === state.selectedId)) void select(first);
}

let pullIndexSource: PullRequest[] | null = null;
let pullIndex = new Map<string, PullRequest>();

function pullById(id: string | null): PullRequest | undefined {
  if (id == null) return undefined;
  if (pullIndexSource !== state.pulls) {
    pullIndexSource = state.pulls;
    pullIndex = new Map(state.pulls.map((pull) => [pull.id, pull]));
  }
  return pullIndex.get(id);
}

function selectedPull(): PullRequest | undefined {
  return pullById(state.selectedId);
}

function queueLabel(pull: PullRequest): string {
  const entry = pull.queueEntry;
  if (entry == null) return '';
  const phase = entry.state === 'AWAITING_CHECKS' ? 'running checks' : entry.state === 'MERGEABLE' ? 'merging' : entry.state === 'UNMERGEABLE' ? 'failed' : entry.state.toLowerCase().replace(/_/g, ' ');
  return `In merge queue · #${entry.position + 1} · ${phase}`;
}

/** The glyph inside a red status icon, one per kind of blocker. */
const BLOCKER_GLYPHS: Record<Blocker, string> = { conflicts: 'conflicts', 'changes requested': 'changes', 'failing checks': 'checks', blocked: 'rules' };

function statusIcon(pull: PullRequest): string {
  const status = prStatus(pull);
  const label = status.tone === 'queued' ? queueLabel(pull) : status.blocker != null ? describeBlockers(pull).join(' · ') : status.label;
  return `<span class="status ${status.tone}${status.blocker != null ? ` ${BLOCKER_GLYPHS[status.blocker]}` : ''}" title="${escapeHtml(label)}"></span>`;
}

function checksIcon(pull: PullRequest): string {
  switch (pull.checkState) {
    case 'SUCCESS':
      return `<span class="check ok" title="Checks passed">${icon('check')}</span>`;
    case 'FAILURE':
    case 'ERROR':
      return `<span class="check bad" title="${escapeHtml(pull.failingChecks.length === 0 ? 'Checks failed' : `Failing: ${describeFailingChecks(pull)}`)}">${icon('x')}</span>`;
    case 'PENDING':
    case 'EXPECTED':
      return `<span class="check wait" title="Checks running">${icon('circleDashed')}</span>`;
    case null:
      return '';
    default:
      return pull.checkState satisfies never;
  }
}

function readinessOf(pull: PullRequest): { percent: number; tone: 'ok' | 'wait' | 'bad'; reason: string } | null {
  const score = aiScoreFor(pull);
  if (score == null) return null;
  const percent = Math.round(Math.max(0, Math.min(1, score)) * 100);
  return { percent, tone: percent >= 65 ? 'ok' : percent >= 40 ? 'wait' : 'bad', reason: aiResults.get(aiKey(pull))?.reason.trim() ?? '' };
}

/** Jev's readiness score on a row, beside the age so the scores line up in a column. */
function readinessBadge(pull: PullRequest): string {
  const readiness = readinessOf(pull);
  if (readiness == null) return '';
  const { percent, tone, reason } = readiness;
  return `<span class="ai-score ${tone}" title="${escapeHtml(reason === '' ? `Readiness ${percent}%` : `Readiness ${percent}% · ${reason}`)}">${percent}</span>`;
}

/** The same score with its reason, in the open PR's header. */
function readinessChip(pull: PullRequest): string {
  const readiness = readinessOf(pull);
  if (readiness == null) return '';
  const { percent, tone: toneName, reason } = readiness;
  return chip(`<b>${percent}</b>${reason === '' ? '' : `<span class="reason">${escapeHtml(reason)}</span>`}`, reason === '' ? `Readiness ${percent}%` : `Readiness ${percent}% · ${reason}`, `readiness tone-${toneName}`);
}

function avatar(pull: PullRequest): string {
  const url = pull.author?.avatarUrl;
  return url == null ? '<span class="avatar"></span>' : `<img class="avatar" src="${escapeHtml(url)}&s=40" alt="" loading="lazy" />`;
}

function repoName(pull: PullRequest): string {
  return pull.repository.nameWithOwner.split('/')[1] ?? pull.repository.nameWithOwner;
}

function mostCommonRepo(): string | undefined {
  const counts = new Map<string, number>();
  state.pulls.forEach((pull) => counts.set(pull.repository.nameWithOwner, (counts.get(pull.repository.nameWithOwner) ?? 0) + 1));
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function repoTag(pull: PullRequest, primaryRepo: string | undefined): string {
  if (pull.repository.nameWithOwner === primaryRepo) return '';
  return `<span class="repo-tag">${escapeHtml(repoName(pull).replace(/^terraform-provider-/, 'tf-'))}</span>`;
}

/** Each tab counts what it would show under the current repository and smart filters. */
function renderCounts(): void {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>('[data-count]').forEach((badge) => {
    const pulls = queueCache.get(badge.dataset.count as QueueKind);
    badge.textContent = pulls == null ? '' : String(pulls.filter((pull) => matchesFilters(pull, now, badge.dataset.count as QueueKind)).length);
  });
}

const GROUPS_CACHE_KEY = 'jevGroups.v2';
let isGrouped = localStorage.getItem('grouped') === '1';

/** Grouping is for open work; merged and reviewed history stays a plain, newest-first list. */
function isGroupingOn(): boolean {
  return isGrouped && !isHistory(state.kind);
}
let groups: PullGroup[] = [];
let groupsSignature = '';
let isGrouping = false;
const collapsedGroups = new Set<string>(JSON.parse(localStorage.getItem('collapsedGroups') ?? '[]') as string[]);

function pullsSignature(pulls: readonly PullRequest[]): string {
  return pulls.map((pull) => pull.id).sort().join(',');
}

function loadCachedGroups(pulls: readonly PullRequest[]): void {
  try {
    const cached = JSON.parse(localStorage.getItem(GROUPS_CACHE_KEY) ?? 'null') as { signature: string; groups: PullGroup[] } | null;
    if (cached?.signature === pullsSignature(pulls)) {
      groups = cached.groups;
      groupsSignature = cached.signature;
    }
  } catch {
    groups = [];
  }
}

async function ensureGroups(isUserInitiated = false): Promise<void> {
  const signature = pullsSignature(state.pulls);
  if (!isGroupingOn() || !isAiEnabled || isGrouping || signature === groupsSignature || state.pulls.length < 2) return;
  loadCachedGroups(state.pulls);
  if (groupsSignature === signature) return renderList();
  isGrouping = true;
  renderList();
  try {
    groups = await groupPulls(state.pulls);
    groupsSignature = signature;
    localStorage.setItem(GROUPS_CACHE_KEY, JSON.stringify({ signature, groups }));
  } catch (error) {
    if (isUserInitiated) toast(`Grouping failed: ${errorMessage(error)}`, true);
    else console.warn('background regroup failed', errorMessage(error));
  } finally {
    isGrouping = false;
    renderList();
  }
}

function toggleGrouping(): void {
  if (!isAiEnabled) {
    toast('Grouping needs TYPESAFE_API_KEY.', true);
    return;
  }
  isGrouped = !isGrouped;
  localStorage.setItem('grouped', isGrouped ? '1' : '0');
  renderList();
  void ensureGroups(true);
}

function averageReadiness(pulls: PullRequest[]): number {
  const now = Date.now();
  const scores = pulls.map((pull) => aiScoreFor(pull) ?? (isReady(pull) ? 0.6 : 0.2) - Math.min(0.2, (now - Date.parse(pull.updatedAt)) / 8.64e8));
  return scores.reduce((total, score) => total + score, 0) / Math.max(1, scores.length);
}

interface ListSection {
  group: PullGroup | null;
  pulls: PullRequest[];
}

function listSections(pulls: PullRequest[]): ListSection[] {
  if (!isGroupingOn() || groups.length === 0) return [{ group: null, pulls }];
  const averages = new Map<string, number>();
  const averageFor = (section: ListSection): number => {
    const id = section.group?.id ?? '';
    const cached = averages.get(id);
    if (cached != null) return cached;
    const value = averageReadiness(section.pulls);
    averages.set(id, value);
    return value;
  };
  const order = new Map(pulls.map((pull, index) => [pull.id, index]));
  const assigned = new Set<string>();
  const sections = groups
    .map((group): ListSection => {
      const members = group.pullIds.filter((id) => order.has(id)).sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
      members.forEach((id) => assigned.add(id));
      return { group, pulls: members.map((id) => pulls[order.get(id) ?? 0] as PullRequest) };
    })
    .filter((section) => section.pulls.length > 0)
    .sort((left, right) => averageFor(right) - averageFor(left));
  const rest = pulls.filter((pull) => !assigned.has(pull.id));
  if (rest.length > 0) sections.push({ group: { id: 'ungrouped', label: 'Other', pullIds: rest.map((pull) => pull.id) }, pulls: rest });
  return sections;
}

function groupHeader(section: ListSection): string {
  const group = section.group;
  if (group == null) return '';
  const isCollapsed = collapsedGroups.has(group.id);
  return `<li class="group-row${isCollapsed ? ' collapsed' : ''}" data-group="${escapeHtml(group.id)}">
    <span class="caret">${icon('chevronRight')}</span>
    <span class="group-label" title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</span>
    <button class="group-select" data-group-select="${escapeHtml(group.id)}" title="Select all ${section.pulls.length} in group">Select</button>
  </li>`;
}

const ROW_HEIGHT = 52;
const GROUP_ROW_HEIGHT = 30;
const STATUS_ROW_HEIGHT = 30;
const virtualList = new VirtualList(dom.list);

/** One fixed column per AI reviewer (Claude, then Greptile) beside the author avatar; empty when it has not touched the PR. */
function botMarks(pull: PullRequest): string {
  const marks = botReviews(pull).map((review) => {
    if (review == null) return '<span class="bot-mark"></span>';
    const label = describeBotReview(review, (iso) => `${relativeTime(iso)} ago`);
    return `<span class="bot-mark ${review.state}${review.isOutdated ? ' outdated' : ''}" title="${escapeHtml(label)}"><img src="${escapeHtml(review.avatarUrl)}&s=32" alt="" loading="lazy" /></span>`;
  });
  return `<span class="bot-marks">${marks.join('')}</span>`;
}

function waitingLabel(turn: Extract<Turn, { whose: 'theirs' }>): string {
  return `Waiting on ${turn.waitingOn.map((name) => `@${name}`).join(', ')}`;
}

/** "You" when I am asked to review by name; a quiet team mark, named in its tooltip, when the request reaches me through a team. */
function askTag(pull: PullRequest): string {
  const ask = askFor(pull);
  if (ask == null) return '';
  const title = escapeHtml(describeAsk(ask));
  if (ask.to === 'me') return `<span class="ask-tag me" title="${title}">${icon('user')}<span>You</span></span>`;
  return `<span class="ask-tag team" title="${title}">${icon('users')}</span>`;
}

/** A fixed-width slot, empty when nobody has a turn, so rows stay aligned. */
function turnMarker(pull: PullRequest): string {
  const turn = turnFor(pull);
  if (turn == null) return '<span class="turn"></span>';
  if (turn.whose === 'mine') return `<span class="turn mine" title="Your turn · ${escapeHtml(turn.reason)}"></span>`;
  return `<span class="turn theirs" title="${escapeHtml(waitingLabel(turn))}">${icon('hourglass')}</span>`;
}

/** Time since the last update; on Reviews, since the last review in the period; for other merged PRs, since the merge. */
function ageLabel(pull: PullRequest): string {
  const reviewedAt = state.kind === 'reviews' ? lastReviewAt(pull, periodStart(), reviewerLogin()) : null;
  if (reviewedAt != null) return `<span class="age" title="${escapeHtml(reviewedTitle(pull))}">${relativeTime(new Date(reviewedAt).toISOString())}</span>`;
  if (pull.mergedAt == null) return `<span class="age">${relativeTime(pull.updatedAt)}</span>`;
  return `<span class="age" title="${escapeHtml(`Merged ${relativeTime(pull.mergedAt)} ago${pull.mergedBy == null ? '' : ` by @${pull.mergedBy}`}`)}">${relativeTime(pull.mergedAt)}</span>`;
}

function rowHtml(pull: PullRequest, primaryRepo: string | undefined, needle: string): string {
  const isChecked = state.checkedIds.has(pull.id);
  const exit = leaving.get(pull.id);
  return `<li data-key="${pull.id}" data-id="${pull.id}" class="${pull.id === state.selectedId ? 'selected' : ''}${isChecked ? ' checked' : ''}${pull.queueEntry != null ? ' queued' : ''}${exit != null ? ' leaving' : ''}${exit?.isPending === true ? ' pending' : ''}${failedMerges.has(pull.id) ? ' merge-failed' : ''}"${exit != null ? ` data-leaving="${escapeHtml(exit.label)}"` : ''}>
        <span class="lead">${statusIcon(pull)}<span class="check-box" data-check="${pull.id}" role="checkbox" aria-checked="${isChecked}" title="Select  E / ⇧V"></span></span>
        <span class="row-main">
          <span class="row-top"><span class="t">${escapeHtml(pull.title)}</span>${readinessBadge(pull)}${turnMarker(pull)}${ageLabel(pull)}</span>
          <span class="row-meta">${repoTag(pull, primaryRepo)}<span class="author">${escapeHtml(pull.author?.login ?? 'ghost')}</span><span class="sep">·</span><span class="id" title="${escapeHtml(pull.repository.nameWithOwner)}">#${pull.number}</span><span class="sep">·</span><span class="delta">+${pull.additions.toLocaleString('en')} −${pull.deletions.toLocaleString('en')}</span>${pull.queueEntry == null ? '' : `<span class="sep">·</span><span class="queued-note" title="${escapeHtml(queueLabel(pull))}">Queued #${pull.queueEntry.position + 1}</span>`}${checksIcon(pull)}<span class="grow"></span>${askTag(pull)}${botMarks(pull)}</span>
        </span>
      </li>`;
}

function renderListEmpty(count: number, needle: string): void {
  const box = document.getElementById('list-empty');
  if (box == null) return;
  const isBooting = fetchedAt(state.kind) == null && state.pulls.length === 0;
  const isSearching = needle !== '' && isSemanticLoading;
  const isAwaiting = count === 0 && state.pulls.length > 0 && isAwaitingMergeStates();
  const kind = count > 0 || isBooting ? '' : isSearching ? 'searching' : isAwaiting ? 'checking' : state.pulls.length === 0 ? 'empty' : needle !== '' ? 'no-results' : 'filtered';
  const filterLabel = state.smartFilter === 'ready' ? 'Ready' : state.smartFilter === 'attention' ? 'Unready' : state.smartFilter;
  const repoLabel = state.repoFilter.split('/')[1] ?? state.repoFilter;
  const where = [repoLabel === '' ? '' : `in ${repoLabel}`, state.labelFilter.length === 0 ? '' : `labelled ${state.labelFilter.join(' or ')}`].filter((part) => part !== '').join(' ');
  const scope = hasAskScope(state.kind) ? state.askScope : 'all';
  const signature = [kind, filterLabel, where, scope, needle].join('|');
  if (box.dataset.signature === signature) return;
  box.dataset.kind = kind;
  box.dataset.signature = signature;
  const scopeTitle = scope === 'me' ? 'Nothing here for you alone right now' : 'No team review requests here right now';
  const filteredTitle = scope !== 'all' && state.smartFilter === 'all' ? scopeTitle : where === '' ? `Nothing is ${escapeHtml(filterLabel)} right now` : state.smartFilter === 'all' ? `No pull requests ${escapeHtml(where)} here` : `Nothing ${escapeHtml(where)} is ${escapeHtml(filterLabel)} right now`;
  const views: Record<string, string> = {
    searching: `${icon('search', 'empty-ico')}<b>Searching…</b><span>Looking for “${escapeHtml(needle)}”</span><div class="empty-skel"><span></span><span></span><span></span></div>`,
    checking: `<div class="empty-overlay"><b>Checking merge status…</b><span>Asking GitHub which PRs are ready to merge</span></div>`,
    'no-results': `${icon('search', 'empty-ico')}<b>No pull requests match “${escapeHtml(needle)}”</b><span>Try another word, or clear the filter</span><button type="button" class="ghost" data-empty-action="clear-filter">Clear filter <kbd>esc</kbd></button>`,
    filtered: `${icon('circleCheck', 'empty-ico')}<b>${filteredTitle}</b><span>Everything else is still in All</span><button type="button" class="ghost" data-empty-action="show-all">Show all <kbd>⌥</kbd><kbd>0</kbd></button>`,
    empty: state.kind === 'merged' ? `${icon('merge', 'empty-ico')}<b>Nothing merged</b><span>${escapeHtml(MERGED_PERIODS[state.mergedPeriod])}, ${state.mergedAuthor === '' ? 'by anyone' : state.mergedAuthor === '@me' ? 'by you' : `by @${escapeHtml(state.mergedAuthor)}`}</span>` : state.kind === 'reviews' ? `${icon('userCheck', 'empty-ico')}<b>No reviews</b><span>${escapeHtml(MERGED_PERIODS[state.mergedPeriod])}, ${state.reviewer === '' ? 'by anyone' : state.reviewer === '@me' ? 'by you' : `by @${escapeHtml(state.reviewer)}`}</span>` : `${icon('circleCheck', 'empty-ico')}<b>Inbox zero</b><span>No open pull requests in this view</span>`,
  };
  box.innerHTML = kind === '' ? '' : kind === 'checking' ? `<div class="list-checking">${listSkeleton()}${views[kind]}</div>` : `<div class="list-empty-inner">${views[kind]}</div>`;
  box.hidden = kind === '';
}

function renderList(): void {
  const pulls = filteredPulls();
  const primaryRepo = mostCommonRepo();
  const sections = listSections(pulls);
  const needle = state.filter.trim().toLowerCase();
  const rows: VirtualRow[] = [];
  const note = state.kind === 'merged' ? mergedNote() : !isGroupingOn() ? '' : isGrouping ? '<span class="spinner"></span>Grouping related work…' : groups.length === 0 ? 'No groups yet · press ⇧T again or run “Regroup”' : '';
  if (note !== '') rows.push({ key: 'status', height: STATUS_ROW_HEIGHT, render: () => `<li data-key="status" class="group-status">${note}</li>` });
  for (const section of sections) {
    const group = section.group;
    if (group != null) rows.push({ key: `group:${group.id}`, height: GROUP_ROW_HEIGHT, render: () => groupHeader(section).replace('<li ', `<li data-key="group:${escapeHtml(group.id)}" `) });
    if (section.group != null && collapsedGroups.has(section.group.id)) continue;
    for (const pull of section.pulls) rows.push({ key: pull.id, height: ROW_HEIGHT, render: () => rowHtml(pull, primaryRepo, needle) });
  }
  dom.list.classList.toggle('grouped', isGroupingOn() && groups.length > 0);
  virtualList.setRows(rows);
  renderListEmpty(pulls.length, needle);
  virtualList.highlightKey(pulls.some((pull) => pull.id === state.selectedId) ? state.selectedId : null);
  renderCounts();
  renderSlice();
  renderBulkBar();
  syncDetailVisibility(pulls);
}

let pendingAutoSelect = 0;

function isAwaitingMergeStates(): boolean {
  if (state.smartFilter !== 'ready' && state.smartFilter !== 'attention') return false;
  return state.pulls.some((pull) => pull.mergeStateStatus === 'UNKNOWN' && !pull.isDraft);
}

function isMergeStateSettled(pull: PullRequest): boolean {
  return pull.isDraft || pull.mergeStateStatus !== 'UNKNOWN';
}

function syncDetailVisibility(pulls: PullRequest[]): void {
  const hasSelection = selectedPull() != null;
  if (state.pulls.length > 0) document.getElementById('list-skeleton')?.remove();
  if (hasSelection) {
    clearBootSkeletons();
    dom.pr.hidden = false;
    dom.empty.hidden = true;
    return;
  }
  const first = pulls[0];
  if (first != null) {
    cancelAnimationFrame(pendingAutoSelect);
    pendingAutoSelect = requestAnimationFrame(() => {
      if (selectedPull() == null) void select(first);
    });
    return;
  }
  if (fetchedAt(state.kind) == null && state.pulls.length === 0) return;
  if (pulls.length === 0 && state.pulls.length > 0 && isAwaitingMergeStates()) {
    dom.pr.hidden = true;
    dom.empty.hidden = false;
    if (!dom.empty.classList.contains('is-loading')) {
      dom.empty.classList.add('is-loading');
      dom.empty.innerHTML = `<div class="boot-skeleton" aria-busy="true">${bootSkeleton()}</div>`;
    }
    return;
  }
  clearBootSkeletons();
  dom.pr.hidden = true;
  dom.empty.hidden = false;
  dom.empty.textContent = state.pulls.length === 0 ? 'No pull requests here.' : pulls.length === 0 ? 'No matches.' : 'Select a pull request';
}

function mergeState(pull: PullRequest): { label: string; tone: string } {
  if (pull.queueEntry != null) return { label: pull.queueEntry.state === 'UNMERGEABLE' ? 'Queue failed' : `In merge queue #${pull.queueEntry.position + 1}`, tone: pull.queueEntry.state === 'UNMERGEABLE' ? 'bad' : 'wait' };
  if (pull.isDraft) return { label: 'Draft', tone: 'muted' };
  if (pull.mergeable === 'CONFLICTING') return { label: 'Conflicts', tone: 'bad' };
  switch (pull.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { label: 'Ready', tone: 'ok' };
    case 'UNSTABLE':
      return { label: 'Checks failing', tone: 'bad' };
    case 'BLOCKED':
      return { label: 'Blocked', tone: 'bad' };
    case 'BEHIND':
      return { label: 'Behind base', tone: 'wait' };
    default:
      return { label: 'Checking…', tone: 'muted' };
  }
}

function reviewLabel(pull: PullRequest): { label: string; tone: string } {
  switch (pull.reviewDecision) {
    case 'APPROVED':
      return { label: 'Approved', tone: 'ok' };
    case 'CHANGES_REQUESTED':
      return { label: 'Changes requested', tone: 'bad' };
    case 'REVIEW_REQUIRED':
      return { label: 'Review required', tone: 'wait' };
    case null:
      return { label: 'Not approved', tone: 'wait' };
    default:
      return pull.reviewDecision satisfies never;
  }
}

function checksLabel(pull: PullRequest): { label: string; tone: string } {
  switch (pull.checkState) {
    case 'SUCCESS':
      return { label: 'Passing', tone: 'ok' };
    case 'FAILURE':
    case 'ERROR':
      return { label: 'Failing', tone: 'bad' };
    case 'PENDING':
    case 'EXPECTED':
      return { label: 'Running', tone: 'wait' };
    case null:
      return { label: 'Not approved', tone: 'wait' };
    default:
      return pull.checkState satisfies never;
  }
}



function skeletonLine(width: string, extra = ''): string {
  return `<span class="sk-line ${extra}" style="width:${width}"></span>`;
}

function conversationSkeleton(): string {
  return `<div class="skeleton">${[0, 1].map(() => `<div class="sk-comment"><span class="sk-avatar"></span><div class="sk-comment-body">${skeletonLine('28%')}${skeletonLine('92%')}${skeletonLine('70%')}</div></div>`).join('')}</div>`;
}

const REVIEW_LABELS: Record<string, { label: string; tone: string }> = {
  APPROVED: { label: 'approved', tone: 'ok' },
  CHANGES_REQUESTED: { label: 'requested changes', tone: 'bad' },
  COMMENTED: { label: 'reviewed', tone: 'muted' },
  DISMISSED: { label: 'review dismissed', tone: 'muted' },
};

let showBotComments = localStorage.getItem('showBotComments') !== '0';

function conversationItemHtml(item: ConversationItem): string {
  const review = item.reviewState == null ? null : REVIEW_LABELS[item.reviewState] ?? { label: item.reviewState.toLowerCase(), tone: 'muted' };
  const avatarHtml = item.avatarUrl == null ? '<span class="avatar"></span>' : `<img class="avatar" src="${escapeHtml(item.avatarUrl)}&s=48" alt="" loading="lazy" />`;
  const action = review == null ? 'commented' : `<span class="review-state tone-${review.tone}">${review.label}</span>`;
  const inline = item.inlineCount > 0 && item.threads.length === 0 ? `<span class="muted">· ${item.inlineCount} inline comment${item.inlineCount === 1 ? '' : 's'}</span>` : '';
  const threads = item.threads.length === 0 ? '' : `<div class="review-threads">${item.threads.map((thread) => threadHtml(thread, { withContext: true, ago: relativeTime })).join('')}</div>`;
  const body = `${item.html.trim() === '' ? '' : `<div class="markdown comment-body">${sanitizeHtml(item.html)}</div>`}${threads}`;
  return `<article class="comment${item.isBot ? ' is-bot' : ''}${review != null ? ` review tone-${review.tone}` : ''}">
    <header>${avatarHtml}<b>${escapeHtml(item.author)}</b>${item.isBot ? '<span class="bot-tag">bot</span>' : ''}${action}${inline}<a class="comment-time" href="${escapeHtml(item.url)}" title="Open on GitHub">${relativeTime(item.at)} ago</a></header>
    ${body}
  </article>`;
}

function renderConversation(container: Element, items: ConversationItem[]): void {
  const visible = showBotComments ? items : items.filter((item) => !item.isBot);
  const botCount = items.filter((item) => item.isBot).length;
  const count = container.querySelector('.conversation-count');
  if (count != null) count.innerHTML = `${items.length} · <button class="link-button" data-toggle-bots>${showBotComments ? 'Hide' : 'Show'} ${botCount} bot${botCount === 1 ? '' : 's'}</button>`;
  const list = container.querySelector('.conversation-list');
  if (list == null) return;
  list.innerHTML = visible.length === 0 ? `<p class="muted">${items.length === 0 ? 'No comments yet.' : 'Only bot comments · hidden.'}</p>` : visible.map(conversationItemHtml).join('');
  list.classList.add('fade-in');
  preloadImages(imageUrlsInHtml(visible.map((item) => item.html).join('')));
  clampLongComments(list);
}

const COMMENT_CLAMP_PX = 320;

function clampLongComments(list: Element): void {
  requestAnimationFrame(() => {
    list.querySelectorAll<HTMLElement>('.comment-body').forEach((body) => {
      if (body.scrollHeight <= COMMENT_CLAMP_PX + 40 || body.nextElementSibling?.classList.contains('comment-more')) return;
      body.classList.add('is-clamped');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'comment-more';
      more.textContent = 'Show more';
      more.addEventListener('click', () => {
        const isClamped = body.classList.toggle('is-clamped');
        more.textContent = isClamped ? 'Show more' : 'Show less';
        if (isClamped) body.closest('.comment')?.scrollIntoView({ block: 'nearest' });
      });
      body.after(more);
    });
  });
}

function listSkeleton(): string {
  const titles = [72, 58, 81, 64, 49, 77, 60, 69, 54, 74, 62, 57, 79, 51];
  return titles.map((width, index) => `<div class="sk-row" style="--delay:${index * 40}ms"><span class="sk-dot"></span><span class="sk-lines"><span class="sk-line" style="width:${width}%"></span><span class="sk-line sk-meta" style="width:${Math.round(width * 0.6)}%"></span></span><span class="sk-line sk-age"></span></div>`).join('');
}

function bootSkeleton(): string {
  return `<div class="boot-head"><span class="sk-line" style="width:180px"></span><span class="sk-dot"></span></div>
    <div class="boot-split"><div class="boot-desc">${descriptionSkeleton()}</div><div class="boot-diff">${diffSkeleton()}</div></div>`;
}

function renderBootSkeletons(): void {
  const list = document.getElementById('list-skeleton');
  if (list != null && state.pulls.length === 0) list.innerHTML = listSkeleton();
  const boot = dom.empty.querySelector('.boot-skeleton');
  if (boot != null) boot.innerHTML = bootSkeleton();
}

function clearBootSkeletons(): void {
  document.getElementById('list-skeleton')?.remove();
  dom.empty.classList.remove('is-loading');
}

function descriptionSkeleton(): string {
  return `<div class="skeleton" aria-label="Loading description" aria-busy="true">
    ${skeletonLine('22%', 'sk-heading')}
    ${skeletonLine('96%')}${skeletonLine('88%')}${skeletonLine('64%')}
    ${skeletonLine('30%', 'sk-heading')}
    ${skeletonLine('92%')}${skeletonLine('81%')}${skeletonLine('86%')}${skeletonLine('48%')}
    <span class="sk-block"></span>
  </div>`;
}

function filesSkeleton(): string {
  const widths = ['62%', '48%', '74%', '55%', '68%', '40%'];
  return `<div class="skeleton files-skeleton" aria-busy="true">${widths.map((width) => `<div class="sk-file"><span class="sk-line" style="width:${width}"></span><span class="sk-line sk-count"></span></div>`).join('')}</div>`;
}

function diffSkeleton(): string {
  const cards = [9, 6, 11].map((lines, card) => `<div class="sk-diff-card">
      <div class="sk-diff-head"><span class="sk-dot"></span><span class="sk-line" style="width:${[44, 58, 36][card]}%"></span></div>
      ${Array.from({ length: lines }, (_, line) => `<div class="sk-diff-row"><span class="sk-gutter"></span><span class="sk-line${line % 4 === 1 ? ' sk-add' : line % 5 === 3 ? ' sk-del' : ''}" style="width:${35 + ((line * 37 + card * 13) % 55)}%"></span></div>`).join('')}
    </div>`);
  return `<div class="skeleton diff-skeleton" aria-busy="true">${cards.join('')}</div>`;
}

function showDiffLoading(isLoading: boolean): void {
  let overlay = document.getElementById('diff-loading');
  if (!isLoading) {
    overlay?.classList.add('done');
    window.setTimeout(() => overlay?.remove(), 180);
    return;
  }
  if (overlay == null) {
    overlay = document.createElement('div');
    overlay.id = 'diff-loading';
    dom.diffRoot.parentElement?.insertBefore(overlay, dom.diffRoot);
  }
  overlay.classList.remove('done');
  overlay.innerHTML = diffSkeleton();
}

function descriptionHtml(bodyHtml: string): string {
  return bodyHtml.trim() === '' ? '<p class="muted">No description provided.</p>' : sanitizeHtml(bodyHtml);
}

function renderDescription(pull: PullRequest): HTMLElement {
  const wrapper = document.createElement('article');
  wrapper.className = 'description';
  const body = descriptionSkeleton();
  wrapper.innerHTML = `
    <h1>${escapeHtml(pull.title)}</h1>
    <div class="byline">${avatar(pull)}<b>${escapeHtml(pull.author?.login ?? 'ghost')}</b> opened ${relativeTime(pull.createdAt)} ago · <code>${escapeHtml(pull.headRefName)}</code> → <code>${escapeHtml(pull.baseRefName)}</code></div>
    <div class="markdown">${body}</div>
    <section class="conversation" data-conversation><div class="conversation-head"><span>Conversation</span><span class="muted conversation-count"></span></div><div class="conversation-list">${conversationSkeleton()}</div></section>
    <div class="files-divider"><span>${pull.changedFiles} files changed</span><span><i class="add">+${pull.additions}</i> <i class="del">−${pull.deletions}</i></span></div>`;
  return wrapper;
}


function chip(content: string, title: string, className = ''): string {
  return `<span class="chip-meta ${className}" title="${escapeHtml(title)}">${content}</span>`;
}

function turnChip(pull: PullRequest): string {
  const turn = turnFor(pull);
  if (turn == null) return '';
  if (turn.whose === 'mine') return chip(`<span class="turn mine"></span>Your turn · ${escapeHtml(turn.reason)}`, `Your turn · ${turn.reason}`, 'plain turn-chip mine');
  return chip(`${icon('hourglass')}${escapeHtml(waitingLabel(turn))}`, waitingLabel(turn), 'plain turn-chip theirs');
}

function askChip(pull: PullRequest): string {
  const ask = askFor(pull);
  if (ask == null) return '';
  const label = ask.to === 'me' ? 'Requested from you' : ask.teams.length === 0 ? 'Requested from your team' : `Requested from ${ask.teams.map((team) => `@${team}`).join(', ')}`;
  return chip(`${icon(ask.to === 'me' ? 'user' : 'users')}${escapeHtml(label)}`, describeAsk(ask), `plain ask-chip ${ask.to}`);
}

function mergedChip(pull: PullRequest): string {
  if (pull.mergedAt == null) return '';
  const label = `Merged ${relativeTime(pull.mergedAt)} ago${pull.mergedBy == null ? '' : ` by @${pull.mergedBy}`}`;
  return chip(`${icon('merge')}${escapeHtml(label)}`, `${label} · ${new Date(pull.mergedAt).toLocaleString()}`, 'plain merged-chip');
}

function renderDetailMeta(pull: PullRequest): void {
  const checks = checksLabel(pull);
  const review = reviewLabel(pull);
  const merge = mergeState(pull);
  const failing = isFailing(pull) ? describeFailingChecks(pull) : '';
  const summary = [merge.label, review.tone === 'muted' ? '' : review.label, checks.tone === 'muted' ? '' : `Checks ${checks.label.toLowerCase()}${failing === '' ? '' : `: ${failing}`}`].filter((part) => part !== '').join(' · ');
  dom.statusBar.innerHTML = [
    chip(`${avatar(pull)}${escapeHtml(pull.author?.login ?? 'ghost')}`, 'Author', 'plain'),
    chip(`<code>${escapeHtml(pull.headRefName)}</code><span class="arrow">→</span><code>${escapeHtml(pull.baseRefName)}</code>`, `${pull.headRefName} → ${pull.baseRefName}`, 'plain branch'),
    mergedChip(pull),
    askChip(pull),
    turnChip(pull),
    readinessChip(pull),
    `<span class="status-summary" title="${escapeHtml(summary)}">${statusIcon(pull)}</span>`,
  ].join('');
  const isMerged = pull.mergedAt != null;
  const isClosed = !isMerged && pull.closedAt != null;
  dom.merge.disabled = isMerged || isClosed || pull.isDraft || pull.mergeable === 'CONFLICTING' || pull.queueEntry != null || leaving.has(pull.id);
  const isOwn = isOwnPull(pull);
  dom.approve.disabled = isOwn || isMerged || isClosed;
  dom.approve.title = isMerged ? 'Already merged' : isClosed ? 'Closed' : isOwn ? 'You can’t approve your own pull request' : 'Approve  A';
  if (pull.queueEntry != null) {
    dom.merge.innerHTML = `${MERGE_ICON}<span class="merge-count">#${pull.queueEntry.position + 1}</span>`;
    dom.merge.title = `In merge queue #${pull.queueEntry.position + 1}`;
  }
}

function syncQueueState(pull: PullRequest): void {
  isSelectedQueued = false;
  syncMergeLabel();
  void usesMergeQueue(pull).then((isQueued) => {
    if (selectedPull()?.id !== pull.id) return;
    isSelectedQueued = isQueued;
    syncMergeLabel();
  });
}

/** The conversation on screen, so the bot toggle and background updates re-render what is current. */
let shownConversation: ConversationItem[] = [];
let shownDescription: HTMLElement | null = null;

/** Fills the description's conversation and puts the code threads under their lines in the diff. */
function showConversation(pull: PullRequest, description: HTMLElement): void {
  const token = renderToken;
  void loadConversation(pull).then(
    (items) => {
      if (token !== renderToken) return;
      const section = description.querySelector('[data-conversation]');
      if (section == null) return;
      shownConversation = items;
      renderConversation(section, items);
    },
    (error: unknown) => {
      if (token !== renderToken) return;
      const list = description.querySelector('.conversation-list');
      if (list != null) list.innerHTML = `<p class="error">Could not load comments: ${escapeHtml(errorMessage(error))}</p>`;
      retryDetail(pull);
    },
  );
  void loadThreads(pull).then(
    (threads) => {
      if (token !== renderToken) return;
      setShownThreads(pull, threads);
    },
    () => undefined,
  );
}

/** After posting: the conversation and the threads again, without rebuilding the description. */
function refreshConversation(pull: PullRequest): void {
  invalidateConversation(pull);
  if (shownDescription != null && selectedPull()?.id === pull.id) showConversation(pull, shownDescription);
}

// --- Code comments: threads under their lines, and drafts from the gutter "+" ---

interface LineDraft {
  key: string;
  pullId: string;
  path: string;
  side: 'additions' | 'deletions';
  line: number;
  startLine: number | null;
  startSide: 'additions' | 'deletions';
  /** What the box opens with, when a pending comment goes back to being edited. */
  text?: string;
}

const lineDrafts = new Map<string, LineDraft>();

// --- The pending review: comments kept here until "Finish review" publishes them together ---

interface PendingComment {
  id: string;
  path: string;
  side: 'additions' | 'deletions';
  line: number;
  startLine: number | null;
  startSide: 'additions' | 'deletions';
  body: string;
}

/** Comments are tied to the commit they were written on, as GitHub's pending reviews are. */
interface PendingReview {
  commit: string;
  comments: PendingComment[];
}

const PENDING_REVIEWS_KEY = 'pendingReviews';

function storedPendingReviews(): Record<string, PendingReview> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PENDING_REVIEWS_KEY) ?? '{}');
    return stored != null && typeof stored === 'object' ? (stored as Record<string, PendingReview>) : {};
  } catch {
    return {};
  }
}

let pendingReviews = storedPendingReviews();

function savePendingReviews(): void {
  try {
    localStorage.setItem(PENDING_REVIEWS_KEY, JSON.stringify(pendingReviews));
  } catch {
    toast('Could not save the pending review on this Mac', true);
  }
}

function pendingComments(pull: PullRequest): PendingComment[] {
  return pendingReviews[pull.id]?.comments ?? [];
}

function setPendingComments(pull: PullRequest, comments: PendingComment[]): void {
  if (comments.length === 0) delete pendingReviews[pull.id];
  else pendingReviews[pull.id] = { commit: pendingReviews[pull.id]?.commit ?? pull.headRefOid, comments };
  savePendingReviews();
  syncAnnotations(pull);
}

let discardArmedUntil = 0;

/** The bar over the diff while a review is pending; Discard asks twice so a stray click loses nothing. */
function syncReviewBar(pull: PullRequest | undefined): void {
  const count = pull == null ? 0 : pendingComments(pull).length;
  dom.reviewBar.hidden = count === 0;
  dom.reviewBarCount.textContent = `${count} pending comment${count === 1 ? '' : 's'}`;
  discardArmedUntil = 0;
  dom.reviewDiscard.textContent = 'Discard';
  const reviewLabel = count === 0 ? 'Start review' : 'Add to review';
  document.querySelectorAll<HTMLButtonElement>('[data-composer-review]').forEach((button) => {
    button.textContent = reviewLabel;
    button.dataset.tip = `${reviewLabel}  ⇧⌘↵`;
  });
}

function toSide(side: PendingComment['side']): 'LEFT' | 'RIGHT' {
  return side === 'deletions' ? 'LEFT' : 'RIGHT';
}

function addToReview(composer: HTMLElement): void {
  const pull = selectedPull();
  const draftKey = composer.closest<HTMLElement>('.diff-annotation[data-draft]')?.dataset.draft;
  const draft = draftKey == null ? undefined : lineDrafts.get(draftKey);
  const body = composer.querySelector<HTMLTextAreaElement>('textarea')?.value.trim() ?? '';
  if (pull == null || draft == null || body === '') return;
  const comments = [...pendingComments(pull), { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, path: draft.path, side: draft.side, line: draft.line, startLine: draft.startLine, startSide: draft.startSide, body }];
  dropDraft(draft.key);
  setPendingComments(pull, comments);
  toast(`Added to your review · ${comments.length} pending`);
}

/** Edit turns a pending comment back into a draft on the same lines, holding its text. */
function editPending(id: string): void {
  const pull = selectedPull();
  const comment = pull == null ? undefined : pendingComments(pull).find((candidate) => candidate.id === id);
  if (pull == null || comment == null) return;
  const key = `draft:${pull.id}:${comment.path}:${comment.side}:${comment.line}`;
  lineDrafts.set(key, { key, pullId: pull.id, path: comment.path, side: comment.side, line: comment.line, startLine: comment.startLine, startSide: comment.startSide, text: comment.body });
  annotationElements.delete(key);
  setPendingComments(pull, pendingComments(pull).filter((candidate) => candidate.id !== id));
  focusComposer(annotationElements.get(key));
}

function deletePending(id: string): void {
  const pull = selectedPull();
  if (pull != null) setPendingComments(pull, pendingComments(pull).filter((candidate) => candidate.id !== id));
}

function openReviewDialog(): void {
  const pull = selectedPull();
  if (pull == null || dom.reviewDialog.open) return;
  const count = pendingComments(pull).length;
  const canApprove = !isOwnPull(pull) && isOpen(pull);
  const approve = dom.reviewDialog.querySelector<HTMLInputElement>('input[value="APPROVE"]');
  if (approve != null) approve.disabled = !canApprove;
  element('review-approve-note').textContent = canApprove ? 'Ready to merge from your side' : isOwnPull(pull) ? 'You can’t approve your own pull request' : pull.mergedAt == null ? 'Closed' : 'Already merged';
  const comment = dom.reviewDialog.querySelector<HTMLInputElement>('input[value="COMMENT"]');
  if (comment != null) comment.checked = true;
  dom.reviewNote.textContent = count === 0 ? 'No pending comments: the summary goes out on its own.' : `${count} pending comment${count === 1 ? '' : 's'} will be published with it.`;
  dom.reviewSubmit.disabled = false;
  dom.reviewDialog.showModal();
  dom.reviewBody.focus();
}

async function sendReview(): Promise<void> {
  const pull = selectedPull();
  if (pull == null || dom.reviewSubmit.disabled) return;
  const event = (dom.reviewDialog.querySelector<HTMLInputElement>('input[name="review-event"]:checked')?.value ?? 'COMMENT') as ReviewEvent;
  const body = dom.reviewBody.value.trim();
  const pending = pendingReviews[pull.id];
  const comments = (pending?.comments ?? []).map((comment): ReviewCommentInput => ({
    path: comment.path,
    line: comment.line,
    side: toSide(comment.side),
    ...(comment.startLine == null ? {} : { start_line: comment.startLine, start_side: toSide(comment.startSide) }),
    body: comment.body,
  }));
  if (event !== 'APPROVE' && body === '' && comments.length === 0) {
    toast('Write a summary, or add comments to the review first', true);
    return;
  }
  dom.reviewSubmit.disabled = true;
  try {
    await submitReview(pull, pending?.commit ?? pull.headRefOid, event, body, comments);
    delete pendingReviews[pull.id];
    savePendingReviews();
    dom.reviewBody.value = '';
    dom.reviewDialog.close();
    syncAnnotations(pull);
    toast(event === 'APPROVE' ? `Approved #${pull.number}` : event === 'REQUEST_CHANGES' ? `Requested changes on #${pull.number}` : `Review sent on #${pull.number}`);
    followUp([pull.id]);
    refreshConversation(pull);
  } catch (error) {
    toast(codeCommentError(error), true);
    dom.reviewSubmit.disabled = false;
  }
}

async function toggleResolved(button: HTMLButtonElement): Promise<void> {
  const pull = selectedPull();
  const threadId = button.dataset.resolveThread;
  if (pull == null || threadId == null || button.disabled) return;
  const resolve = button.dataset.resolved !== 'true';
  button.disabled = true;
  try {
    await resolveThread(threadId, resolve);
    toast(resolve ? 'Resolved' : 'Unresolved');
    refreshConversation(pull);
  } catch (error) {
    toast(errorMessage(error), true);
    button.disabled = false;
  }
}
const annotationRefs = new Map<string, AnnotationRef>();
const annotationElements = new Map<string, HTMLElement>();
let shownThreads: { pullId: string; threads: ReviewThread[] } = { pullId: '', threads: [] };

/** A thread's key changes with its content, so a new reply or a resolve renders it afresh. */
function threadKey(thread: ReviewThread): string {
  return `thread:${thread.id}:${thread.comments.length}:${thread.isResolved}`;
}

function annotationRef(key: string): AnnotationRef {
  const existing = annotationRefs.get(key);
  if (existing != null) return existing;
  const ref = { key };
  annotationRefs.set(key, ref);
  return ref;
}

function setShownThreads(pull: PullRequest, threads: ReviewThread[]): void {
  if (shownThreads.pullId !== pull.id) {
    [...annotationElements.keys()].filter((key) => key.startsWith('thread:')).forEach((key) => annotationElements.delete(key));
  }
  shownThreads = { pullId: pull.id, threads };
  syncAnnotations(pull);
}

/** Open threads on current lines, then this PR's drafts; outdated threads only show in the conversation. */
function syncAnnotations(pull: PullRequest): void {
  const byPath = new Map<string, DiffAnnotation[]>();
  const add = (path: string, annotation: DiffAnnotation): void => void byPath.set(path, [...(byPath.get(path) ?? []), annotation]);
  const threads = shownThreads.pullId === pull.id ? shownThreads.threads : [];
  threads.forEach((thread) => {
    if (thread.line != null && !thread.isOutdated) add(thread.path, { side: thread.side, lineNumber: thread.line, metadata: annotationRef(threadKey(thread)) });
  });
  pendingComments(pull).forEach((comment) => add(comment.path, { side: comment.side, lineNumber: comment.line, metadata: annotationRef(`pending:${comment.id}`) }));
  lineDrafts.forEach((draft) => {
    if (draft.pullId === pull.id) add(draft.path, { side: draft.side, lineNumber: draft.line, metadata: annotationRef(draft.key) });
  });
  diffView.setAnnotations(byPath);
  syncReviewBar(pull);
}

function draftLabel(draft: LineDraft): string {
  const sign = draft.side === 'deletions' ? '−' : '+';
  return draft.startLine == null ? `Line ${sign}${draft.line}` : `Lines ${draft.startSide === 'deletions' ? '−' : '+'}${draft.startLine} to ${sign}${draft.line}`;
}

function focusComposer(element: Element | undefined | null): void {
  requestAnimationFrame(() => element?.querySelector<HTMLTextAreaElement>('.inline-composer textarea')?.focus({ preventScroll: true }));
}

/** The gutter "+": one line, or the lines it was dragged over. A second click on the same line returns to its draft. */
function startLineComment(path: string, range: SelectedLineRange): void {
  const pull = selectedPull();
  if (pull == null) return;
  const from = { line: range.start, side: range.side ?? 'additions' };
  const to = { line: range.end, side: range.endSide ?? range.side ?? 'additions' };
  const [first, last] = from.line <= to.line ? [from, to] : [to, from];
  const key = `draft:${pull.id}:${path}:${last.side}:${last.line}`;
  if (!lineDrafts.has(key)) lineDrafts.set(key, { key, pullId: pull.id, path, side: last.side, line: last.line, startLine: first.line === last.line && first.side === last.side ? null : first.line, startSide: first.side });
  syncAnnotations(pull);
  focusComposer(annotationElements.get(key));
}

function renderAnnotation(ref: AnnotationRef): HTMLElement | undefined {
  const cached = annotationElements.get(ref.key);
  if (cached != null) return cached;
  const element = document.createElement('div');
  element.className = 'diff-annotation';
  const draft = lineDrafts.get(ref.key);
  const pull = selectedPull();
  if (draft != null) {
    element.dataset.draft = draft.key;
    element.innerHTML = composerHtml(draftLabel(draft), 'Comment', pull != null && pendingComments(pull).length > 0 ? 'Add to review' : 'Start review');
    const textarea = element.querySelector('textarea');
    if (textarea != null && draft.text != null) textarea.value = draft.text;
    focusComposer(element);
  } else if (ref.key.startsWith('pending:')) {
    const comment = pull == null ? undefined : pendingComments(pull).find((candidate) => `pending:${candidate.id}` === ref.key);
    if (comment == null) return undefined;
    element.innerHTML = pendingHtml(comment);
  } else {
    const thread = shownThreads.threads.find((candidate) => threadKey(candidate) === ref.key);
    if (thread == null) return undefined;
    element.innerHTML = threadHtml(thread, { withContext: false, ago: relativeTime });
  }
  annotationElements.set(ref.key, element);
  return element;
}

function dropDraft(key: string): void {
  lineDrafts.delete(key);
  annotationElements.delete(key);
  annotationRefs.delete(key);
  diffView.clearSelection();
  const pull = selectedPull();
  if (pull != null) syncAnnotations(pull);
}

/** GitHub takes code comments only on lines the diff shows (not on lines opened from "unmodified lines"). */
function codeCommentError(error: unknown): string {
  const message = errorMessage(error);
  return /part of the diff|could not be resolved|422/i.test(message) ? 'GitHub only takes comments on lines that are part of the diff' : message;
}

function closeReply(composer: HTMLElement): void {
  const reply = composer.closest<HTMLElement>('.thread-reply');
  const thread = composer.closest<HTMLElement>('[data-thread]');
  if (reply == null || thread == null) return;
  const id = thread.dataset.thread ?? '';
  reply.innerHTML = replyRowHtml({ id, isResolved: shownThreads.threads.find((candidate) => candidate.id === id)?.isResolved ?? false });
}

function cancelComposer(composer: HTMLElement): void {
  const draftKey = composer.closest<HTMLElement>('.diff-annotation[data-draft]')?.dataset.draft;
  if (draftKey != null) dropDraft(draftKey);
  else closeReply(composer);
}

async function submitComposer(composer: HTMLElement): Promise<void> {
  const pull = selectedPull();
  const textarea = composer.querySelector<HTMLTextAreaElement>('textarea');
  const submit = composer.querySelector<HTMLButtonElement>('[data-composer-submit]');
  const body = textarea?.value.trim() ?? '';
  if (pull == null || textarea == null || submit == null || body === '' || submit.disabled) return;
  submit.disabled = true;
  try {
    const draftKey = composer.closest<HTMLElement>('.diff-annotation[data-draft]')?.dataset.draft;
    const draft = draftKey == null ? undefined : lineDrafts.get(draftKey);
    if (draft != null) {
      const side = (value: LineDraft['side']): 'LEFT' | 'RIGHT' => (value === 'deletions' ? 'LEFT' : 'RIGHT');
      await commentOnLines(pull, { path: draft.path, line: draft.line, side: side(draft.side), startLine: draft.startLine ?? undefined, startSide: draft.startLine == null ? undefined : side(draft.startSide) }, body);
      dropDraft(draft.key);
      toast(`Commented on ${draft.path.split('/').pop() ?? draft.path}:${draft.line}`);
    } else {
      const threadId = composer.closest<HTMLElement>('[data-thread]')?.dataset.thread;
      const root = shownThreads.threads.find((thread) => thread.id === threadId)?.comments[0];
      if (root == null) throw new Error('This thread is no longer loaded; refresh and try again');
      await replyToThread(pull, root.databaseId, body);
      closeReply(composer);
      toast('Replied');
    }
    refreshConversation(pull);
  } catch (error) {
    toast(codeCommentError(error), true);
    submit.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const resolve = target.closest<HTMLButtonElement>('[data-resolve-thread]');
  if (resolve != null) {
    void toggleResolved(resolve);
    return;
  }
  const pending = target.closest<HTMLElement>('[data-pending]')?.dataset.pending;
  if (pending != null && target.closest('[data-pending-edit]') != null) return editPending(pending);
  if (pending != null && target.closest('[data-pending-delete]') != null) return deletePending(pending);
  const open = target.closest<HTMLElement>('[data-reply-thread]');
  if (open != null) {
    const reply = open.closest<HTMLElement>('.thread-reply');
    if (reply == null) return;
    reply.innerHTML = composerHtml('Reply', 'Reply');
    focusComposer(reply);
    return;
  }
  const composer = target.closest<HTMLElement>('.inline-composer');
  if (composer == null) return;
  if (target.closest('[data-composer-cancel]') != null) cancelComposer(composer);
  else if (target.closest('[data-composer-review]') != null) addToReview(composer);
  else if (target.closest('[data-composer-submit]') != null) void submitComposer(composer);
});

element('review-finish').addEventListener('click', openReviewDialog);
element('review-cancel').addEventListener('click', () => dom.reviewDialog.close());
dom.reviewSubmit.addEventListener('click', () => void sendReview());
dom.reviewDialog.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.metaKey) {
    event.preventDefault();
    void sendReview();
  }
});
dom.reviewDiscard.addEventListener('click', () => {
  const pull = selectedPull();
  if (pull == null) return;
  if (Date.now() > discardArmedUntil) {
    discardArmedUntil = Date.now() + 3000;
    dom.reviewDiscard.textContent = `Discard ${pendingComments(pull).length}?`;
    return;
  }
  setPendingComments(pull, []);
  toast('Pending review discarded');
});

/** The open PR changed without new code: its header and conversation update in place, and the diff keeps its scroll. */
function refreshOpenPull(pull: PullRequest, previous: PullRequest): void {
  renderDetailMeta(pull);
  if (pull.updatedAt === previous.updatedAt) return;
  const section = document.querySelector('.description [data-conversation]');
  if (section == null) return;
  const token = renderToken;
  void loadConversation(pull).then(
    (items) => {
      if (token !== renderToken || !section.isConnected) return;
      shownConversation = items;
      renderConversation(section, items);
    },
    () => undefined,
  );
}

function renderDetail(pull: PullRequest): void {
  syncQueueState(pull);
  void syncPreviewButton(pull);
  dom.crumbs.innerHTML = `<span class="repo" title="${escapeHtml(pull.repository.nameWithOwner)}">${escapeHtml(repoName(pull))}</span><span class="sep">›</span><a class="cur pr-link" href="${escapeHtml(pull.url)}" title="Open on GitHub  O">#${pull.number}</a>`;
  renderDetailMeta(pull);
  const description = renderDescription(pull);
  if (reviewMode === 'side') {
    dom.descPane.replaceChildren(description);
    diffView.setHeader(undefined);
  } else {
    dom.descPane.replaceChildren();
    diffView.setHeader(description);
  }
  shownDescription = description;
  const section = description.querySelector('[data-conversation]');
  section?.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-toggle-bots]') == null) return;
    showBotComments = !showBotComments;
    localStorage.setItem('showBotComments', showBotComments ? '1' : '0');
    renderConversation(section, shownConversation);
  });
  showConversation(pull, description);
  const token = renderToken;
  void loadBody(pull, true).then(
    (bodyHtml) => {
      if (token !== renderToken) return;
      const target = description.querySelector('.markdown');
      if (target != null) {
        target.innerHTML = descriptionHtml(bodyHtml);
        target.classList.add('fade-in');
      }
    },
    (error: unknown) => {
      if (token !== renderToken) return;
      const target = description.querySelector('.markdown');
      if (target != null) target.innerHTML = `<p class="error">Could not load description: ${escapeHtml(errorMessage(error))}</p>`;
      retryDetail(pull);
    },
  );
}

/** A detail fetch that failed (often a network blip) is tried again shortly, once a minute at most, if the PR is still open. */
const DETAIL_RETRY_MS = 3_000;
const detailRetries = new Map<string, number>();

function retryDetail(pull: PullRequest): void {
  if (Date.now() - (detailRetries.get(pull.id) ?? 0) < 60_000) return;
  detailRetries.set(pull.id, Date.now());
  const token = renderToken;
  window.setTimeout(() => {
    const current = selectedPull();
    if (token === renderToken && current?.id === pull.id) void renderSelection(current);
  }, DETAIL_RETRY_MS);
}

function fileLabel(file: ParsedFile): string {
  const slash = file.diff.name.lastIndexOf('/');
  const directory = slash >= 0 ? file.diff.name.slice(0, slash + 1) : '';
  return `<span class="base">${escapeHtml(file.diff.name.slice(slash + 1))}</span><span class="dir">${escapeHtml(directory)}</span>`;
}

function renderFiles(files: ParsedFile[]): void {
  dom.fileCount.textContent = String(files.length);
  dom.files.innerHTML = files
    .map(
      (file, index) => `<button data-index="${index}" data-id="${escapeHtml(file.id)}" class="file ${file.diff.type}${diffView.isCollapsed(file.id) ? ' collapsed' : ''}" title="${escapeHtml(file.diff.name)}">
        <span class="name">${fileLabel(file)}</span><span class="counts"><i class="add">+${file.additions}</i><i class="del">−${file.deletions}</i></span>
      </button>`,
    )
    .join('');
}

function markFileCollapsed(id: string, isCollapsed: boolean): void {
  dom.files.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.toggle('collapsed', isCollapsed);
}

function setActiveFile(index: number): void {
  const file = currentFiles[index];
  if (file == null) return;
  state.activeFileIndex = index;
  dom.files.querySelector('.active')?.classList.remove('active');
  const button = dom.files.querySelector<HTMLElement>(`[data-index="${index}"]`);
  button?.classList.add('active');
  button?.scrollIntoView({ block: 'nearest' });
  if (diffView.isCollapsed(file.id)) diffView.toggle(file.id, false);
  diffView.scrollToFile(file.id);
}

function prefetchAround(pull: PullRequest): void {
  const pulls = visiblePulls();
  const index = pulls.findIndex((candidate) => candidate.id === pull.id);
  const neighbours = [...pulls.slice(index + 1, index + 1 + PREFETCH_AHEAD), ...(index > 0 ? [pulls[index - 1]] : [])];
  const run = (): void =>
    neighbours.forEach((candidate) => {
      if (candidate == null || state.selectedId !== pull.id) return;
      void loadDiff(candidate).catch(() => undefined);
      void loadBody(candidate).catch(() => undefined);
    });
  const idle = (window as unknown as { requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  if (idle != null) idle(run, { timeout: 300 });
  else window.setTimeout(run, 120);
}

let detailFrame = 0;
let lastSelectAt = 0;
const RAPID_SELECT_MS = 90;

function select(pull: PullRequest): Promise<void> {
  const previousId = state.selectedId;
  state.selectedId = pull.id;
  if (previousId != null && previousId !== pull.id && leaving.has(previousId)) scheduleLeave(previousId);
  state.activeFileIndex = -1;
  virtualList.scrollToKey(pull.id);
  virtualList.highlightKey(pull.id);
  virtualList.forEachRendered((element) => {
    const isSelected = element.dataset.key === pull.id;
    if (element.classList.contains('selected') !== isSelected) element.classList.toggle('selected', isSelected);
  });
  const now = performance.now();
  const isRapid = now - lastSelectAt < RAPID_SELECT_MS;
  lastSelectAt = now;
  cancelAnimationFrame(detailFrame);
  window.clearTimeout(detailFrame);
  if (!isRapid) return renderSelection(pull);
  return new Promise((resolve) => {
    detailFrame = window.setTimeout(() => {
      if (state.selectedId === pull.id) void renderSelection(pull).then(resolve);
      else resolve();
    }, RAPID_SELECT_MS);
  });
}

let lastRenderedPullId: string | null = null;

function resetScrollForNewPull(pull: PullRequest): void {
  if (lastRenderedPullId === pull.id) return;
  lastRenderedPullId = pull.id;
  dom.descPane.scrollTop = 0;
  dom.diffRoot.scrollTop = 0;
  dom.files.scrollTop = 0;
}

/** Fetching every changed file waits until the diff is on screen and the selection has stopped moving. */
const FULL_FILE_PREFETCH_DELAY_MS = 400;

/** The diff comes first; the files behind its "unmodified lines" separators follow quietly, so an expand click is instant. */
function prefetchHiddenLines(pull: PullRequest, files: readonly ParsedFile[], token: number): void {
  const repo = pull.repository.nameWithOwner;
  const paths = files.filter((file) => hasHiddenLines(file) && !file.startsCollapsed).map((file) => file.diff.name);
  if (paths.length === 0) return;
  window.setTimeout(() => {
    if (token === renderToken) prefetchFullFiles(repo, pull.headRefOid, paths);
  }, FULL_FILE_PREFETCH_DELAY_MS);
}

async function renderSelection(pull: PullRequest): Promise<void> {
  const token = ++renderToken;
  cancelFullFilePrefetch();
  resetScrollForNewPull(pull);
  dom.empty.hidden = true;
  dom.pr.hidden = false;
  currentFiles = [];
  diffView.show([]);
  syncAnnotations(pull);
  renderDetail(pull);
  const diffPromise = loadDiff(pull);
  let isSettled = false;
  void diffPromise.finally(() => (isSettled = true)).catch(() => undefined);
  const skeletonTimer = window.setTimeout(() => {
    if (isSettled || token !== renderToken) return;
    dom.files.innerHTML = filesSkeleton();
    dom.fileCount.textContent = '';
    showDiffLoading(true);
  }, 60);
  prefetchAround(pull);
  try {
    const files = await diffPromise;
    if (token !== renderToken) return;
    currentFiles = files;
    diffView.show(files, (path) => fullFile(pull.repository.nameWithOwner, pull.headRefOid, path));
    renderFiles(files);
    prefetchHiddenLines(pull, files, token);
  } catch (error) {
    if (token !== renderToken) return;
    dom.files.innerHTML = `<div class="error pad">${escapeHtml(errorMessage(error))}</div>`;
    retryDetail(pull);
  } finally {
    window.clearTimeout(skeletonTimer);
    if (token === renderToken) showDiffLoading(false);
  }
}

function movePull(delta: number): void {
  const pulls = visiblePulls();
  if (pulls.length === 0) return;
  const index = pulls.findIndex((pull) => pull.id === state.selectedId);
  const next = pulls[Math.min(pulls.length - 1, Math.max(0, index + delta))];
  if (next != null && next.id !== state.selectedId) void select(next);
  if (next != null && visualAnchorId != null) {
    state.selectedId = next.id;
    syncVisualRange();
  }
}

const LIST_PAGE_ROWS = 10;
const DIFF_LINE_PX = 60;

function listPageSize(): number {
  return Math.max(1, Math.floor(dom.list.clientHeight / ROW_HEIGHT / 2)) || LIST_PAGE_ROWS;
}

function jumpPull(position: 'first' | 'last'): void {
  const pulls = visiblePulls();
  const target = position === 'first' ? pulls[0] : pulls.at(-1);
  if (target != null && target.id !== state.selectedId) void select(target);
}

type PaneTarget = 'list' | 'middle' | 'right';
type VimMotion = 'half-down' | 'half-up' | 'page-down' | 'page-up' | 'line-down' | 'line-up' | 'top' | 'bottom';

const PANE_MODIFIER: Record<PaneTarget, string> = { list: '⌃', middle: '⌥', right: '⌘' };
const PANE_LABEL: Record<PaneTarget, string> = { list: 'list', middle: 'middle pane', right: 'right pane' };
const MOTION_KEYS: Record<VimMotion, string> = { 'half-down': 'd', 'half-up': 'u', 'page-down': 'f', 'page-up': 'b', 'line-down': 'e', 'line-up': 'y', top: 'g', bottom: '⇧g' };
const MOTION_TITLE: Record<VimMotion, string> = { 'half-down': 'Half page down', 'half-up': 'Half page up', 'page-down': 'Page down', 'page-up': 'Page up', 'line-down': 'Scroll down', 'line-up': 'Scroll up', top: 'Top', bottom: 'Bottom' };
const SKIPPED_MOTIONS: Partial<Record<PaneTarget, VimMotion[]>> = { right: ['page-down', 'page-up'] };
const EXTRA_MOTION_KEYS: Partial<Record<PaneTarget, Partial<Record<VimMotion, string[]>>>> = {
  list: { 'line-down': ['⌃n'], 'line-up': ['⌃p'] },
  middle: { 'line-down': ['⌥j'], 'line-up': ['⌥k'] },
};

function paneElement(pane: Exclude<PaneTarget, 'list'>): HTMLElement {
  if (reviewMode === 'side') return pane === 'middle' ? dom.descPane : dom.diffRoot;
  return pane === 'middle' ? dom.diffRoot : dom.files;
}

function scrollPane(pane: Exclude<PaneTarget, 'list'>, motion: VimMotion): void {
  const target = paneElement(pane);
  const page = target.clientHeight;
  const deltas: Record<VimMotion, number> = {
    'half-down': page * 0.5, 'half-up': -page * 0.5, 'page-down': page * 0.9, 'page-up': -page * 0.9,
    'line-down': DIFF_LINE_PX, 'line-up': -DIFF_LINE_PX, top: -target.scrollHeight, bottom: target.scrollHeight,
  };
  const isStep = motion === 'line-down' || motion === 'line-up';
  if (isStep) {
    if (target === dom.diffRoot) diffView.stepBy(deltas[motion]);
    else glideScrollBy(target, deltas[motion]);
    return;
  }
  if (target === dom.diffRoot) diffView.glideBy(deltas[motion]);
  else glideScrollTo(target, target.scrollTop + deltas[motion]);
}

function moveList(motion: VimMotion): void {
  const half = listPageSize();
  const steps: Record<VimMotion, number> = { 'half-down': half, 'half-up': -half, 'page-down': half * 2, 'page-up': -half * 2, 'line-down': 1, 'line-up': -1, top: -Infinity, bottom: Infinity };
  const step = steps[motion];
  if (step === -Infinity) return jumpPull('first');
  if (step === Infinity) return jumpPull('last');
  movePull(step);
}

function vimCommands(): Command[] {
  const panes: PaneTarget[] = ['list', 'middle', 'right'];
  const motions = Object.keys(MOTION_KEYS) as VimMotion[];
  return panes.flatMap((pane) =>
    motions.filter((motion) => !(SKIPPED_MOTIONS[pane] ?? []).includes(motion)).map((motion): Command => ({
      id: `vim-${pane}-${motion}`,
      section: `Vim · ${PANE_LABEL[pane]} (${PANE_MODIFIER[pane]})`,
      title: `${MOTION_TITLE[motion]} in ${PANE_LABEL[pane]}`,
      aliases: 'vim scroll',
      keys: [`${PANE_MODIFIER[pane]}${MOTION_KEYS[motion]}`, ...(EXTRA_MOTION_KEYS[pane]?.[motion] ?? [])],
      run: () => (pane === 'list' ? moveList(motion) : scrollPane(pane, motion)),
      isEnabled: pane === 'list' ? undefined : hasPull,
    })),
  );
}

function moveFile(delta: number): void {
  if (currentFiles.length === 0) return;
  setActiveFile(Math.min(currentFiles.length - 1, Math.max(0, state.activeFileIndex + delta)));
}

function toggleCurrentFile(): void {
  const file = currentFiles[Math.max(0, state.activeFileIndex)];
  if (file != null) diffView.toggle(file.id);
}

/** Merge state, kept while the PR, its code and its checks stay as they were. */
const mergeStateCache = new Map<string, { key: string; state: MergeState }>();

function mergeKey(pull: PullRequest): string {
  return `${pull.updatedAt}|${pull.headRefOid}|${pull.checkState ?? ''}`;
}

const AI_CONCURRENCY = 4;
const AI_CACHE_KEY = 'jevReadiness.v2';
const aiResults = new Map<string, ReadinessResult>(Object.entries(JSON.parse(localStorage.getItem(AI_CACHE_KEY) ?? '{}') as Record<string, ReadinessResult>));
const aiPending = new Set<string>();
let isAiEnabled = false;
let aiRenderFrame = 0;

function aiKey(pull: PullRequest): string {
  return `${pull.id}:${pull.updatedAt}`;
}

function aiScoreFor(pull: PullRequest): number | undefined {
  return isAiEnabled ? aiResults.get(aiKey(pull))?.score : undefined;
}

function persistAiResults(): void {
  const live = new Set(state.pulls.map(aiKey));
  const kept = Object.fromEntries([...aiResults.entries()].filter(([key]) => live.has(key)).slice(-400));
  localStorage.setItem(AI_CACHE_KEY, JSON.stringify(kept));
}

function scheduleAiRender(): void {
  cancelAnimationFrame(aiRenderFrame);
  aiRenderFrame = requestAnimationFrame(() => {
    const key = state.selectedId;
    const before = key == null ? null : virtualList.rowTop(key);
    const offset = before == null ? null : before - dom.list.scrollTop;
    renderList();
    const after = key == null ? null : virtualList.rowTop(key);
    if (offset != null && after != null) dom.list.scrollTop = after - offset;
    const pull = selectedPull();
    if (pull != null) renderDetailMeta(pull);
  });
}

async function scoreWithJev(pulls: PullRequest[]): Promise<void> {
  if (!isAiEnabled) return;
  const queue = pulls.filter((pull) => !pull.isDraft && isOpen(pull) && !aiResults.has(aiKey(pull)) && !aiPending.has(aiKey(pull)));
  queue.forEach((pull) => aiPending.add(aiKey(pull)));
  const worker = async (): Promise<void> => {
    for (let pull = queue.shift(); pull != null; pull = queue.shift()) {
      const key = aiKey(pull);
      try {
        aiResults.set(key, await assessReadiness(pull));
        invalidateList();
      } catch (error) {
        console.warn('jev readiness failed', pull.number, errorMessage(error));
      } finally {
        aiPending.delete(key);
        scheduleAiRender();
      }
    }
  };
  await Promise.all(Array.from({ length: AI_CONCURRENCY }, worker));
  persistAiResults();
}
let mergeStateRenderFrame = 0;

function withMergeState(pull: PullRequest): PullRequest {
  const cached = mergeStateCache.get(pull.id);
  return cached?.key === mergeKey(pull) ? { ...pull, mergeable: cached.state.mergeable, mergeStateStatus: cached.state.mergeStateStatus } : pull;
}

/** Merge states land in every tab holding the PR, since tabs share searches. */
function applyMergeStates(states: MergeState[]): void {
  invalidateList();
  const byId = new Map(states.map((mergeState) => [mergeState.id, mergeState]));
  const keyById = new Map([...queueCache.values()].flat().map((pull) => [pull.id, mergeKey(pull)]));
  for (const mergeState of states) {
    const key = keyById.get(mergeState.id);
    if (key != null && mergeState.mergeStateStatus !== 'UNKNOWN') mergeStateCache.set(mergeState.id, { key, state: mergeState });
  }
  for (const [kind, pulls] of queueCache) {
    if (!pulls.some((pull) => byId.has(pull.id))) continue;
    queueCache.set(kind, pulls.map((pull) => {
      const mergeState = byId.get(pull.id);
      return mergeState == null ? pull : { ...pull, mergeable: mergeState.mergeable, mergeStateStatus: mergeState.mergeStateStatus };
    }));
  }
  const updated = queueCache.get(state.kind);
  if (updated == null || !state.pulls.some((pull) => byId.has(pull.id))) return;
  state.pulls = updated;
  cancelAnimationFrame(mergeStateRenderFrame);
  mergeStateRenderFrame = requestAnimationFrame(() => {
    renderList();
    if (selectedPull() == null) {
      const first = visiblePulls()[0];
      if (first != null) void select(first);
    }
    const pull = selectedPull();
    if (pull != null) renderDetailMeta(pull);
  });
}

const MERGE_STATE_RETRY_MS = [2_000, 5_000, 10_000, 20_000];

const mergeStatesInFlight = new Set<string>();

async function loadMergeStates(pulls: PullRequest[]): Promise<void> {
  const ids = [...new Set(pulls.filter((pull) => mergeStateCache.get(pull.id)?.key !== mergeKey(pull) && !mergeStatesInFlight.has(pull.id)).map((pull) => pull.id))];
  ids.forEach((id) => mergeStatesInFlight.add(id));
  try {
    let pending = ids;
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      const unknown: string[] = [];
      await fetchMergeStates(pending, (states) => {
        applyMergeStates(states);
        unknown.push(...states.filter((mergeState) => mergeState.mergeStateStatus === 'UNKNOWN').map((mergeState) => mergeState.id));
      });
      const delay = MERGE_STATE_RETRY_MS[attempt];
      if (delay == null || unknown.length === 0) return;
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      pending = unknown;
    }
  } finally {
    ids.forEach((id) => mergeStatesInFlight.delete(id));
  }
}

/** The searches behind each tab. A search shared by tabs is fetched once and feeds all of them. */
const QUEUE_SEARCHES: Record<Exclude<QueueKind, 'merged' | 'reviews'>, readonly SearchKind[]> = { turn: ['review', 'mine', 'reviewed'], review: ['review'], mine: ['mine'], involved: ['involved'], approved: ['reviewed'] };
const QUEUE_KINDS: readonly QueueKind[] = [...(Object.keys(QUEUE_SEARCHES) as QueueKind[]), 'merged', 'reviews'];
const SEARCH_KINDS: readonly SearchKind[] = ['review', 'mine', 'involved', 'reviewed'];
/** Searches outlive restarts, so the app opens on the last data it saw while it refreshes. */
const SEARCH_CACHE_KEY = 'searchCache.v3';
/** Merged searches are keyed `merged:<period>:<author>`; the author is empty for everyone. */
const MERGED_PREFIX = 'merged:';
/** Reviewed searches are keyed `reviews:<period>`; the reviewer only narrows the list, so it is not part of the key. */
const REVIEWS_PREFIX = 'reviews:';
/** The reviewed search is kept across restarts only below this size, to leave room in storage for the rest. */
const MAX_CACHED_REVIEWS_CHARS = 1_500_000;
/** A forced refresh still reuses a search that finished this recently, e.g. for another tab. */
const FRESH_SEARCH_MS = 3_000;
/** GitHub's search index trails reviews by minutes; a PR I reviewed here stays in my reviewed search meanwhile. */
const SEARCH_LAG_MS = 10 * 60_000;
/** After I act on a PR it is fetched again now, then once checks a review triggers (e.g. an approval gate) have had time to rerun. */
const FOLLOW_UP_FETCH_MS = [0, 20_000, 60_000];

/** Search results by key: a SearchKind, or a merged key. `total` is how many GitHub matched (it returns at most 1,000). */
const searches = new Map<string, { at: number; pulls: PullRequest[]; total: number }>();
const searchesInFlight = new Map<string, Promise<void>>();
const reviewedHere = new Map<string, number>();

function mergedKey(author = state.mergedAuthor): string {
  return `${MERGED_PREFIX}${state.mergedPeriod}:${author}`;
}

function reviewsKey(period = state.mergedPeriod): string {
  return `${REVIEWS_PREFIX}${period}`;
}

/** Where the current period starts, in ms. */
function periodStart(period = state.mergedPeriod): number {
  return Date.parse(mergedSince(period));
}

/** The chosen reviewer's login, or empty for anyone. */
function reviewerLogin(): string {
  return state.reviewer === '@me' ? (viewer ?? '@me') : state.reviewer;
}

/** PRs reviewed in the period by the chosen reviewer (anyone when empty), as the Reviews list shows them. */
function reviewedPulls(pulls: readonly PullRequest[], period = state.mergedPeriod, reviewer = reviewerLogin()): PullRequest[] {
  const since = periodStart(period);
  return pulls.filter((pull) => lastReviewAt(pull, since, reviewer) != null);
}

/** Newest review first. */
function byLastReview(pulls: readonly PullRequest[]): PullRequest[] {
  const since = periodStart();
  const reviewer = reviewerLogin();
  const at = new Map(pulls.map((pull) => [pull.id, lastReviewAt(pull, since, reviewer) ?? 0]));
  return [...pulls].sort((left, right) => (at.get(right.id) ?? 0) - (at.get(left.id) ?? 0));
}

/** Who reviewed it in the period, latest first, for a row's tooltip. */
function reviewedTitle(pull: PullRequest): string {
  const people = [...new Set(reviewsSince(pull, periodStart()).reverse().map((review) => `@${review.author.login}`))];
  return `Reviewed by ${people.join(', ')}`;
}

function searchesFor(kind: QueueKind): readonly string[] {
  if (kind === 'merged') return [mergedKey()];
  if (kind === 'reviews') return [reviewsKey()];
  return QUEUE_SEARCHES[kind];
}

/** The organisations merged PRs are searched in: my teams', else those of the repositories in my queues. */
function mergedOrgs(): string[] {
  const fromTeams = [...(viewerTeams ?? [])].map((team) => team.split('/')[0] ?? '');
  const fromRepos = SEARCH_KINDS.flatMap((kind) => searchPulls(kind).map((pull) => pull.repository.nameWithOwner.split('/')[0] ?? ''));
  return [...new Set((fromTeams.length > 0 ? fromTeams : fromRepos).filter((org) => org !== ''))].slice(0, 10);
}

function fetchSearch(key: string, expected: number): Promise<SearchResult> {
  if (key.startsWith(REVIEWS_PREFIX)) return fetchReviews(key);
  if (!key.startsWith(MERGED_PREFIX)) return fetchQueue(key as SearchKind, expected);
  const [period, author] = key.slice(MERGED_PREFIX.length).split(':') as [MergedPeriod, string];
  return fetchMerged(mergedSince(period), mergedOrgs(), author === '' ? null : author, expected);
}

/**
 * A whole period of reviews takes from a few seconds (a week) to a minute (90 days), so it is fetched in full only the
 * first time and on a manual refresh. Syncs ask for what changed since the last fetch, less the search index's lag,
 * and fold it in. Only PRs someone reviewed in the period are kept.
 */
async function fetchReviews(key: string): Promise<SearchResult> {
  const since = periodStart(key.slice(REVIEWS_PREFIX.length) as MergedPeriod);
  const cached = loudRefreshes.has('reviews') ? undefined : searches.get(key);
  const previous = cached?.pulls ?? [];
  const fetched = await fetchReviewed(cached == null ? since : Math.max(since, cached.at - SEARCH_LAG_MS), mergedOrgs());
  const fresh = new Map(fetched.map((pull) => [pull.id, pull]));
  const known = new Set(previous.map((pull) => pull.id));
  const pulls = [...previous.map((pull) => fresh.get(pull.id) ?? pull), ...fetched.filter((pull) => !known.has(pull.id))].filter((pull) => reviewsSince(pull, since).length > 0);
  return { pulls, total: pulls.length };
}

function loadSearch(key: string, maxAgeMs: number): Promise<void> {
  const cached = searches.get(key);
  if (cached != null && Date.now() - cached.at < maxAgeMs) return Promise.resolve();
  const running = searchesInFlight.get(key);
  if (running != null) return running;
  const pending = fetchSearch(key, cached?.pulls.length ?? 0)
    .then((result) => storeSearch(key, result))
    .finally(() => searchesInFlight.delete(key));
  searchesInFlight.set(key, pending);
  return pending;
}

/** Keeps a search's results; when nothing changed it only notes the time, so the screen stays as it is. */
function storeSearch(key: string, { pulls: fetched, total }: SearchResult): void {
  if (key === 'review' && viewerTeams == null) loadViewerTeams();
  const found = new Set(fetched.map((pull) => pull.id));
  const lagging = key === 'reviewed' ? searchPulls(key).filter((pull) => !found.has(pull.id) && Date.now() - (reviewedHere.get(pull.id) ?? 0) < SEARCH_LAG_MS) : [];
  const previous = searches.get(key);
  const pulls = mergeSearch(previous?.pulls ?? [], [...lagging, ...fetched]);
  if (pulls == null && previous != null && previous.total === total) {
    previous.at = Date.now();
    return;
  }
  searches.set(key, { at: Date.now(), pulls: pulls ?? previous?.pulls ?? [], total });
  publishQueues(QUEUE_KINDS.filter((queue) => searchesFor(queue).includes(key)));
  persistSearches();
}

function searchPulls(key: string): PullRequest[] {
  return searches.get(key)?.pulls ?? [];
}

/** When a tab's searches were fetched: the oldest of them, or undefined until each has been. */
function fetchedAt(kind: QueueKind): number | undefined {
  const times = searchesFor(kind).map((search) => searches.get(search)?.at);
  return times.every((time): time is number => time != null) ? Math.min(...times) : undefined;
}

/** Merged and reviewed searches cost seconds each, so they only run once their tab has been opened. */
function isInUse(kind: QueueKind): boolean {
  if (kind === 'merged') return state.kind === kind || searches.has(mergedKey());
  if (kind === 'reviews') return state.kind === kind || searches.has(reviewsKey());
  return true;
}

function requestedPulls(): PullRequest[] {
  return searchPulls('review').filter((pull) => !isStaleRequest(pull, viewer, viewerTeams));
}

function deriveQueue(kind: QueueKind): PullRequest[] {
  switch (kind) {
    case 'review':
      return requestedPulls();
    case 'mine':
    case 'involved':
      return searchPulls(kind);
    case 'approved':
      return searchPulls('reviewed').filter((pull) => verdictOf(pull.activity.reviews, viewer) === 'APPROVED');
    case 'merged':
      return searchPulls(mergedKey());
    case 'reviews':
      return reviewedPulls(searchPulls(reviewsKey()));
    case 'turn': {
      const seen = new Set<string>();
      return [...requestedPulls(), ...searchPulls('mine'), ...searchPulls('reviewed')].filter((pull) => !seen.has(pull.id) && seen.add(pull.id) != null && turnFor(pull)?.whose === 'mine');
    }
    default:
      return kind satisfies never;
  }
}

/** Rebuilds tabs from their searches and shows the current one; tabs whose searches have not all arrived wait. */
function publishQueues(kinds: readonly QueueKind[]): void {
  reviewRequestedIds = new Set(requestedPulls().map((pull) => pull.id));
  turnCache = new WeakMap();
  invalidateList();
  const published: PullRequest[] = [];
  for (const kind of kinds) {
    if (fetchedAt(kind) == null) continue;
    const pulls = deriveQueue(kind).map(withMergeState);
    queueCache.set(kind, pulls);
    if (!isHistory(kind)) published.push(...pulls);
    if (kind === state.kind) applyQueue(pulls);
  }
  renderCounts();
  void loadMergeStates(published).catch((error: unknown) => console.warn('merge states failed', errorMessage(error)));
}

function persistSearches(): void {
  try {
    const kept = [...searches].filter(([key]) => (!key.startsWith(MERGED_PREFIX) || key === mergedKey()) && (!key.startsWith(REVIEWS_PREFIX) || (key === reviewsKey() && cachedReviewsFit())));
    const live = new Set(kept.flatMap(([, entry]) => entry.pulls.map((pull) => pull.id)));
    const mergeStates = Object.fromEntries([...mergeStateCache].filter(([id]) => live.has(id)));
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify({ viewer, teams: viewerTeams == null ? null : [...viewerTeams], searches: Object.fromEntries(kept), mergeStates }));
  } catch (error) {
    console.warn('could not cache queues', errorMessage(error));
  }
}

let reviewsSizeChecked: { pulls: PullRequest[]; fits: boolean } | null = null;

/** Whether the current reviewed search is small enough to keep; measured once per result. */
function cachedReviewsFit(): boolean {
  const pulls = searchPulls(reviewsKey());
  if (reviewsSizeChecked?.pulls !== pulls) reviewsSizeChecked = { pulls, fits: JSON.stringify(pulls).length <= MAX_CACHED_REVIEWS_CHARS };
  return reviewsSizeChecked.fits;
}

interface SearchCache {
  viewer: string | null;
  teams: string[] | null;
  searches: Record<string, { at: number; pulls: PullRequest[]; total: number }>;
  mergeStates: Record<string, { key: string; state: MergeState }>;
}

/** Shows the last data seen, then refreshes; a cache from another account or an older shape is dropped. */
function hydrateSearches(): void {
  ['searchCache.v1', 'searchCache.v2'].forEach((key) => localStorage.removeItem(key));
  try {
    const cached = JSON.parse(localStorage.getItem(SEARCH_CACHE_KEY) ?? 'null') as SearchCache | null;
    if (cached == null) return;
    viewer = cached.viewer;
    viewerTeams = cached.teams == null ? null : new Set(cached.teams);
    Object.entries(cached.mergeStates).forEach(([id, entry]) => mergeStateCache.set(id, entry));
    for (const [key, entry] of Object.entries(cached.searches)) {
      const isKnown = (SEARCH_KINDS as readonly string[]).includes(key) || key === mergedKey() || key === reviewsKey();
      // Caches from before labels were fetched hold none; the refresh at start fills them in.
      if (isKnown && Array.isArray(entry.pulls) && entry.pulls.every((pull) => pull.activity != null && Array.isArray(pull.failingChecks))) searches.set(key, { ...entry, pulls: entry.pulls.map((pull) => (Array.isArray(pull.labels) ? pull : { ...pull, labels: [] })) });
    }
    publishQueues(QUEUE_KINDS);
  } catch (error) {
    console.warn('dropping queue cache', errorMessage(error));
    localStorage.removeItem(SEARCH_CACHE_KEY);
  }
}

/** Puts new copies of pull requests into every search holding them, and into `addTo` if it lacks them. */
function patchSearches(updated: readonly PullRequest[], addTo: string | null = null): void {
  const byId = new Map(updated.map((pull) => [pull.id, pull]));
  for (const [kind, entry] of searches) {
    const present = new Set(entry.pulls.map((pull) => pull.id));
    const added = kind === addTo ? updated.filter((pull) => !present.has(pull.id)) : [];
    searches.set(kind, { ...entry, pulls: [...added, ...entry.pulls.map((pull) => byId.get(pull.id) ?? pull)] });
  }
}

/** Rebuilds every tab after a local change, refreshing the open PR's header if it was touched. */
function republish(touched: ReadonlySet<string>): void {
  publishQueues(QUEUE_KINDS);
  persistSearches();
  const pull = selectedPull();
  if (pull != null && touched.has(pull.id)) renderDetailMeta(pull);
}

/** Fetches just these PRs again, now and after the checks my action triggers have rerun, instead of whole queues. */
function followUp(ids: readonly string[]): void {
  if (ids.length === 0) return;
  for (const delay of FOLLOW_UP_FETCH_MS) {
    window.setTimeout(() => {
      void fetchPulls(ids)
        .then((fresh) => {
          patchSearches(fresh);
          republish(new Set(ids));
        })
        .catch((error: unknown) => console.warn('pull refresh failed', errorMessage(error)));
    }, delay);
  }
}

/** Refreshes running, by tab; Merged and Reviews by their current filters, so changing them starts a new one. */
const inFlight = new Map<string, Promise<void>>();

function flightKey(kind: QueueKind): string {
  return kind === 'merged' ? mergedKey() : kind === 'reviews' ? reviewsKey() : kind;
}
const MIN_REFRESH_GAP_MS = 20_000;
/** Refreshes the user asked for. Background syncs show no spinner unless a tab has nothing to show yet. */
const loudRefreshes = new Set<QueueKind>();
/** Tabs whose last background sync failed, so a failure is reported once rather than every minute. */
const failingSyncs = new Set<QueueKind>();
/** A failed sync tries again soon, then less often, rather than waiting for the next minute (or for focus). */
const RETRY_SYNC_MS = [5_000, 30_000];
const retryTimers = new Map<QueueKind, number>();

function retrySync(kind: QueueKind, isRepeat: boolean): void {
  if (retryTimers.has(kind)) return;
  retryTimers.set(kind, window.setTimeout(() => {
    retryTimers.delete(kind);
    void refresh(kind, true);
  }, RETRY_SYNC_MS[isRepeat ? 1 : 0]));
}

let refreshTicker: number | undefined;

function renderRefreshStatus(): void {
  const button = document.getElementById('refresh-button');
  const isLoading = loudRefreshes.has(state.kind) || (inFlight.has(flightKey(state.kind)) && fetchedAt(state.kind) == null);
  button?.classList.toggle('spinning', isLoading);
  document.getElementById('list-pane')?.classList.toggle('loading', isLoading);
  if (button == null) return;
  const at = fetchedAt(state.kind);
  const seconds = at == null ? null : Math.round((Date.now() - at) / 1000);
  const age = seconds == null ? '' : seconds < 10 ? ' · updated just now' : seconds < 60 ? ` · updated ${seconds}s ago` : ` · updated ${Math.round(seconds / 60)}m ago`;
  button.dataset.tip = isLoading ? 'Refreshing…' : `Refresh${age}  ⌘R`;
}

function summarizeChange(before: PullRequest[], after: PullRequest[]): string {
  const beforeIds = new Set(before.map((pull) => pull.id));
  const afterIds = new Set(after.map((pull) => pull.id));
  const added = after.filter((pull) => !beforeIds.has(pull.id)).length;
  const removed = before.filter((pull) => !afterIds.has(pull.id)).length;
  const beforeById = new Map(before.map((pull) => [pull.id, pull]));
  const updated = after.filter((pull) => {
    const previous = beforeById.get(pull.id);
    return previous != null && previous.updatedAt !== pull.updatedAt;
  }).length;
  const parts = [added > 0 ? `${added} new` : '', removed > 0 ? `${removed} closed or merged` : '', updated > 0 ? `${updated} updated` : ''].filter((part) => part !== '');
  return parts.length === 0 ? `Up to date · ${after.length} PRs` : `Refreshed · ${parts.join(' · ')}`;
}

function manualRefresh(): void {
  stableOrder.reset();
  const before = queueCache.get(state.kind) ?? [];
  const kind = state.kind;
  const started = Date.now();
  if (loudRefreshes.has(kind)) {
    toast('Already refreshing…');
    return;
  }
  loudRefreshes.add(kind);
  const pending = inFlight.get(flightKey(kind)) ?? refresh(kind, true, 0);
  renderRefreshStatus();
  void pending
    .then(() => {
      if (kind !== state.kind || (fetchedAt(kind) ?? 0) < started) return;
      toast(summarizeChange(before, queueCache.get(kind) ?? []));
    })
    .finally(() => {
      loudRefreshes.delete(kind);
      renderRefreshStatus();
    });
}

/** `maxAgeMs` is how old a shared search may be and still count; a forced refresh reuses only ones a few seconds old. */
function refresh(kind: QueueKind, isForced = false, maxAgeMs = isForced ? FRESH_SEARCH_MS : MIN_REFRESH_GAP_MS): Promise<void> {
  const flight = flightKey(kind);
  const running = inFlight.get(flight);
  if (running != null) return running;
  if (!isForced && Date.now() - (fetchedAt(kind) ?? 0) < MIN_REFRESH_GAP_MS) return Promise.resolve();
  if (kind === 'merged' && state.mergedAuthor !== '') void loadSearch(mergedKey(''), maxAgeMs).catch((error: unknown) => console.warn('merged authors failed', errorMessage(error)));
  const pending = Promise.all(searchesFor(kind).map((search) => loadSearch(search, maxAgeMs)))
    .then(() => {
      failingSyncs.delete(kind);
      if (kind !== state.kind) return;
      void scoreWithJev(state.pulls);
      void ensureGroups();
    })
    .catch((error: unknown) => {
      const isRepeat = failingSyncs.has(kind) && !loudRefreshes.has(kind);
      failingSyncs.add(kind);
      retrySync(kind, isRepeat);
      if (kind !== state.kind) return;
      if (isRepeat) console.warn('sync failed again', kind, errorMessage(error));
      else toast(`GitHub: ${errorMessage(error).split('\n')[0]}`, true);
      if (state.pulls.length === 0) {
        clearBootSkeletons();
        dom.empty.textContent = `Could not load: ${errorMessage(error)}`;
      }
    })
    .finally(() => {
      inFlight.delete(flight);
      renderRefreshStatus();
    });
  inFlight.set(flight, pending);
  renderRefreshStatus();
  return pending;
}

function applyQueue(pulls: PullRequest[]): void {
  const previous = selectedPull();
  state.pulls = pulls.filter((pull) => !leaving.has(pull.id)).concat([...leaving.values()].map((entry) => entry.pull));
  renderList();
  const stillThere = previous == null ? undefined : state.pulls.find((pull) => pull.id === previous.id);
  if (stillThere != null) {
    if (previous == null || stillThere === previous) return;
    if (stillThere.headRefOid !== previous.headRefOid) void select(stillThere);
    else refreshOpenPull(stillThere, previous);
    return;
  }
  const first = visiblePulls()[0];
  if (first != null) void select(first);
}

function switchKind(kind: QueueKind): void {
  state.kind = kind;
  state.checkedIds.clear();
  state.selectedId = null;
  dom.viewTitle.textContent = VIEW_TITLES[kind];
  document.querySelectorAll<HTMLButtonElement>('.rail button').forEach((button) => button.classList.toggle('active', button.dataset.kind === kind));
  sliceMenu.close();
  sortMenu.close();
  state.pulls = queueCache.get(kind) ?? [];
  renderList();
  const first = visiblePulls()[0];
  if (first != null) void select(first);
  void scoreWithJev(state.pulls);
  renderRefreshStatus();
  groupsSignature = '';
  stableOrder.reset();
  void ensureGroups();
  void refresh(kind);
}

function checkedPulls(): PullRequest[] {
  return [...state.checkedIds].map((id) => pullById(id)).filter((pull): pull is PullRequest => pull != null);
}

function renderBulkBar(): void {
  const checked = checkedPulls();
  const hasSelection = checked.length > 0;
  syncMergeLabel();
  setVisibleWithMotion(dom.bulkBar, hasSelection);
  dom.list.classList.toggle('selecting', hasSelection);
  if (!hasSelection) return;
  const readyCount = checked.filter(isReady).length;
  dom.bulkCount.innerHTML = `<b>${checked.length}</b> selected${readyCount < checked.length ? ` · <span class="warn">${checked.length - readyCount} not ready</span>` : ''}`;
  dom.bulkMerge.disabled = checked.every((pull) => pull.isDraft || pull.mergeable === 'CONFLICTING');
  dom.bulkApprove.disabled = checked.every(isOwnPull);
  dom.bulkApprove.title = dom.bulkApprove.disabled ? 'You can’t approve your own pull requests' : 'Approve selected  ⇧A';
}

function syncCheckedRows(): void {
  virtualList.forEachRendered((element) => {
    const isChecked = state.checkedIds.has(element.dataset.key ?? '');
    if (element.classList.contains('checked') === isChecked) return;
    element.classList.toggle('checked', isChecked);
    element.querySelector('.check-box')?.setAttribute('aria-checked', String(isChecked));
  });
}

function setChecked(ids: Iterable<string>, isChecked: boolean): void {
  for (const id of ids) {
    if (isChecked) state.checkedIds.add(id);
    else state.checkedIds.delete(id);
  }
  syncCheckedRows();
  renderBulkBar();
}

let checkAnchorId: string | null = null;

function toggleChecked(id: string, isRange: boolean): void {
  const pulls = visiblePulls();
  const anchorIndex = pulls.findIndex((pull) => pull.id === checkAnchorId);
  const targetIndex = pulls.findIndex((pull) => pull.id === id);
  if (isRange && anchorIndex >= 0 && targetIndex >= 0) {
    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    setChecked(pulls.slice(start, end + 1).map((pull) => pull.id), true);
    return;
  }
  checkAnchorId = id;
  setChecked([id], !state.checkedIds.has(id));
}

function toggleCheckedCurrent(isRange: boolean): void {
  if (state.selectedId != null) toggleChecked(state.selectedId, isRange);
}

let visualAnchorId: string | null = null;

function toggleVisualMode(): void {
  if (visualAnchorId != null) {
    visualAnchorId = null;
    dom.list.classList.remove('visual');
    toast(`${state.checkedIds.size} selected`);
    return;
  }
  if (state.selectedId == null) return;
  visualAnchorId = state.selectedId;
  dom.list.classList.add('visual');
  setChecked([state.selectedId], true);
  toast('Visual mode: J/K to extend, ⌘↵ merge, ⇧A approve, Esc to exit');
}

function syncVisualRange(): void {
  if (visualAnchorId == null || state.selectedId == null) return;
  const pulls = visiblePulls();
  const anchor = pulls.findIndex((pull) => pull.id === visualAnchorId);
  const cursor = pulls.findIndex((pull) => pull.id === state.selectedId);
  if (anchor < 0 || cursor < 0) return;
  const [start, end] = anchor < cursor ? [anchor, cursor] : [cursor, anchor];
  state.checkedIds = new Set(pulls.slice(start, end + 1).map((pull) => pull.id));
  syncCheckedRows();
  renderBulkBar();
}

function extendSelection(delta: number): void {
  if (state.selectedId == null) return;
  if (!state.checkedIds.has(state.selectedId)) setChecked([state.selectedId], true);
  movePull(delta);
  if (state.selectedId != null) setChecked([state.selectedId], true);
}

function selectAllVisible(): void {
  const pulls = visiblePulls();
  const isAllChecked = pulls.every((pull) => state.checkedIds.has(pull.id));
  setChecked(pulls.map((pull) => pull.id), !isAllChecked);
}

function selectReady(): void {
  setChecked(visiblePulls().filter(isReady).map((pull) => pull.id), true);
}

function selectUnready(): void {
  const unready = state.pulls.filter(needsAttention);
  if (unready.length === 0) {
    toast('Every PR is ready');
    return;
  }
  setChecked(unready.map((pull) => pull.id), true);
  toast(`Selected ${unready.length} PR${unready.length === 1 ? '' : 's'} that need attention · ⇧X to fix with an agent`);
}

function clearChecked(): void {
  checkAnchorId = null;
  visualAnchorId = null;
  dom.list.classList.remove('visual');
  setChecked([...state.checkedIds], false);
}

function setSmartFilter(filter: SmartFilter, isToggle = true): void {
  state.smartFilter = isToggle && state.smartFilter === filter && filter !== 'all' ? 'all' : filter;
  localStorage.setItem('smartFilter', state.smartFilter);
  renderList();
  const first = visiblePulls()[0];
  if (first != null && !visiblePulls().some((pull) => pull.id === state.selectedId)) void select(first);
}

function setSortOrder(order: SortOrder): void {
  state.sortOrder = order;
  localStorage.setItem('sortOrder', order);
  renderList();
}

function cycleSortOrder(): void {
  const orders: SortOrder[] = ['smart', 'updated', 'size'];
  const next = orders[(orders.indexOf(state.sortOrder) + 1) % orders.length] ?? 'smart';
  setSortOrder(next);
  toast(`Sort: ${SORT_LABELS[next]}`);
}

function confirmBulkMerge(pulls: PullRequest[], method: MergeMethod): Promise<boolean> {
  const notReady = pulls.filter((pull) => !isReady(pull)).length;
  dom.bulkConfirmTitle.textContent = `${MERGE_LABELS[method]} ${pulls.length} pull request${pulls.length === 1 ? '' : 's'}?`;
  dom.bulkConfirmList.innerHTML = pulls
    .map((pull) => `<li>${statusIcon(pull)}<span class="id">#${pull.number}</span><span class="t">${escapeHtml(pull.title)}</span>${isReady(pull) ? '<span class="tone ok"><i></i>Ready</span>' : `<span class="tone wait"><i></i>${escapeHtml(mergeState(pull).label)}</span>`}</li>`)
    .join('');
  dom.bulkConfirmNote.textContent = notReady > 0 ? `${notReady} not ready. GitHub will reject any that branch protection blocks; the rest still merge.` : 'Merged one at a time, in this order. Branch protection and merge queues still apply.';
  dom.bulkConfirm.returnValue = '';
  dom.bulkConfirm.showModal();
  return new Promise((resolve) => dom.bulkConfirm.addEventListener('close', () => resolve(dom.bulkConfirm.returnValue === 'ok'), { once: true }));
}

const LEAVE_AFTER_MS = 3_000;
const LEAVE_ANIMATION_MS = 220;
const leaveTimers = new Map<string, number>();
const failedMerges = new Map<string, number>();

function markPending(pull: PullRequest, label: string): void {
  leaving.set(pull.id, { pull, label, isPending: true });
  window.clearTimeout(leaveTimers.get(pull.id));
  invalidateList();
  renderList();
  if (selectedPull()?.id === pull.id) renderDetailMeta(pull);
}

function rollbackPending(pull: PullRequest): void {
  leaving.delete(pull.id);
  window.clearTimeout(leaveTimers.get(pull.id));
  leaveTimers.delete(pull.id);
  invalidateList();
  renderList();
  failedMerges.set(pull.id, Date.now());
  invalidateList();
  renderList();
  window.setTimeout(() => {
    failedMerges.delete(pull.id);
    virtualList.element(pull.id)?.classList.remove('merge-failed');
  }, 4_000);
  if (selectedPull()?.id === pull.id) renderDetailMeta(pull);
}

function markLeaving(pull: PullRequest, label: string): void {
  leaving.set(pull.id, { pull, label });
  invalidateList();
  renderList();
  scheduleLeave(pull.id);
}

function scheduleLeave(id: string): void {
  window.clearTimeout(leaveTimers.get(id));
  leaveTimers.set(id, window.setTimeout(() => finishLeaving(id), LEAVE_AFTER_MS));
}

function finishLeaving(id: string): void {
  if (!leaving.has(id) || leaving.get(id)?.isPending === true) return;
  if (state.selectedId === id) {
    scheduleLeave(id);
    return;
  }
  const row = virtualList.element(id);
  const remove = (): void => {
    leaving.delete(id);
    leaveTimers.delete(id);
    state.pulls = state.pulls.filter((candidate) => candidate.id !== id);
    invalidateList();
    renderList();
  };
  if (row == null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return remove();
  row.classList.add('removing');
  window.setTimeout(remove, LEAVE_ANIMATION_MS);
}

const MERGE_CONCURRENCY = 3;

async function runMerge(pull: PullRequest, isQueued: boolean): Promise<string | null> {
  markPending(pull, isQueued ? 'Queueing…' : 'Merging…');
  try {
    await mergePull(pull, MERGE_METHOD);
    markLeaving(pull, isQueued ? 'Queued' : 'Merged');
    return null;
  } catch (error) {
    rollbackPending(pull);
    return `#${pull.number}: ${errorMessage(error).split('\n')[0]}`;
  }
}

async function bulkMerge(): Promise<void> {
  const pulls = checkedPulls().filter((pull) => isOpen(pull) && !pull.isDraft && pull.mergeable !== 'CONFLICTING' && !leaving.has(pull.id));
  if (pulls.length === 0) return;
  const queueFlags = await Promise.all(pulls.map(usesMergeQueue));
  const isAllQueued = queueFlags.every(Boolean);
  if (!isAllQueued && !(await confirmBulkMerge(pulls, MERGE_METHOD))) return;
  const verb = isAllQueued ? 'Queued' : 'Merged';
  clearChecked();
  pulls.forEach((pull, index) => markPending(pull, queueFlags[index] ? 'Queueing…' : 'Merging…'));
  toast(`${isAllQueued ? 'Queueing' : 'Merging'} ${pulls.length} pull request${pulls.length === 1 ? '' : 's'}…`);
  const failures: string[] = [];
  const work = pulls.map((pull, index) => ({ pull, isQueued: queueFlags[index] ?? false }));
  const worker = async (): Promise<void> => {
    for (let next = work.shift(); next != null; next = work.shift()) {
      const failure = await runMerge(next.pull, next.isQueued);
      if (failure != null) failures.push(failure);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MERGE_CONCURRENCY, pulls.length) }, worker));
  const done = pulls.length - failures.length;
  toast(failures.length === 0 ? `${verb} ${done} pull request${done === 1 ? '' : 's'}` : `${verb} ${done}, failed ${failures.length} — ${failures.join(' · ')}`, failures.length > 0);
  void refresh(state.kind);
}

function isOwnPull(pull: PullRequest): boolean {
  return viewer != null && pull.author?.login.toLowerCase() === viewer.toLowerCase();
}

/**
 * Approval shows before GitHub answers: each PR reads approved, joins Approved and leaves the tabs that were
 * waiting on me. A refusal puts it back; an acceptance is confirmed by fetching just those PRs again.
 * Returns one message per refusal.
 */
async function approveNow(pulls: readonly PullRequest[]): Promise<string[]> {
  if (viewer == null || pulls.length === 0) return [];
  const before = new Map(searches);
  const shown = new Set(state.pulls.map((pull) => pull.id));
  const at = new Date().toISOString();
  const approved = pulls.map((pull) => withMyApproval(pull, viewer as string, viewerTeams, at));
  const visible = approved.filter((pull) => shown.has(pull.id));
  approved.forEach((pull) => reviewedHere.set(pull.id, Date.now()));
  visible.forEach((pull) => leaving.set(pull.id, { pull, label: 'Approved' }));
  patchSearches(approved, 'reviewed');
  republish(new Set(pulls.map((pull) => pull.id)));
  const here = new Set((queueCache.get(state.kind) ?? []).map((pull) => pull.id));
  visible.forEach((pull) => (here.has(pull.id) ? leaving.delete(pull.id) : scheduleLeave(pull.id)));
  invalidateList();
  renderList();
  const results = await Promise.allSettled(pulls.map((pull) => approvePull(pull)));
  const refused = pulls.filter((_, index) => results[index]?.status === 'rejected');
  if (refused.length > 0) {
    const refusedIds = new Set(refused.map((pull) => pull.id));
    for (const [kind, entry] of searches) {
      const previous = new Map((before.get(kind)?.pulls ?? []).map((pull) => [pull.id, pull]));
      searches.set(kind, { ...entry, pulls: entry.pulls.flatMap((pull) => (!refusedIds.has(pull.id) ? [pull] : previous.has(pull.id) ? [previous.get(pull.id) as PullRequest] : [])) });
    }
    refused.forEach((pull) => {
      reviewedHere.delete(pull.id);
      leaving.delete(pull.id);
      window.clearTimeout(leaveTimers.get(pull.id));
    });
    republish(refusedIds);
  }
  followUp(pulls.filter((pull) => !refused.includes(pull)).map((pull) => pull.id));
  return results.flatMap((result, index) => (result.status === 'rejected' ? [`#${pulls[index]?.number}: ${errorMessage(result.reason).split('\n')[0]}`] : []));
}

async function bulkApprove(): Promise<void> {
  const checked = checkedPulls().filter(isOpen);
  const pulls = checked.filter((pull) => !isOwnPull(pull));
  if (pulls.length === 0) {
    if (checked.length > 0) toast('You can’t approve your own pull requests', true);
    return;
  }
  dom.bulkApprove.disabled = true;
  const failures = await approveNow(pulls);
  const skipped = checked.length - pulls.length;
  const skippedNote = skipped > 0 ? ` · skipped ${skipped} of yours` : '';
  toast(failures.length === 0 ? `Approved ${pulls.length}${skippedNote}` : `Approved ${pulls.length - failures.length}, failed ${failures.length}${skippedNote} — ${failures.join(' · ')}`, failures.length > 0);
  dom.bulkApprove.disabled = false;
}

async function approveSelected(): Promise<void> {
  const pull = selectedPull();
  if (pull == null || dom.approve.disabled) return;
  if (isOwnPull(pull)) {
    toast('You can’t approve your own pull request', true);
    return;
  }
  dom.approve.disabled = true;
  const [failure] = await approveNow([pull]);
  toast(failure == null ? `Approved #${pull.number}` : failure.replace(/^#\d+: /, ''), failure != null);
  dom.approve.disabled = isOwnPull(pull);
}

function confirmMerge(pull: PullRequest, method: MergeMethod): Promise<boolean> {
  dom.confirmTitle.textContent = `${MERGE_LABELS[method]} #${pull.number}?`;
  dom.confirmText.innerHTML = `${escapeHtml(pull.title)}<br><span class="muted">${escapeHtml(pull.headRefName)} → ${escapeHtml(pull.baseRefName)} · ${escapeHtml(pull.repository.nameWithOwner)}</span>`;
  dom.confirm.returnValue = '';
  dom.confirm.showModal();
  return new Promise((resolve) => dom.confirm.addEventListener('close', () => resolve(dom.confirm.returnValue === 'ok'), { once: true }));
}

async function mergeSelected(): Promise<void> {
  const pull = selectedPull();
  if (pull == null || dom.merge.disabled || leaving.has(pull.id)) return;
  const isQueued = await usesMergeQueue(pull);
  if (!isQueued && !(await confirmMerge(pull, MERGE_METHOD))) return;
  const failure = await runMerge(pull, isQueued);
  if (failure != null) toast(failure.replace(/^#\d+: /, ''), true);
  else toast(isQueued ? `#${pull.number} added to the merge queue` : `Merged #${pull.number}`);
  void refresh(state.kind);
}

function expandLinesLabel(choice: ExpandLines): string {
  return choice === 'all' ? 'the whole gap' : `${choice} lines`;
}

const EXPAND_PRESETS: readonly ExpandLines[] = [20, 100, 'all'];

function setExpandLines(choice: ExpandLines): void {
  state.expandLines = choice;
  localStorage.setItem('expandLines', String(choice));
  diffView.setExpandLines(choice);
  toast(`Unmodified lines: a click shows ${expandLinesLabel(choice)}`);
}

/** Like the sort, one key steps through the presets (a custom count steps on to the whole gap) and a toast names the choice. */
function cycleExpandLines(): void {
  setExpandLines(EXPAND_PRESETS[(EXPAND_PRESETS.indexOf(state.expandLines) + 1) % EXPAND_PRESETS.length] ?? 'all');
}

const expandMenu = new PopoverMenu('Lines per click');

/** Right-click on an "unmodified lines" separator: how much one click reveals. */
function openExpandMenu(x: number, y: number): void {
  sliceMenu.close();
  sortMenu.close();
  labelMenu.close();
  const isCustom = !EXPAND_PRESETS.includes(state.expandLines);
  const pick = (choice: ExpandLines) => () => {
    expandMenu.close();
    setExpandLines(choice);
  };
  expandMenu.openAt(x, y, () => [
    {
      title: 'Lines per click',
      items: [
        { label: '20 lines', checked: state.expandLines === 20, run: pick(20) },
        { label: '100 lines', checked: state.expandLines === 100, run: pick(100) },
        { label: isCustom ? `Custom · ${state.expandLines} lines` : 'Custom…', checked: isCustom, run: openCustomExpand },
        { label: 'All', checked: state.expandLines === 'all', run: pick('all') },
      ],
    },
  ]);
}

function openCustomExpand(): void {
  expandMenu.close();
  dom.expandInput.value = typeof state.expandLines === 'number' && !EXPAND_PRESETS.includes(state.expandLines) ? String(state.expandLines) : '';
  dom.expandDialog.returnValue = '';
  dom.expandDialog.showModal();
  dom.expandInput.focus();
  dom.expandInput.select();
}

function toggleStyle(): void {
  state.diffStyle = state.diffStyle === 'split' ? 'unified' : 'split';
  localStorage.setItem('diffStyle', state.diffStyle);
  diffView.setStyle(state.diffStyle);
  toast(state.diffStyle === 'split' ? 'Split view' : 'Unified view');
}

type ReviewMode = 'stacked' | 'side';
let layoutRef: Layout | null = null;
const reviewMode: ReviewMode = 'side';

function applyReviewMode(): void {
  const isSide = reviewMode === 'side';
  element('app').classList.toggle('mode-side', isSide);
  diffView.setFlush(isSide);
  if (isSide) dom.inspector.append(dom.diffRoot);
  else dom.bodySplit.insertBefore(dom.diffRoot, dom.bodySplit.querySelector('.resizer[data-resize="inspector"]'));
  const pull = selectedPull();
  if (pull != null) renderDetail(pull);
  layoutRef?.refit();
}

const PRESET_LABELS: Record<LayoutPreset, string> = { review: 'Review', diff: 'Diff focus', read: 'Read description' };

function applyLayoutPreset(preset: LayoutPreset): void {
  layout.applyPreset(preset);
  toast(`Layout: ${PRESET_LABELS[preset]}`);
}

const layout = new Layout(element('app'), () => syncPaneButtons());
layoutRef = layout;
const lightbox = new Lightbox((url) => void openInBrowser(url).catch((error: unknown) => toast(errorMessage(error), true)));

function descriptionRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#pr-body-split .description');
}

function openMedia(index = 0): void {
  const root = descriptionRoot();
  const items = root == null ? [] : collectMedia(root);
  if (!lightbox.open(items, index)) toast('No images, videos or HTML previews in this description');
}

function openMediaFrom(target: HTMLElement): boolean {
  const root = descriptionRoot();
  if (root == null || !root.contains(target)) return false;
  const items = collectMedia(root);
  const index = items.findIndex((item) => item.source === target || item.source.contains(target) || target.contains(item.source));
  if (index < 0) return false;
  return lightbox.open(items, index);
}
const listPane = element('list-pane');
new ResizeObserver(([entry]) => {
  const width = entry?.contentRect.width ?? 999;
  listPane.classList.toggle('narrow', width < 400);
}).observe(listPane);
const commands = new CommandRegistry();
const hasPull = (): boolean => selectedPull() != null;
const hasFiles = (): boolean => currentFiles.length > 0;

const TESTED_THRESHOLD = 0.75;

function isTested(pull: PullRequest): boolean {
  return (aiResults.get(aiKey(pull))?.tested ?? 0) >= TESTED_THRESHOLD;
}

let triagePulls: PullRequest[] = [];

function triageIncluded(): Set<AttentionReason> {
  return new Set(ATTENTION_ORDER.filter((reason) => dom.triage.querySelector<HTMLInputElement>(`input[data-reason="${reason}"]`)?.checked ?? true));
}

function triageTargets(included: ReadonlySet<AttentionReason>): PullRequest[] {
  return triagePulls.filter((pull) => attentionReasons(pull).some((reason) => included.has(reason)));
}

function renderTriageSummary(): void {
  const count = triageTargets(triageIncluded()).length;
  dom.triageCopy.disabled = count === 0;
  dom.triageCopy.firstChild!.textContent = `Copy prompt for ${count} PR${count === 1 ? '' : 's'} `;
}

function openTriage(): void {
  const scope = state.checkedIds.size > 0 ? checkedPulls() : state.pulls;
  triagePulls = scope.filter(needsAttention);
  if (triagePulls.length === 0) {
    toast(state.checkedIds.size > 0 ? 'Nothing in the selection needs attention' : 'Every PR is approved, green and conflict-free');
    return;
  }
  dom.triageTitle.textContent = `${triagePulls.length} PR${triagePulls.length === 1 ? '' : 's'} need attention${state.checkedIds.size > 0 ? ' in selection' : ''}`;
  dom.triageSections.innerHTML = ATTENTION_ORDER.map((reason) => {
    const pulls = triagePulls.filter((pull) => attentionReasons(pull).includes(reason));
    if (pulls.length === 0) return '';
    const meta = ATTENTION_META[reason];
    const rows = pulls.map((pull) => `<li>${statusIcon(pull)}<span class="id">#${pull.number}</span><span class="t">${escapeHtml(pull.title)}</span><span class="age">${relativeTime(pull.updatedAt)}</span></li>`).join('');
    return `<section class="triage-section tone-${meta.tone}"><label class="triage-head"><input type="checkbox" data-reason="${reason}" checked /><i class="triage-dot"></i><span>${meta.title}</span><span class="triage-count">${pulls.length}</span></label><ol class="bulk-list">${rows}</ol></section>`;
  }).join('');
  renderTriageSummary();
  dom.triage.returnValue = '';
  dom.triage.showModal();
  dom.triageCopy.focus();
}

dom.triage.addEventListener('change', renderTriageSummary);
dom.triage.addEventListener('close', () => {
  if (dom.triage.returnValue !== 'copy') return;
  const included = triageIncluded();
  const targets = triageTargets(included);
  if (targets.length === 0) return;
  void navigator.clipboard.writeText(buildAgentPrompt(targets, included)).then(
    () => toast(`Copied agent prompt for ${targets.length} PR${targets.length === 1 ? '' : 's'} · paste it into your agent`),
    () => toast('Clipboard unavailable', true),
  );
});

const PREVIEW_HOST_PATTERN = /(?:^|\.)(?:preview\.[a-z0-9-]+\.[a-z]{2,}|vercel\.app|netlify\.app|pages\.dev|workers\.dev|onrender\.com|fly\.dev|up\.railway\.app|herokuapp\.com|amplifyapp\.com|web\.app|firebaseapp\.com|surge\.sh|github\.io)$/i;
const PREVIEW_WORD_PATTERN = /preview|deploy|staging/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;
const IGNORED_PREVIEW_HOSTS = /(?:^|\.)(?:github\.com|githubusercontent\.com|vercel\.com|netlify\.com|datadoghq\.com|shields\.io)$/i;

function previewUrlsIn(html: string): string[] {
  const text = html.replace(/&amp;/g, '&');
  const urls = [...new Set([...text.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.,;:!?]+$/, '')))];
  return urls.filter((url) => {
    const host = URL.canParse(url) ? new URL(url).hostname : '';
    if (host === '' || IGNORED_PREVIEW_HOSTS.test(host)) return false;
    return PREVIEW_HOST_PATTERN.test(host) || (/(?:^|[.-])(?:pr|preview)-?\d+[.-]/i.test(host) && PREVIEW_WORD_PATTERN.test(text));
  });
}

async function findPreview(pull: PullRequest): Promise<string | null> {
  const items = await loadConversation(pull).catch((): ConversationItem[] => []);
  const fromComments = [...items].reverse().flatMap((item) => previewUrlsIn(item.html));
  if (fromComments[0] != null) return fromComments[0];
  const fromBody = previewUrlsIn(await loadBody(pull).catch(() => ''));
  return fromBody[0] ?? null;
}

async function syncPreviewButton(pull: PullRequest): Promise<void> {
  const button = document.getElementById('open-preview') as HTMLButtonElement | null;
  if (button == null) return;
  const url = await findPreview(pull);
  if (selectedPull()?.id !== pull.id) return;
  button.disabled = url == null;
  button.dataset.tip = url == null ? 'No preview deployment found' : `Open preview  P\n${url}`;
}

async function openPreview(): Promise<void> {
  const pull = selectedPull();
  if (pull == null) return;
  const url = await findPreview(pull);
  if (url == null) {
    toast(`No preview deployment found on #${pull.number}`, true);
    return;
  }
  await openInBrowser(url).then(
    () => toast(`Opened preview for #${pull.number}`),
    (error: unknown) => toast(errorMessage(error), true),
  );
}

function openSelectedOnGitHub(): void {
  const pull = selectedPull();
  if (pull == null) return;
  void openInBrowser(pull.url).then(
    () => toast(`Opened #${pull.number} on GitHub`),
    (error: unknown) => toast(errorMessage(error), true),
  );
}

function copyText(text: string, label: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast(`Copied ${label}`),
    () => toast('Clipboard unavailable', true),
  );
}

let themeId = localStorage.getItem('themeId') ?? (localStorage.getItem('theme') === 'dark' || localStorage.getItem('theme') === 'light' ? (localStorage.getItem('theme') as string) : SYSTEM_THEME_ID);
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedAppTheme(id: string = themeId): AppTheme {
  const fallback = themeById(systemDark.matches ? 'dark' : 'light') ?? THEMES[0]!;
  return id === SYSTEM_THEME_ID ? fallback : themeById(id) ?? fallback;
}

let diffThemeTimer = 0;

function applyTheme(id: string = themeId, diffDelayMs = 0): void {
  const theme = resolvedAppTheme(id);
  applyThemeColors(document.documentElement, theme);
  window.clearTimeout(diffThemeTimer);
  if (diffDelayMs <= 0) {
    diffView.setTheme(theme.mode, theme.diff);
    return;
  }
  diffThemeTimer = window.setTimeout(() => diffView.setTheme(theme.mode, theme.diff), diffDelayMs);
}

function setTheme(id: string): void {
  themeId = id;
  localStorage.setItem('themeId', id);
  applyTheme();
  toast(`Theme: ${id === SYSTEM_THEME_ID ? `System (${resolvedAppTheme().name})` : resolvedAppTheme().name}`);
}

const themePicker = new ThemePicker({
  current: () => themeId,
  preview: (id) => applyTheme(id, 220),
  commit: setTheme,
  cancel: () => applyTheme(),
});

const commentDrafts = new Map<string, string>();
let commentTarget: PullRequest | null = null;

function openCommentDialog(): void {
  const pull = selectedPull();
  if (pull == null) return;
  commentTarget = pull;
  dom.commentTitle.textContent = `Comment on #${pull.number}`;
  dom.commentHint.textContent = `${pull.repository.nameWithOwner} · ${pull.title}`;
  dom.commentBody.value = commentDrafts.get(pull.id) ?? '';
  dom.commentSend.disabled = dom.commentBody.value.trim() === '';
  dom.commentDialog.showModal();
  dom.commentBody.focus();
  dom.commentBody.setSelectionRange(dom.commentBody.value.length, dom.commentBody.value.length);
}

function closeCommentDialog(): void {
  if (commentTarget != null) {
    const draft = dom.commentBody.value;
    if (draft.trim() === '') commentDrafts.delete(commentTarget.id);
    else commentDrafts.set(commentTarget.id, draft);
  }
  dom.commentDialog.close();
}

async function submitComment(): Promise<void> {
  const pull = commentTarget;
  const body = dom.commentBody.value.trim();
  if (pull == null || body === '' || dom.commentSend.disabled) return;
  dom.commentSend.disabled = true;
  try {
    await commentOnPull(pull, body);
    commentDrafts.delete(pull.id);
    dom.commentBody.value = '';
    commentTarget = null;
    dom.commentDialog.close();
    toast(`Commented on #${pull.number}`);
    invalidateConversation(pull);
    if (selectedPull()?.id === pull.id) renderDetail(pull);
  } catch (error) {
    toast(errorMessage(error), true);
    dom.commentSend.disabled = false;
  }
}

dom.commentBody.addEventListener('input', () => (dom.commentSend.disabled = dom.commentBody.value.trim() === ''));
dom.commentBody.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.stopPropagation();
    void submitComment();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeCommentDialog();
  }
});
dom.commentDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeCommentDialog();
});
dom.commentSend.addEventListener('click', () => void submitComment());
element('comment-cancel').addEventListener('click', closeCommentDialog);
element('comment-button').addEventListener('click', openCommentDialog);
element('open-preview').addEventListener('click', () => void openPreview());

function openThemePicker(): void {
  themePicker.open();
}

function syncPaneButtons(): void {
  document.getElementById('toggle-sidebar')?.classList.toggle('on', !layout.isHidden('list'));
  const fullscreen = document.getElementById('toggle-fullscreen');
  if (fullscreen != null) {
    fullscreen.classList.toggle('on', layout.isFocused());
    fullscreen.dataset.tip = `${layout.isFocused() ? 'Exit fullscreen diff' : 'Fullscreen diff'}  F`;
  }
}

function openHelp(): void {
  let section = '';
  dom.shortcutList.innerHTML = commands
    .list()
    .map((command) => {
      const heading = command.section !== section ? `<h4>${(section = command.section)}</h4>` : '';
      const keys = command.keys.map(renderShortcut).join('<span class="or">or</span>');
      return `${heading}<div class="shortcut"><span>${command.title}</span><span class="keys">${keys}</span></div>`;
    })
    .join('');
  dom.help.showModal();
  dom.help.scrollTop = 0;
  (document.activeElement as HTMLElement | null)?.blur();
}

const VIM_COMMANDS = vimCommands();

const DIFF_SCROLL_COMMANDS: Command[] = [
  { id: 'diff-scroll-down', section: 'Diff', title: 'Scroll diff down', aliases: 'vim line', keys: ['⌘j'], run: () => diffView.stepBy(DIFF_LINE_PX * 2), isEnabled: hasPull },
  { id: 'diff-scroll-up', section: 'Diff', title: 'Scroll diff up', aliases: 'vim line', keys: ['⌘k'], run: () => diffView.stepBy(-DIFF_LINE_PX * 2), isEnabled: hasPull },
];

const COMMANDS: Command[] = [
  { id: 'update', section: 'General', title: 'Check for updates / restart into update', aliases: 'upgrade version release', keys: ['⌘⇧u'], run: () => (restartIntoUpdate != null ? restartIntoUpdate() : (toast('Checking for updates…'), checkForUpdates())) },
  { id: 'help', section: 'General', title: 'Keyboard shortcuts', keys: ['?', '⌘/'], run: openHelp },
  { id: 'filter', section: 'General', title: 'Filter pull requests', keys: ['/', '⌘f'], run: () => { dom.filter.focus(); dom.filter.select(); const box = dom.filter.closest<HTMLElement>('.search'); if (box != null) flash(box); } },
  { id: 'refresh', allowWhileTyping: true, section: 'General', title: 'Refresh', keys: ['r', '⌘r'], run: manualRefresh },

  { id: 'smart-all', section: 'Filter', title: 'Show all', aliases: 'clear filter', keys: ['⌥0'], run: () => setSmartFilter('all') },
  { id: 'smart-ready', section: 'Filter', title: 'Show ready to merge', aliases: 'green approved mergeable', keys: ['⌥1'], run: () => setSmartFilter('ready') },
  { id: 'smart-small', section: 'Filter', title: 'Show small diffs', aliases: 'tiny quick', keys: ['⌥2'], run: () => setSmartFilter('small') },
  { id: 'smart-recent', section: 'Filter', title: 'Show recently updated', aliases: 'new fresh', keys: ['⌥3'], run: () => setSmartFilter('recent') },
  { id: 'smart-tested', section: 'Filter', title: 'Show end-to-end tested', aliases: 'e2e verified qa proof screenshots recording', keys: ['⌥5'], run: () => setSmartFilter('tested') },
  { id: 'ask-me', section: 'Filter', title: 'Only me: hide PRs here only because my team was asked', aliases: 'direct personal mine review requests scope', keys: ['⌥6'], run: () => setAskScope('me') },
  { id: 'ask-team', section: 'Filter', title: 'Only team: review requests to my teams', aliases: 'team group codeowners engineering scope', keys: ['⌥7'], run: () => setAskScope('team') },
  { id: 'smart-attention', section: 'Filter', title: 'Show PRs that need attention', aliases: 'unapproved conflicts failing blocked red yellow triage', keys: ['⌥4'], run: () => setSmartFilter('attention') },
  { id: 'filters', section: 'Filter', title: 'What to show: requests, state, repository (period and author on Merged, period and reviewer on Reviews)', aliases: 'filter selector slice scope repo period author', keys: ['⇧f'], run: openSliceMenu },
  { id: 'labels', section: 'Filter', title: 'Filter by label (any of the chosen ones)', aliases: 'label labels tag tags', keys: ['⇧l'], run: openLabelMenu },
  { id: 'group', section: 'Filter', title: 'Group related work', aliases: 'cluster effort category batch smart group', keys: ['⇧t'], run: toggleGrouping },
  { id: 'regroup', section: 'Filter', title: 'Regroup', aliases: 'refresh groups cluster', keys: [], run: () => { groupsSignature = ''; localStorage.removeItem(GROUPS_CACHE_KEY); void ensureGroups(true); } },
  { id: 'sort', section: 'Filter', title: 'Cycle sort (smart / updated / smallest)', aliases: 'order', keys: ['⇧s'], run: cycleSortOrder },

  { id: 'visual', section: 'Select', title: 'Visual select mode (vim V)', aliases: 'multi range bulk vim', keys: ['⇧v'], run: toggleVisualMode, isEnabled: hasPull },
  { id: 'check', section: 'Select', title: 'Select / deselect pull request', aliases: 'check bulk multi', keys: ['e'], run: () => toggleCheckedCurrent(false), isEnabled: hasPull },
  { id: 'check-down', section: 'Select', title: 'Extend selection down', keys: ['⇧j', '⇧↓'], run: () => extendSelection(1), isEnabled: hasPull },
  { id: 'check-up', section: 'Select', title: 'Extend selection up', keys: ['⇧k', '⇧↑'], run: () => extendSelection(-1), isEnabled: hasPull },
  { id: 'check-all', section: 'Select', title: 'Select all visible', keys: ['⌘a'], run: selectAllVisible },
  { id: 'check-ready', section: 'Select', title: 'Select all ready', aliases: 'green approved', keys: ['⇧r'], run: selectReady },
  { id: 'check-unready', section: 'Select', title: 'Select all unready (conflicts, failing, not approved)', aliases: 'attention broken red yellow fix bulk', keys: ['⇧u'], run: selectUnready },
  { id: 'check-clear', section: 'Select', title: 'Clear selection', keys: ['esc', '⌫'], run: clearChecked, isEnabled: () => state.checkedIds.size > 0 },
  { id: 'bulk-approve', section: 'Select', title: 'Approve selected', aliases: 'bulk lgtm', keys: ['⇧a'], run: () => void bulkApprove(), isEnabled: () => state.checkedIds.size > 0 },

  { id: 'view-turn', section: 'Views', title: 'Go to My turn', keys: ['⌘4', 'g t'], run: () => switchKind('turn') },
  { id: 'view-review', section: 'Views', title: 'Go to Review requested', keys: ['⌘1', 'g r'], run: () => switchKind('review') },
  { id: 'view-involved', section: 'Views', title: 'Go to Involved', keys: ['⌘2', 'g i'], run: () => switchKind('involved') },
  { id: 'view-mine', section: 'Views', title: 'Go to Created by me', keys: ['⌘3', 'g m'], run: () => switchKind('mine') },
  { id: 'view-approved', section: 'Views', title: 'Go to Approved by me', keys: ['⌘5', 'g a'], run: () => switchKind('approved') },
  { id: 'view-merged', section: 'Views', title: 'Go to Merged', aliases: 'history shipped done closed', keys: ['⌘6', 'g d'], run: () => switchKind('merged') },
  { id: 'view-reviews', section: 'Views', title: 'Go to Reviews', aliases: 'reviewers leaderboard who reviewed most stats', keys: ['⌘7', 'g v'], run: () => switchKind('reviews') },

  { id: 'toggle-sidebar', section: 'Layout', title: 'Toggle pull request list', aliases: 'hide show pane sidebar navigation queue inbox', keys: ['⌘b', '⌘\\'], run: () => layout.toggle('list') },
  { id: 'layout-review', section: 'Layout', title: 'Layout: review (list 24% · description 36% · diff)', aliases: 'preset pane default balanced', keys: ['1', '⌘⌥1'], run: () => applyLayoutPreset('review') },
  { id: 'layout-diff', section: 'Layout', title: 'Layout: diff focus (list minimal · description 26% · diff)', aliases: 'preset pane code wide', keys: ['2', '⌘⌥2'], run: () => applyLayoutPreset('diff') },
  { id: 'layout-read', section: 'Layout', title: 'Layout: read description (list minimal · description 62% · diff)', aliases: 'preset pane body middle', keys: ['3', '⌘⌥3'], run: () => applyLayoutPreset('read') },
  { id: 'focus-mode', section: 'Layout', title: 'Fullscreen diff (hide list and description)', aliases: 'zen focus maximize expand hide panes', keys: ['f', '⌘.', 'z'], run: () => layout.toggleFocus() },
  { id: 'theme', section: 'Layout', title: 'Choose theme', aliases: 'light dark mode appearance color catppuccin dracula tokyo night nord gruvbox github solarized monokai rose pine one dark', keys: ['t', '⌘⇧l'], run: openThemePicker },
  { id: 'reset-layout', section: 'Layout', title: 'Reset layout', aliases: 'panes widths default', keys: ['⌘⇧0'], run: () => layout.reset() },

  { id: 'next-pr', section: 'Navigate', title: 'Next pull request', keys: ['j', '↓'], run: () => movePull(1) },
  { id: 'prev-pr', section: 'Navigate', title: 'Previous pull request', keys: ['k', '↑'], run: () => movePull(-1) },
  { id: 'page-diff-down', section: 'Navigate', title: 'Page down (middle pane)', keys: ['space'], run: () => scrollPane('middle', 'page-down'), isEnabled: hasPull },
  { id: 'page-diff-up', section: 'Navigate', title: 'Page up (middle pane)', keys: ['⇧space'], run: () => scrollPane('middle', 'page-up'), isEnabled: hasPull },
  { id: 'list-first', section: 'Navigate', title: 'First pull request', aliases: 'vim top', keys: ['g g', 'Home'], run: () => jumpPull('first') },
  { id: 'list-last', section: 'Navigate', title: 'Last pull request', aliases: 'vim bottom', keys: ['⇧g', 'End'], run: () => jumpPull('last') },
  { id: 'next-file', section: 'Navigate', title: 'Next file', keys: ['n', ']c', '⌥↓'], run: () => moveFile(1), isEnabled: hasFiles },
  { id: 'prev-file', section: 'Navigate', title: 'Previous file', keys: ['[c', '⌥↑'], run: () => moveFile(-1), isEnabled: hasFiles },
  { id: 'preview', section: 'Pull request', title: 'Open preview deployment', aliases: 'preview deploy vercel netlify cloudflare pages staging site web', keys: ['p'], run: () => void openPreview(), isEnabled: hasPull },
  { id: 'media', section: 'Navigate', title: 'Open first image / video / HTML preview', aliases: 'lightbox screenshot media picture gif recording', keys: ['i', '⌘⇧i'], run: () => openMedia(0), isEnabled: hasPull },
  { id: 'description', section: 'Navigate', title: 'Jump to description', keys: ['⌘↑'], run: () => diffView.scrollToTop(), isEnabled: hasPull },

  ...VIM_COMMANDS,
  ...DIFF_SCROLL_COMMANDS,
  { id: 'toggle-file', section: 'Diff', title: 'Collapse / expand file', aliases: 'fold unfold hide', keys: ['x'], run: toggleCurrentFile, isEnabled: hasFiles },
  { id: 'toggle-bots', section: 'Pull request', title: 'Show / hide bot comments', aliases: 'bots perry github-actions automated comments conversation', keys: ['⇧b'], run: () => { showBotComments = !showBotComments; localStorage.setItem('showBotComments', showBotComments ? '1' : '0'); const pull = selectedPull(); if (pull != null) renderDetail(pull); toast(showBotComments ? 'Showing bot comments' : 'Hiding bot comments'); } },
  { id: 'expand-lines', section: 'Diff', title: 'Unmodified lines per click: 20 / 100 / all (right-click a separator for a custom count)', aliases: 'expand context hidden unchanged separator github', keys: ['⇧e'], run: cycleExpandLines },
  { id: 'diff-style', section: 'Diff', title: 'Toggle split / unified diff', aliases: 'side by side inline view', keys: ['s', '⌘⌥s'], run: toggleStyle },

  { id: 'comment', section: 'Pull request', title: 'Write a comment', aliases: 'reply message mention note', keys: ['c'], run: openCommentDialog, isEnabled: hasPull },
  { id: 'approve', section: 'Pull request', title: 'Approve', aliases: 'lgtm review accept', keys: ['a'], run: () => void approveSelected(), isEnabled: () => { const pull = selectedPull(); return pull != null && !isOwnPull(pull); } },
  { id: 'finish-review', section: 'Pull request', title: 'Finish review: publish pending comments with Comment, Approve or Request changes', aliases: 'submit review pending verdict request changes', keys: ['⌘⇧↵'], run: openReviewDialog, isEnabled: hasPull },
  { id: 'merge', section: 'Pull request', title: 'Merge (all selected when several are checked)', aliases: 'squash ship land queue', keys: ['⌘↵', 'm'], run: () => void (state.checkedIds.size > 0 ? bulkMerge() : mergeSelected()), isEnabled: () => hasPull() || state.checkedIds.size > 0 },
  { id: 'fix-prompt', section: 'Pull request', title: 'Needs attention → copy agent prompt', aliases: 'triage unapproved broken red failing ci conflict agent claude codex prompt clipboard review', keys: ['⇧x'], run: openTriage },
  { id: 'open', section: 'Pull request', title: 'Open on GitHub', aliases: 'browser link url web', keys: ['o', '⌘o', 'g o'], run: openSelectedOnGitHub, isEnabled: hasPull },
  { id: 'copy-url', section: 'Pull request', title: 'Copy link', keys: ['⌘⇧c', 'y'], run: () => { const pull = selectedPull(); if (pull != null) copyText(pull.url, 'link'); }, isEnabled: hasPull },
  { id: 'copy-branch', section: 'Pull request', title: 'Copy branch name', keys: ['⌘⇧.', 'b'], run: () => { const pull = selectedPull(); if (pull != null) copyText(pull.headRefName, 'branch'); }, isEnabled: hasPull },
];

const SEQUENCE_TIMEOUT_MS = 900;
const isSequenceShortcut = (shortcut: string): boolean => shortcut.includes(' ') || /^[[\]][a-z]$/.test(shortcut);
const sequenceCommands = COMMANDS.filter((command) => command.keys.some(isSequenceShortcut));
let pendingPrefix: string | null = null;
let prefixTimer: number | undefined;

commands.add(...COMMANDS.map((command) => ({ ...command, keys: command.keys.filter((shortcut) => !isSequenceShortcut(shortcut)) })));

const SEQUENCE_PREFIXES = new Set(['g', '[', ']']);

function handleSequence(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (pendingPrefix != null) {
    const shortcut = `${pendingPrefix} ${key}`;
    const bracketShortcut = `${pendingPrefix}${key}`;
    pendingPrefix = null;
    window.clearTimeout(prefixTimer);
    const command = sequenceCommands.find((candidate) => candidate.keys.includes(shortcut) || candidate.keys.includes(bracketShortcut));
    if (command == null) return false;
    event.preventDefault();
    command.run();
    return true;
  }
  if (!SEQUENCE_PREFIXES.has(key) || (event.shiftKey && key !== '[' && key !== ']')) return false;
  pendingPrefix = key;
  prefixTimer = window.setTimeout(() => (pendingPrefix = null), SEQUENCE_TIMEOUT_MS);
  event.preventDefault();
  return true;
}

document.addEventListener('keydown', (event) => {
  if ((event.isComposing && !event.altKey) || sliceMenu.isOpen || sortMenu.isOpen || labelMenu.isOpen || expandMenu.isOpen || dom.expandDialog.open || dom.reviewDialog.open || lightbox.isOpen || dom.confirm.open || dom.help.open || dom.bulkConfirm.open || dom.triage.open || themePicker.isOpen || dom.commentDialog.open) return;
  const target = event.target;
  const composer = target instanceof HTMLTextAreaElement ? target.closest<HTMLElement>('.inline-composer') : null;
  if (composer != null && target instanceof HTMLTextAreaElement) {
    if (event.key === 'Enter' && event.metaKey && event.shiftKey) {
      event.preventDefault();
      if (composer.querySelector('[data-composer-review]') != null) addToReview(composer);
    } else if (event.key === 'Enter' && event.metaKey) {
      event.preventDefault();
      void submitComposer(composer);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (target.value.trim() === '') cancelComposer(composer);
      else target.blur();
    }
    return;
  }
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
  if (isTyping && (event.key === 'Escape' || (event.key === 'Enter' && !event.metaKey))) {
    if (event.key === 'Escape' && target === dom.filter && dom.filter.value !== '' && filteredPulls().length === 0) {
      dom.filter.value = '';
      dom.filter.dispatchEvent(new Event('input', { bubbles: true }));
    }
    (target as HTMLElement).blur();
    event.preventDefault();
    return;
  }
  if (!isTyping && handleSequence(event)) return;
  commands.handle(event, isTyping);
});

dom.list.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const selectAll = target.closest<HTMLElement>('[data-group-select]');
  if (selectAll != null) {
    const section = listSections(filteredPulls()).find((candidate) => candidate.group?.id === selectAll.dataset.groupSelect);
    if (section != null) setChecked(section.pulls.map((pull) => pull.id), true);
    return;
  }
  const header = target.closest<HTMLElement>('.group-row');
  if (header?.dataset.group != null) {
    const id = header.dataset.group;
    if (collapsedGroups.has(id)) collapsedGroups.delete(id);
    else collapsedGroups.add(id);
    invalidateList();
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups]));
    renderList();
    return;
  }
  const row = target.closest<HTMLElement>('li');
  const rowId = row?.dataset.id;
  if (rowId != null && (target.closest('.check-box') != null || event.metaKey || event.shiftKey)) {
    event.preventDefault();
    toggleChecked(rowId, event.shiftKey);
    return;
  }
  const id = rowId;
  const pull = state.pulls.find((candidate) => candidate.id === id);
  if (pull != null) void select(pull);
});

dom.files.addEventListener('click', (event) => {
  const index = Number((event.target as HTMLElement).closest<HTMLElement>('button')?.dataset.index);
  if (Number.isInteger(index)) setActiveFile(index);
});

document.getElementById('pr-body-split')?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const media = target.closest?.('.description img, .description video, .description a');
  if (media instanceof HTMLElement && openMediaFrom(media instanceof HTMLAnchorElement ? (media.querySelector('img') ?? media) : media)) {
    event.preventDefault();
    return;
  }
});

document.querySelectorAll<HTMLButtonElement>('.rail button').forEach((button) =>
  button.addEventListener('click', () => switchKind(button.dataset.kind as QueueKind)),
);
let filterFrame = 0;
dom.filter.addEventListener('input', () => {
  state.filter = dom.filter.value;
  cancelAnimationFrame(filterFrame);
  filterFrame = requestAnimationFrame(() => {
    renderList();
    renderSearchState();
  });
  scheduleSemanticSearch();
});
element('toggle-sidebar').addEventListener('click', () => layout.toggle('list'));
element('toggle-fullscreen').addEventListener('click', () => layout.toggleFocus());
element('open-github').addEventListener('click', openSelectedOnGitHub);
element('refresh-button').addEventListener('click', manualRefresh);
dom.sliceButton.addEventListener('click', openSliceMenu);
dom.groupButton.addEventListener('click', toggleGrouping);
dom.fixButton.addEventListener('click', openTriage);
dom.labelButton.addEventListener('click', openLabelMenu);
element('expand-cancel').addEventListener('click', () => dom.expandDialog.close('cancel'));
dom.expandDialog.addEventListener('close', () => {
  if (dom.expandDialog.returnValue !== 'ok') return;
  const lines = Number(dom.expandInput.value);
  if (Number.isInteger(lines) && lines > 0) setExpandLines(Math.min(lines, MAX_EXPAND_LINES));
});
dom.sortButton.addEventListener('click', () => {
  sliceMenu.close();
  labelMenu.close();
  sortMenu.toggle(dom.sortButton, sortSections, 'end');
});
element('list-empty').addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest<HTMLElement>('[data-empty-action]')?.dataset.emptyAction;
  if (action === 'clear-filter') {
    dom.filter.value = '';
    dom.filter.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (action === 'show-all') {
    if (state.repoFilter !== '') setRepoFilter('');
    if (state.labelFilter.length > 0) setLabelFilter([]);
    if (state.askScope !== 'all') setAskScope('all');
    if (state.smartFilter !== 'all') setSmartFilter('all');
  }
});
document.querySelectorAll<HTMLElement>('.h-scroll').forEach(attachScrollFade);
animateDialogCancel();
watchKbdGlyphs();
element('theme-button').addEventListener('click', openThemePicker);
refreshTicker = window.setInterval(renderRefreshStatus, 5_000);
void refreshTicker;
dom.crumbs.addEventListener('click', (event) => {
  if (!(event.target as HTMLElement).closest('.pr-link')) return;
  event.preventDefault();
  openSelectedOnGitHub();
});
applyReviewMode();
enableWindowDrag();
applyTheme();
enableTooltips();
routeLinksToBrowser(openInBrowser, (message) => toast(message, true));
systemDark.addEventListener('change', () => themeId === SYSTEM_THEME_ID && applyTheme());
element('bulk-ready').addEventListener('click', selectReady);
element('bulk-unready').addEventListener('click', selectUnready);
element('bulk-clear').addEventListener('click', clearChecked);
dom.bulkApprove.addEventListener('click', () => void bulkApprove());
dom.bulkMerge.addEventListener('click', () => void bulkMerge());
syncPaneButtons();
dom.approve.addEventListener('click', () => void approveSelected());
dom.merge.addEventListener('click', () => void (state.checkedIds.size > 0 ? bulkMerge() : mergeSelected()));
/** Syncs every tab; searches they share are fetched once, and ones fetched in the last 20s are reused. */
function syncAll(): void {
  QUEUE_KINDS.filter(isInUse).forEach((kind) => void refresh(kind));
}
window.addEventListener('focus', syncAll);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncAll();
});
window.setInterval(() => {
  if (document.visibilityState === 'visible') syncAll();
}, SYNC_INTERVAL_MS);

loadViewerTeams();

void fetchViewerLogin().then((login) => {
  if (login != null && viewer != null && login !== viewer) {
    searches.clear();
    queueCache.clear();
  }
  viewer = login;
  resetTurns();
  const pull = selectedPull();
  if (pull != null) renderDetailMeta(pull);
  renderBulkBar();
});

void isReadinessAvailable().then((isAvailable) => {
  isAiEnabled = isAvailable;
  if (isAvailable) void scoreWithJev(state.pulls);
  if (isAvailable) void ensureGroups();
});

const checkForUpdates = startAutoUpdate({
  onReady: (version, restart) => {
    const pill = document.getElementById('update-pill');
    if (pill == null) return;
    pill.hidden = false;
    pill.dataset.tip = `PR Review ${version} is installed. Restart to use it  ⌘⇧U`;
    pill.onclick = restart;
    restartIntoUpdate = restart;
    toast(`Updated to ${version} · restart when ready (⌘⇧U)`);
  },
  onError: (message) => toast(`Update check failed: ${message}`, true),
});
let restartIntoUpdate: (() => void) | null = null;

hydrateSearches();
if (state.pulls.length === 0) renderBootSkeletons();
QUEUE_KINDS.filter(isInUse).forEach((kind) => void refresh(kind, true));

if (import.meta.env.VITE_PR_REVIEW_HARNESS === '1') {
  Object.assign(window, {
    __prReview: {
      snapshot: () => ({
        selectedId: state.selectedId,
        checkedIds: [...state.checkedIds].sort(),
        visibleIds: visiblePulls().map((pull) => pull.id),
        smartFilter: state.smartFilter,
        filter: state.filter,
        isVisual: visualAnchorId != null,
        themeId,
        renderedRows: dom.list.querySelectorAll('li[data-id]').length,
      }),
    },
  });
}
