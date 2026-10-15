import type { PullRequest } from './github';
import { isConflicted, isFailing } from './status';
import { isApproved, isGreen, isReady } from './smart';

const HOUR_MS = 3_600_000;
/** A PR nobody has touched for this long is stuck. */
export const STUCK_MS = 24 * HOUR_MS;
/** Waits past these turn yellow, then red. */
const SLOW_MS = 24 * HOUR_MS;
const LATE_MS = 48 * HOUR_MS;
/** Sizes past this fill the whole size bar; Matteo's budget for one PR. */
const SIZE_BUDGET = 1_000;

export type TeamGroup = 'stuck' | 'moving' | 'ready';
type Tone = 'bad' | 'wait' | 'ok' | 'muted';

/** Who holds a PR now and why: the people whose move it is, or nobody while CI runs. */
export interface Holder {
  who: string[];
  why: string;
  tone: Tone;
}

export interface TeamRow {
  pull: PullRequest;
  holder: Holder;
  /** When the PR last moved: a push, a review or a comment by a human. */
  idleSince: number;
  group: TeamGroup;
}

export interface ReviewerLoad {
  login: string;
  /** How long each pending request has waited, oldest first. */
  waits: number[];
}

export interface FailingCheck {
  name: string;
  pulls: PullRequest[];
}

/** Parts of a list row the dashboard shares with the main list, so both look the same. */
export interface RowParts {
  status(pull: PullRequest): string;
  bots(pull: PullRequest): string;
  escape(text: string): string;
}

function time(iso: string | null | undefined): number {
  const parsed = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function authorOf(pull: PullRequest): string {
  return pull.author?.login ?? 'ghost';
}

/** The last time a human moved the PR forward. */
export function lastActivityAt(pull: PullRequest): number {
  const human = [...pull.activity.reviews, ...pull.activity.comments].filter((event) => !event.author.isBot).map((event) => time(event.at));
  return Math.max(time(pull.createdAt), time(pull.activity.lastCommitAt), ...human);
}

/** Whose move it is, in the order that unblocks a PR: the queue, the author's fixes, the reviewers, then merging. */
export function holderOf(pull: PullRequest): Holder {
  const author = authorOf(pull);
  if (pull.queueEntry != null) return { who: [], why: `Queue #${pull.queueEntry.position + 1}`, tone: 'ok' };
  if (isConflicted(pull)) return { who: [author], why: 'conflicts', tone: 'bad' };
  if (isFailing(pull)) return { who: [author], why: 'fix CI', tone: 'bad' };
  if (pull.reviewDecision === 'CHANGES_REQUESTED') return { who: [author], why: 'changes', tone: 'bad' };
  if (isReady(pull) || (isApproved(pull) && isGreen(pull))) return { who: [author], why: 'merge', tone: 'ok' };
  const people = pull.activity.reviewRequests.filter((request) => !request.isTeam).map((request) => request.name);
  const teams = pull.activity.reviewRequests.filter((request) => request.isTeam).map((request) => request.name.split('/').pop() ?? request.name);
  if (people.length > 0 || teams.length > 0) return { who: people.length > 0 ? people : teams, why: 'review', tone: 'wait' };
  if (pull.checkState === 'PENDING' || pull.checkState === 'EXPECTED') return { who: [], why: 'CI running', tone: 'muted' };
  return { who: [author], why: 'ask for review', tone: 'wait' };
}

function groupOf(holder: Holder, idleMs: number): TeamGroup {
  if (holder.tone === 'ok') return 'ready';
  return idleMs >= STUCK_MS ? 'stuck' : 'moving';
}

/** Every PR with its holder, longest idle first within each group. Bots' PRs (dependency bumps) are left out. */
export function teamRows(pulls: readonly PullRequest[], now: number): TeamRow[] {
  return pulls
    .filter((pull) => !pull.isDraft && !(pull.author?.login ?? '').endsWith('[bot]'))
    .map((pull) => {
      const holder = holderOf(pull);
      const idleSince = lastActivityAt(pull);
      return { pull, holder, idleSince, group: groupOf(holder, now - idleSince) };
    })
    .sort((left, right) => left.idleSince - right.idleSince);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** How long the open PRs that got a human review waited for the first one. */
export function firstReviewMedian(pulls: readonly PullRequest[]): number | null {
  const waits = pulls.flatMap((pull) => {
    const firsts = pull.activity.reviews.filter((review) => !review.author.isBot && review.author.login !== pull.author?.login).map((review) => time(review.at));
    return firsts.length === 0 ? [] : [Math.min(...firsts) - time(pull.createdAt)];
  });
  return median(waits.filter((wait) => wait >= 0));
}

/** Pending review requests per person. A request is dated by the author's last push, since GitHub does not date it here. */
export function reviewerLoad(rows: readonly TeamRow[], now: number): ReviewerLoad[] {
  const load = new Map<string, number[]>();
  for (const { pull, holder } of rows) {
    if (holder.why !== 'review') continue;
    const askedAt = Math.max(time(pull.createdAt), time(pull.activity.lastCommitAt));
    pull.activity.reviewRequests.filter((request) => !request.isTeam).forEach((request) => load.set(request.name, [...(load.get(request.name) ?? []), now - askedAt]));
  }
  return [...load.entries()]
    .map(([login, waits]) => ({ login, waits: waits.sort((left, right) => right - left) }))
    .sort((left, right) => right.waits.length - left.waits.length || (right.waits[0] ?? 0) - (left.waits[0] ?? 0));
}

/** Checks failing now, by how many PRs they block. */
export function failingChecks(rows: readonly TeamRow[]): FailingCheck[] {
  const byName = new Map<string, PullRequest[]>();
  rows.forEach(({ pull }) => pull.failingChecks.forEach((check) => byName.set(check.name, [...(byName.get(check.name) ?? []), pull])));
  return [...byName.entries()].map(([name, pulls]) => ({ name, pulls })).sort((left, right) => right.pulls.length - left.pulls.length);
}

/** `3d 2h`, `14h`, `40m`. */
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 || days >= 7 ? `${days}d` : `${days}d ${hours % 24}h`;
}

function waitTone(ms: number): string {
  return ms >= LATE_MS ? 'bad' : ms >= SLOW_MS ? 'wait' : '';
}

function personAvatar(login: string, state: string, parts: RowParts): string {
  return `<span class="team-person ${state}" title="${parts.escape(`@${login}${state === '' ? '' : ` · ${state}`}`)}"><img src="https://github.com/${encodeURIComponent(login)}.png?size=40" alt="" loading="lazy" /></span>`;
}

/** Requested reviewers (waiting) and everyone else's latest verdict, one avatar each. */
function reviewersHtml(pull: PullRequest, parts: RowParts): string {
  const latest = new Map<string, string>();
  pull.activity.reviews
    .filter((review) => !review.author.isBot && review.author.login !== pull.author?.login)
    .forEach((review) => latest.set(review.author.login, review.state === 'APPROVED' ? 'approved' : review.state === 'CHANGES_REQUESTED' ? 'changes' : 'commented'));
  pull.activity.reviewRequests.filter((request) => !request.isTeam).forEach((request) => latest.set(request.name, 'requested'));
  return [...latest.entries()].slice(0, 4).map(([login, state]) => personAvatar(login, state, parts)).join('');
}

function sizeHtml(pull: PullRequest): string {
  const total = pull.additions + pull.deletions;
  const scale = Math.min(1, total / SIZE_BUDGET);
  const added = total === 0 ? 0 : (pull.additions / total) * scale * 100;
  const removed = total === 0 ? 0 : (pull.deletions / total) * scale * 100;
  return `<span class="team-size" title="+${pull.additions} −${pull.deletions} in ${pull.changedFiles} files"><span class="bar"><i class="add" style="width:${added}%"></i><i class="del" style="width:${removed}%"></i></span><span class="${total > SIZE_BUDGET ? 'bad' : ''}">${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total}</span></span>`;
}

function ciHtml(pull: PullRequest, parts: RowParts): string {
  if (isFailing(pull)) return `<span class="bad" title="${parts.escape(pull.failingChecks.map((check) => check.name).join(', '))}">${parts.escape(pull.failingChecks[0]?.name ?? 'failing')}${pull.failingChecks.length > 1 ? ` +${pull.failingChecks.length - 1}` : ''}</span>`;
  if (pull.checkState === 'PENDING' || pull.checkState === 'EXPECTED') return '<span class="muted">running</span>';
  if (pull.checkState === 'SUCCESS') return '<span class="ok">passed</span>';
  return '<span class="muted">none</span>';
}

function holderHtml(holder: Holder, parts: RowParts): string {
  const who = holder.who.length === 0 ? '' : `<b>${parts.escape(holder.who.slice(0, 2).join(', '))}${holder.who.length > 2 ? ` +${holder.who.length - 2}` : ''}</b> `;
  return `<span class="team-holder ${holder.tone}">${who}<span>${parts.escape(holder.why)}</span></span>`;
}

function rowHtml(row: TeamRow, now: number, selectedId: string | null, parts: RowParts): string {
  const { pull, holder } = row;
  const idle = now - row.idleSince;
  return `<li data-id="${pull.id}" class="${pull.id === selectedId ? 'selected' : ''}">
    ${parts.status(pull)}
    <span class="repo">${parts.escape(pull.repository.nameWithOwner.split('/')[1] ?? '')}</span>
    <span class="num">#${pull.number}</span>
    <span class="t" title="${parts.escape(pull.title)}">${parts.escape(pull.title)}</span>
    <span class="author">${parts.escape(authorOf(pull))}</span>
    <span class="age">${duration(now - time(pull.createdAt))}</span>
    ${sizeHtml(pull)}
    <span class="ci">${ciHtml(pull, parts)}</span>
    <span class="people">${reviewersHtml(pull, parts)}</span>
    ${parts.bots(pull)}
    ${holderHtml(holder, parts)}
    <span class="idle ${row.group === 'ready' ? '' : waitTone(idle)}">${duration(idle)}</span>
  </li>`;
}

const GROUP_TITLES: Record<TeamGroup, string> = { stuck: 'Stuck over 24h', moving: 'Moving', ready: 'Ready to merge' };

function groupNote(rows: readonly TeamRow[]): string {
  const counts = new Map<string, number>();
  rows.forEach(({ holder }) => counts.set(holder.why, (counts.get(holder.why) ?? 0) + 1));
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([why, count]) => `${count} ${why}`).join(' · ');
}

function figure(value: string, label: string, tone = ''): string {
  return `<span class="team-figure"><b class="${tone}">${value}</b>${label}</span>`;
}

function reviewerLoadHtml(load: readonly ReviewerLoad[], person: string, parts: RowParts): string {
  if (load.length === 0) return '<p class="muted">No pending review requests.</p>';
  const rows = load.map(({ login, waits }) => `<li data-person="${parts.escape(login)}" class="${login === person ? 'selected' : ''}">
      ${personAvatar(login, '', parts)}<span class="name">${parts.escape(login)}</span>
      <span class="blocks">${waits.slice(0, 8).map((wait) => `<i class="${waitTone(wait)}"></i>`).join('')}</span>
      <span class="n">${waits.length}</span>
      <span class="oldest ${waitTone(waits[0] ?? 0)}">${duration(waits[0] ?? 0)}</span>
    </li>`);
  return `<ol class="team-load"><li class="head"><span></span><span>Reviewer</span><span>Pending</span><span></span><span>Oldest</span></li>${rows.join('')}</ol>`;
}

function failingChecksHtml(checks: readonly FailingCheck[], parts: RowParts): string {
  if (checks.length === 0) return '<p class="muted">Nothing failing.</p>';
  return `<ol class="team-checks">${checks
    .slice(0, 6)
    .map(({ name, pulls }) => `<li><span class="name">${parts.escape(name)}</span><span class="n bad">${pulls.length}</span><span class="nums">${pulls.map((pull) => `<span data-id="${pull.id}">#${pull.number}</span>`).join(' ')}</span></li>`)
    .join('')}</ol>`;
}

export interface TeamViewInput {
  pulls: readonly PullRequest[];
  now: number;
  /** Narrows the table to PRs waiting on this login; empty for everyone. */
  person: string;
  /** Narrows everything to one repository (`owner/name`); empty for all. */
  repo: string;
  selectedId: string | null;
  updatedAt: number | undefined;
}

/** The Team dashboard: four figures, every open PR grouped by whether it moves, and who and what holds them up. */
export function teamHtml({ pulls, now, person, repo, selectedId, updatedAt }: TeamViewInput, parts: RowParts): string {
  const everyone = teamRows(pulls, now);
  const all = repo === '' ? everyone : everyone.filter((row) => row.pull.repository.nameWithOwner === repo);
  const rows = person === '' ? all : all.filter((row) => row.holder.who.includes(person));
  const stuck = all.filter((row) => row.group === 'stuck').length;
  const ready = all.filter((row) => row.group === 'ready').length;
  const firstReview = firstReviewMedian(all.map((row) => row.pull));
  const repos = [...new Set(everyone.map((row) => row.pull.repository.nameWithOwner))].sort();
  const repoTabs = ['', ...repos].map((name) => {
    const count = name === '' ? everyone.length : everyone.filter((row) => row.pull.repository.nameWithOwner === name).length;
    return `<button data-repo="${parts.escape(name)}" class="${name === repo ? 'on' : ''}">${parts.escape(name === '' ? 'All' : (name.split('/')[1] ?? name))}<span>${count}</span></button>`;
  });
  const groups = (['stuck', 'moving', 'ready'] as const).flatMap((group) => {
    const inGroup = rows.filter((row) => row.group === group);
    if (inGroup.length === 0) return [];
    return [`<li class="team-group"><b>${GROUP_TITLES[group]}</b><span class="n">${inGroup.length}</span><span class="note">${groupNote(inGroup)}</span></li>`, ...inGroup.map((row) => rowHtml(row, now, selectedId, parts))];
  });
  return `<header class="team-head drag-region" data-tauri-drag-region>
      <h2>Team</h2>
      <nav class="team-repos">${repoTabs.join('')}</nav>
      ${person === '' ? '' : `<button class="team-filter" data-person="">Waiting on ${parts.escape(person)}<span aria-hidden="true">×</span></button>`}
      <span class="grow" data-tauri-drag-region></span>
      <span class="muted">${updatedAt == null ? 'Loading…' : `Updated ${duration(now - updatedAt)} ago`}</span>
    </header>
    <div class="team-figures">
      ${figure(String(all.length), 'open')}
      ${figure(String(stuck), 'stuck over 24h', stuck > 0 ? 'bad' : '')}
      ${figure(String(ready), 'ready to merge', ready > 0 ? 'ok' : '')}
      ${figure(firstReview == null ? '–' : duration(firstReview), 'to first review, median')}
    </div>
    <div class="team-body">
      <section class="team-table${new Set(rows.map((row) => row.pull.repository.nameWithOwner)).size > 1 ? '' : ' one-repo'}">
        <div class="team-cols"><span class="repo">Repo</span><span class="t">Pull request</span><span class="author">Author</span><span class="age">Age</span><span class="team-size">Size</span><span class="ci">CI</span><span class="people">Reviewers</span><span class="bot-marks">AI</span><span class="team-holder">Waiting on</span><span class="idle">Idle</span></div>
        <ol>${groups.join('') || '<li class="team-empty">No open pull requests.</li>'}</ol>
      </section>
      <aside class="team-side">
        <h3>Reviewer load</h3>
        ${reviewerLoadHtml(reviewerLoad(all, now), person, parts)}
        <h3>Failing checks</h3>
        ${failingChecksHtml(failingChecks(all), parts)}
      </aside>
    </div>`;
}
