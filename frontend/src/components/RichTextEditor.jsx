import React, { useRef, useEffect } from 'react';

const HTML_TAG_PATTERN = /<(p|div|br|ul|ol|li|strong|b|em|i|u|a|span|h[1-6])\b/i;
const looksLikeHtml = (s) => typeof s === 'string' && HTML_TAG_PATTERN.test(s);

/**
 * Tidy pasted HTML: strip Office / Google Docs noise, force every <a> to
 * have target=_blank + rel, drop styling attributes that bloat the email.
 * Returns clean HTML suitable for the editor and the outgoing message.
 */
function sanitizePastedHtml(html) {
  if (!html) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = html;

  // Remove Office-specific containers and conditional comments.
  tpl.content.querySelectorAll('o\\:p, w\\:sdt, w\\:sdtPr, style, meta, link, script').forEach(n => n.remove());

  // Strip class attrs (Word adds MsoNormal etc.), inline mso-* and font
  // declarations from Word.
  tpl.content.querySelectorAll('*').forEach((el) => {
    el.removeAttribute('class');
    el.removeAttribute('lang');
    const style = el.getAttribute('style');
    if (style) {
      const cleaned = style
        .split(';')
        .filter(s => !/^\s*(mso-|font-family|font-size|line-height|color)/i.test(s))
        .join(';')
        .trim();
      if (cleaned) el.setAttribute('style', cleaned);
      else el.removeAttribute('style');
    }
  });

  // Ensure every anchor opens in a new tab with safe rel and a hover
  // tooltip showing its target — and that the href is present + clickable.
  tpl.content.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) {
      // Office sometimes uses <a name="..."> bookmarks with no href —
      // unwrap them so they don't look like clickable links.
      const parent = a.parentNode;
      while (a.firstChild) parent.insertBefore(a.firstChild, a);
      parent.removeChild(a);
      return;
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('title', href);
  });

  return tpl.innerHTML;
}

/**
 * Minimal contenteditable rich-text editor for email body editing.
 *
 * Preserves formatting on paste (bold, italic, lists, links, etc.)
 * from Word / Outlook / Google Docs / web pages. Has a tiny toolbar
 * for common operations, but native keyboard shortcuts (Cmd/Ctrl+B
 * etc.) work too because contenteditable handles them by default.
 *
 *   value      — initial HTML to show. Used as the editor's seed
 *                when resetKey changes; otherwise the editor is
 *                uncontrolled and the caller reads from onChange.
 *   onChange   — fires on every input with the latest innerHTML.
 *   resetKey   — bump this when you want the editor to re-seed from
 *                value (e.g. on a new selection).
 *   placeholder — shown when innerHTML is empty.
 *   style      — passed to the editable area's outer div.
 */
export default function RichTextEditor({
  value,
  onChange,
  resetKey,
  placeholder = '',
  style = {},
}) {
  const ref = useRef(null);

  // Seed innerHTML when resetKey changes — keeps cursor stable while
  // typing because we DON'T re-set innerHTML on every value update.
  // Plain-text seeds get \n → <br/> mapping so multi-line drafts (from
  // the LLM, which outputs plain text) display correctly.
  useEffect(() => {
    if (!ref.current) return;
    const seed = looksLikeHtml(value)
      ? (value || '')
      : (value || '').replace(/\n/g, '<br/>');
    if (ref.current.innerHTML !== seed) ref.current.innerHTML = seed;
    decorateExistingLinks(ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Ensure links that were already in the seed value also get target/rel/title.
  const decorateExistingLinks = (root) => {
    if (!root) return;
    root.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      if (!a.getAttribute('title')) a.setAttribute('title', a.getAttribute('href'));
    });
  };

  const handlePaste = (e) => {
    const clipboard = e.clipboardData;
    if (!clipboard) return;
    const html = clipboard.getData('text/html');
    if (!html) return; // let the browser handle plain-text paste normally
    e.preventDefault();
    const clean = sanitizePastedHtml(html);
    document.execCommand('insertHTML', false, clean);
    onChange(ref.current?.innerHTML || '');
  };

  const handleClick = (e) => {
    // Cmd/Ctrl + click on a link opens it in a new tab. Regular click
    // is left to contenteditable so the user can place the cursor.
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      window.open(a.getAttribute('href'), '_blank', 'noopener,noreferrer');
    }
  };

  const cmd = (command, arg) => {
    ref.current?.focus();
    // execCommand is deprecated but still the simplest cross-browser
    // path for bold/italic/lists/links inside a contenteditable.
    document.execCommand(command, false, arg);
    onChange(ref.current?.innerHTML || '');
  };

  const insertLink = () => {
    const url = window.prompt('Link URL (must start with https://)');
    if (!url) return;
    const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    cmd('createLink', safe);
    // execCommand strips target — re-apply.
    const links = ref.current?.querySelectorAll(`a[href="${safe}"]`) || [];
    links.forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.setAttribute('title', safe);
    });
    onChange(ref.current?.innerHTML || '');
  };

  const ToolBtn = ({ label, title, onClick }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        background: 'transparent',
        border: '1px solid var(--border-soft)',
        color: 'var(--text-secondary)',
        borderRadius: 4,
        padding: '3px 8px',
        cursor: 'pointer',
        fontSize: '0.78rem',
        fontWeight: 600,
        minWidth: 28,
      }}
    >{label}</button>
  );

  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-tertiary)' }}>
      <div style={{
        display: 'flex', gap: 4, padding: '6px 8px',
        borderBottom: '1px solid var(--border-soft)',
        background: 'var(--bg-secondary)',
        flexWrap: 'wrap',
      }}>
        <ToolBtn label="B" title="Bold (Cmd/Ctrl+B)"      onClick={() => cmd('bold')} />
        <ToolBtn label="I" title="Italic (Cmd/Ctrl+I)"    onClick={() => cmd('italic')} />
        <ToolBtn label="U" title="Underline (Cmd/Ctrl+U)" onClick={() => cmd('underline')} />
        <span style={{ width: 1, background: 'var(--border-soft)', margin: '0 4px' }} />
        <ToolBtn label="• List"  title="Bulleted list"   onClick={() => cmd('insertUnorderedList')} />
        <ToolBtn label="1. List" title="Numbered list"   onClick={() => cmd('insertOrderedList')} />
        <span style={{ width: 1, background: 'var(--border-soft)', margin: '0 4px' }} />
        <ToolBtn label="🔗"     title="Insert link"     onClick={insertLink} />
        <ToolBtn label="× Clear" title="Strip formatting from selection" onClick={() => cmd('removeFormat')} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
          Cmd/Ctrl+click a link to open it
        </span>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={() => onChange(ref.current?.innerHTML || '')}
        onPaste={handlePaste}
        onClick={handleClick}
        data-placeholder={placeholder}
        style={{
          minHeight: 160,
          padding: '10px 12px',
          fontSize: '0.88rem',
          lineHeight: 1.55,
          color: 'var(--text-primary)',
          outline: 'none',
          ...style,
        }}
      />
    </div>
  );
}
