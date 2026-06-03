import React, { useRef, useEffect } from 'react';

const HTML_TAG_PATTERN = /<(p|div|br|ul|ol|li|strong|b|em|i|u|a|span|h[1-6])\b/i;
const looksLikeHtml = (s) => typeof s === 'string' && HTML_TAG_PATTERN.test(s);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

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
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={() => onChange(ref.current?.innerHTML || '')}
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
