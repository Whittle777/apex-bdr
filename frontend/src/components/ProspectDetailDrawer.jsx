import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { useToast } from './Toast';
import { ENROLLMENT_STATUS_STYLES } from '../constants';

// ── Contact Timeline ──────────────────────────────────────────────────────────

const LANE_COLORS = {
  email:   '#0ea5e9',
  call:    '#22c55e',
  meeting: '#a855f7',
  reply:   '#f59e0b',
  unsub:   '#ef4444',
};

const dotR = (type, item) => {
  if (type === 'meeting') return 9;
  if (type === 'reply') return item.classification === 'genuine_reply' ? 8 : 6;
  if (type === 'email' && item.status === 'opened') return 7;
  if (type === 'call' && item.outcome === 'connected') return 7;
  return 5;
};

const dotColor = (type, item) => {
  if (type === 'reply' && item.classification === 'unsubscribe') return LANE_COLORS.unsub;
  return LANE_COLORS[type] || '#64748b';
};

const dotLabel = (type, item) => {
  const d = new Date(item.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (type === 'email')   return `Email ${item.status || ''}${item.subject ? ' · ' + item.subject : ''} — ${d}`;
  if (type === 'call')    return `Call ${item.outcome || item.status || ''}${item.durationSecs ? ' · ' + Math.round(item.durationSecs / 60) + 'm' : ''} — ${d}`;
  if (type === 'meeting') return `Meeting${item.title && item.title !== 'Meeting' ? ' · ' + item.title : ''}${item.outcome ? ' · ' + item.outcome : ''} — ${d}`;
  if (type === 'reply')   return `Reply (${item.classification || 'unknown'})${item.subject ? ' · ' + item.subject : ''} — ${d}`;
  return d;
};

const isOutreach = (type, item) => type === 'email' || type === 'meeting' || (type === 'call' && item.outcome !== 'connected');
const isResponse = (type, item) => type === 'reply' || (type === 'call' && item.outcome === 'connected');

const TimelineLane = ({ items, label, emptyMsg }) => {
  const [hovered, setHovered] = useState(null);

  if (items.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', width: 60, flexShrink: 0, textAlign: 'right' }}>{label}</span>
        <div style={{ flex: 1, height: 2, background: 'var(--border-subtle)', borderRadius: 1 }} />
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>{emptyMsg}</span>
      </div>
    );
  }

  const dates = items.map(it => new Date(it.date).getTime()).filter(Boolean);
  const minT = Math.min(...dates);
  const maxT = Math.max(...dates, Date.now());
  const span = maxT - minT || 1;

  const pct = (t) => Math.max(0, Math.min(100, ((t - minT) / span) * 100));

  const startLabel = new Date(minT).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const endLabel   = new Date(maxT).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', width: 60, flexShrink: 0, textAlign: 'right' }}>{label}</span>
      <div style={{ flex: 1, position: 'relative', height: 24, display: 'flex', alignItems: 'center' }}>
        {/* axis */}
        <div style={{ position: 'absolute', left: 0, right: 0, height: 2, background: 'var(--border-subtle)', borderRadius: 1 }} />
        {/* dots */}
        {items.map((item, i) => {
          const t = new Date(item.date).getTime();
          const x = pct(t);
          const r = dotR(item.type, item);
          const c = dotColor(item.type, item);
          const isHov = hovered === i;
          return (
            <div
              key={i}
              title={dotLabel(item.type, item)}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              style={{
                position: 'absolute',
                left: `${x}%`,
                transform: 'translate(-50%, 0)',
                width: r * 2,
                height: r * 2,
                borderRadius: '50%',
                background: c,
                opacity: isHov ? 1 : 0.82,
                boxShadow: isHov ? `0 0 0 3px ${c}44, 0 0 8px ${c}88` : 'none',
                cursor: 'default',
                transition: 'box-shadow 0.12s, opacity 0.12s',
                zIndex: isHov ? 10 : 1,
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{startLabel} – {endLabel}</span>
    </div>
  );
};

const ContactTimeline = ({ prospectId }) => {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!prospectId) return;
    setLoading(true);
    api.get(`/prospects/${prospectId}/activity-timeline`)
      .then(r => setItems(r.data || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [prospectId]);

  const outreach = items.filter(it => isOutreach(it.type, it));
  const response = items.filter(it => isResponse(it.type, it));

  const LEGEND = [
    { color: LANE_COLORS.email,   label: 'Email' },
    { color: LANE_COLORS.call,    label: 'Call' },
    { color: LANE_COLORS.meeting, label: 'Meeting' },
    { color: LANE_COLORS.reply,   label: 'Reply' },
    { color: LANE_COLORS.unsub,   label: 'Unsub' },
  ];

  return (
    <div style={{ padding: '12px 14px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Contact Timeline
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {LEGEND.map(l => (
            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: l.color, opacity: 0.85 }} />
              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{l.label}</span>
            </div>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center', padding: '6px 0', fontStyle: 'italic' }}>No activity recorded yet</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <TimelineLane items={outreach} label="Outreach" emptyMsg="none" />
          <TimelineLane items={response} label="Response" emptyMsg="none" />
        </div>
      )}
    </div>
  );
};

const FIELD = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <label style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
      {label}
    </label>
    {children}
  </div>
);


const EnrollmentBadge = ({ status }) => {
  const s = ENROLLMENT_STATUS_STYLES[status] || ENROLLMENT_STATUS_STYLES.active;
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 8px',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      borderRadius: 'var(--radius-full)', fontSize: '0.68rem', fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      {status.replace('_', ' ')}
    </span>
  );
};

const ProspectDetailDrawer = ({ isOpen, onClose, prospect, onSave }) => {
  const [form, setForm] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState(null);
  const toast = useToast();

  // Sequence enrollment state
  const [enrollments, setEnrollments] = useState([]);
  const [sequences, setSequences] = useState([]);
  const [enrollingSeqId, setEnrollingSeqId] = useState('');
  const [isEnrolling, setIsEnrolling] = useState(false);

  // Call modal state
  const [callOpen, setCallOpen] = useState(false);
  const [callPhase, setCallPhase] = useState('pre');
  const [callForm, setCallForm] = useState({ outcome: 'connected', durationSecs: '', notes: '' });
  const [callEnrollment, setCallEnrollment] = useState(null);
  const [callLogging, setCallLogging] = useState(false);

  // Account-level research, fetched on demand so the SDR can see the
  // company context that feeds the prospect brief.
  const [accountInfo, setAccountInfo] = useState(null);

  useEffect(() => {
    if (prospect) {
      setForm(prospect);
      fetchEnrollments(prospect.id);
    }
  }, [prospect]);

  useEffect(() => {
    setAccountInfo(null);
    if (!prospect?.accountId) return;
    let cancelled = false;
    api.get(`/accounts/${prospect.accountId}`)
      .then(r => { if (!cancelled) setAccountInfo(r.data); })
      .catch(() => { /* ignore — drawer still works without it */ });
    return () => { cancelled = true; };
  }, [prospect?.accountId]);

  useEffect(() => {
    api.get('/sequences').then(r => setSequences(r.data || [])).catch(() => {});
  }, []);

  const fetchEnrollments = async (id) => {
    try {
      const res = await api.get(`/sequences/enrollments/prospect/${id}`);
      setEnrollments(res.data || []);
    } catch {
      setEnrollments([]);
    }
  };

  const handleEnrich = async () => {
    setIsEnriching(true);
    setEnrichResult(null);
    try {
      const res = await api.post(`/prospects/${form.id}/enrich`);
      const { enriched, prospect: updated } = res.data;
      setForm(prev => ({ ...prev, title: updated.title, techStack: updated.techStack, trackingPixelData: updated.trackingPixelData }));
      setEnrichResult({ ok: true, enriched });
      onSave();
      toast(enriched ? 'Prospect enriched with new data' : 'Already up-to-date', enriched ? 'success' : 'info');
    } catch (err) {
      const msg = err.response?.data?.error || 'Enrichment failed';
      setEnrichResult({ ok: false, message: msg });
      toast(msg, 'error');
    } finally {
      setIsEnriching(false);
    }
  };

  const setPhone = (phone) => {
    setForm(prev => ({ ...prev, trackingPixelData: { ...(prev.trackingPixelData || {}), phone } }));
  };

  // Tags helpers
  const [tagInput, setTagInput] = useState('');
  const parsedTags = (() => { try { return JSON.parse(form.tags || '[]'); } catch { return []; } })();

  const addTag = (raw) => {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (!tag || parsedTags.includes(tag)) return;
    setForm(prev => ({ ...prev, tags: JSON.stringify([...parsedTags, tag]) }));
    setTagInput('');
  };

  const removeTag = (tag) => {
    setForm(prev => ({ ...prev, tags: JSON.stringify(parsedTags.filter(t => t !== tag)) }));
  };

  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); }
    if (e.key === 'Backspace' && !tagInput && parsedTags.length > 0) removeTag(parsedTags[parsedTags.length - 1]);
  };

  const openCallModal = async () => {
    setCallPhase('pre');
    setCallForm({ outcome: 'connected', durationSecs: '', notes: '' });
    setCallEnrollment(null);
    setCallOpen(true);
    try {
      const res = await api.get(`/sequences/enrollments/prospect/${form.id}`);
      const active = (res.data || []).find(enr => enr.status === 'active');
      setCallEnrollment(active || null);
    } catch { /* ignore */ }
  };

  const handleLogCall = async () => {
    setCallLogging(true);
    try {
      const payload = {
        prospectId: form.id,
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
      setCallOpen(false);
      onSave();
    } catch {
      toast('Failed to log call', 'error');
    } finally {
      setCallLogging(false);
    }
  };

  const handleEnrollInSequence = async () => {
    if (!enrollingSeqId) return;
    setIsEnrolling(true);
    try {
      const seq = sequences.find(s => s.id === Number(enrollingSeqId) || s.id === enrollingSeqId);
      await api.post(`/sequences/${enrollingSeqId}/enroll`, { prospectIds: [form.id] });
      setEnrollingSeqId('');
      fetchEnrollments(form.id);
      onSave();
      toast(`Enrolled in "${seq?.name || 'sequence'}"`, 'success');
    } catch (err) {
      console.error('Enrollment failed', err);
      toast('Enrollment failed — please try again', 'error');
    } finally {
      setIsEnrolling(false);
    }
  };

  const handleOptOut = async (sequenceId) => {
    try {
      await api.post(`/sequences/${sequenceId}/opt-out/${form.id}`);
      fetchEnrollments(form.id);
      setForm(prev => ({ ...prev, status: 'Not Interested' }));
      onSave();
      toast(`${form.firstName} opted out`, 'info', 2200);
    } catch (err) {
      toast('Failed to opt out — please try again', 'error');
    }
  };

  const handlePauseResume = async (enrollment) => {
    const isPaused = enrollment.status === 'paused';
    const endpoint = isPaused
      ? `/sequences/${enrollment.sequenceId}/resume/${form.id}`
      : `/sequences/${enrollment.sequenceId}/pause/${form.id}`;
    try {
      await api.post(endpoint);
      fetchEnrollments(form.id);
      toast(`Sequence ${isPaused ? 'resumed' : 'paused'}`, 'info', 2000);
    } catch (err) {
      toast(`Failed to ${isPaused ? 'resume' : 'pause'} sequence`, 'error');
    }
  };

  if (!isOpen || !form) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const { id, createdAt, updatedAt, _count, sequenceEnrollments, ...updatable } = form;
      await api.put(`/prospects/${form.id}`, updatable);
      onSave();
      onClose();
      toast(`${form.firstName} ${form.lastName} updated`, 'success');
    } catch (err) {
      console.error('Failed to update prospect', err);
      toast('Failed to save changes', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const initials = `${form.firstName?.[0] || ''}${form.lastName?.[0] || ''}`.toUpperCase();

  const STATUS_COLORS = {
    'Uncontacted':    { bg: 'var(--accent-soft)',          color: 'var(--accent-light)',    border: 'var(--border-accent)' },
    'In Sequence':    { bg: 'var(--status-info-dim)',       color: 'var(--status-info)',     border: 'var(--status-info-border)' },
    'Meeting Booked': { bg: 'var(--status-success-dim)',    color: 'var(--status-success)',  border: 'var(--status-success-border)' },
    'Not Interested': { bg: 'rgba(100,116,139,0.1)',        color: 'var(--text-muted)',      border: 'rgba(100,116,139,0.2)' },
    'Replied':        { bg: 'var(--status-warning-dim)',    color: 'var(--status-warning)',  border: 'var(--status-warning-border)' },
  };
  const statusStyle = STATUS_COLORS[form.status] || STATUS_COLORS['Uncontacted'];

  const activeEnrollments = enrollments.filter(e => e.status === 'active' || e.status === 'paused');
  const availableSequences = sequences.filter(s => !enrollments.find(e => e.sequenceId === s.id && e.status === 'active'));

  return (
    <>
      <div className="overlay" onClick={onClose} />

      <div className="drawer" style={{ padding: 0 }}>
        {/* Header */}
        <div style={{
          padding: '20px 22px 16px',
          borderBottom: '1px solid var(--border-color)',
          background: 'linear-gradient(180deg, var(--accent-dim) 0%, transparent 100%)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Prospect Intelligence
            </div>
            <button onClick={onClose} className="ghost" style={{ padding: '6px 8px', fontSize: '1rem', color: 'var(--text-muted)' }}>✕</button>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{
              width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
              background: 'var(--grad-brand)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 800, fontSize: '0.88rem', color: '#fff',
              boxShadow: 'var(--shadow-glow-sm)',
            }}>
              {initials}
            </div>
            <div>
              <h3 style={{ marginBottom: 2 }}>{form.firstName} {form.lastName}</h3>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                {form.title ? `${form.title}${form.companyName ? ' · ' + form.companyName : ''}` : form.companyName}
              </div>
              <div style={{ marginTop: 6 }}>
                <span style={{
                  display: 'inline-flex', padding: '2px 10px',
                  background: statusStyle.bg, color: statusStyle.color,
                  border: `1px solid ${statusStyle.border}`,
                  borderRadius: 'var(--radius-full)', fontSize: '0.7rem', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                  {form.status || 'Uncontacted'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Contact Timeline */}
        <div style={{ padding: '14px 22px 0', flexShrink: 0 }}>
          <ContactTimeline prospectId={form.id} />
        </div>

        {/* Form body */}
        <form
          onSubmit={handleSubmit}
          style={{ flex: 1, overflowY: 'auto', padding: '14px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div style={{ display: 'flex', gap: 12 }}>
            <FIELD label="First Name">
              <input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required style={{ width: '100%' }} />
            </FIELD>
            <FIELD label="Last Name">
              <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required style={{ width: '100%' }} />
            </FIELD>
          </div>

          <FIELD label="Email Address">
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required style={{ width: '100%' }} />
          </FIELD>

          <div style={{ display: 'flex', gap: 12 }}>
            <FIELD label="Company">
              <input value={form.companyName || ''} onChange={(e) => setForm({ ...form, companyName: e.target.value })} style={{ width: '100%' }} />
            </FIELD>
            <FIELD label="Job Title">
              <input value={form.title || ''} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ width: '100%' }} />
            </FIELD>
          </div>

          <FIELD label="Phone Number">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="tel"
                value={form.phone || form.trackingPixelData?.phone || ''}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 000 0000"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                onClick={openCallModal}
                disabled={!form.phone && !form.trackingPixelData?.phone}
                style={{ flexShrink: 0, padding: '0 14px', fontSize: '0.82rem', whiteSpace: 'nowrap', background: 'var(--status-success)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', opacity: (!form.phone && !form.trackingPixelData?.phone) ? 0.4 : 1 }}
              >
                📞 Call
              </button>
            </div>
          </FIELD>

          <FIELD label="Tags">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '6px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', minHeight: 36, cursor: 'text', alignItems: 'center' }}
              onClick={() => document.getElementById('drawer-tag-input')?.focus()}
            >
              {parsedTags.map(tag => (
                <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-full)', fontSize: '0.72rem', fontWeight: 600, color: 'var(--accent-secondary)', whiteSpace: 'nowrap' }}>
                  #{tag}
                  <button type="button" onClick={(e) => { e.stopPropagation(); removeTag(tag); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1, fontSize: '0.7rem', opacity: 0.7 }}>✕</button>
                </span>
              ))}
              <input
                id="drawer-tag-input"
                type="text"
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={() => tagInput && addTag(tagInput)}
                placeholder={parsedTags.length === 0 ? 'Add tags… (Enter or comma to confirm)' : ''}
                style={{ background: 'none', border: 'none', outline: 'none', fontSize: '0.78rem', color: 'var(--text-primary)', flex: '1 1 80px', minWidth: 80, padding: '1px 2px' }}
              />
            </div>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 3 }}>Spaces become hyphens. Backspace removes last tag.</div>
          </FIELD>

          <FIELD label="Status">
            <select value={form.status || 'Uncontacted'} onChange={(e) => setForm({ ...form, status: e.target.value })} style={{ width: '100%' }}>
              <option value="Uncontacted">Uncontacted</option>
              <option value="In Sequence">In Sequence</option>
              <option value="Replied">Replied</option>
              <option value="Meeting Booked">Meeting Booked</option>
              <option value="Not Interested">Not Interested</option>
            </select>
          </FIELD>

          {/* ── Sequence Enrollment Panel ── */}
          <div style={{ padding: 12, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
              Sequence Enrollments
            </div>

            {/* Active enrollments */}
            {enrollments.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                {enrollments.map(enrollment => (
                  <div key={enrollment.id} style={{
                    padding: '8px 10px',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: '0.82rem', color: 'var(--text-primary)' }}>
                        {enrollment.sequence?.name}
                      </span>
                      <EnrollmentBadge status={enrollment.status} />
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: 14, marginBottom: 8 }}>
                      <span>Step {enrollment.currentStepOrder} completed</span>
                      {enrollment.lastContactedAt && (
                        <span>Last contact: {new Date(enrollment.lastContactedAt).toLocaleDateString()}</span>
                      )}
                      {enrollment.nextStepDue && enrollment.status === 'active' && (
                        <span>Next: {new Date(enrollment.nextStepDue).toLocaleDateString()}</span>
                      )}
                      {enrollment.optedOutAt && (
                        <span>Opted out: {new Date(enrollment.optedOutAt).toLocaleDateString()}</span>
                      )}
                    </div>
                    {/* Recent activity */}
                    {enrollment.activities?.length > 0 && (
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                        {enrollment.activities.slice(0, 3).map(a => (
                          <span key={a.id} style={{ marginRight: 10 }}>
                            Step {a.sequenceStep?.order}: {a.status}
                            {a.openedAt ? ' · opened' : ''}
                            {a.repliedAt ? ' · replied' : ''}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Controls */}
                    {(enrollment.status === 'active' || enrollment.status === 'paused') && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => handlePauseResume(enrollment)}
                          style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                        >
                          {enrollment.status === 'paused' ? 'Resume' : 'Pause'}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => handleOptOut(enrollment.sequenceId)}
                          style={{ fontSize: '0.72rem', padding: '2px 8px', color: 'var(--status-danger)' }}
                        >
                          Opt Out
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                Not enrolled in any sequences.
              </div>
            )}

            {/* Enroll in new sequence */}
            {availableSequences.length > 0 && (
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value={enrollingSeqId}
                  onChange={(e) => setEnrollingSeqId(e.target.value)}
                  style={{ flex: 1, fontSize: '0.82rem' }}
                >
                  <option value="">Add to sequence…</option>
                  {availableSequences.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleEnrollInSequence}
                  disabled={!enrollingSeqId || isEnrolling}
                  style={{ flexShrink: 0, padding: '0 12px', fontSize: '0.82rem' }}
                >
                  {isEnrolling ? 'Enrolling…' : 'Enroll'}
                </button>
              </div>
            )}
          </div>

          {/* ── AI Research Brief Panel ── */}
          <div style={{ padding: 12, background: 'rgba(56,189,248,0.04)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                AI Research Brief
              </div>
              {form.researchBrief && (
                <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', background: 'rgba(74,222,128,0.12)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.25)', borderRadius: 'var(--radius-full)', letterSpacing: '0.05em' }}>
                  ✓ Saved
                </span>
              )}
            </div>
            <textarea
              value={form.researchBrief || ''}
              onChange={(e) => setForm(prev => ({ ...prev, researchBrief: e.target.value }))}
              placeholder="No brief yet. Generate one by uploading this prospect's list through the Research tab, or write your own here."
              rows={6}
              style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
            />
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 5 }}>
              Saved with "Save Changes". Generated by the Research tab — edit freely.
            </div>
          </div>

          {/* ── Account Research (read-only summary; edit in Accounts page) ── */}
          {accountInfo?.researchSummary && (
            <div style={{ padding: 12, background: 'rgba(167,139,250,0.04)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Account Research — {accountInfo.name}
                </div>
                <a
                  href={`/accounts?focus=${accountInfo.id}`}
                  onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', `/accounts?focus=${accountInfo.id}`); window.dispatchEvent(new PopStateEvent('popstate')); }}
                  style={{ fontSize: '0.7rem', color: '#a78bfa', textDecoration: 'none' }}
                >
                  Edit →
                </a>
              </div>
              <div style={{ fontSize: '0.82rem', lineHeight: 1.55, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
                {accountInfo.researchSummary}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>
                Used as context when generating this prospect's brief.
              </div>
            </div>
          )}

          {/* ── Notes Panel ── */}
          <div style={{ padding: 12, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
              Research &amp; Call Notes
            </div>
            <textarea
              value={form.notes || ''}
              onChange={(e) => setForm(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Add research notes, context, or talking points… Call notes are appended here automatically after each call."
              rows={5}
              style={{ width: '100%', resize: 'vertical', fontSize: '0.82rem', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontFamily: 'inherit', lineHeight: 1.55, boxSizing: 'border-box' }}
            />
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 5 }}>
              Saved with "Save Changes". Call outcomes are prepended automatically.
            </div>
          </div>

          {/* ── Enrichment Panel ── */}
          <div style={{ padding: 12, background: 'var(--bg-glass)', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Enrichment Data
              </div>
              <button
                type="button"
                className="ghost"
                onClick={handleEnrich}
                disabled={isEnriching}
                style={{ fontSize: '0.75rem', padding: '3px 10px', color: 'var(--accent-light)' }}
              >
                {isEnriching ? 'Enriching…' : '✦ Run Enrich'}
              </button>
            </div>

            {enrichResult && (
              <div style={{
                marginBottom: 10, padding: '7px 10px', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem',
                background: enrichResult.ok ? 'var(--status-success-dim)' : 'var(--status-danger-dim)',
                border: `1px solid ${enrichResult.ok ? 'var(--status-success-border)' : 'var(--status-danger-border)'}`,
                color: enrichResult.ok ? 'var(--status-success)' : 'var(--status-danger)',
              }}>
                {enrichResult.ok ? '✓ Enrichment complete — title & tech stack updated' : `✕ ${enrichResult.message}`}
              </div>
            )}

            {[
              { label: 'LinkedIn URL', key: 'linkedIn' },
              { label: 'Timezone', key: 'timezone' },
            ].map((item) => {
              const enriched = form.trackingPixelData?.[item.key];
              return (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: enriched ? 'var(--status-success)' : 'var(--status-danger)',
                    boxShadow: `0 0 6px ${enriched ? 'var(--status-success)' : 'var(--status-danger)'}`,
                  }} />
                  <span style={{ flex: 1, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{item.label}</span>
                  <span style={{ fontSize: '0.78rem', color: enriched ? 'var(--text-primary)' : 'var(--text-muted)', fontFamily: enriched ? 'monospace' : 'inherit' }}>
                    {enriched || 'Not enriched'}
                  </span>
                </div>
              );
            })}
          </div>
        </form>

        {/* Footer */}
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-color)', display: 'flex', gap: 10, flexShrink: 0 }}>
          <button type="button" onClick={handleSubmit} disabled={isSaving} style={{ flex: 1, padding: '9px' }}>
            {isSaving ? 'Saving…' : 'Save Changes'}
          </button>
          <button type="button" className="secondary" onClick={onClose} style={{ padding: '9px 16px' }}>
            Cancel
          </button>
        </div>
      </div>

      {/* ── Call Modal ── */}
      {callOpen && (() => {
        const ph = form.phone || form.trackingPixelData?.phone || '';
        return (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)' }}
            onClick={() => setCallOpen(false)}
          >
            <div className="glass-card" style={{ width: 'min(400px, calc(100vw - 40px))', padding: '28px 28px 24px', borderRadius: 'var(--radius-lg)', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem' }}>{form.firstName} {form.lastName}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                    {[form.title, form.companyName].filter(Boolean).join(' · ') || 'No title'}
                  </div>
                  {callEnrollment && (
                    <div style={{ marginTop: 7, fontSize: '0.72rem', color: 'var(--accent-secondary)', background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', padding: '2px 8px', borderRadius: 'var(--radius-sm)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      ⚡ {callEnrollment.sequence?.name}
                    </div>
                  )}
                </div>
                <button className="ghost" onClick={() => setCallOpen(false)} style={{ fontSize: '1.1rem', padding: '0 4px', lineHeight: 1, opacity: 0.6 }}>✕</button>
              </div>

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
                    <button className="ghost" style={{ padding: '9px 14px', fontSize: '0.85rem' }} onClick={() => setCallOpen(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
};

export default ProspectDetailDrawer;
