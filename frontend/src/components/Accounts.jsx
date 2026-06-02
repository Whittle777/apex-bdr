import React, { useState, useEffect, useRef } from 'react';
import api from '../services/api';
import { useToast } from './Toast';

// ── Helpers ───────────────────────────────────────────────────────────────────

const parseTags = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

const TIERS    = ['enterprise', 'mid-market', 'smb'];
const STATUSES = ['prospect', 'customer', 'churned', 'partner'];

const STATUS_STYLES = {
  prospect: { bg: 'var(--accent-soft)',       color: 'var(--accent-secondary)', border: 'var(--border-accent)' },
  customer: { bg: 'var(--status-success-dim)', color: 'var(--status-success)',   border: 'var(--status-success-border)' },
  churned:  { bg: 'rgba(100,116,139,0.12)',    color: 'var(--text-muted)',        border: 'rgba(100,116,139,0.2)' },
  partner:  { bg: 'var(--status-info-dim)',    color: 'var(--status-info)',       border: 'var(--status-info-border)' },
};

const TIER_STYLES = {
  enterprise:  { bg: 'rgba(168,85,247,0.12)', color: '#a855f7', border: 'rgba(168,85,247,0.25)' },
  'mid-market':{ bg: 'rgba(59,130,246,0.12)', color: '#3b82f6', border: 'rgba(59,130,246,0.25)' },
  smb:         { bg: 'rgba(34,197,94,0.12)',  color: '#22c55e', border: 'rgba(34,197,94,0.25)' },
};

const Pill = ({ label, style }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 9999, fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', border: '1px solid', whiteSpace: 'nowrap', ...style }}>
    {label}
  </span>
);

const initials = (name) => name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';

// ── Section wrapper ───────────────────────────────────────────────────────────

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 20 }}>
    <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid var(--border-subtle)' }}>
      {title}
    </div>
    {children}
  </div>
);

const Field = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</label>
    {children}
  </div>
);

const Grid2 = ({ children }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{children}</div>
);

// ── Tag input ─────────────────────────────────────────────────────────────────

const TagInput = ({ tags, onChange }) => {
  const [input, setInput] = useState('');
  const add = (raw) => {
    const t = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (!t || tags.includes(t)) return;
    onChange([...tags, t]);
    setInput('');
  };
  const remove = (t) => onChange(tags.filter(x => x !== t));
  return (
    <div
      style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '6px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', minHeight: 36, cursor: 'text', alignItems: 'center' }}
      onClick={() => document.getElementById('acc-tag-input')?.focus()}
    >
      {tags.map(tag => (
        <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', borderRadius: 9999, fontSize: '0.72rem', fontWeight: 600, color: 'var(--accent-secondary)' }}>
          #{tag}
          <button type="button" onClick={e => { e.stopPropagation(); remove(tag); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: '0.7rem', lineHeight: 1, opacity: 0.7 }}>✕</button>
        </span>
      ))}
      <input
        id="acc-tag-input"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input); }
          if (e.key === 'Backspace' && !input && tags.length) remove(tags[tags.length - 1]);
        }}
        onBlur={() => input && add(input)}
        placeholder={tags.length === 0 ? 'Add tags…' : ''}
        style={{ background: 'none', border: 'none', outline: 'none', fontSize: '0.78rem', color: 'var(--text-primary)', flex: '1 1 80px', minWidth: 60, padding: '1px 2px' }}
      />
    </div>
  );
};

// ── Account detail panel ──────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: '', domain: '', website: '', industry: '', subIndustry: '',
  revenue: '', employees: '', country: '', region: '', city: '',
  description: '', notes: '', researchSummary: '', status: 'prospect', tier: '',
  techStack: '', tags: '[]', linkedInUrl: '', twitterUrl: '', foundedYear: '',
  // FY27 account-tracker fields
  priorityTier: '', dealMotion: '', targetCloseDate: '', closeQuarter: '',
  useCases: '', primaryStakeholder: '', backupStakeholders: '', warmIntroPaths: '',
  weeklyFocus: '', outreachStatus: '', lastContactedAt: '', myNotes: '', rep: '',
};

const PRIORITY_TIER_STYLES = {
  'A-Existing': { bg: 'rgba(34,197,94,0.12)', color: '#22c55e', border: 'rgba(34,197,94,0.25)' },
  'A-Priority': { bg: 'rgba(59,130,246,0.18)', color: '#3b82f6', border: 'rgba(59,130,246,0.3)' },
  'B-Pursue':   { bg: 'rgba(234,179,8,0.15)',  color: '#eab308', border: 'rgba(234,179,8,0.3)' },
  'B-Watch':    { bg: 'rgba(239,68,68,0.12)',  color: '#ef4444', border: 'rgba(239,68,68,0.25)' },
};

const formatDateInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
};

const AccountDetail = ({ account, onSaved, onDeleted, allProspects }) => {
  const [form, setForm]         = useState(null);
  const [saving, setSaving]     = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [activeTab, setActiveTab]   = useState('details');
  const [linkSearch, setLinkSearch] = useState('');
  const [linking, setLinking]       = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (account) {
      setForm({
        ...EMPTY_FORM,
        ...account,
        foundedYear: account.foundedYear ?? '',
        tags: account.tags || '[]',
        targetCloseDate: formatDateInput(account.targetCloseDate),
        lastContactedAt: formatDateInput(account.lastContactedAt),
      });
      setActiveTab('details');
      setConfirmDel(false);
    }
  }, [account?.id, account?.updatedAt]);

  if (!account || !form) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
      Select an account to view details
    </div>
  );

  const tags = parseTags(form.tags);
  const setTags = (t) => setForm(f => ({ ...f, tags: JSON.stringify(t) }));
  const f = (k) => (v) => setForm(prev => ({ ...prev, [k]: v }));
  const input = (k, props = {}) => (
    <input value={form[k] || ''} onChange={e => setForm(prev => ({ ...prev, [k]: e.target.value }))} {...props} />
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.put(`/accounts/${account.id}`, {
        ...form,
        foundedYear: form.foundedYear ? parseInt(form.foundedYear) : null,
        targetCloseDate: form.targetCloseDate ? new Date(form.targetCloseDate).toISOString() : null,
        lastContactedAt: form.lastContactedAt ? new Date(form.lastContactedAt).toISOString() : null,
      });
      onSaved(res.data);
      toast(`"${form.name}" saved`, 'success', 2000);
    } catch (err) {
      toast(err.response?.data?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.delete(`/accounts/${account.id}`);
      onDeleted(account.id);
      toast(`"${account.name}" deleted`, 'info', 2200);
    } catch (err) {
      toast('Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleUnlink = async (prospectId) => {
    try {
      await api.delete(`/accounts/${account.id}/link-prospect/${prospectId}`);
      onSaved({ ...account, prospects: account.prospects.filter(p => p.id !== prospectId) });
      toast('Prospect unlinked', 'info', 1800);
    } catch { toast('Failed to unlink', 'error'); }
  };

  const handleLink = async (prospectId) => {
    setLinking(true);
    try {
      await api.post(`/accounts/${account.id}/link-prospect`, { prospectId });
      const res = await api.get(`/accounts/${account.id}`);
      onSaved(res.data);
      setLinkSearch('');
      toast('Prospect linked', 'success', 1800);
    } catch { toast('Failed to link', 'error'); }
    finally { setLinking(false); }
  };

  const linkedIds = new Set((account.prospects || []).map(p => p.id));
  const linkCandidates = allProspects.filter(p =>
    !linkedIds.has(p.id) &&
    (linkSearch.length < 2 || `${p.firstName} ${p.lastName} ${p.companyName || ''} ${p.email}`.toLowerCase().includes(linkSearch.toLowerCase()))
  ).slice(0, 8);

  const activityTotals = (account.prospects || []).reduce((acc, p) => ({
    emails:   acc.emails   + (p._count?.emailActivities   || 0),
    calls:    acc.calls    + (p._count?.callActivities    || 0),
    meetings: acc.meetings + (p._count?.meetingActivities || 0),
  }), { emails: 0, calls: 0, meetings: 0 });

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {/* Account header */}
      <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border-color)', background: 'linear-gradient(180deg, var(--accent-dim) 0%, transparent 100%)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 'var(--radius-md)', background: 'var(--grad-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '1rem', color: '#fff', flexShrink: 0, boxShadow: 'var(--shadow-glow-sm)' }}>
            {initials(form.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              style={{ fontWeight: 700, fontSize: '1.15rem', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', padding: 0, width: '100%' }}
              placeholder="Account name"
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {form.status && <Pill label={form.status} style={STATUS_STYLES[form.status] || STATUS_STYLES.prospect} />}
              {form.tier && <Pill label={form.tier} style={TIER_STYLES[form.tier] || {}} />}
              {form.industry && <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{form.industry}</span>}
              {form.domain && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{form.domain}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {/* Stats bubbles */}
            {[
              { n: account._count?.prospects || 0, label: 'contacts' },
              { n: activityTotals.emails,   label: 'emails' },
              { n: activityTotals.calls,    label: 'calls' },
              { n: activityTotals.meetings, label: 'meetings' },
            ].map(s => (
              <div key={s.label} style={{ textAlign: 'center', padding: '4px 10px', background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>{s.n}</div>
                <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 16, marginTop: 14 }}>
          {['details', 'prospects'].map(tab => (
            <button key={tab} className={`tab-btn${activeTab === tab ? ' active' : ''}`} onClick={() => setActiveTab(tab)} style={{ textTransform: 'capitalize' }}>
              {tab}
              {tab === 'prospects' && (
                <span className="count-pill" style={{ marginLeft: 6 }}>{account._count?.prospects || 0}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {activeTab === 'details' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

            <Section title="FY27 Account Research">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Grid2>
                  <Field label="Priority Tier">{input('priorityTier', { placeholder: 'A-Existing · A-Priority · B-Pursue · B-Watch' })}</Field>
                  <Field label="Rep">{input('rep', { placeholder: 'Owning rep' })}</Field>
                </Grid2>
                <Grid2>
                  <Field label="Deal Motion">{input('dealMotion', { placeholder: 'e.g. Net-New Pursuit' })}</Field>
                  <Field label="Outreach Status">{input('outreachStatus', { placeholder: 'Not Started · Research Phase · …' })}</Field>
                </Grid2>
                <Grid2>
                  <Field label="Target Close Date"><input type="date" value={form.targetCloseDate || ''} onChange={e => setForm(f => ({ ...f, targetCloseDate: e.target.value }))} /></Field>
                  <Field label="Close Quarter">{input('closeQuarter', { placeholder: 'e.g. Q2 (Aug–Oct 2026)' })}</Field>
                </Grid2>
                <Field label="Top Use Cases (drives personalization)">
                  <textarea
                    value={form.useCases || ''}
                    onChange={e => setForm(f => ({ ...f, useCases: e.target.value }))}
                    placeholder="Top use cases relevant to this account — used as research context for AI personalization"
                    rows={3}
                    style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
                  />
                </Field>
                <Field label="Primary Stakeholder">{input('primaryStakeholder', { placeholder: 'Name + title' })}</Field>
                <Field label="Backup Stakeholders">
                  <textarea
                    value={form.backupStakeholders || ''}
                    onChange={e => setForm(f => ({ ...f, backupStakeholders: e.target.value }))}
                    rows={2}
                    style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
                  />
                </Field>
                <Field label="Warm Intro Paths">
                  <textarea
                    value={form.warmIntroPaths || ''}
                    onChange={e => setForm(f => ({ ...f, warmIntroPaths: e.target.value }))}
                    rows={2}
                    style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
                  />
                </Field>
                <Field label="Q1 Weekly Focus / Key Gates">
                  <textarea
                    value={form.weeklyFocus || ''}
                    onChange={e => setForm(f => ({ ...f, weeklyFocus: e.target.value }))}
                    rows={2}
                    style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
                  />
                </Field>
                <Grid2>
                  <Field label="Last Contact Date"><input type="date" value={form.lastContactedAt || ''} onChange={e => setForm(f => ({ ...f, lastContactedAt: e.target.value }))} /></Field>
                  <div />
                </Grid2>
                <Field label="My Notes">
                  <textarea
                    value={form.myNotes || ''}
                    onChange={e => setForm(f => ({ ...f, myNotes: e.target.value }))}
                    placeholder="Personal notes from outreach"
                    rows={3}
                    style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
                  />
                </Field>
              </div>
            </Section>

            <Section title="Classification">
              <Grid2>
                <Field label="Status">
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                    {STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                  </select>
                </Field>
                <Field label="Tier">
                  <select value={form.tier || ''} onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}>
                    <option value="">— None —</option>
                    {TIERS.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                  </select>
                </Field>
              </Grid2>
            </Section>

            <Section title="Company Info">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Grid2>
                  <Field label="Domain">{input('domain', { placeholder: 'acme.com' })}</Field>
                  <Field label="Website">{input('website', { placeholder: 'https://acme.com' })}</Field>
                </Grid2>
                <Grid2>
                  <Field label="Industry">{input('industry', { placeholder: 'e.g. SaaS' })}</Field>
                  <Field label="Sub-Industry">{input('subIndustry', { placeholder: 'e.g. HR Tech' })}</Field>
                </Grid2>
                <Grid2>
                  <Field label="Revenue">{input('revenue', { placeholder: 'e.g. $10M–$50M' })}</Field>
                  <Field label="Employees">{input('employees', { placeholder: 'e.g. 100–500' })}</Field>
                </Grid2>
                <Grid2>
                  <Field label="Founded Year">{input('foundedYear', { type: 'number', placeholder: '2010' })}</Field>
                  <Field label="Tech Stack">{input('techStack', { placeholder: 'Salesforce, AWS, React…' })}</Field>
                </Grid2>
              </div>
            </Section>

            <Section title="Location">
              <Grid2>
                <Field label="Country">{input('country')}</Field>
                <Field label="Region / State">{input('region')}</Field>
              </Grid2>
              <div style={{ marginTop: 10 }}>
                <Field label="City">{input('city')}</Field>
              </div>
            </Section>

            <Section title="Social &amp; Links">
              <Grid2>
                <Field label="LinkedIn URL">{input('linkedInUrl', { placeholder: 'https://linkedin.com/company/…' })}</Field>
                <Field label="Twitter / X">{input('twitterUrl', { placeholder: 'https://x.com/…' })}</Field>
              </Grid2>
            </Section>

            <Section title="Tags">
              <TagInput tags={tags} onChange={setTags} />
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 4 }}>Enter or comma to confirm · Backspace removes last</div>
            </Section>

            <Section title="Description">
              <Field label="">
                <textarea
                  value={form.description || ''}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="What does this company do? Key context for outreach…"
                  rows={3}
                  style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
                />
              </Field>
            </Section>

            <Section title="Account Research">
              <Field label="">
                <textarea
                  value={form.researchSummary || ''}
                  onChange={e => setForm(f => ({ ...f, researchSummary: e.target.value }))}
                  placeholder="Account-level research. Pulled into every prospect brief generated for this company. Bulk-upload via Research → Account research."
                  rows={5}
                  style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(56,189,248,0.25)', background: 'rgba(56,189,248,0.04)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
                />
              </Field>
            </Section>

            <Section title="Internal Notes">
              <Field label="">
                <textarea
                  value={form.notes || ''}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Deal notes, objections, stakeholder context…"
                  rows={4}
                  style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
                />
              </Field>
            </Section>

          </div>
        )}

        {activeTab === 'prospects' && (
          <div>
            {/* Link new prospect */}
            <div style={{ marginBottom: 16, padding: '12px 14px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Link a Prospect</div>
              <input
                value={linkSearch}
                onChange={e => setLinkSearch(e.target.value)}
                placeholder="Search by name, company, or email…"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: linkSearch.length >= 2 ? 6 : 0 }}
              />
              {linkSearch.length >= 2 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {linkCandidates.length === 0 ? (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: '4px 0' }}>No unlinked prospects match</div>
                  ) : linkCandidates.map(p => (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.82rem' }}>{p.firstName} {p.lastName}</div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{p.title}{p.companyName ? ` · ${p.companyName}` : ''}</div>
                      </div>
                      <button onClick={() => handleLink(p.id)} disabled={linking} style={{ fontSize: '0.75rem', padding: '3px 10px', flexShrink: 0 }}>
                        + Link
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Linked prospects */}
            {(account.prospects || []).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                No prospects linked yet. Search above to link contacts.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(account.prospects || []).map(p => {
                  const ph = p.phone || (typeof p.trackingPixelData === 'object' ? p.trackingPixelData?.phone : null);
                  return (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--grad-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.68rem', color: '#fff', flexShrink: 0 }}>
                        {`${p.firstName?.[0] || ''}${p.lastName?.[0] || ''}`.toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.855rem' }}>{p.firstName} {p.lastName}</div>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                          {p.title && <span>{p.title}</span>}
                          {p.email && <span style={{ fontFamily: 'monospace' }}>{p.email}</span>}
                          {ph && <span>{ph}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                          {p._count?.emailActivities || 0}✉ {p._count?.callActivities || 0}📞
                        </span>
                        <button onClick={() => handleUnlink(p.id)} className="ghost" style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: '2px 7px' }} title="Unlink prospect">
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '12px 24px', borderTop: '1px solid var(--border-color)', display: 'flex', gap: 10, flexShrink: 0, alignItems: 'center' }}>
        <button onClick={handleSave} disabled={saving} style={{ flex: 1, padding: '9px' }}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        {confirmDel ? (
          <>
            <span style={{ fontSize: '0.78rem', color: 'var(--status-danger)', fontWeight: 600 }}>Delete account?</span>
            <button onClick={handleDelete} disabled={deleting} className="danger" style={{ padding: '9px 14px', fontSize: '0.82rem' }}>
              {deleting ? '…' : 'Delete'}
            </button>
            <button onClick={() => setConfirmDel(false)} className="ghost" style={{ padding: '9px 12px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              Cancel
            </button>
          </>
        ) : (
          <button onClick={() => setConfirmDel(true)} className="ghost" style={{ padding: '9px 14px', fontSize: '0.82rem', color: 'var(--status-danger)' }}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
};

// ── Main Accounts page ────────────────────────────────────────────────────────

const Accounts = () => {
  const [accounts, setAccounts]         = useState([]);
  const [allProspects, setAllProspects] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [tierFilter, setTierFilter]     = useState('all');
  const [activeId, setActiveId]         = useState(null);
  const [creating, setCreating]         = useState(false);
  const [newName, setNewName]           = useState('');
  const [autoLinking, setAutoLinking]   = useState(false);
  const [importing, setImporting]       = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [editedMapping, setEditedMapping] = useState({});
  const [committing, setCommitting]     = useState(false);
  const fileInputRef = useRef(null);
  const toast = useToast();

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const res = await api.get('/accounts');
      setAccounts(res.data || []);
      if (!activeId && res.data?.length > 0) setActiveId(res.data[0].id);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
    api.get('/prospects').then(r => setAllProspects(r.data || [])).catch(() => {});
  }, []);

  // The list endpoint (GET /accounts) only includes _count.prospects,
  // not the prospects[] array — to keep the list response small. Whenever
  // the user selects an account, fetch the full detail (with prospects,
  // owners, and all scalars including researchSummary) and merge it back
  // into the cached list.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    api.get(`/accounts/${activeId}`)
      .then(r => {
        if (cancelled) return;
        setAccounts(prev => prev.map(a => a.id === r.data.id ? r.data : a));
      })
      .catch(() => { /* keep showing whatever's in the list cache */ });
    return () => { cancelled = true; };
  }, [activeId]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await api.post('/accounts', { name: newName.trim() });
      setAccounts(prev => [res.data, ...prev]);
      setActiveId(res.data.id);
      setNewName('');
      toast(`"${res.data.name}" created`, 'success', 2000);
    } catch (err) {
      toast(err.response?.data?.message || 'Failed to create', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post('/accounts/import-xlsx/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportPreview(res.data);
      setEditedMapping({ ...(res.data.proposedMapping || {}) });
    } catch (err) {
      toast(err.response?.data?.message || 'Preview failed', 'error', 4000);
      console.error(err);
    } finally {
      setImporting(false);
    }
  };

  const handleCommitImport = async () => {
    if (!importPreview?.uploadId) return;
    setCommitting(true);
    try {
      const res = await api.post('/accounts/import-xlsx/commit', {
        uploadId: importPreview.uploadId,
        mapping: editedMapping,
      });
      const d = res.data;
      toast(`Imported ${d.total} accounts (${d.created} new, ${d.updated} updated) from "${d.sheetName}"`, 'success', 4000);
      if (d.failures?.length) {
        toast(`${d.failures.length} row(s) failed — check console`, 'error', 5000);
        console.error('Import failures:', d.failures);
      }
      setImportPreview(null);
      setEditedMapping({});
      fetchAccounts();
    } catch (err) {
      toast(err.response?.data?.message || 'Import failed', 'error', 4000);
    } finally {
      setCommitting(false);
    }
  };

  const handleCancelImport = () => {
    setImportPreview(null);
    setEditedMapping({});
  };

  const handleAutoLink = async () => {
    setAutoLinking(true);
    try {
      const res = await api.post('/accounts/auto-link');
      fetchAccounts();
      toast(`${res.data.linked} prospect${res.data.linked !== 1 ? 's' : ''} auto-linked by company name`, 'success', 3000);
    } catch {
      toast('Auto-link failed', 'error');
    } finally {
      setAutoLinking(false);
    }
  };

  const handleSaved = (updated) => {
    setAccounts(prev => prev.map(a => a.id === updated.id ? { ...a, ...updated } : a));
    // Refresh full data for the active account
    api.get(`/accounts/${updated.id}`).then(r => {
      setAccounts(prev => prev.map(a => a.id === r.data.id ? r.data : a));
    }).catch(() => {});
  };

  const handleDeleted = (id) => {
    const remaining = accounts.filter(a => a.id !== id);
    setAccounts(remaining);
    setActiveId(remaining[0]?.id || null);
  };

  const filtered = accounts.filter(a => {
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    if (tierFilter !== 'all' && a.tier !== tierFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      (a.domain || '').toLowerCase().includes(q) ||
      (a.industry || '').toLowerCase().includes(q) ||
      parseTags(a.tags).some(t => t.includes(q))
    );
  });

  const activeAccount = accounts.find(a => a.id === activeId) || null;

  return (
    <div style={{ display: 'flex', height: '100%', gap: 0 }}>

      {/* LEFT: Account list */}
      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-color)', background: 'var(--bg-secondary)' }}>

        {/* Header */}
        <div style={{ padding: '16px 14px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Accounts</h3>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{accounts.length}</span>
          </div>

          {/* Search */}
          <div style={{ position: 'relative', marginBottom: 8 }}>
            <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '0.8rem', pointerEvents: 'none' }}>🔍</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search accounts…"
              style={{ paddingLeft: 26, width: '100%', boxSizing: 'border-box', fontSize: '0.8rem' }}
            />
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {['all', ...STATUSES].map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                style={{ fontSize: '0.65rem', padding: '2px 7px', borderRadius: 9999, fontWeight: statusFilter === s ? 700 : 500, background: statusFilter === s ? 'var(--accent-dim)' : 'var(--bg-primary)', color: statusFilter === s ? 'var(--accent-secondary)' : 'var(--text-muted)', border: `1px solid ${statusFilter === s ? 'var(--border-accent)' : 'var(--border-subtle)'}`, cursor: 'pointer', textTransform: 'capitalize' }}
              >
                {s === 'all' ? 'All' : s}
              </button>
            ))}
          </div>
        </div>

        {/* Create form + Excel import */}
        <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <form onSubmit={handleCreate} style={{ display: 'flex', gap: 6, padding: '8px 10px 6px' }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New account name…" style={{ flex: 1, fontSize: '0.8rem' }} />
            <button type="submit" disabled={creating || !newName.trim()} style={{ padding: '6px 10px', fontSize: '0.78rem' }}>+</button>
          </form>
          <div style={{ padding: '0 10px 8px' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              onChange={handleImport}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="ghost"
              style={{ width: '100%', fontSize: '0.74rem', padding: '6px 0', textAlign: 'center', color: 'var(--text-muted)' }}
              title="Upload the FY27 Account Tracker .xlsx — upserts by company name"
            >
              {importing ? 'Importing…' : '📥 Import Account Tracker (.xlsx)'}
            </button>
          </div>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 6px' }}>
          {loading ? (
            [1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 52, borderRadius: 'var(--radius-sm)', marginBottom: 5 }} />)
          ) : filtered.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
              {accounts.length === 0 ? 'No accounts yet. Create one above.' : 'No matches.'}
            </div>
          ) : filtered.map(acc => {
            const isSel = acc.id === activeId;
            const st = STATUS_STYLES[acc.status] || STATUS_STYLES.prospect;
            const ti = acc.tier ? TIER_STYLES[acc.tier] : null;
            return (
              <div
                key={acc.id}
                onClick={() => setActiveId(acc.id)}
                style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', marginBottom: 3, background: isSel ? 'var(--accent-dim)' : 'transparent', border: `1px solid ${isSel ? 'var(--border-accent)' : 'transparent'}`, transition: 'all var(--transition-fast)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)', background: 'var(--grad-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.62rem', color: '#fff', flexShrink: 0 }}>
                    {initials(acc.name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.84rem', color: isSel ? 'var(--accent-secondary)' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{acc.name}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                      <span>{acc._count?.prospects || 0} contacts</span>
                      {acc.industry && <span style={{ opacity: 0.7 }}>· {acc.industry}</span>}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9999, border: `1px solid ${st.border}`, background: st.bg, color: st.color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{acc.status}</span>
                  {ti && <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9999, border: `1px solid ${ti.border}`, background: ti.bg, color: ti.color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{acc.tier}</span>}
                  {acc.priorityTier && (() => {
                    const ps = PRIORITY_TIER_STYLES[acc.priorityTier] || { bg: 'var(--bg-tertiary)', color: 'var(--text-muted)', border: 'var(--border-subtle)' };
                    return <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9999, border: `1px solid ${ps.border}`, background: ps.bg, color: ps.color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{acc.priorityTier}</span>;
                  })()}
                  {acc.rep && <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginLeft: 2 }}>· {acc.rep}</span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Auto-link footer */}
        <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={handleAutoLink} disabled={autoLinking} className="ghost" style={{ width: '100%', fontSize: '0.72rem', color: 'var(--text-muted)', padding: '6px 0', textAlign: 'center' }}>
            {autoLinking ? 'Linking…' : '⚡ Auto-link prospects by company name'}
          </button>
        </div>
      </div>

      {/* RIGHT: Account detail */}
      <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRadius: 0, padding: 0, minWidth: 0, overflow: 'hidden' }}>
        <AccountDetail
          account={activeAccount}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          allProspects={allProspects}
        />
      </div>

      {/* Import mapping modal */}
      {importPreview && (
        <ImportMappingModal
          preview={importPreview}
          mapping={editedMapping}
          onChange={setEditedMapping}
          onConfirm={handleCommitImport}
          onCancel={handleCancelImport}
          committing={committing}
        />
      )}
    </div>
  );
};

// ── Import mapping modal ──────────────────────────────────────────────────────

const ImportMappingModal = ({ preview, mapping, onChange, onConfirm, onCancel, committing }) => {
  const { headers, sampleRows, accountFields, fieldDescriptions, sheetName, rowCount, mappingSource, mappingModel, mappingReasoning } = preview;
  const updateField = (header, value) => onChange({ ...mapping, [header]: value });

  const sampleForHeader = (h, idx) => {
    const samples = sampleRows.map(r => r[idx]).filter(v => v != null && v !== '');
    return samples[0];
  };

  const nameCount = Object.values(mapping).filter(v => v === 'name').length;
  const canImport = nameCount === 1 && !committing;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onCancel}>
      <div className="glass-card" onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', width: 'min(900px, 92vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Confirm column mapping</h3>
              <div style={{ marginTop: 4, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-secondary)' }}>{sheetName}</strong> · {rowCount} rows · {headers.length} columns
                <span style={{ marginLeft: 10, padding: '1px 8px', borderRadius: 9999, fontSize: '0.68rem', fontWeight: 700, background: mappingSource === 'ai' ? 'var(--accent-dim)' : 'var(--bg-tertiary)', color: mappingSource === 'ai' ? 'var(--accent-secondary)' : 'var(--text-muted)', border: `1px solid ${mappingSource === 'ai' ? 'var(--border-accent)' : 'var(--border-subtle)'}` }}>
                  {mappingSource === 'ai' ? `✦ AI mapped (${mappingModel})` : '⚙ Keyword fallback'}
                </span>
              </div>
              {mappingReasoning && (
                <div style={{ marginTop: 6, fontSize: '0.74rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>{mappingReasoning}</div>
              )}
            </div>
            <button onClick={onCancel} className="ghost" style={{ padding: '4px 10px', fontSize: '0.85rem' }}>✕</button>
          </div>
        </div>

        {/* Body — mapping table */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 22px' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
            Map each column to an Account field. Unmapped columns can go to <code>notes</code> (catch-all) or be skipped.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 1.2fr', gap: 0, border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
            {/* Table header */}
            <div style={{ padding: '8px 12px', background: 'var(--bg-tertiary)', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' }}>Spreadsheet column</div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-tertiary)', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' }}>Sample value</div>
            <div style={{ padding: '8px 12px', background: 'var(--bg-tertiary)', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' }}>Maps to</div>

            {headers.map((h, i) => {
              const sample = sampleForHeader(h, i);
              const current = mapping[h] || 'notes';
              const isName = current === 'name';
              const isSkipped = current === '_skip';
              return (
                <React.Fragment key={i}>
                  <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6, opacity: isSkipped ? 0.5 : 1 }}>
                    <span style={{ fontWeight: 600, fontSize: '0.84rem' }}>{h || <em style={{ color: 'var(--text-muted)' }}>(empty)</em>}</span>
                    {isName && <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9999, background: 'var(--accent-dim)', color: 'var(--accent-secondary)', border: '1px solid var(--border-accent)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Key</span>}
                  </div>
                  <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: isSkipped ? 0.5 : 1 }} title={String(sample ?? '')}>
                    {sample == null || sample === '' ? <em style={{ color: 'var(--text-muted)' }}>—</em> : String(sample).slice(0, 80)}
                  </div>
                  <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
                    <select
                      value={current}
                      onChange={e => updateField(h, e.target.value)}
                      style={{ width: '100%', fontSize: '0.8rem', padding: '5px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}
                    >
                      <option value="_skip">— Skip this column —</option>
                      <option value="notes">notes (catch-all)</option>
                      {accountFields.filter(f => f !== 'notes').map(f => (
                        <option key={f} value={f} title={fieldDescriptions?.[f] || ''}>{f}</option>
                      ))}
                    </select>
                  </div>
                </React.Fragment>
              );
            })}
          </div>

          {nameCount === 0 && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--status-danger-soft, rgba(239,68,68,0.1))', border: '1px solid var(--status-danger-border, rgba(239,68,68,0.3))', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem', color: 'var(--status-danger)' }}>
              ⚠ Map exactly one column to <code>name</code> — it's the upsert key.
            </div>
          )}
          {nameCount > 1 && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--status-warning-soft, rgba(234,179,8,0.1))', border: '1px solid var(--status-warning-border, rgba(234,179,8,0.3))', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem', color: 'var(--status-warning, #eab308)' }}>
              ⚠ Multiple columns mapped to <code>name</code>. Only one can be the key.
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--border-color)', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
          <div style={{ marginRight: 'auto', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
            {Object.values(mapping).filter(v => v && v !== '_skip').length} of {headers.length} columns will be imported
          </div>
          <button onClick={onCancel} className="ghost" style={{ padding: '8px 16px' }}>Cancel</button>
          <button onClick={onConfirm} disabled={!canImport} style={{ padding: '8px 18px', fontWeight: 600 }}>
            {committing ? 'Importing…' : `Import ${rowCount} accounts`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Accounts;
