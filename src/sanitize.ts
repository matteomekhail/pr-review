const ALLOWED_TAGS = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG',
  'INPUT', 'KBD', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUMMARY', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL', 'G-EMOJI', 'VIDEO', 'SOURCE', 'PICTURE',
]);
const ALLOWED_ATTRIBUTES = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan', 'type', 'checked', 'disabled', 'open', 'controls', 'muted', 'loop', 'playsinline', 'poster', 'srcset', 'media']);
const SAFE_URL = /^(https:|#)/i;

function cleanElement(node: Element): void {
  for (const attribute of [...node.attributes]) {
    const name = attribute.name.toLowerCase();
    const isUrl = name === 'href' || name === 'src' || name === 'poster';
    if (name === 'srcset' && attribute.value.split(',').some((part) => !SAFE_URL.test(part.trim()))) node.removeAttribute(attribute.name);
    if (!ALLOWED_ATTRIBUTES.has(name) || (isUrl && !SAFE_URL.test(attribute.value.trim()))) node.removeAttribute(attribute.name);
  }
  if (node.tagName === 'INPUT' && node.getAttribute('type') !== 'checkbox') node.remove();
  if (node.tagName === 'INPUT') node.setAttribute('disabled', '');
  if (node.tagName === 'IMG') {
    node.setAttribute('loading', 'eager');
    node.setAttribute('decoding', 'async');
  }
  if (node.tagName === 'VIDEO') node.setAttribute('preload', 'metadata');
}

export function sanitizeHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const disallowed: Element[] = [];
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const current = node as Element;
    if (ALLOWED_TAGS.has(current.tagName)) cleanElement(current);
    else disallowed.push(current);
  }
  disallowed.forEach((node) => (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.tagName) ? node.remove() : node.replaceWith(...node.childNodes)));
  return template.innerHTML;
}
