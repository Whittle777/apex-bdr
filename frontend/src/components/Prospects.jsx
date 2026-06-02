import React, { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../services/api';
import { parseZoomInfoCsv } from '../utils/zoomInfoCsv';
import ProspectDetailDrawer from './ProspectDetailDrawer';
import { useToast } from './Toast';
import { PROSPECT_STATUS_STYLES } from '../constants';

const STATUS_STYLES = PROSPECT_STATUS_STYLES;

const StatusBadge = ({ status }) => {
  const s = STATUS_STYLES[status] || STATUS_STYLES['Uncontacted'];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '3px 9px',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      borderRadius: 'var(--radius-full)',
      fontSize: '0.7rem', fontWeight: 700,
      letterSpacing: '0.05em', textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {status || 'Uncontacted'}
    </span>
  );
};

// Computes a 0–100 engagement score from available prospect signals.
// Higher = more engaged / better ICP fit. Used like Outreach's "prospect score".
function computeEngagementScore(p) {
  let score = 0;
  if (p.email)                             score += 10;
  if (p.phone || p.trackingPixelData?.phone)          score += 10;
  if (p.enrichmentStatus === 'enriched')   score += 15;
  if (p.title)                             score += 5;
  if (p.companyName)                       score += 5;
  const statusBonus = { 'Meeting Booked': 25, 'Replied': 20, 'In Sequence': 10, 'Uncontacted': 5, 'Not Interested': 0 };
  score += statusBonus[p.status] ?? 5;
  score += Math.min((p._count?.sequenceEnrollments || 0) * 10, 20);
  return Math.min(score, 100);
}

const ScoreBadge = ({ score }) => {
  const color = score >= 70 ? 'var(--status-success)' : score >= 40 ? 'var(--status-warning)' : 'var(--status-danger)';
  const bg    = score >= 70 ? 'var(--status-success-dim)' : score >= 40 ? 'var(--status-warning-dim)' : 'var(--status-danger-dim)';
  const circumference = 2 * Math.PI * 8; // r=8
  const offset = circumference * (1 - score / 100);
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <svg width="24" height="24" viewBox="0 0 24 24" style={{ transform:'rotate(-90deg)', flexShrink:0 }}>
        <circle cx="12" cy="12" r="8" fill="none" stroke="var(--bg-tertiary)" strokeWidth="3" />
        <circle cx="12" cy="12" r="8" fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" style={{ transition:'stroke-dashoffset 0.4s ease' }} />
      </svg>
      <span style={{ fontSize:'0.78rem', fontWeight:700, color, minWidth:24 }}>{score}</span>
    </div>
  );
};

// Dot sized on a log scale so a single contact shows clearly and large volumes don't overflow
const dotSize = (n) => Math.max(6, Math.min(18, 6 + Math.log(n + 1) * 3.5));

const MiniContactTimeline = ({ p }) => {
  const emails   = p._count?.emailActivities   || 0;
  const calls    = p._count?.callActivities    || 0;
  const replies  = p._count?.replyActivities   || 0;
  const meetings = p._count?.meetingActivities || 0;

  const Dot = ({ n, color, label }) => n > 0 ? (
    <div title={`${n} ${label}`} style={{
      width: dotSize(n), height: dotSize(n), borderRadius: '50%',
      background: color, flexShrink: 0, opacity: 0.88,
      transition: 'transform 0.15s',
    }} />
  ) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 48 }}>
      {/* Outreach row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', width: 9, flexShrink: 0, textAlign: 'right' }}>↑</span>
        <Dot n={emails}   color="#0ea5e9" label={`email${emails !== 1 ? 's' : ''} sent`} />
        <Dot n={calls}    color="#22c55e" label={`call${calls !== 1 ? 's' : ''} made`} />
        <Dot n={meetings} color="#a855f7" label={`meeting${meetings !== 1 ? 's' : ''}`} />
        {!emails && !calls && !meetings && (
          <span style={{ fontSize: '0.65rem', color: 'var(--border-color)' }}>—</span>
        )}
      </div>
      {/* Inbound row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', width: 9, flexShrink: 0, textAlign: 'right' }}>↓</span>
        <Dot n={replies} color="#f59e0b" label={`repl${replies !== 1 ? 'ies' : 'y'} received`} />
        {!replies && (
          <span style={{ fontSize: '0.65rem', color: 'var(--border-color)' }}>—</span>
        )}
      </div>
    </div>
  );
};

const Prospects = () => {
  const location = useLocation();
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [quickFilter, setQuickFilter] = useState(null); // 'has_phone' | 'enriched' | null
  const [tagFilter, setTagFilter] = useState(null); // tag string | null
  const [companyFilter, setCompanyFilter] = useState(null); // company string | null
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectedProspect, setSelectedProspect] = useState(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', companyName: '' });
  const [sortField, setSortField] = useState('score'); // 'score' | 'name' | 'emails' | 'calls'
  const [sortDir, setSortDir] = useState('desc');
  const toast = useToast();

  const handleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
  };

  // Bulk upload states
  const [fileProcessing, setFileProcessing] = useState(false);
  const [uploadStats, setUploadStats] = useState(null);
  const fileInputRef = useRef(null);

  // Sequence enroll modal
  const [sequences, setSequences] = useState([]);
  const [showSeqModal, setShowSeqModal] = useState(false);
  const [enrollingSeqId, setEnrollingSeqId] = useState(null);
  const [enrollStatus, setEnrollStatus] = useState(null); // { type: 'success'|'error', msg }
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [confirmClearDemo, setConfirmClearDemo] = useState(false);
  const [clearingDemo, setClearingDemo] = useState(false);

  // Inline status editing
  const [editingStatusId, setEditingStatusId] = useState(null);

  // Call modal
  const [callModal, setCallModal] = useState(null);
  const [callPhase, setCallPhase] = useState('pre'); // 'pre' | 'disposition'
  const [callForm, setCallForm] = useState({ outcome: 'connected', durationSecs: '', notes: '' });
  const [callEnrollment, setCallEnrollment] = useState(null);
  const [callLogging, setCallLogging] = useState(false);

  const openCallModal = async (e, prospect) => {
    e.stopPropagation();
    setCallModal(prospect);
    setCallPhase('pre');
    setCallForm({ outcome: 'connected', durationSecs: '', notes: '' });
    setCallEnrollment(null);
    try {
      const res = await api.get(`/sequences/enrollments/prospect/${prospect.id}`);
      const active = (res.data || []).find(enr => enr.status === 'active');
      setCallEnrollment(active || null);
    } catch { /* ignore */ }
  };

  const handleLogCall = async () => {
    if (!callModal) return;
    setCallLogging(true);
    try {
      const payload = {
        prospectId: callModal.id,
        status: 'completed',
        outcome: callForm.outcome,
        durationSecs: callForm.durationSecs ? parseInt(callForm.durationSecs) : null,
        notes: callForm.notes || null,
      };
      if (callEnrollment) {
        payload.enrollmentId = callEnrollment.id;
        const steps = callEnrollment.sequence?.steps || [];
        const nextStep = steps.find(s =>
          callEnrollment.currentStepOrder === 0 ? s.order === 1 : s.order > callEnrollment.currentStepOrder
        );
        if (nextStep && nextStep.stepType === 'CALL') {
          payload.sequenceStepId = nextStep.id;
          payload.stepOrder = nextStep.order;
        }
      }
      await api.post('/call-activities', payload);
      toast(`Call logged — ${callForm.outcome.replace(/_/g, ' ')}`, 'success');
      setCallModal(null);
      fetchProspects();
    } catch {
      toast('Failed to log call', 'error');
    } finally {
      setCallLogging(false);
    }
  };

  const fetchProspects = async () => {
    setLoading(true);
    try {
      const res = await api.get('/prospects');
      setProspects(res.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProspects();
    api.get('/sequences').then(r => setSequences(r.data || [])).catch(() => {});
  }, []);

  // Auto-open drawer if navigated here from command palette with a prospect id
  const openProspectId = location.state?.openProspectId;
  useEffect(() => {
    if (openProspectId && prospects.length > 0) {
      const p = prospects.find(pr => pr.id === openProspectId);
      if (p) setSelectedProspect(p);
    }
  }, [prospects, openProspectId]);

  const createProspect = async (e) => {
    e.preventDefault();
    try {
      await api.post('/prospects', form);
      const name = `${form.firstName} ${form.lastName}`.trim();
      setForm({ firstName: '', lastName: '', email: '', companyName: '' });
      fetchProspects();
      toast(`${name || 'Prospect'} added`, 'success', 2200);
    } catch (err) {
      console.error(err);
      toast('Failed to add prospect', 'error');
    }
  };

  const removeProspect = async (id) => {
    try {
      await api.delete(`/prospects/${id}`);
      fetchProspects();
      toast('Prospect removed', 'info', 2000);
    } catch (err) {
      console.error(err);
      toast('Failed to remove prospect', 'error');
    }
  };

  const handleSelectAll = (e) => {
    if (e.target.checked) setSelectedIds(new Set(filteredProspects.map(p => p.id)));
    else setSelectedIds(new Set());
  };

  const handleSelectOne = (id) => {
    const s = new Set(selectedIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedIds(s);
  };

  const handleBulkDelete = async () => {
    setConfirmBulkDelete(false);
    const count = selectedIds.size;
    try {
      await Promise.all(Array.from(selectedIds).map(id => api.delete(`/prospects/${id}`)));
      setSelectedIds(new Set());
      fetchProspects();
      toast(`Deleted ${count} prospect${count !== 1 ? 's' : ''}`, 'success');
    } catch (err) {
      console.error('Bulk delete failed', err);
      toast('Delete failed — please try again', 'error');
    }
  };

  const handleBulkOptOut = async () => {
    const count = selectedIds.size;
    try {
      await Promise.all(Array.from(selectedIds).map(id => api.put(`/prospects/${id}`, { status: 'Not Interested' })));
      setSelectedIds(new Set());
      fetchProspects();
      toast(`Marked ${count} prospect${count !== 1 ? 's' : ''} as Not Interested`, 'info');
    } catch (err) {
      console.error('Bulk opt out failed', err);
      toast('Opt-out failed — please try again', 'error');
    }
  };

  const handleBulkEnrollToSequence = async (seqId) => {
    if (!seqId) return;
    setEnrollingSeqId(seqId);
    setEnrollStatus(null);
    const count = selectedIds.size;
    try {
      await api.post(`/sequences/${seqId}/enroll`, { prospectIds: [...selectedIds] });
      const seq = sequences.find(s => s.id === seqId);
      setSelectedIds(new Set());
      fetchProspects();
      setShowSeqModal(false);
      toast(`${count} prospect${count !== 1 ? 's' : ''} enrolled in "${seq?.name}"`, 'success');
    } catch (err) {
      setEnrollStatus({ type: 'error', msg: err.response?.data?.message || 'Enrollment failed' });
      toast('Enrollment failed — please try again', 'error');
    } finally {
      setEnrollingSeqId(null);
    }
  };

  const handleChangeStatus = async (prospectId, newStatus) => {
    try {
      await api.put(`/prospects/${prospectId}`, { status: newStatus });
      fetchProspects();
      toast(`Status updated to "${newStatus}"`, 'success', 2000);
    } catch (err) {
      console.error('Status update failed', err);
      toast('Failed to update status', 'error');
    }
    setEditingStatusId(null);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileProcessing(true);
    setUploadStats(null);

    try {
      const mappedProspects = await parseZoomInfoCsv(file);
      if (mappedProspects.length === 0) {
        setUploadStats({ error: 'No valid prospects found. Check CSV column headers.' });
        setFileProcessing(false);
        return;
      }
      const res = await api.post('/prospects/bulk', { prospects: mappedProspects });
      const added = res.data?.count ?? mappedProspects.length;
      const accountsCreated = res.data?.accountsCreated ?? 0;
      const skipped = mappedProspects.length - added;
      const parts = [];
      if (added > 0) parts.push(`${added} prospect${added !== 1 ? 's' : ''} imported`);
      if (skipped > 0) parts.push(`${skipped} skipped (already exist)`);
      if (accountsCreated > 0) parts.push(`${accountsCreated} account${accountsCreated !== 1 ? 's' : ''} created`);
      const msg = parts.join(' · ');
      setUploadStats({ success: msg });
      fetchProspects();
      toast(msg, 'success');
    } catch (err) {
      setUploadStats({ error: err.response?.data?.message || err.message || 'Failed to parse CSV file.' });
      toast('Import failed — check CSV format', 'error');
    } finally {
      setFileProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClearDemoData = async () => {
    setClearingDemo(true);
    try {
      await api.delete('/prospects/demo-reset');
      await fetchProspects();
      setConfirmClearDemo(false);
      toast('Demo data cleared — ready for real prospects', 'success');
    } catch (err) {
      toast(err.response?.data?.message || 'Failed to clear demo data', 'error');
    } finally {
      setClearingDemo(false);
    }
  };

  // Parse tags JSON helper
  const parseTags = (p) => {
    try { return JSON.parse(p.tags || '[]'); } catch { return []; }
  };

  // All unique tags across all prospects
  const allTags = [...new Set(prospects.flatMap(parseTags))].sort();

  const filteredProspects = prospects.filter(p => {
    if (statusFilter !== 'all' && (p.status || 'Uncontacted') !== statusFilter) return false;
    if (quickFilter === 'has_phone' && !(p.phone || p.trackingPixelData?.phone)) return false;
    if (quickFilter === 'enriched' && p.enrichmentStatus !== 'enriched') return false;
    if (tagFilter && !parseTags(p).includes(tagFilter)) return false;
    if (companyFilter && (p.companyName || '').toLowerCase() !== companyFilter.toLowerCase()) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const phone = (p.phone || p.trackingPixelData?.phone || '').replace(/\D/g, '');
    const qDigits = q.replace(/\D/g, '');
    return (
      `${p.firstName} ${p.lastName}`.toLowerCase().includes(q) ||
      (p.companyName || '').toLowerCase().includes(q) ||
      (p.email || '').toLowerCase().includes(q) ||
      (p.title || '').toLowerCase().includes(q) ||
      (p.region || '').toLowerCase().includes(q) ||
      (p.country || '').toLowerCase().includes(q) ||
      (p.techStack || '').toLowerCase().includes(q) ||
      (p.notes || '').toLowerCase().includes(q) ||
      parseTags(p).some(t => t.toLowerCase().includes(q)) ||
      (qDigits.length >= 4 && phone.includes(qDigits))
    );
  }).sort((a, b) => {
    let aVal, bVal;
    if (sortField === 'score')  { aVal = computeEngagementScore(a); bVal = computeEngagementScore(b); }
    else if (sortField === 'name')   { aVal = `${a.firstName} ${a.lastName}`.toLowerCase(); bVal = `${b.firstName} ${b.lastName}`.toLowerCase(); }
    else if (sortField === 'enrollments') { aVal = a._count?.sequenceEnrollments || 0; bVal = b._count?.sequenceEnrollments || 0; }
    else return 0;
    if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const STATUS_FILTERS = [
    { key: 'all',            label: 'All' },
    { key: 'Uncontacted',    label: 'Uncontacted' },
    { key: 'In Sequence',    label: 'In Sequence' },
    { key: 'Replied',        label: 'Replied' },
    { key: 'Meeting Booked', label: 'Meeting Booked' },
    { key: 'Not Interested', label: 'Not Interested' },
  ];

  const QUICK_FILTERS = [
    { key: 'has_phone', label: 'Has Phone' },
    { key: 'enriched',  label: 'Enriched' },
  ];

  const activeFilterCount =
    (statusFilter !== 'all' ? 1 : 0) +
    (quickFilter ? 1 : 0) +
    (tagFilter ? 1 : 0) +
    (companyFilter ? 1 : 0) +
    (searchQuery ? 1 : 0);

  const clearAllFilters = () => {
    setStatusFilter('all');
    setQuickFilter(null);
    setTagFilter(null);
    setCompanyFilter(null);
    setSearchQuery('');
  };

  const allSelected = filteredProspects.length > 0 && selectedIds.size === filteredProspects.length;
  const isFiltered = filteredProspects.length < prospects.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 style={{ marginBottom: 2 }}>Prospects</h1>
          <p className="page-header-meta" style={{ margin: 0 }}>
            {loading ? 'Loading…' : `${filteredProspects.length.toLocaleString()} of ${prospects.length.toLocaleString()} contacts`}
            {isFiltered && <span style={{ color: 'var(--accent-secondary)' }}> · filtered</span>}
          </p>
        </div>
        <div className="page-header-actions">
          {/* Search */}
          <div style={{ position: 'relative', flex: '1 1 auto', minWidth: 160, maxWidth: 340 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '0.85rem', pointerEvents: 'none' }}>🔍</span>
            <input
              type="text"
              placeholder="Name, company, title, email, phone, tag…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ paddingLeft: 30, width: '100%', boxSizing: 'border-box' }}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1, padding: 2 }}>✕</button>
            )}
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Row 1: Status + quick attribute filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {STATUS_FILTERS.map(f => (
            <button
              key={f.key}
              className={`filter-chip${statusFilter === f.key ? ' active' : ''}`}
              onClick={() => setStatusFilter(f.key)}
            >
              {f.label}
              {f.key !== 'all' && (
                <span className="count-pill" style={{ marginLeft: 5 }}>
                  {prospects.filter(p => (p.status || 'Uncontacted') === f.key).length}
                </span>
              )}
            </button>
          ))}

          <div style={{ width: 1, height: 16, background: 'var(--border-subtle)', margin: '0 2px' }} />

          {QUICK_FILTERS.map(f => (
            <button
              key={f.key}
              className={`filter-chip${quickFilter === f.key ? ' active' : ''}`}
              onClick={() => setQuickFilter(prev => prev === f.key ? null : f.key)}
            >
              {f.key === 'has_phone' ? '📞 ' : '✦ '}{f.label}
              <span className="count-pill" style={{ marginLeft: 5 }}>
                {f.key === 'has_phone'
                  ? prospects.filter(p => p.phone || p.trackingPixelData?.phone).length
                  : prospects.filter(p => p.enrichmentStatus === 'enriched').length}
              </span>
            </button>
          ))}

          {/* Active filter pills */}
          {companyFilter && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', background: 'var(--status-info-dim)', border: '1px solid var(--status-info-border)', borderRadius: 'var(--radius-full)', fontSize: '0.72rem', color: 'var(--status-info)', fontWeight: 600 }}>
              🏢 {companyFilter}
              <button onClick={() => setCompanyFilter(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1, fontSize: '0.75rem' }}>✕</button>
            </span>
          )}
          {tagFilter && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-full)', fontSize: '0.72rem', color: 'var(--accent-secondary)', fontWeight: 600 }}>
              # {tagFilter}
              <button onClick={() => setTagFilter(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1, fontSize: '0.75rem' }}>✕</button>
            </span>
          )}

          {activeFilterCount > 0 && (
            <button className="ghost" style={{ fontSize: '0.74rem', color: 'var(--text-muted)', padding: '4px 8px', marginLeft: 2 }} onClick={clearAllFilters}>
              ✕ Clear all
            </button>
          )}
        </div>

        {/* Row 2: Tag chips (only shown if any tags exist) */}
        {allTags.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginRight: 2 }}>Tags</span>
            {allTags.map(tag => (
              <button
                key={tag}
                onClick={() => setTagFilter(prev => prev === tag ? null : tag)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', fontSize: '0.72rem', fontWeight: tagFilter === tag ? 700 : 500,
                  background: tagFilter === tag ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                  color: tagFilter === tag ? 'var(--accent-secondary)' : 'var(--text-secondary)',
                  border: `1px solid ${tagFilter === tag ? 'var(--border-accent)' : 'var(--border-color)'}`,
                  borderRadius: 'var(--radius-full)', cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
              >
                # {tag}
                <span style={{ opacity: 0.6, fontSize: '0.65rem' }}>
                  {prospects.filter(p => parseTags(p).includes(tag)).length}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Import + Add row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {/* Bulk Import */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px' }}>
          <div>
            <h3 style={{ marginBottom: 2, fontSize: '0.92rem' }}>Bulk Import</h3>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              Upload a ZoomInfo CSV. Columns mapped automatically — including phone &amp; LinkedIn.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <input
              type="file"
              accept=".csv"
              ref={fileInputRef}
              onChange={handleFileUpload}
              style={{ display: 'none' }}
              id="csv-upload"
            />
            <label htmlFor="csv-upload" className={`btn-upload${fileProcessing ? ' uploading' : ''}`}>
              {fileProcessing ? '⏳ Processing…' : '↑ Upload CSV'}
            </label>
            {uploadStats?.success && (
              <span style={{ fontSize: '0.82rem', color: 'var(--status-success)' }}>✓ {uploadStats.success}</span>
            )}
            {uploadStats?.error && (
              <span style={{ fontSize: '0.82rem', color: 'var(--status-danger)' }}>✕ {uploadStats.error}</span>
            )}
          </div>
          {/* Clear demo data */}
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8, marginTop: 2 }}>
            {confirmClearDemo ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Delete ALL prospects? This cannot be undone.</span>
                <button
                  onClick={handleClearDemoData}
                  disabled={clearingDemo}
                  style={{ fontSize: '0.75rem', padding: '3px 10px', background: 'var(--status-danger)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                >
                  {clearingDemo ? 'Clearing…' : 'Yes, clear all'}
                </button>
                <button
                  onClick={() => setConfirmClearDemo(false)}
                  style={{ fontSize: '0.75rem', padding: '3px 10px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', borderRadius: 4, cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmClearDemo(true)}
                style={{ fontSize: '0.75rem', color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Clear all prospects (switch out of demo)
              </button>
            )}
          </div>
        </div>

        {/* Single create */}
        <div className="glass-card" style={{ padding: '14px 16px' }}>
          <h3 style={{ marginBottom: 10, fontSize: '0.92rem' }}>Add Prospect</h3>
          <form onSubmit={createProspect} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <input style={{ flex: 1 }} placeholder="First name" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              <input style={{ flex: 1 }} placeholder="Last name" required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
            </div>
            <input type="email" placeholder="Email address" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input placeholder="Company" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
            <button type="submit" style={{ alignSelf: 'flex-start', marginTop: 2 }}>Add Prospect</button>
          </form>
        </div>
      </div>

      {/* Prospects table */}
      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>
            {isFiltered ? 'Filtered Results' : 'All Prospects'}
          </h3>
          {/* Select-all results bar — shown whenever filtered/searched */}
          {!loading && isFiltered && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {filteredProspects.length} match{filteredProspects.length !== 1 ? 'es' : ''}
              </span>
              {selectedIds.size < filteredProspects.length ? (
                <button
                  className="ghost"
                  style={{ fontSize: '0.78rem', padding: '3px 10px', color: 'var(--accent-secondary)', fontWeight: 600, border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-full)' }}
                  onClick={() => setSelectedIds(new Set(filteredProspects.map(p => p.id)))}
                >
                  Select all {filteredProspects.length}
                </button>
              ) : (
                <button
                  className="ghost"
                  style={{ fontSize: '0.78rem', padding: '3px 10px', color: 'var(--text-muted)', borderRadius: 'var(--radius-full)' }}
                  onClick={() => setSelectedIds(new Set())}
                >
                  Deselect all
                </button>
              )}
            </div>
          )}
          {selectedIds.size > 0 && (
            <span style={{ fontSize: '0.82rem', color: 'var(--accent-secondary)', fontWeight: 600, background: 'var(--accent-dim)', padding: '2px 10px', borderRadius: 'var(--radius-full)' }}>
              {selectedIds.size} selected
            </span>
          )}
        </div>

        {loading ? (
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[1,2,3,4,5].map(i => (
              <div key={i} className="skeleton" style={{ height: 52, borderRadius: 'var(--radius-sm)' }} />
            ))}
          </div>
        ) : prospects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">👥</div>
            <h4>No prospects yet</h4>
            <p>Add a single prospect or bulk upload a CSV to get started.</p>
          </div>
        ) : filteredProspects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔍</div>
            <h4>No matches</h4>
            <p>No prospects match your current filters or search query.</p>
            <button
              className="secondary"
              style={{ marginTop: 8, fontSize: '0.82rem' }}
              onClick={clearAllFilters}
            >
              Clear all filters
            </button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th style={{ width: 44, paddingLeft: 20 }}>
                    <input type="checkbox" onChange={handleSelectAll} checked={allSelected} />
                  </th>
                  <th onClick={() => handleSort('name')} style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }}>
                    Prospect {sortField === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : <span style={{ opacity:0.3 }}>↕</span>}
                  </th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th onClick={() => handleSort('score')} style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }} title="Engagement score: 70+ = High (green) · 40–69 = Medium (amber) · under 40 = Low (red). Based on profile completeness, status, and email/call activity. Click to sort.">
                    Engagement {sortField === 'score' ? (sortDir === 'asc' ? '↑' : '↓') : <span style={{ opacity:0.3 }}>↕</span>}
                    <span style={{ marginLeft: 4, fontSize: '0.65rem', opacity: 0.45, fontWeight: 400 }}>ⓘ</span>
                  </th>
                  <th>Activity</th>
                  <th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {filteredProspects.map(p => {
                  const initials = `${p.firstName?.[0] || ''}${p.lastName?.[0] || ''}`.toUpperCase();
                  return (
                    <tr
                      key={p.id}
                      onClick={() => setSelectedProspect(p)}
                      className={selectedIds.has(p.id) ? 'row-selected' : ''}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ paddingLeft: 20, width: 44 }} onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => handleSelectOne(p.id)} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{
                            width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                            background: 'var(--grad-brand)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.62rem', fontWeight: 800, color: '#fff',
                          }}>
                            {initials}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{p.firstName} {p.lastName}</div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                              {p.title && <span>{p.title}</span>}
                              {p.title && p.companyName && <span style={{ opacity: 0.5 }}> · </span>}
                              {p.companyName && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setCompanyFilter(p.companyName); }}
                                  title={`Filter to all ${p.companyName} prospects`}
                                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 'inherit', color: companyFilter === p.companyName ? 'var(--accent-secondary)' : 'var(--text-secondary)', fontWeight: companyFilter === p.companyName ? 700 : 'inherit', textDecoration: 'none' }}
                                >
                                  {p.companyName}
                                </button>
                              )}
                              {!p.title && !p.companyName && '—'}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 1 }}>{p.email}</div>
                            {parseTags(p).length > 0 && (
                              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                                {parseTags(p).map(tag => (
                                  <button
                                    key={tag}
                                    onClick={(e) => { e.stopPropagation(); setTagFilter(prev => prev === tag ? null : tag); }}
                                    style={{
                                      background: tagFilter === tag ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                                      color: tagFilter === tag ? 'var(--accent-secondary)' : 'var(--text-muted)',
                                      border: `1px solid ${tagFilter === tag ? 'var(--border-accent)' : 'var(--border-subtle)'}`,
                                      borderRadius: 'var(--radius-full)', fontSize: '0.62rem', fontWeight: 600,
                                      padding: '1px 6px', cursor: 'pointer',
                                    }}
                                  >
                                    #{tag}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{(() => {
                        const ph = p.phone || p.trackingPixelData?.phone;
                        return ph ? (
                          <button
                            onClick={(e) => openCallModal(e, p)}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.78rem', color: 'var(--accent-light)', fontFamily: 'monospace', textDecoration: 'underline', textDecorationStyle: 'dotted', whiteSpace: 'nowrap' }}
                          >{ph}</button>
                        ) : <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</span>;
                      })()}</td>
                      <td onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
                        {editingStatusId === p.id ? (
                          <select
                            autoFocus
                            value={p.status || 'Uncontacted'}
                            onChange={(e) => handleChangeStatus(p.id, e.target.value)}
                            onBlur={() => setEditingStatusId(null)}
                            style={{ fontSize: '0.78rem', padding: '3px 6px', minWidth: 130 }}
                          >
                            {Object.keys(STATUS_STYLES).map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        ) : (
                          <div
                            title="Click to change status"
                            onClick={() => setEditingStatusId(p.id)}
                            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            <StatusBadge status={p.status} />
                            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', opacity: 0.6 }}>▼</span>
                          </div>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <ScoreBadge score={computeEngagementScore(p)} />
                      </td>
                      <td><MiniContactTimeline p={p} /></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          className="ghost"
                          style={{ fontSize: '0.78rem', color: 'var(--status-danger)', padding: '4px 10px' }}
                          onClick={() => removeProspect(p.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Floating bulk actions */}
      {selectedIds.size > 0 && (
        <div className="floating-toolbar">
          <span style={{ fontWeight: 600, fontSize: '0.855rem', color: 'var(--accent-secondary)' }}>
            {selectedIds.size} selected
          </span>
          <div style={{ width: 1, height: 20, background: 'var(--border-color)' }} />
          <button className="ghost" style={{ fontSize: '0.82rem' }} onClick={() => { setShowSeqModal(true); setEnrollStatus(null); }}>+ Sequence</button>
          <button className="ghost" style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }} onClick={handleBulkOptOut}>Opt Out</button>
          {confirmBulkDelete ? (
            <>
              <span style={{ fontSize: '0.78rem', color: 'var(--status-danger)', fontWeight: 600 }}>Delete {selectedIds.size}?</span>
              <button className="danger" style={{ fontSize: '0.78rem', padding: '3px 10px' }} onClick={handleBulkDelete}>Confirm</button>
              <button className="ghost" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }} onClick={() => setConfirmBulkDelete(false)}>Cancel</button>
            </>
          ) : (
            <button className="danger" style={{ fontSize: '0.82rem' }} onClick={() => setConfirmBulkDelete(true)}>Delete</button>
          )}
          <button className="ghost" style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }} onClick={() => { setSelectedIds(new Set()); setConfirmBulkDelete(false); }}>✕</button>
        </div>
      )}

      <ProspectDetailDrawer
        isOpen={!!selectedProspect}
        prospect={selectedProspect}
        onClose={() => setSelectedProspect(null)}
        onSave={fetchProspects}
      />

      {/* Sequence enrollment modal */}
      {showSeqModal && (
        <div
          onClick={() => setShowSeqModal(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="glass-card"
            style={{ width: 'min(380px, calc(100vw - 40px))', padding: 0, overflow: 'hidden' }}
          >
            {/* Header */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: 0 }}>Enroll in Sequence</h3>
                <p style={{ margin: '3px 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {selectedIds.size} prospect{selectedIds.size > 1 ? 's' : ''} selected
                </p>
              </div>
              <button className="ghost" style={{ padding: '4px 8px', color: 'var(--text-muted)' }} onClick={() => setShowSeqModal(false)}>✕</button>
            </div>

            {/* Sequence list */}
            <div style={{ maxHeight: 320, overflowY: 'auto', padding: '10px 12px' }}>
              {sequences.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem', padding: '20px 0' }}>No sequences yet. Create one in the Sequences view.</p>
              ) : (
                sequences.map(seq => {
                  const enrolled = seq.prospectEnrollments?.length || 0;
                  const isLoading = enrollingSeqId === seq.id;
                  return (
                    <button
                      key={seq.id}
                      onClick={() => handleBulkEnrollToSequence(seq.id)}
                      disabled={!!enrollingSeqId}
                      className="ghost"
                      style={{
                        width: '100%', textAlign: 'left', padding: '10px 12px',
                        borderRadius: 'var(--radius-sm)', marginBottom: 4,
                        border: '1px solid var(--border-color)',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        opacity: enrollingSeqId && !isLoading ? 0.5 : 1,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{seq.name}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                          {(seq._count?.sequenceSteps ?? 0)} steps · {enrolled} enrolled
                        </div>
                      </div>
                      {isLoading ? (
                        <span style={{ fontSize: '0.8rem', color: 'var(--accent-secondary)' }}>Enrolling…</span>
                      ) : (
                        <span style={{ fontSize: '0.8rem', color: 'var(--accent-secondary)', fontWeight: 600 }}>Enroll →</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Status feedback */}
            {enrollStatus && (
              <div style={{
                padding: '10px 20px',
                borderTop: '1px solid var(--border-color)',
                fontSize: '0.82rem',
                color: enrollStatus.type === 'success' ? 'var(--status-success)' : 'var(--status-danger)',
                fontWeight: 600,
              }}>
                {enrollStatus.type === 'success' ? '✓ ' : '✕ '}{enrollStatus.msg}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Call Modal ─────────────────────────────────────────────────── */}
      {callModal && (() => {
        const ph = callModal.phone || callModal.trackingPixelData?.phone || '';
        return (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)' }}
            onClick={() => setCallModal(null)}
          >
            <div className="glass-card" style={{ width: 'min(400px, calc(100vw - 40px))', padding: '28px 28px 24px', borderRadius: 'var(--radius-lg)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem' }}>{callModal.firstName} {callModal.lastName}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                    {[callModal.title, callModal.companyName].filter(Boolean).join(' · ') || 'No title'}
                  </div>
                  {callEnrollment && (
                    <div style={{ marginTop: 7, fontSize: '0.72rem', color: 'var(--accent-secondary)', background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      ⚡ {callEnrollment.sequence?.name}
                    </div>
                  )}
                </div>
                <button className="ghost" onClick={() => setCallModal(null)} style={{ fontSize: '1.1rem', padding: '0 4px', lineHeight: 1, opacity: 0.6 }}>✕</button>
              </div>

              {/* Phone number */}
              <div style={{ textAlign: 'center', padding: '16px 0 20px', borderTop: '1px solid var(--border-color)', borderBottom: callPhase === 'pre' ? 'none' : '1px solid var(--border-color)', marginBottom: callPhase === 'pre' ? 0 : 18 }}>
                <div style={{ fontSize: '1.35rem', fontWeight: 700, fontFamily: 'monospace', letterSpacing: 2, marginBottom: 14 }}>{ph}</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <a
                    href={`tel:${ph.replace(/\D/g,'')}`}
                    onClick={() => setTimeout(() => setCallPhase('disposition'), 1500)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 18px', background: 'var(--status-success)', color: '#fff', borderRadius: 'var(--radius-sm)', textDecoration: 'none', fontSize: '0.85rem', fontWeight: 700 }}
                  >
                    📞 Call
                  </a>
                  {callPhase === 'pre' && (
                    <button className="ghost" style={{ padding: '8px 14px', fontSize: '0.82rem' }}
                      onClick={() => setCallPhase('disposition')}>
                      Log Disposition →
                    </button>
                  )}
                </div>
              </div>

              {/* Disposition form */}
              {callPhase === 'disposition' && (
                <div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Call Outcome</div>
                  <select
                    value={callForm.outcome}
                    onChange={e => setCallForm(f => ({ ...f, outcome: e.target.value }))}
                    style={{ width: '100%', marginBottom: 8, fontSize: '0.85rem', padding: '8px 10px' }}
                  >
                    <option value="connected">Connected</option>
                    <option value="voicemail">Voicemail</option>
                    <option value="no_answer">No Answer</option>
                    <option value="left_message">Left Message</option>
                  </select>
                  <input
                    type="number" min="0" placeholder="Duration (seconds)"
                    value={callForm.durationSecs}
                    onChange={e => setCallForm(f => ({ ...f, durationSecs: e.target.value }))}
                    style={{ width: '100%', marginBottom: 8, fontSize: '0.85rem', padding: '8px 10px', boxSizing: 'border-box' }}
                  />
                  <input
                    type="text" placeholder="Notes (optional)"
                    value={callForm.notes}
                    onChange={e => setCallForm(f => ({ ...f, notes: e.target.value }))}
                    style={{ width: '100%', marginBottom: 14, fontSize: '0.85rem', padding: '8px 10px', boxSizing: 'border-box' }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      disabled={callLogging}
                      onClick={handleLogCall}
                      style={{ flex: 1, padding: '9px', fontSize: '0.88rem', fontWeight: 700, background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', opacity: callLogging ? 0.6 : 1 }}
                    >
                      {callLogging ? 'Saving…' : 'Save Call'}
                    </button>
                    <button className="ghost" style={{ padding: '9px 14px', fontSize: '0.85rem' }} onClick={() => setCallModal(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default Prospects;
