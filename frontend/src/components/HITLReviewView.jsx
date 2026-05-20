import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { useToast } from './Toast';

const CONFIDENCE_THRESHOLDS = {
  HIGH: 85,
  MODERATE: 70,
};

const ConfidenceBadge = ({ score }) => {
  let color, label, bg;
  if (score >= CONFIDENCE_THRESHOLDS.HIGH) {
    color = 'var(--status-success)'; bg = 'var(--status-success-soft)'; label = 'Auto-Execute';
  } else if (score >= CONFIDENCE_THRESHOLDS.MODERATE) {
    color = 'var(--status-warning)'; bg = 'var(--status-warning-soft)'; label = 'Needs Review';
  } else {
    color = 'var(--status-danger)'; bg = 'var(--status-danger-soft)'; label = 'Escalate';
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, backgroundColor: 'var(--bg-primary)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', backgroundColor: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
      </div>
      <span style={{ fontSize: '0.75rem', fontWeight: 700, color, backgroundColor: bg, padding: '2px 8px', borderRadius: 'var(--radius-full)', whiteSpace: 'nowrap' }}>
        {score}% · {label}
      </span>
    </div>
  );
};

// Normalise a backend queue item (minimal shape) to the rich shape the UI expects
const normaliseItem = (item) => ({
  ...item,
  prospect: item.prospect || {
    firstName: 'Queue Item',
    lastName: `#${item.id}`,
    companyName: '—',
    title: item.type,
    email: '—',
  },
  pipelineValue: item.pipelineValue || '—',
  reasoning: item.reasoning || [`[${item.type}] Confidence: ${item.confidenceScore}%`, item.aiSummary || ''],
  sourceData: item.sourceData || { recentEmail: '—', calls: 0, webVisits: 0, techStack: '—' },
});

// Normalise an EmailActivity draft row (durable Track B drafts) into the same UI shape
const normaliseDraft = (d) => ({
  id: `draft-${d.id}`,             // string-prefixed so it doesn't collide with queue ints
  emailActivityId: d.id,
  __isDraft: true,
  type: 'Email Draft',
  confidenceScore: 75,
  urgency: 'Medium',
  status: 'pending',
  createdAt: d.createdAt,
  subject: d.subject,
  draftBody: d.draftBody || '',
  draftPrompt: d.draftPrompt || '',
  draftReasoning: d.draftReasoning || '',
  draftModel: d.draftModel || '',
  draftProvider: d.draftProvider || '',
  aiSummary: d.draftReasoning || `Personalized via ${d.draftProvider || '?'} ${d.draftModel || ''}`.trim(),
  draftContent: `Subject: ${d.subject}\n\n${d.draftBody || ''}`,
  prospect: d.prospect ? {
    ...d.prospect,
    company: d.prospect.companyName,
  } : { firstName: 'Prospect', lastName: `#${d.prospectId}`, companyName: '—', email: '—', title: '—' },
  step: d.sequenceStep,
  enrollment: d.enrollment,
  reasoning: [
    d.draftReasoning || `Generated via ${d.draftProvider} ${d.draftModel}`,
    d.sequenceStep?.aiPurpose ? `Intent: ${d.sequenceStep.aiPurpose}` : null,
  ].filter(Boolean),
  pipelineValue: '—',
  sourceData: { recentEmail: '—', calls: 0, webVisits: 0, techStack: '—' },
});

const HITLReviewView = () => {
  const [queue, setQueue] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editedSubject, setEditedSubject] = useState('');
  const [editedContent, setEditedContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [actionLog, setActionLog] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [showPrompt, setShowPrompt] = useState(false);
  const [regenInput, setRegenInput] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const toast = useToast();

  const fetchQueue = async () => {
    try {
      const [hitlRes, draftsRes] = await Promise.allSettled([
        api.get('/hitl/queue'),
        api.get('/email-activities/drafts'),
      ]);
      const hitlItems = hitlRes.status === 'fulfilled' ? (hitlRes.value.data || []).map(normaliseItem) : [];
      const draftItems = draftsRes.status === 'fulfilled' ? (draftsRes.value.data || []).map(normaliseDraft) : [];
      // Drafts first (most actionable), then legacy queue items
      const items = [...draftItems, ...hitlItems];
      setQueue(items);
      if (!selectedId && items.length > 0) setSelectedId(items[0].id);
    } catch (err) {
      console.error('Failed to fetch HITL queue', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchQueue(); }, []);

  const selected = queue.find(i => i.id === selectedId);

  useEffect(() => {
    if (selected) {
      if (selected.__isDraft) {
        setEditedSubject(selected.subject || '');
        setEditedContent(selected.draftBody || '');
      } else {
        setEditedSubject('');
        setEditedContent(selected.draftContent || '');
      }
      setIsEditing(false);
      setShowPrompt(false);
      setRegenInput('');
    }
  }, [selectedId, selected]);

  const handleAction = async (action) => {
    const timestamp = new Date().toLocaleTimeString();
    const prospectLabel = `${selected.prospect.firstName} ${selected.prospect.lastName}`;
    const wasDraft = selected.__isDraft;
    const draftId = selected.emailActivityId;
    const currentId = selectedId;

    // Optimistic UI update
    setActionLog(prev => [{ id: currentId, action, prospect: prospectLabel, timestamp }, ...prev]);
    setQueue(prev => prev.filter(i => i.id !== currentId));
    const remaining = queue.filter(i => i.id !== currentId);
    setSelectedId(remaining[0]?.id || null);

    const toastMsg = {
      'accepted':            `Approved email to ${prospectLabel}`,
      'rejected':            `Rejected draft for ${prospectLabel}`,
      'edited-and-accepted': `Edited & sent to ${prospectLabel}`,
      'escalated':           `Escalated ${prospectLabel} for manual review`,
    }[action];
    if (toastMsg) toast(toastMsg, action === 'rejected' ? 'warning' : 'success');

    try {
      if (wasDraft) {
        // Real EmailActivity draft path
        if (action === 'accepted' || action === 'edited-and-accepted') {
          const body = { editedSubject, editedBody: editedContent };
          await api.post(`/email-activities/${draftId}/approve`, body);
        } else if (action === 'rejected') {
          await api.post(`/email-activities/${draftId}/reject`, { skipStep: false });
        } else if (action === 'escalated') {
          // No backend support for escalate yet — just log it
          toast('Escalation logged (escalation backend coming soon)', 'info');
        }
      } else {
        // Legacy in-memory /hitl/queue path
        if (action === 'accepted') {
          await api.post(`/hitl/queue/${currentId}/accept`);
        } else if (action === 'rejected') {
          await api.post(`/hitl/queue/${currentId}/reject`);
        } else if (action === 'edited-and-accepted') {
          await api.post(`/hitl/queue/${currentId}/edit`, { editedContent });
        } else if (action === 'escalated') {
          await api.post(`/hitl/queue/${currentId}/escalate`);
        }
      }
    } catch (err) {
      console.error(`HITL action "${action}" failed`, err);
      toast(err.response?.data?.message || 'Action failed — re-queuing', 'error');
      fetchQueue();
    }
  };

  const handleRegenerate = async () => {
    if (!selected?.__isDraft) return;
    setRegenerating(true);
    try {
      const res = await api.post(`/email-activities/${selected.emailActivityId}/regenerate`, {
        customInstructions: regenInput || undefined,
      });
      const fresh = res.data;
      // Update the queue item in place
      setQueue(prev => prev.map(it => it.id === selectedId
        ? { ...it, subject: fresh.subject, draftBody: fresh.draftBody, draftPrompt: fresh.draftPrompt, draftReasoning: fresh.draftReasoning, draftModel: fresh.draftModel, draftProvider: fresh.draftProvider }
        : it
      ));
      setEditedSubject(fresh.subject);
      setEditedContent(fresh.draftBody);
      setRegenInput('');
      toast('Regenerated', 'success', 2000);
    } catch (err) {
      toast(err.response?.data?.message || 'Regenerate failed', 'error');
    } finally {
      setRegenerating(false);
    }
  };

  const handleRejectAndSkip = async () => {
    if (!selected?.__isDraft) return;
    const draftId = selected.emailActivityId;
    const currentId = selectedId;
    const prospectLabel = `${selected.prospect.firstName} ${selected.prospect.lastName}`;
    setActionLog(prev => [{ id: currentId, action: 'rejected', prospect: prospectLabel, timestamp: new Date().toLocaleTimeString() }, ...prev]);
    setQueue(prev => prev.filter(i => i.id !== currentId));
    const remaining = queue.filter(i => i.id !== currentId);
    setSelectedId(remaining[0]?.id || null);
    try {
      await api.post(`/email-activities/${draftId}/reject`, { skipStep: true });
      toast(`Rejected — advanced past this step for ${prospectLabel}`, 'warning');
    } catch (err) {
      toast('Reject failed — re-queuing', 'error');
      fetchQueue();
    }
  };

  const filteredQueue = queue.filter(item => {
    if (filter === 'escalate') return item.confidenceScore < CONFIDENCE_THRESHOLDS.MODERATE;
    if (filter === 'review') return item.confidenceScore >= CONFIDENCE_THRESHOLDS.MODERATE && item.confidenceScore < CONFIDENCE_THRESHOLDS.HIGH;
    if (filter === 'auto') return item.confidenceScore >= CONFIDENCE_THRESHOLDS.HIGH;
    return true;
  });

  const getUrgencyColor = (urgency) => {
    if (urgency === 'High') return 'var(--status-danger)';
    if (urgency === 'Medium') return 'var(--status-warning)';
    return 'var(--text-muted)';
  };

  // Keyboard shortcuts: J/K navigate, A accept, R reject, E escalate
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      const idx = filteredQueue.findIndex(i => i.id === selectedId);
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (idx < filteredQueue.length - 1) setSelectedId(filteredQueue[idx + 1].id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) setSelectedId(filteredQueue[idx - 1].id);
      } else if (e.key === 'a' && selected && !isEditing) {
        handleAction('accepted');
      } else if (e.key === 'r' && selected && !isEditing) {
        handleAction('rejected');
      } else if (e.key === 'e' && selected && !isEditing) {
        handleAction('escalated');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, filteredQueue, selected, isEditing]);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 48px)', gap: 0, backgroundColor: 'var(--bg-primary)' }}>

      {/* LEFT RAIL — Review Queue */}
      <div style={{ width: 320, borderRight: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '20px 16px', borderBottom: '1px solid var(--border-color)' }}>
          {/* Show labs banner only when there are no real drafts */}
          {!queue.some(i => i.__isDraft) && (
            <div style={{ marginBottom: 14, padding: '9px 12px', background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.25)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--accent-secondary)', lineHeight: 1.5 }}>
              <strong>No live drafts.</strong> Enable <em>AI-personalize</em> on a sequence step and run the mailer to populate this queue with editable drafts.
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Review Queue</h3>
            <button onClick={fetchQueue} title="Refresh" className="ghost" style={{ padding: '2px 8px', fontSize: '0.7rem', color: 'var(--text-muted)' }}>↻</button>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: 16 }}>
            {loading ? 'Loading…' : `${queue.length} items · ${queue.filter(i => i.__isDraft).length} live draft${queue.filter(i => i.__isDraft).length === 1 ? '' : 's'}`}
          </p>
          <div className="pill-group" style={{ flexWrap: 'wrap' }}>
            {[
              { key: 'all',      label: 'All' },
              { key: 'escalate', label: '🔴 Escalate' },
              { key: 'review',   label: '🟡 Review' },
              { key: 'auto',     label: '🟢 Auto' },
            ].map(f => (
              <button key={f.key} className={`pill-btn${filter === f.key ? ' active' : ''}`} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filteredQueue.length === 0 && !loading && (
            <div className="empty-state" style={{ padding: '32px 16px' }}>
              <div className="empty-state-icon">✅</div>
              <p>No items in this category</p>
            </div>
          )}
          {loading && (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[1,2,3].map(i => <div key={i} className="skeleton" style={{ height: 68 }} />)}
            </div>
          )}
          {filteredQueue.map(item => (
            <div
              key={item.id}
              onClick={() => setSelectedId(item.id)}
              style={{
                padding: '16px', cursor: 'pointer', borderBottom: '1px solid var(--border-color)',
                backgroundColor: selectedId === item.id ? 'var(--accent-dim)' : 'transparent',
                borderLeft: selectedId === item.id ? '3px solid var(--accent-primary)' : '3px solid transparent',
                transition: 'all 0.15s'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div
                    title={item.urgency || 'Normal'}
                    style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 5,
                      backgroundColor: getUrgencyColor(item.urgency),
                      boxShadow: item.urgency === 'High' ? '0 0 6px var(--status-danger)' : 'none',
                    }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{item.prospect.firstName} {item.prospect.lastName}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{item.prospect.companyName || item.prospect.company} · {item.type}</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{item.pipelineValue}</div>
                </div>
              </div>
              <ConfidenceBadge score={item.confidenceScore} />
            </div>
          ))}
        </div>

        {/* Action Log */}
        {actionLog.length > 0 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-color)', maxHeight: 140, overflowY: 'auto', background: 'var(--bg-tertiary)' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Recent Actions</div>
            {actionLog.slice(0, 5).map((log, i) => {
              const color = log.action === 'accepted' || log.action === 'edited-and-accepted'
                ? 'var(--status-success)'
                : log.action === 'rejected' ? 'var(--status-danger)' : 'var(--status-warning)';
              const icon = log.action === 'accepted' || log.action === 'edited-and-accepted' ? '✓' : log.action === 'rejected' ? '✗' : '↑';
              return (
                <div key={i} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 5, display: 'flex', gap: 7, alignItems: 'baseline' }}>
                  <span style={{ color, fontWeight: 700, flexShrink: 0 }}>{icon}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.prospect}
                  </span>
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: '0.72rem' }}>{log.timestamp}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* CENTER PANE — Contextual Record */}
      {selected ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-color)', overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '1.1rem' }}>
                {selected.prospect.firstName[0]}{selected.prospect.lastName[0]}
              </div>
              <div>
                <h3 style={{ margin: 0 }}>{selected.prospect.firstName} {selected.prospect.lastName}</h3>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  {selected.prospect.title} · {selected.prospect.companyName || selected.prospect.company} · {selected.prospect.email}
                </div>
              </div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--accent-primary)' }}>{selected.pipelineValue}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Pipeline Value</div>
              </div>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Engagement Context */}
            <div style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 16 }}>
              <h4 style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Omnichannel Context</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {[
                  { label: 'Web Visits', value: selected.sourceData.webVisits, icon: '🌐' },
                  { label: 'Calls Made', value: selected.sourceData.calls, icon: '📞' },
                  { label: 'Recent Email', value: selected.sourceData.recentEmail, icon: '✉️', wide: true },
                ].map(stat => (
                  <div key={stat.label} style={{ gridColumn: stat.wide ? 'span 3' : 'span 1', padding: '10px 14px', backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: '1.1rem' }}>{stat.icon}</span>
                    <div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{stat.label}</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{stat.value}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, padding: '10px 14px', backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 4 }}>Tech Stack</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {selected.sourceData.techStack.split(', ').map(t => (
                    <span key={t} style={{ fontSize: '0.75rem', padding: '2px 8px', backgroundColor: 'var(--accent-dim)', color: 'var(--accent-primary)', borderRadius: 'var(--radius-full)', border: '1px solid var(--border-accent)' }}>{t}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* AI Reasoning Chain */}
            <div style={{ backgroundColor: 'var(--bg-code)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 16 }}>
              <h4 style={{ fontSize: '0.8rem', color: 'var(--status-warning)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>🤖</span> AI Reasoning Chain
              </h4>
              {selected.reasoning.map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 8, fontFamily: 'monospace', fontSize: '0.82rem', color: i === selected.reasoning.length - 1 ? 'var(--status-warning)' : '#94a3b8', opacity: i === selected.reasoning.length - 1 ? 1 : 0.75 }}>
                  <span>▶</span><span>{step}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
          {queue.length === 0 ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '3rem', marginBottom: 12 }}>✅</div>
              <h3>Queue Empty</h3>
              <p style={{ color: 'var(--text-secondary)' }}>All items have been reviewed. Great work!</p>
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>Select an item from the queue</div>
          )}
        </div>
      )}

      {/* RIGHT PANE — Agentic Action Panel */}
      {selected && (
        <div style={{ width: 380, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div style={{ padding: '20px', borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
            <h4 style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Review &amp; Decide</h4>
            <div style={{ marginTop: 12 }}>
              <ConfidenceBadge score={selected.confidenceScore} />
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* AI Summary + model badge */}
            <div style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-md)', padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--accent-primary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>AI Summary</div>
                {selected.__isDraft && (selected.draftProvider || selected.draftModel) && (
                  <span style={{ fontSize: '0.66rem', fontWeight: 700, padding: '2px 7px', borderRadius: 9999, background: 'var(--bg-primary)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', fontFamily: 'monospace' }}>
                    {selected.draftProvider}{selected.draftModel ? ` · ${selected.draftModel}` : ''}
                  </span>
                )}
              </div>
              <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>{selected.aiSummary}</p>
            </div>

            {/* Draft Content — split subject + body when this is a real draft */}
            {selected.__isDraft ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Subject</label>
                  <input
                    value={editedSubject}
                    onChange={e => { setEditedSubject(e.target.value); setIsEditing(true); }}
                    style={{ padding: '8px 12px', fontSize: '0.9rem', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Body</label>
                    <button
                      onClick={() => setShowPrompt(p => !p)}
                      style={{ padding: '2px 8px', fontSize: '0.7rem', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                      title="Show the exact prompt the model received"
                    >
                      {showPrompt ? 'Hide prompt' : 'Show prompt'}
                    </button>
                  </div>
                  <textarea
                    value={editedContent}
                    onChange={e => { setEditedContent(e.target.value); setIsEditing(true); }}
                    style={{ flex: 1, minHeight: 220, padding: 14, fontSize: '0.88rem', lineHeight: 1.6, backgroundColor: 'var(--bg-primary)', border: `1px solid ${isEditing ? 'var(--accent-primary)' : 'var(--border-color)'}`, borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', resize: 'vertical', fontFamily: 'inherit' }}
                  />
                </div>

                {showPrompt && (
                  <div style={{ background: 'var(--bg-code)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 12, maxHeight: 240, overflowY: 'auto' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Prompt sent to model</div>
                    <pre style={{ margin: 0, fontSize: '0.74rem', lineHeight: 1.45, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{selected.draftPrompt}</pre>
                  </div>
                )}

                {/* Regenerate with custom instructions */}
                <div style={{ background: 'var(--bg-tertiary)', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Adjust prompt &amp; regenerate</label>
                  <textarea
                    value={regenInput}
                    onChange={e => setRegenInput(e.target.value)}
                    placeholder="Extra instructions for the next run — e.g. 'shorter, lead with the warm-intro path, drop the use-case mention'"
                    style={{ width: '100%', padding: '8px 10px', fontSize: '0.82rem', lineHeight: 1.45, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', resize: 'vertical', minHeight: 50, fontFamily: 'inherit', boxSizing: 'border-box' }}
                  />
                  <button
                    onClick={handleRegenerate}
                    disabled={regenerating}
                    style={{ alignSelf: 'flex-start', padding: '6px 14px', fontSize: '0.82rem' }}
                  >
                    {regenerating ? 'Regenerating…' : '↻ Regenerate'}
                  </button>
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {selected.type === 'Email Draft' ? 'AI-Drafted Email' : 'AI-Drafted Script'}
                  </div>
                  <button
                    onClick={() => setIsEditing(!isEditing)}
                    style={{ padding: '4px 10px', fontSize: '0.75rem', backgroundColor: isEditing ? 'var(--accent-soft)' : 'var(--bg-tertiary)', color: isEditing ? 'var(--accent-primary)' : 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}
                  >
                    {isEditing ? '✎ Editing' : '✎ Inline Edit'}
                  </button>
                </div>
                {isEditing ? (
                  <textarea
                    value={editedContent}
                    onChange={(e) => setEditedContent(e.target.value)}
                    style={{ flex: 1, minHeight: 280, padding: 14, fontSize: '0.88rem', lineHeight: 1.6, backgroundColor: 'var(--bg-primary)', border: '1px solid var(--accent-primary)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', resize: 'none', fontFamily: 'inherit' }}
                  />
                ) : (
                  <div style={{ flex: 1, padding: 14, fontSize: '0.88rem', lineHeight: 1.6, backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', overflowY: 'auto', minHeight: 280 }}>
                    {editedContent}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              {[['A', 'Accept'], ['R', 'Reject'], ['E', 'Escalate'], ['J/K', 'Navigate']].map(([key, label]) => (
                <span key={key} style={{ fontSize: '0.68rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <kbd style={{ padding: '1px 5px', background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', borderRadius: 3, fontFamily: 'monospace', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{key}</kbd>
                  {label}
                </span>
              ))}
            </div>
            <button
              onClick={() => handleAction(selected.__isDraft && isEditing ? 'edited-and-accepted' : 'accepted')}
              className="success-btn"
              style={{ width: '100%', padding: '12px', fontSize: '0.95rem' }}
            >
              ✓ {selected.__isDraft && isEditing ? 'Approve Edited & Send' : 'Approve & Send'}
            </button>
            {!selected.__isDraft && isEditing && (
              <button
                onClick={() => handleAction('edited-and-accepted')}
                style={{ width: '100%', padding: '12px', fontSize: '0.95rem' }}
              >
                ✎ Accept Edited Version
              </button>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleAction('rejected')}
                className="danger"
                style={{ flex: 1, padding: '10px' }}
                title={selected.__isDraft ? 'Reject this draft; enrollment stays paused so you can regenerate' : 'Reject this item'}
              >
                ✗ Reject
              </button>
              {selected.__isDraft ? (
                <button
                  onClick={handleRejectAndSkip}
                  className="secondary"
                  style={{ flex: 1, padding: '10px', fontSize: '0.85rem' }}
                  title="Reject and advance enrollment past this step (don't try again)"
                >
                  ⏭ Skip step
                </button>
              ) : (
                <button
                  onClick={() => handleAction('escalated')}
                  className="secondary"
                  style={{ flex: 1, padding: '10px', fontSize: '0.85rem' }}
                >
                  ↑ Escalate
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HITLReviewView;
