import type { ReviewThread, ThreadComment } from './conversation';
import { sanitizeHtml } from './sanitize';

/** Lines of the diff hunk shown above a thread in the conversation, as GitHub does. */
const HUNK_CONTEXT_LINES = 4;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function commentHtml(comment: ThreadComment, ago: (iso: string) => string): string {
  const avatar = comment.avatarUrl == null ? '<span class="avatar"></span>' : `<img class="avatar" src="${escapeHtml(comment.avatarUrl)}&s=40" alt="" loading="lazy" />`;
  return `<div class="thread-comment">
    <header>${avatar}<b>${escapeHtml(comment.author)}</b>${comment.isBot ? '<span class="bot-tag">bot</span>' : ''}<a class="comment-time" href="${escapeHtml(comment.url)}" title="Open on GitHub">${ago(comment.at)} ago</a></header>
    <div class="markdown thread-body">${sanitizeHtml(comment.html)}</div>
  </div>`;
}

function hunkHtml(diffHunk: string): string {
  const rows = diffHunk.split('\n').filter((row) => !row.startsWith('@@') && !row.startsWith('\\')).slice(-HUNK_CONTEXT_LINES);
  if (rows.length === 0) return '';
  return `<pre class="thread-hunk">${rows.map((row) => `<span class="${row.startsWith('+') ? 'add' : row.startsWith('-') ? 'del' : 'ctx'}">${escapeHtml(row === '' ? ' ' : row)}</span>`).join('')}</pre>`;
}

function lineLabel(thread: ReviewThread): string {
  if (thread.line != null && thread.startLine != null && thread.startLine !== thread.line) return `lines ${thread.startLine}–${thread.line}`;
  const line = thread.line ?? thread.originalLine;
  return line == null ? '' : `line ${line}`;
}

/**
 * A code thread: its comments in order and a reply box. In the conversation (`withContext`) it also names the file
 * and shows the last lines of code it is on; in the diff that code is right above it. Resolved threads start folded.
 */
export function threadHtml(thread: ReviewThread, { withContext, ago }: { withContext: boolean; ago: (iso: string) => string }): string {
  const tags = [thread.isOutdated ? 'Outdated' : '', thread.isResolved ? 'Resolved' : ''].filter((tag) => tag !== '').map((tag) => `<span class="thread-tag">${tag}</span>`).join('');
  const line = lineLabel(thread);
  const head = withContext ? `<header class="thread-head"><code title="${escapeHtml(thread.path)}">${escapeHtml(thread.path)}</code>${line === '' ? '' : `<span>${line}</span>`}${tags}</header>${hunkHtml(thread.diffHunk)}` : '';
  const body = `${head}<div class="thread-comments">${thread.comments.map((comment) => commentHtml(comment, ago)).join('')}</div><div class="thread-reply"><button type="button" class="thread-reply-open" data-reply-thread="${escapeHtml(thread.id)}">Reply…</button></div>`;
  if (!thread.isResolved) return `<section class="thread" data-thread="${escapeHtml(thread.id)}">${body}</section>`;
  const count = `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`;
  const where = withContext ? `${escapeHtml(thread.path.split('/').pop() ?? thread.path)}${line === '' ? '' : ` · ${line}`} · ` : '';
  return `<details class="thread is-resolved" data-thread="${escapeHtml(thread.id)}"><summary><span class="thread-tag">Resolved</span>${where}${count} · ${escapeHtml(thread.comments[0]?.author ?? '')}</summary>${body}</details>`;
}

/** A comment box; `label` says where the comment goes. ⌘↵ sends it, Esc on an empty box drops it. */
export function composerHtml(label: string, submitLabel: string): string {
  return `<div class="inline-composer">
    <textarea rows="3" placeholder="Leave a comment… (markdown, @mentions work)" spellcheck="true"></textarea>
    <div class="composer-foot"><span class="muted">${escapeHtml(label)}</span><button type="button" class="ghost" data-composer-cancel>Cancel <kbd>esc</kbd></button><button type="button" class="primary" data-composer-submit>${escapeHtml(submitLabel)} <kbd>⌘</kbd><kbd>↵</kbd></button></div>
  </div>`;
}
