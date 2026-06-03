import React, { useState, useEffect, useRef, useMemo } from 'react';
import api from '../services/api';
import { useToast } from './Toast';
import { useIntegrations } from '../contexts/IntegrationContext';
import { SetupTooltipBlock } from './SetupTooltip';
import { STEP_TYPE_CONFIG, ENROLLMENT_STATUS_STYLES } from '../constants';
import RichTextEditor from './RichTextEditor';

const STATUS_DOT_COLORS = {
  active:    'var(--status-info)',
  paused:    'var(--status-warning)',
  completed: 'var(--status-success)',
  opted_out: 'var(--text-muted)',
};

const SequenceManager = () => {
  const { isConfigured } = useIntegrations();
  const googleReady = isConfigured('google');
  const [sequences, setSequences] = useState([]);
  const [allSteps, setAllSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeSequenceId, setActiveSequenceId] = useState(null);
  const [activeTab, setActiveTab] = useState('steps'); // 'steps' | 'prospects' | 'emails' | 'calls' | 'replies'
  const [newSeqName, setNewSeqName] = useState('');
  const toast = useToast();

  // Step form
  const [isAddingStep, setIsAddingStep] = useState(false);
  const [stepForm, setStepForm] = useState({ id: null, order: null, stepType: 'AUTO_EMAIL', delayDays: 1, subject: '', body: '' });

  // Drag state — ID-based so display reorder doesn't corrupt indices
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  // Enrollment
  const [allProspects, setAllProspects] = useState([]);
  const [prospectSearch, setProspectSearch] = useState('');
  const [enrollStatusFilter, setEnrollStatusFilter] = useState('all');
  const [isEnrolling, setIsEnrolling] = useState(false);

  // Emails tab
  const [emailItems, setEmailItems] = useState([]);
  const [emailsLoading, setEmailsLoading] = useState(false);
  const [emailStatusFilter, setEmailStatusFilter] = useState('all');
  const [selectedEmailKeys, setSelectedEmailKeys] = useState(new Set()); // "activity-{id}" or "enrollment-{id}"
  const [reschedulingKey, setReschedulingKey] = useState(null); // key being rescheduled
  const [rescheduleDate, setRescheduleDate] = useState('');

  // Calls tab
  const [callItems, setCallItems] = useState([]);
  const [callsLoading, setCallsLoading] = useState(false);
  const [callStatusFilter, setCallStatusFilter] = useState('all');
  const [callGroupBy, setCallGroupBy] = useState('none'); // 'none' | 'account' | 'outcome' | 'step'
  const [selectedCallKeys, setSelectedCallKeys] = useState(new Set());
  const [callReschedulingKey, setCallReschedulingKey] = useState(null);
  const [callRescheduleDate, setCallRescheduleDate] = useState('');
  const [logCallKey, setLogCallKey] = useState(null); // planned item key being logged
  const [callLogForm, setCallLogForm] = useState({ outcome: 'connected', durationSecs: '', notes: '' });

  // Replies tab
  const [replyItems, setReplyItems] = useState([]);
  const [repliesLoading, setRepliesLoading] = useState(false);
  const [replyClassFilter, setReplyClassFilter] = useState('all');

  // Rename sequence
  const [renamingSeqId, setRenamingSeqId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  // Sequence item hover state
  const [hoveredSeqId, setHoveredSeqId] = useState(null);
  const [confirmDeleteSeqId, setConfirmDeleteSeqId] = useState(null);

  // Three-dot menu
  const [menuOpenId, setMenuOpenId] = useState(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpenId) return;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpenId(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpenId]);

  // Bulk enroll
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState(new Set());

  const fetchSequences = async () => {
    setLoading(true);
    try {
      const [seqRes, stepsRes] = await Promise.all([
        api.get('/sequences'),
        api.get('/sequenceSteps')
      ]);
      setSequences(seqRes.data || []);
      setAllSteps(stepsRes.data || []);

      if (!activeSequenceId && seqRes.data && seqRes.data.length > 0) {
        setActiveSequenceId(seqRes.data[0].id);
      }
    } catch (err) {
      // Surface the real error — silent fallback used to mask DB/schema failures
      // and replace them with fake sequences, which made created rows look "missing".
      console.error('[SequenceManager] fetchSequences failed', err);
      setSequences([]);
      setAllSteps([]);
      const msg = err.response?.data?.error || err.response?.data?.message || err.message || 'Failed to load sequences';
      toast(msg, 'error', 6000);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSequences();
    api.get('/prospects').then(r => setAllProspects(r.data || [])).catch(() => {});
  }, []);

  const fetchEmails = async (seqId) => {
    if (!seqId) return;
    setEmailsLoading(true);
    try {
      const res = await api.get(`/email-activities/sequence/${seqId}`);
      setEmailItems(res.data || []);
    } catch (err) {
      console.error('Failed to load emails', err);
      setEmailItems([]);
    } finally {
      setEmailsLoading(false);
    }
  };

  useEffect(() => {
    // Also fetch on Steps tab so per-step stat panels can compute from
    // real EmailActivity counts (otherwise the panels just don't render).
    if ((activeTab === 'emails' || activeTab === 'steps') && activeSequenceId) {
      fetchEmails(activeSequenceId);
    }
  }, [activeTab, activeSequenceId]);

  // Reset email/call/reply state when sequence changes
  useEffect(() => {
    setSelectedEmailKeys(new Set());
    setReschedulingKey(null);
    setSelectedCallKeys(new Set());
    setCallReschedulingKey(null);
    setLogCallKey(null);
    setReplyItems([]);
    setReplyClassFilter('all');
  }, [activeSequenceId]);

  const fetchCalls = async (seqId) => {
    if (!seqId) return;
    setCallsLoading(true);
    try {
      const res = await api.get(`/call-activities/sequence/${seqId}`);
      setCallItems(res.data || []);
    } catch (err) {
      console.error('Failed to load calls', err);
      setCallItems([]);
    } finally {
      setCallsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'calls' && activeSequenceId) fetchCalls(activeSequenceId);
  }, [activeTab, activeSequenceId]);

  const fetchReplies = async (seqId) => {
    if (!seqId) return;
    setRepliesLoading(true);
    try {
      const res = await api.get(`/reply-activities/sequence/${seqId}`);
      setReplyItems(res.data || []);
    } catch (err) {
      console.error('Failed to load replies', err);
      setReplyItems([]);
    } finally {
      setRepliesLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'replies' && activeSequenceId) fetchReplies(activeSequenceId);
  }, [activeTab, activeSequenceId]);

  const createSequence = async (e) => {
    e.preventDefault();
    // If the user didn't type anything, fall back to a default name they can
    // rename later. Number suffix keeps multiple defaults distinguishable.
    let name = newSeqName.trim();
    if (!name) {
      const untitledCount = sequences.filter(s => /^Untitled sequence(\s|$)/i.test(s.name || '')).length;
      name = untitledCount === 0 ? 'Untitled sequence' : `Untitled sequence ${untitledCount + 1}`;
    }
    try {
      const res = await api.post('/sequences', { name });
      setNewSeqName('');
      await fetchSequences();
      // Select the newly created sequence so the user can immediately rename / edit it
      if (res?.data?.id) setActiveSequenceId(res.data.id);
      toast(`"${name}" created`, 'success', 2200);
    } catch (err) {
      console.error('[SequenceManager] createSequence failed', err);
      const msg = err.response?.data?.error || err.response?.data?.details || err.response?.data?.message || err.message || 'Failed to create sequence';
      toast(msg, 'error', 6000);
    }
  };

  const deleteSequence = async (seq) => {
    setConfirmDeleteSeqId(null);
    try {
      await api.delete(`/sequences/${seq.id}`);
      if (activeSequenceId === seq.id) setActiveSequenceId(null);
      fetchSequences();
      toast(`"${seq.name}" deleted`, 'info', 2200);
    } catch (err) {
      console.error('[SequenceManager] deleteSequence failed', err);
      const msg = err.response?.data?.details || err.response?.data?.error || err.response?.data?.message || err.message || 'Failed to delete sequence';
      toast(msg, 'error', 6000);
    }
  };

  const cloneSequence = async (seq) => {
    setMenuOpenId(null);
    try {
      await api.post(`/sequences/${seq.id}/clone`);
      fetchSequences();
      toast(`"${seq.name}" cloned`, 'success', 2200);
    } catch (err) {
      toast('Failed to clone sequence', 'error');
    }
  };

  const pauseAllEnrollments = async (seq) => {
    setMenuOpenId(null);
    try {
      const res = await api.post(`/sequences/${seq.id}/pause-all`);
      fetchSequences();
      toast(`${res.data.paused} enrollment${res.data.paused !== 1 ? 's' : ''} paused`, 'info', 2200);
    } catch (err) {
      toast('Failed to pause enrollments', 'error');
    }
  };

  const resumeAllEnrollments = async (seq) => {
    setMenuOpenId(null);
    try {
      const res = await api.post(`/sequences/${seq.id}/resume-all`);
      fetchSequences();
      toast(`${res.data.resumed} enrollment${res.data.resumed !== 1 ? 's' : ''} resumed`, 'success', 2200);
    } catch (err) {
      toast('Failed to resume enrollments', 'error');
    }
  };

  const startRename = (seq) => {
    setRenamingSeqId(seq.id);
    setRenameValue(seq.name);
  };

  const commitRename = async (seqId) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      try {
        await api.put(`/sequences/${seqId}`, { name: trimmed });
        fetchSequences();
        toast('Sequence renamed', 'success', 2000);
      } catch (err) {
        console.error(err);
        toast('Failed to rename sequence', 'error');
      }
    }
    setRenamingSeqId(null);
    setRenameValue('');
  };

  const cancelRename = () => {
    setRenamingSeqId(null);
    setRenameValue('');
  };

  const saveStep = async (e) => {
    e.preventDefault();
    try {
      if (stepForm.id) {
        await api.put(`/sequenceSteps/${stepForm.id}`, {
          order: stepForm.order,
          stepType: stepForm.stepType,
          delayDays: stepForm.delayDays,
          subject: stepForm.subject,
          body: stepForm.body,
          aiPersonalize: !!stepForm.aiPersonalize,
          aiPurpose: stepForm.aiPurpose || null,
          aiInstructions: stepForm.aiInstructions || null,
          aiModel: stepForm.aiModel || null,
          replyToPrevious: !!stepForm.replyToPrevious,
        });
      } else {
        const sequenceSteps = allSteps.filter(s => s.sequenceId === activeSequenceId);
        const nextOrder = sequenceSteps.length > 0 ? Math.max(...sequenceSteps.map(s => s.order)) + 1 : 1;

        await api.post('/sequenceSteps', {
          sequenceId: activeSequenceId,
          order: nextOrder,
          stepType: stepForm.stepType,
          delayDays: stepForm.delayDays,
          subject: stepForm.subject,
          body: stepForm.body,
          aiPersonalize: !!stepForm.aiPersonalize,
          aiPurpose: stepForm.aiPurpose || null,
          aiInstructions: stepForm.aiInstructions || null,
          aiModel: stepForm.aiModel || null,
          replyToPrevious: !!stepForm.replyToPrevious,
        });
      }
      setIsAddingStep(false);
      setStepForm({ id: null, order: null, stepType: 'AUTO_EMAIL', delayDays: 1, subject: '', body: '', aiPersonalize: false, aiPurpose: '', aiInstructions: '', aiModel: '', replyToPrevious: false });
      fetchSequences();
      toast(stepForm.id ? 'Step updated' : 'Step added', 'success', 2000);
    } catch (err) {
      console.error(err);
      toast('Failed to save step', 'error');
    }
  };

  const deleteStep = async (stepId) => {
    try {
      await api.delete(`/sequenceSteps/${stepId}`);
      fetchSequences();
      toast('Step deleted', 'info', 2000);
    } catch (err) {
      console.error(err);
      toast('Failed to delete step', 'error');
    }
  };

  const duplicateStep = async (step) => {
    const sequenceSteps = allSteps.filter(s => s.sequenceId === activeSequenceId);
    const nextOrder = sequenceSteps.length > 0 ? Math.max(...sequenceSteps.map(s => s.order)) + 1 : 1;
    try {
      await api.post('/sequenceSteps', {
        sequenceId: activeSequenceId,
        order: nextOrder,
        stepType: step.stepType || 'AUTO_EMAIL',
        delayDays: step.delayDays,
        subject: step.subject,
        body: step.body,
        aiPersonalize: !!step.aiPersonalize,
        aiPurpose: step.aiPurpose || '',
        aiInstructions: step.aiInstructions || '',
        aiModel: step.aiModel || '',
      });
      fetchSequences();
      toast('Step duplicated', 'success', 2000);
    } catch (err) {
      console.error(err);
      toast('Failed to duplicate step', 'error');
    }
  };

  const handleEnrollProspect = async (prospectId) => {
    setIsEnrolling(true);
    try {
      await api.post(`/sequences/${activeSequenceId}/enroll`, { prospectIds: [prospectId] });
      fetchSequences();
      toast('Prospect enrolled', 'success', 2200);
    } catch (err) {
      console.error('Enrollment failed', err);
      toast('Enrollment failed', 'error');
    } finally {
      setIsEnrolling(false);
    }
  };

  const handleBulkEnroll = async () => {
    if (bulkSelected.size === 0) return;
    const count = bulkSelected.size;
    setIsEnrolling(true);
    try {
      await api.post(`/sequences/${activeSequenceId}/enroll`, { prospectIds: [...bulkSelected] });
      setBulkSelected(new Set());
      setBulkMode(false);
      fetchSequences();
      toast(`${count} prospect${count !== 1 ? 's' : ''} enrolled`, 'success');
    } catch (err) {
      console.error('Bulk enrollment failed', err);
      toast('Bulk enrollment failed', 'error');
    } finally {
      setIsEnrolling(false);
    }
  };

  const handleEnrollmentAction = async (enrollment, action) => {
    const seqId = activeSequenceId;
    const pid = enrollment.prospectId || enrollment.prospect?.id;
    const name = enrollment.prospect ? `${enrollment.prospect.firstName} ${enrollment.prospect.lastName}` : 'Prospect';
    try {
      if (action === 'opt_out') await api.post(`/sequences/${seqId}/opt-out/${pid}`);
      else if (action === 'pause')  await api.post(`/sequences/${seqId}/pause/${pid}`);
      else if (action === 'resume') await api.post(`/sequences/${seqId}/resume/${pid}`);
      else if (action === 'remove') await api.delete(`/sequences/${seqId}/enroll/${pid}`);
      fetchSequences();
      const actionLabels = { opt_out: 'opted out', pause: 'paused', resume: 'resumed', remove: 'removed' };
      toast(`${name} ${actionLabels[action] || action}`, 'info', 2200);
    } catch (err) {
      console.error('Enrollment action failed', err);
      toast('Action failed — please try again', 'error');
    }
  };

  const emailKey = (item) => item.type === 'scheduled' ? `enrollment-${item.enrollmentId}` : `activity-${item.id}`;

  const handleEmailCancel = async (item) => {
    try {
      if (item.type === 'scheduled') {
        await api.patch(`/email-activities/enrollment/${item.enrollmentId}/cancel`);
      } else {
        await api.patch(`/email-activities/${item.id}/cancel`);
      }
      toast('Email cancelled', 'info', 2000);
      fetchEmails(activeSequenceId);
    } catch (err) {
      toast('Failed to cancel email', 'error');
    }
  };

  const handleEmailRetry = async (item) => {
    try {
      await api.patch(`/email-activities/enrollment/${item.enrollmentId}/retry`);
      toast('Retry scheduled — will send on next cron run', 'success', 3000);
      fetchEmails(activeSequenceId);
    } catch (err) {
      toast('Failed to retry', 'error');
    }
  };

  const handleEmailReschedule = async (item) => {
    if (!rescheduleDate) return;
    try {
      // datetime-local input gives a local-time string with no timezone
      // suffix. new Date() in the browser interprets it as local, and
      // .toISOString() converts to a proper UTC ISO string the backend can
      // store unambiguously. Without this, the backend (running in UTC)
      // would parse "2026-06-02T14:00" AS UTC, shifting the time wrong on
      // every save.
      const isoUtc = new Date(rescheduleDate).toISOString();
      await api.patch(`/email-activities/enrollment/${item.enrollmentId}/reschedule`, { scheduledFor: isoUtc });
      toast('Email rescheduled', 'success', 2000);
      setReschedulingKey(null);
      setRescheduleDate('');
      fetchEmails(activeSequenceId);
    } catch (err) {
      toast('Failed to reschedule', 'error');
    }
  };

  const handleBulkEmailCancel = async () => {
    const keys = Array.from(selectedEmailKeys);
    const items = emailItems.filter(it => keys.includes(emailKey(it)));
    try {
      await Promise.all(items.map(it => {
        if (it.type === 'scheduled') return api.patch(`/email-activities/enrollment/${it.enrollmentId}/cancel`);
        return api.patch(`/email-activities/${it.id}/cancel`);
      }));
      setSelectedEmailKeys(new Set());
      toast(`${items.length} email${items.length !== 1 ? 's' : ''} cancelled`, 'info');
      fetchEmails(activeSequenceId);
    } catch (err) {
      toast('Failed to cancel some emails', 'error');
    }
  };

  // ── Call handlers ──────────────────────────────────────────────────────────
  const callKey = (item) => item.type === 'planned' ? `enrollment-${item.enrollmentId}` : `activity-${item.id}`;

  const handleCallReschedule = async (item) => {
    if (!callRescheduleDate) return;
    try {
      // Same local-time → UTC ISO conversion as email reschedule.
      const isoUtc = new Date(callRescheduleDate).toISOString();
      await api.patch(`/call-activities/enrollment/${item.enrollmentId}/reschedule`, { scheduledFor: isoUtc });
      toast('Call rescheduled', 'success', 2000);
      setCallReschedulingKey(null);
      setCallRescheduleDate('');
      fetchCalls(activeSequenceId);
    } catch (err) {
      toast('Failed to reschedule call', 'error');
    }
  };

  const handleCallCancel = async (item) => {
    try {
      await api.patch(`/call-activities/enrollment/${item.enrollmentId}/cancel`);
      toast('Call cancelled', 'info', 2000);
      fetchCalls(activeSequenceId);
    } catch (err) {
      toast('Failed to cancel call', 'error');
    }
  };

  const handleCallSkip = async (item) => {
    try {
      await api.patch(`/call-activities/enrollment/${item.enrollmentId}/skip`, {
        stepOrder: item.sequenceStep?.order,
        sequenceStepId: item.sequenceStep?.id,
        prospectId: item.prospect?.id,
        notes: 'Skipped by user',
      });
      toast('Call skipped — enrollment advanced', 'info', 2000);
      fetchCalls(activeSequenceId);
    } catch (err) {
      toast('Failed to skip call', 'error');
    }
  };

  const handleLogCall = async (item) => {
    try {
      await api.post('/call-activities', {
        enrollmentId: item.enrollmentId,
        sequenceStepId: item.sequenceStep?.id,
        prospectId: item.prospect?.id,
        stepOrder: item.sequenceStep?.order,
        status: callLogForm.outcome === 'skipped' ? 'skipped' : 'completed',
        outcome: callLogForm.outcome,
        durationSecs: callLogForm.durationSecs ? parseInt(callLogForm.durationSecs) : null,
        notes: callLogForm.notes || null,
      });
      toast('Call logged', 'success', 2000);
      setLogCallKey(null);
      setCallLogForm({ outcome: 'connected', durationSecs: '', notes: '' });
      fetchCalls(activeSequenceId);
    } catch (err) {
      toast('Failed to log call', 'error');
    }
  };

  const handleBulkCallCancel = async () => {
    const keys = Array.from(selectedCallKeys);
    const items = callItems.filter(it => keys.includes(callKey(it)) && it.status === 'planned');
    try {
      await Promise.all(items.map(it => api.patch(`/call-activities/enrollment/${it.enrollmentId}/cancel`)));
      setSelectedCallKeys(new Set());
      toast(`${items.length} call${items.length !== 1 ? 's' : ''} cancelled`, 'info');
      fetchCalls(activeSequenceId);
    } catch (err) {
      toast('Failed to cancel some calls', 'error');
    }
  };

  const activeSequence = sequences.find(s => s.id === activeSequenceId);
  const activeSteps = allSteps
    .filter(s => s.sequenceId === activeSequenceId)
    .sort((a, b) => a.order - b.order);

  // Live reorder preview during drag — shifts other items out of the way as the user drags
  const displaySteps = useMemo(() => {
    if (!dragId || !dragOverId || dragId === dragOverId) return activeSteps;
    const fromIdx = activeSteps.findIndex(s => s.id === dragId);
    const toIdx   = activeSteps.findIndex(s => s.id === dragOverId);
    if (fromIdx === -1 || toIdx === -1) return activeSteps;
    const r = [...activeSteps];
    const [moved] = r.splice(fromIdx, 1);
    r.splice(toIdx, 0, moved);
    return r;
  }, [activeSteps, dragId, dragOverId]);

  // Cadence stats for right pane
  const totalCadenceDays = activeSteps.reduce((acc, s) => acc + (s.delayDays || 0), 0);

  // Enrollment breakdown counts
  const enrollments = activeSequence?.prospectEnrollments || [];
  const enrollmentCounts = {
    active:    enrollments.filter(e => e.status === 'active').length,
    paused:    enrollments.filter(e => e.status === 'paused').length,
    completed: enrollments.filter(e => e.status === 'completed').length,
    opted_out: enrollments.filter(e => e.status === 'opted_out').length,
  };

  // Step timeline (cumulative days)
  const stepTimeline = activeSteps.reduce((acc, step, i) => {
    const prevDay = i === 0 ? 0 : acc[i - 1].day;
    acc.push({ step, day: prevDay + (i === 0 ? 0 : step.delayDays) });
    return acc;
  }, []);

  const handleDragStart = (e, stepId) => {
    setDragId(stepId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, stepId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (stepId !== dragOverId) setDragOverId(stepId);
  };

  const handleDrop = async (e, dropId) => {
    e.preventDefault();
    const fromId = dragId;
    setDragId(null);
    setDragOverId(null);

    if (!fromId || fromId === dropId) return;

    // displaySteps already has the final reordered state — use it directly
    const updated = displaySteps.map((step, i) => ({ ...step, order: i + 1 }));

    setAllSteps(prev => {
      const others = prev.filter(s => s.sequenceId !== activeSequenceId);
      return [...others, ...updated];
    });

    const results = await Promise.allSettled(
      updated.map(step =>
        api.put(`/sequenceSteps/${step.id}`, {
          order: step.order,
          stepType: step.stepType,
          delayDays: step.delayDays,
          subject: step.subject,
          body: step.body,
        })
      )
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) toast('Step order may not have saved — please refresh', 'warning');
  };

  const handleDragEnd = () => {
    setDragId(null);
    setDragOverId(null);
  };

  return (
    <div className="split-pane">
      {/* LEFT PANE - SEQUENCE LIST */}
      <div className="left-pane glass-card" style={{ flex: '0 0 300px' }}>
        <h3>Sequences</h3>

        <form onSubmit={createSequence} style={{ marginTop: 12, marginBottom: 14, display: 'flex', gap: 8 }}>
          <input
            placeholder="New sequence name (optional)"
            value={newSeqName}
            onChange={(e) => setNewSeqName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" style={{ padding: '8px' }} title="Leave blank to create as 'Untitled sequence' — rename anytime">+</button>
        </form>

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            {[1,2,3].map(i => <div key={i} className="skeleton" style={{ height: 52, borderRadius: 'var(--radius-sm)' }} />)}
          </div>
        ) : null}
        {!loading && sequences.length === 0 && (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
            <div style={{ fontSize: '1.8rem', marginBottom: 8, opacity: 0.3 }}>✉️</div>
            No sequences yet.<br />Create one above to get started.
          </div>
        )}
        <ul style={{ display: loading ? 'none' : 'flex', flexDirection: 'column', gap: 4 }}>
          {sequences.map(seq => {
            const stepCount = allSteps.filter(s => s.sequenceId === seq.id).length;
            const enrollCount = seq.prospectEnrollments?.length || 0;
            const isActive = seq.id === activeSequenceId;
            const isHovered = hoveredSeqId === seq.id;
            const isRenaming = renamingSeqId === seq.id;
            return (
              <li
                key={seq.id}
                onClick={() => { if (!isRenaming) setActiveSequenceId(seq.id); }}
                onMouseEnter={() => setHoveredSeqId(seq.id)}
                onMouseLeave={() => setHoveredSeqId(null)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  backgroundColor: isActive ? 'var(--accent-dim)' : 'transparent',
                  border: `1px solid ${isActive ? 'var(--border-accent)' : 'transparent'}`,
                  transition: 'all var(--transition-fast)',
                  position: 'relative',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(seq.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(seq.id); }
                        if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                      }}
                      onClick={e => e.stopPropagation()}
                      style={{ flex: 1, fontWeight: 600, fontSize: '0.855rem', padding: '2px 6px', marginRight: 6 }}
                    />
                  ) : (
                    <div
                      style={{ fontWeight: 600, fontSize: '0.855rem', color: isActive ? 'var(--accent-secondary)' : 'var(--text-primary)', flex: 1 }}
                      onClick={e => {
                        if (isActive) {
                          e.stopPropagation();
                          startRename(seq);
                        }
                      }}
                      title={isActive ? 'Click to rename' : undefined}
                    >
                      {seq.name}
                    </div>
                  )}
                  {/* Three-dot menu */}
                  {!isRenaming && (
                    <div style={{ position: 'relative', flexShrink: 0 }} ref={menuOpenId === seq.id ? menuRef : null} onClick={e => e.stopPropagation()}>
                      <button
                        className="ghost"
                        onClick={e => { e.stopPropagation(); setMenuOpenId(prev => prev === seq.id ? null : seq.id); }}
                        style={{ fontSize: '1rem', padding: '1px 6px', lineHeight: 1, color: 'var(--text-muted)', opacity: isHovered || menuOpenId === seq.id ? 1 : 0, transition: 'opacity 0.15s' }}
                        title="More options"
                      >
                        ⋯
                      </button>
                      {menuOpenId === seq.id && (
                        <div style={{
                          position: 'absolute', top: '100%', right: 0, zIndex: 200,
                          background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                          borderRadius: 'var(--radius-md)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                          minWidth: 168, padding: '4px 0', marginTop: 4,
                        }}>
                          {/* Rename */}
                          <button
                            className="ghost"
                            onClick={() => { setMenuOpenId(null); startRename(seq); setActiveSequenceId(seq.id); }}
                            style={{ width: '100%', textAlign: 'left', padding: '7px 14px', fontSize: '0.82rem', borderRadius: 0, color: 'var(--text-primary)' }}
                          >
                            ✎ Rename
                          </button>
                          {/* Pause / Resume all */}
                          {(() => {
                            const activeCount = seq.prospectEnrollments?.filter(e => e.status === 'active').length || 0;
                            const pausedCount = seq.prospectEnrollments?.filter(e => e.status === 'paused').length || 0;
                            return activeCount > 0 ? (
                              <button
                                className="ghost"
                                onClick={() => pauseAllEnrollments(seq)}
                                style={{ width: '100%', textAlign: 'left', padding: '7px 14px', fontSize: '0.82rem', borderRadius: 0, color: 'var(--status-warning)' }}
                              >
                                ⏸ Pause all ({activeCount})
                              </button>
                            ) : pausedCount > 0 ? (
                              <button
                                className="ghost"
                                onClick={() => resumeAllEnrollments(seq)}
                                style={{ width: '100%', textAlign: 'left', padding: '7px 14px', fontSize: '0.82rem', borderRadius: 0, color: 'var(--status-success)' }}
                              >
                                ▶ Resume all ({pausedCount})
                              </button>
                            ) : null;
                          })()}
                          {/* Clone */}
                          <button
                            className="ghost"
                            onClick={() => cloneSequence(seq)}
                            style={{ width: '100%', textAlign: 'left', padding: '7px 14px', fontSize: '0.82rem', borderRadius: 0, color: 'var(--text-primary)' }}
                          >
                            ⎘ Clone sequence
                          </button>
                          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
                          {/* Delete */}
                          {confirmDeleteSeqId === seq.id ? (
                            <div style={{ padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Delete "{seq.name}"?</span>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button className="danger" onClick={() => deleteSequence(seq)} style={{ fontSize: '0.75rem', padding: '3px 10px', flex: 1 }}>Delete</button>
                                <button className="ghost" onClick={() => setConfirmDeleteSeqId(null)} style={{ fontSize: '0.75rem', padding: '3px 8px', color: 'var(--text-muted)' }}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <button
                              className="ghost"
                              onClick={() => setConfirmDeleteSeqId(seq.id)}
                              style={{ width: '100%', textAlign: 'left', padding: '7px 14px', fontSize: '0.82rem', borderRadius: 0, color: 'var(--status-danger)' }}
                            >
                              🗑 Delete
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: 10 }}>
                  <span>{stepCount} steps</span>
                  {enrollCount > 0 && <span style={{ color: 'var(--status-info)' }}>{enrollCount} enrolled</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* CENTER PANE - VISUAL WATERFALL */}
      <div className="center-pane glass-card" style={{ flex: 1, overflowY: 'auto' }}>
        {activeSequence ? (
          <>
            <div style={{ paddingBottom: 14, borderBottom: '1px solid var(--border-color)', marginBottom: 18 }}>
              <h2>{activeSequence.name}</h2>
              <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
                <button className={`tab-btn${activeTab === 'steps' ? ' active' : ''}`} onClick={() => setActiveTab('steps')}>
                  Sequence Steps
                </button>
                <button className={`tab-btn${activeTab === 'prospects' ? ' active' : ''}`} onClick={() => setActiveTab('prospects')}>
                  Enrolled Prospects
                  <span className="count-pill" style={{ marginLeft: 6 }}>{activeSequence.prospectEnrollments?.length || 0}</span>
                </button>
                <button className={`tab-btn${activeTab === 'emails' ? ' active' : ''}`} onClick={() => setActiveTab('emails')}>
                  Emails
                  {emailItems.length > 0 && (
                    <span className="count-pill" style={{ marginLeft: 6 }}>{emailItems.length}</span>
                  )}
                </button>
                <button className={`tab-btn${activeTab === 'calls' ? ' active' : ''}`} onClick={() => setActiveTab('calls')}>
                  Calls
                  {callItems.length > 0 && (
                    <span className="count-pill" style={{ marginLeft: 6 }}>{callItems.length}</span>
                  )}
                </button>
                <button className={`tab-btn${activeTab === 'replies' ? ' active' : ''}`} onClick={() => setActiveTab('replies')}>
                  Replies
                  {replyItems.length > 0 && (
                    <span className="count-pill" style={{ marginLeft: 6, background: replyItems.some(r => r.classification === 'ooo') ? 'var(--status-warning-dim)' : undefined, color: replyItems.some(r => r.classification === 'ooo') ? 'var(--status-warning)' : undefined }}>{replyItems.length}</span>
                  )}
                </button>
              </div>
            </div>

            {activeTab === 'steps' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'relative' }}>
                {/* Vertical line connecting steps */}
                <div style={{ position: 'absolute', left: '20px', top: '24px', bottom: '0', width: '2px', backgroundColor: 'var(--border-color)', zIndex: 0 }}></div>

                {displaySteps.map((step, index) => {
                  const cfg = STEP_TYPE_CONFIG[step.stepType || 'AUTO_EMAIL'];
                  const isEditing = isAddingStep && stepForm.id === step.id;
                  const isDragging = dragId === step.id;
                  const isDropTarget = dragOverId === step.id && dragId !== step.id;
                  const cumulativeDay = displaySteps.slice(0, index + 1).reduce((acc, s) => acc + s.delayDays, 0);

                  return (
                    <div
                      key={step.id}
                      draggable={!isEditing}
                      onDragStart={(e) => handleDragStart(e, step.id)}
                      onDragOver={(e) => handleDragOver(e, step.id)}
                      onDrop={(e) => handleDrop(e, step.id)}
                      onDragEnd={handleDragEnd}
                      style={{
                        display: 'flex', gap: 16, position: 'relative', zIndex: 1,
                        opacity: isDragging ? 0.35 : 1,
                        transform: isDragging ? 'scale(0.98)' : 'scale(1)',
                        transition: 'opacity 0.12s, transform 0.12s',
                      }}
                    >
                      {/* Timeline node */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 40, flexShrink: 0 }}>
                        <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: cfg.color, marginTop: 14, flexShrink: 0 }} />
                        {index > 0 && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 3, whiteSpace: 'nowrap' }}>
                            +{step.delayDays}d
                          </div>
                        )}
                      </div>

                      {/* Step Card */}
                      <div style={{
                        flex: 1,
                        backgroundColor: 'var(--bg-tertiary)',
                        padding: 14,
                        borderRadius: 'var(--radius-md)',
                        border: isDropTarget
                          ? '2px solid var(--accent-primary)'
                          : isEditing
                            ? '1px solid var(--accent-primary)'
                            : '1px solid var(--border-color)',
                        boxShadow: isDropTarget ? '0 0 0 3px var(--accent-soft)' : 'none',
                        transition: 'border-color 0.12s, box-shadow 0.12s',
                      }}>
                        {isEditing ? (
                          /* ── Inline edit form ── */
                          <>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                              <h4 style={{ margin: 0, fontSize: '0.9rem' }}>Edit Step {step.order}</h4>
                              <button
                                type="button"
                                className="ghost"
                                style={{ fontSize: '0.72rem', color: 'var(--text-muted)', padding: '2px 6px' }}
                                onClick={() => { setIsAddingStep(false); setStepForm({ id: null, order: null, stepType: 'AUTO_EMAIL', delayDays: 1, subject: '', body: '', aiPersonalize: false, aiPurpose: '', aiInstructions: '', aiModel: '', replyToPrevious: false }); }}
                              >
                                ✕ Cancel
                              </button>
                            </div>
                            {['AUTO_EMAIL','MANUAL_EMAIL'].includes(stepForm.stepType) && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'var(--accent-dim)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-accent)', marginBottom: 12 }}>
                                <span style={{ fontSize: '0.75rem', color: 'var(--accent-light)', fontWeight: 600 }}>Personalise:</span>
                                {['{{firstName}}','{{lastName}}','{{company}}','{{title}}'].map(tag => (
                                  <code key={tag} style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 3, fontSize: '0.72rem', cursor: 'pointer', userSelect: 'all', color: 'var(--text-primary)' }}>{tag}</code>
                                ))}
                              </div>
                            )}
                            <form onSubmit={saveStep} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                              <div>
                                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Step Type</label>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                  {Object.entries(STEP_TYPE_CONFIG).map(([key, c]) => {
                                    const sel = stepForm.stepType === key;
                                    return (
                                      <button key={key} type="button" onClick={() => setStepForm({...stepForm, stepType: key})}
                                        style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:'0.82rem', fontWeight: sel ? 700 : 500, padding:'6px 13px', borderRadius:'var(--radius-full)', cursor:'pointer', transition:'all var(--transition-fast)',
                                          color: sel ? c.color : 'var(--text-muted)', background: sel ? c.bg : 'var(--bg-primary)', border:`1px solid ${sel ? c.border : 'var(--border-color)'}` }}>
                                        {c.icon} {c.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                              {/* Step type workflow note */}
                              {stepForm.stepType === 'AUTO_EMAIL' && (
                                <div style={{ padding: '8px 11px', background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--accent-secondary)', lineHeight: 1.5 }}>
                                  <strong>Auto Email</strong> — sent automatically by the scheduler once the wait period passes. Write your template below; first name, company, and title are personalised at send time. Sent emails appear in the Emails tab.
                                </div>
                              )}
                              {stepForm.stepType === 'MANUAL_EMAIL' && (
                                <div style={{ padding: '8px 11px', background: 'var(--status-info-dim)', border: '1px solid var(--status-info-border)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--status-info)', lineHeight: 1.5 }}>
                                  <strong>Manual Email</strong> — the scheduler flags this for your review. It will appear in the Emails tab as "Scheduled" — you send it yourself after checking the content.
                                </div>
                              )}
                              {stepForm.stepType === 'CALL' && (
                                <div style={{ padding: '8px 11px', background: 'var(--status-success-dim)', border: '1px solid var(--status-success-border)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--status-success)', lineHeight: 1.5 }}>
                                  <strong>Call</strong> — appears as a call task in the Calls tab when it's due. Log the outcome there (connected, voicemail, etc.) to advance the prospect to the next step.
                                </div>
                              )}
                              {(stepForm.stepType === 'LINKEDIN' || stepForm.stepType === 'TASK') && (
                                <div style={{ padding: '8px 11px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                  <strong>{stepForm.stepType === 'LINKEDIN' ? 'LinkedIn' : 'Task'}</strong> — appears in the Task Inbox when due. Mark it complete there to advance the sequence.
                                </div>
                              )}
                              <div>
                                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Wait Days</label>
                                <input type="number" min="0" value={stepForm.delayDays} onChange={e => setStepForm({...stepForm, delayDays: Number(e.target.value)})} style={{ width: '100%', marginTop: 4 }} />
                              </div>
                              {['AUTO_EMAIL','MANUAL_EMAIL'].includes(stepForm.stepType) ? (
                                <>
                                  <div>
                                    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Subject</label>
                                    <input value={stepForm.subject} onChange={e => setStepForm({...stepForm, subject: e.target.value})} placeholder="e.g. Quick question for {{firstName}}" style={{ width: '100%', marginTop: 4 }} />
                                  </div>
                                  <div>
                                    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Body Template</label>
                                    <div style={{ marginTop: 4 }}>
                                      <RichTextEditor
                                        value={stepForm.body}
                                        resetKey={stepForm.id || 'new'}
                                        onChange={v => setStepForm({ ...stepForm, body: v })}
                                        placeholder={"Hi {{firstName}},\n\nUse the toolbar to format. Paste from Word / Outlook / Docs to keep bold, links, lists, etc."}
                                        style={{ minHeight: 160 }}
                                      />
                                    </div>
                                  </div>

                                  {/* Reply-in-thread toggle */}
                                  <div style={{ marginTop: 4, padding: '10px 12px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={!!stepForm.replyToPrevious}
                                        onChange={e => setStepForm({ ...stepForm, replyToPrevious: e.target.checked })}
                                      />
                                      ↪ Send as reply to the previous email in this sequence
                                    </label>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
                                      When on, this step sends in the same Outlook thread as the most recent sent step (subject becomes "Re: …" automatically). Best for short follow-ups / bumps. The AI personalizer adapts to write a concise follow-up note instead of repeating the original pitch.
                                    </div>
                                  </div>

                                  {/* AI personalization toggle + fields */}
                                  <div style={{ marginTop: 4, padding: '10px 12px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={!!stepForm.aiPersonalize}
                                        onChange={e => setStepForm({ ...stepForm, aiPersonalize: e.target.checked })}
                                      />
                                      ✨ AI-personalize each email using prospect &amp; account research (drafts go to review queue)
                                    </label>
                                    {stepForm.aiPersonalize && (
                                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                                        <div>
                                          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Intent (one line)</label>
                                          <input
                                            value={stepForm.aiPurpose}
                                            onChange={e => setStepForm({ ...stepForm, aiPurpose: e.target.value })}
                                            placeholder="e.g. Cold open for a Mining CFO. Personalize opener around any recent strategic shift or stated priority."
                                            style={{ width: '100%', marginTop: 4 }}
                                          />
                                        </div>
                                        <div>
                                          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Voice / Style / Constraints</label>
                                          <textarea
                                            value={stepForm.aiInstructions}
                                            onChange={e => setStepForm({ ...stepForm, aiInstructions: e.target.value })}
                                            placeholder="Tone, length, and rules. e.g. Direct, peer-to-peer. Match the template's length — do not summarize the pitch. Bridge sentence after opener must mention the prospect's stated priority."
                                            style={{ width: '100%', marginTop: 4, minHeight: 80, resize: 'vertical' }}
                                          />
                                        </div>
                                        <div>
                                          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Model override (optional)</label>
                                          <input
                                            value={stepForm.aiModel}
                                            onChange={e => setStepForm({ ...stepForm, aiModel: e.target.value })}
                                            placeholder="default: gemini-2.5-pro · alternatives: gemini-2.5-flash · claude-opus-4-7 · claude-sonnet-4-6"
                                            style={{ width: '100%', marginTop: 4, fontFamily: 'monospace', fontSize: '0.78rem' }}
                                          />
                                        </div>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                          The AI <strong>personalizes the opener</strong> against your body template — it does NOT rewrite the pitch. Product names, customer name-drops, benefits, and the CTA from your template are preserved. Only the opening hook (and one bridge sentence) get re-written per prospect.
                                          <br/>
                                          Drafts queue in the <a href="/hitl" style={{ color: 'var(--accent-secondary)' }}>AI Review Queue</a> up to 7 days before send time so you can edit, regenerate, or skip before approval.
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div>
                                    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{stepForm.stepType === 'CALL' ? 'Call Objective' : stepForm.stepType === 'LINKEDIN' ? 'LinkedIn Action' : 'Task Title'}</label>
                                    <input value={stepForm.subject} onChange={e => setStepForm({...stepForm, subject: e.target.value})} placeholder={stepForm.stepType === 'CALL' ? 'e.g. Discovery call with {{firstName}}' : 'e.g. Connect on LinkedIn'} style={{ width: '100%', marginTop: 4 }} />
                                  </div>
                                  <div>
                                    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Notes / Script</label>
                                    <textarea value={stepForm.body} onChange={e => setStepForm({...stepForm, body: e.target.value})} placeholder="Talking points or context..." style={{ width: '100%', marginTop: 4, minHeight: 80, resize: 'vertical' }} />
                                  </div>
                                </>
                              )}
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button type="submit" style={{ flex: 1 }}>Save Step</button>
                                <button type="button" className="secondary" onClick={() => { setIsAddingStep(false); setStepForm({ id: null, order: null, stepType: 'AUTO_EMAIL', delayDays: 1, subject: '', body: '', aiPersonalize: false, aiPurpose: '', aiInstructions: '', aiModel: '', replyToPrevious: false }); }}>Cancel</button>
                              </div>
                            </form>
                          </>
                        ) : (
                          /* ── Step view ── */
                          <>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span title="Drag to reorder" style={{ cursor: 'grab', color: 'var(--text-muted)', fontSize: '1rem', userSelect: 'none' }}>⠿</span>
                                <span style={{ fontWeight: 600, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>Step {index + 1}</span>
                                <span style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:'0.72rem', fontWeight:700, padding:'2px 7px', borderRadius:'var(--radius-full)', color: cfg.color, background: cfg.bg, border:`1px solid ${cfg.border}` }}>
                                  {cfg.icon} {cfg.label}
                                </span>
                              </div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                  {cumulativeDay === 0 ? 'Immediate' : `Day ${cumulativeDay}`}
                                </span>
                                <button className="ghost" style={{ fontSize: '0.72rem', padding: '2px 7px' }} onClick={() => { setStepForm({ ...step, aiPersonalize: !!step.aiPersonalize, aiPurpose: step.aiPurpose || '', aiInstructions: step.aiInstructions || '', aiModel: step.aiModel || '', replyToPrevious: !!step.replyToPrevious }); setIsAddingStep(true); }}>Edit</button>
                                <button className="ghost" style={{ fontSize: '0.72rem', padding: '2px 7px' }} onClick={() => duplicateStep(step)}>Dupe</button>
                                <button className="ghost" style={{ fontSize: '0.72rem', padding: '2px 7px', color: 'var(--status-danger)' }} onClick={() => deleteStep(step.id)}>Delete</button>
                              </div>
                            </div>

                            {step.subject && (
                              <div style={{ marginBottom: step.body ? 6 : 0, fontSize: '0.84rem' }}>
                                <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginRight: 5 }}>
                                  {['AUTO_EMAIL','MANUAL_EMAIL'].includes(step.stepType || 'AUTO_EMAIL') ? 'Subject:' : step.stepType === 'CALL' ? 'Objective:' : step.stepType === 'LINKEDIN' ? 'Action:' : 'Task:'}
                                </span>
                                <span style={{ color: 'var(--text-primary)' }}>{step.subject}</span>
                              </div>
                            )}
                            {step.body && (
                              /<(p|div|br|ul|ol|li|strong|b|em|i|u|a|span|h[1-6])\b/i.test(step.body) ? (
                                // Rich-text bodies render as HTML so bold,
                                // links, lists, etc. show as they will in the
                                // actual email.
                                <div
                                  style={{ backgroundColor: 'var(--bg-primary)', padding: '8px 10px', borderRadius: 'var(--radius-sm)', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}
                                  dangerouslySetInnerHTML={{ __html: step.body }}
                                />
                              ) : (
                                <div style={{ backgroundColor: 'var(--bg-primary)', padding: '8px 10px', borderRadius: 'var(--radius-sm)', fontSize: '0.82rem', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                                  {step.body}
                                </div>
                              )
                            )}
                            {/* Per-step stats: only render when we have real EmailActivity
                                counts for this step in emailItems. Honest empty otherwise. */}
                            {['AUTO_EMAIL','MANUAL_EMAIL'].includes(step.stepType || 'AUTO_EMAIL') && (() => {
                              const acts = emailItems.filter(it => it.type === 'activity' && it.sequenceStepId === step.id);
                              if (acts.length === 0) return null;
                              const sent   = acts.filter(a => a.status === 'sent' || a.status === 'opened').length;
                              const opened = acts.filter(a => a.status === 'opened').length;
                              const failed = acts.filter(a => a.status === 'failed').length;
                              const openRate = sent > 0 ? Math.round((opened / sent) * 100) : 0;
                              return (
                                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:0, marginTop:10, borderTop:'1px solid var(--border-subtle)', paddingTop:8 }}>
                                  {[
                                    { label:'Sent',   value: sent,                  color:'var(--text-secondary)' },
                                    { label:'Opened', value: `${openRate}%`,        color: sent === 0 ? 'var(--text-muted)' : openRate >= 40 ? 'var(--status-success)' : openRate >= 25 ? 'var(--status-warning)' : 'var(--status-danger)' },
                                    { label:'Failed', value: failed,                color: failed > 0 ? 'var(--status-danger)' : 'var(--text-secondary)' },
                                  ].map(({ label, value, color }, i, arr) => (
                                    <div key={label} style={{ textAlign:'center', borderRight: i < arr.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                                      <div style={{ fontSize:'0.62rem', color:'var(--text-muted)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:2 }}>{label}</div>
                                      <div style={{ fontSize:'0.85rem', fontWeight:700, color }}>{value}</div>
                                    </div>
                                  ))}
                                </div>
                              );
                            })()}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}

              {/* Add New Step — only shown when NOT editing an existing step */}
              <div style={{ display: 'flex', gap: 16, position: 'relative', zIndex: 1, marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'center', width: 40, flexShrink: 0 }}>
                  <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--text-muted)', backgroundColor: 'var(--bg-glass)', marginTop: 12 }} />
                </div>

                <div style={{ flex: 1 }}>
                  {/* Show "Add New Step" button only when the form isn't open for a new step */}
                  {(!isAddingStep || stepForm.id !== null) ? (
                    <button
                      className="secondary"
                      onClick={() => { setStepForm({ id: null, order: null, stepType: 'AUTO_EMAIL', delayDays: 1, subject: '', body: '', aiPersonalize: false, aiPurpose: '', aiInstructions: '', aiModel: '', replyToPrevious: false }); setIsAddingStep(true); }}
                      style={{ borderStyle: 'dashed', width: '100%', justifyContent: 'center', backgroundColor: 'transparent' }}
                    >
                      + Add New Step
                    </button>
                  ) : (
                    /* New step form */
                    <div style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--accent-primary)', padding: 16, borderRadius: 'var(--radius-md)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <h4 style={{ margin: 0, fontSize: '0.9rem' }}>New Step</h4>
                        <button type="button" className="ghost" style={{ fontSize: '0.72rem', color: 'var(--text-muted)', padding: '2px 6px' }} onClick={() => { setIsAddingStep(false); setStepForm({ id: null, order: null, stepType: 'AUTO_EMAIL', delayDays: 1, subject: '', body: '', aiPersonalize: false, aiPurpose: '', aiInstructions: '', aiModel: '', replyToPrevious: false }); }}>✕ Cancel</button>
                      </div>
                      {['AUTO_EMAIL','MANUAL_EMAIL'].includes(stepForm.stepType) && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'var(--accent-dim)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-accent)', marginBottom: 12 }}>
                          <span style={{ fontSize: '0.75rem', color: 'var(--accent-light)', fontWeight: 600 }}>Personalise:</span>
                          {['{{firstName}}','{{lastName}}','{{company}}','{{title}}'].map(tag => (
                            <code key={tag} style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 3, fontSize: '0.72rem', cursor: 'pointer', userSelect: 'all', color: 'var(--text-primary)' }}>{tag}</code>
                          ))}
                        </div>
                      )}
                      <form onSubmit={saveStep} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                          <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Step Type</label>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {Object.entries(STEP_TYPE_CONFIG).map(([key, cfg]) => {
                              const sel = stepForm.stepType === key;
                              return (
                                <button key={key} type="button" onClick={() => setStepForm({...stepForm, stepType: key})}
                                  style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:'0.82rem', fontWeight: sel ? 700 : 500, padding:'6px 13px', borderRadius:'var(--radius-full)', cursor:'pointer', transition:'all var(--transition-fast)',
                                    color: sel ? cfg.color : 'var(--text-muted)', background: sel ? cfg.bg : 'var(--bg-primary)', border:`1px solid ${sel ? cfg.border : 'var(--border-color)'}` }}>
                                  {cfg.icon} {cfg.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        {/* Step type workflow note */}
                        {stepForm.stepType === 'AUTO_EMAIL' && (
                          <div style={{ padding: '8px 11px', background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--accent-secondary)', lineHeight: 1.5 }}>
                            <strong>Auto Email</strong> — sent automatically by the scheduler once the wait period passes. Write your template below; first name, company, and title are personalised at send time.
                          </div>
                        )}
                        {stepForm.stepType === 'MANUAL_EMAIL' && (
                          <div style={{ padding: '8px 11px', background: 'var(--status-info-dim)', border: '1px solid var(--status-info-border)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--status-info)', lineHeight: 1.5 }}>
                            <strong>Manual Email</strong> — appears in the Emails tab as "Scheduled". You review the content and send it yourself.
                          </div>
                        )}
                        {stepForm.stepType === 'CALL' && (
                          <div style={{ padding: '8px 11px', background: 'var(--status-success-dim)', border: '1px solid var(--status-success-border)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--status-success)', lineHeight: 1.5 }}>
                            <strong>Call</strong> — appears in the Calls tab when due. Log the outcome to advance the prospect.
                          </div>
                        )}
                        {(stepForm.stepType === 'LINKEDIN' || stepForm.stepType === 'TASK') && (
                          <div style={{ padding: '8px 11px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            <strong>{stepForm.stepType === 'LINKEDIN' ? 'LinkedIn' : 'Task'}</strong> — appears in the Task Inbox when due. Mark complete there to advance the sequence.
                          </div>
                        )}
                        <div>
                          <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Wait Days</label>
                          <input type="number" min="0" value={stepForm.delayDays} onChange={e => setStepForm({...stepForm, delayDays: Number(e.target.value)})} style={{ width: '100%', marginTop: 4 }} />
                        </div>
                        {['AUTO_EMAIL','MANUAL_EMAIL'].includes(stepForm.stepType) ? (
                          <>
                            <div>
                              <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Subject</label>
                              <input value={stepForm.subject} onChange={e => setStepForm({...stepForm, subject: e.target.value})} placeholder="e.g. Quick question for {{firstName}}" style={{ width: '100%', marginTop: 4 }} />
                            </div>
                            <div>
                              <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Body Template</label>
                              <div style={{ marginTop: 4 }}>
                                <RichTextEditor
                                  value={stepForm.body}
                                  resetKey={stepForm.id || 'new'}
                                  onChange={v => setStepForm({ ...stepForm, body: v })}
                                  placeholder={"Hi {{firstName}},\n\nUse the toolbar to format. Paste from Word / Outlook / Docs to keep bold, links, lists, etc."}
                                  style={{ minHeight: 160 }}
                                />
                              </div>
                            </div>

                            {/* Reply-in-thread toggle */}
                            <div style={{ marginTop: 4, padding: '10px 12px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                                <input
                                  type="checkbox"
                                  checked={!!stepForm.replyToPrevious}
                                  onChange={e => setStepForm({ ...stepForm, replyToPrevious: e.target.checked })}
                                />
                                ↪ Send as reply to the previous email in this sequence
                              </label>
                              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
                                When on, this step sends in the same Outlook thread as the most recent sent step (subject becomes "Re: …" automatically). Best for short follow-ups / bumps. The AI personalizer adapts to write a concise follow-up note instead of repeating the original pitch.
                              </div>
                            </div>

                            {/* AI personalization toggle + fields */}
                            <div style={{ marginTop: 4, padding: '10px 12px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                                <input
                                  type="checkbox"
                                  checked={!!stepForm.aiPersonalize}
                                  onChange={e => setStepForm({ ...stepForm, aiPersonalize: e.target.checked })}
                                />
                                ✨ AI-personalize each email using prospect &amp; account research (drafts go to review queue)
                              </label>
                              {stepForm.aiPersonalize && (
                                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                                  <div>
                                    <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Intent (one line)</label>
                                    <input
                                      value={stepForm.aiPurpose || ''}
                                      onChange={e => setStepForm({ ...stepForm, aiPurpose: e.target.value })}
                                      placeholder="e.g. Cold open for a Mining CFO. Personalize opener around any recent strategic shift or stated priority."
                                      style={{ width: '100%', marginTop: 4 }}
                                    />
                                  </div>
                                  <div>
                                    <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Voice / Style / Constraints</label>
                                    <textarea
                                      value={stepForm.aiInstructions || ''}
                                      onChange={e => setStepForm({ ...stepForm, aiInstructions: e.target.value })}
                                      placeholder="Tone, length, and rules. e.g. Direct, peer-to-peer. Match the template's length — do not summarize the pitch. Bridge sentence after opener must mention the prospect's stated priority."
                                      style={{ width: '100%', marginTop: 4, minHeight: 80, resize: 'vertical' }}
                                    />
                                  </div>
                                  <div>
                                    <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Model override (optional)</label>
                                    <input
                                      value={stepForm.aiModel || ''}
                                      onChange={e => setStepForm({ ...stepForm, aiModel: e.target.value })}
                                      placeholder="default: gemini-2.5-pro · alternatives: gemini-2.5-flash · claude-opus-4-7 · claude-sonnet-4-6"
                                      style={{ width: '100%', marginTop: 4, fontFamily: 'monospace', fontSize: '0.78rem' }}
                                    />
                                  </div>
                                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                    The AI <strong>personalizes the opener</strong> against your body template — it does NOT rewrite the pitch. Product names, customer name-drops, benefits, and the CTA from your template are preserved. Only the opening hook (and one bridge sentence) get re-written per prospect.
                                    <br/>
                                    Drafts queue in the <a href="/hitl" style={{ color: 'var(--accent-secondary)' }}>AI Review Queue</a> up to 7 days before send time so you can edit, regenerate, or skip before approval.
                                  </div>
                                </div>
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <div>
                              <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{stepForm.stepType === 'CALL' ? 'Call Objective' : stepForm.stepType === 'LINKEDIN' ? 'LinkedIn Action' : 'Task Title'}</label>
                              <input value={stepForm.subject} onChange={e => setStepForm({...stepForm, subject: e.target.value})} placeholder={stepForm.stepType === 'CALL' ? 'e.g. Discovery call with {{firstName}}' : 'e.g. Connect on LinkedIn'} style={{ width: '100%', marginTop: 4 }} />
                            </div>
                            <div>
                              <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Notes / Script</label>
                              <textarea value={stepForm.body} onChange={e => setStepForm({...stepForm, body: e.target.value})} placeholder="Talking points or context..." style={{ width: '100%', marginTop: 4, minHeight: 80, resize: 'vertical' }} />
                            </div>
                          </>
                        )}
                        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                          <button type="submit" style={{ flex: 1 }}>Save Step</button>
                          <button type="button" className="secondary" onClick={() => { setIsAddingStep(false); setStepForm({ id: null, order: null, stepType: 'AUTO_EMAIL', delayDays: 1, subject: '', body: '', aiPersonalize: false, aiPurpose: '', aiInstructions: '', aiModel: '', replyToPrevious: false }); }}>Cancel</button>
                        </div>
                      </form>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Enroll prospects */}
              {(() => {
                const enrolledIds = new Set((activeSequence.prospectEnrollments || []).map(e => e.prospect?.id));
                const ENROLL_STATUS_FILTERS = [
                  { key: 'all',           label: 'All' },
                  { key: 'Uncontacted',   label: 'Uncontacted' },
                  { key: 'In Sequence',   label: 'In Sequence' },
                  { key: 'Replied',       label: 'Replied' },
                  { key: 'not_enrolled',  label: 'Not in any sequence' },
                ];

                const unenrolledPool = allProspects.filter(p => !enrolledIds.has(p.id));

                const statusMatches = unenrolledPool.filter(p => {
                  if (enrollStatusFilter === 'all') return true;
                  if (enrollStatusFilter === 'not_enrolled') {
                    return !p.sequenceEnrollments || p.sequenceEnrollments.length === 0;
                  }
                  return (p.status || 'Uncontacted') === enrollStatusFilter;
                });

                const searchMatches = prospectSearch.length > 1
                  ? statusMatches.filter(p => {
                      const q = prospectSearch.toLowerCase();
                      return (
                        `${p.firstName} ${p.lastName}`.toLowerCase().includes(q) ||
                        (p.email || '').toLowerCase().includes(q) ||
                        (p.companyName || '').toLowerCase().includes(q) ||
                        (p.title || '').toLowerCase().includes(q)
                      );
                    }).slice(0, 8)
                  : [];

                const bulkListSlice = statusMatches.slice(0, 50);

                return (
                  <div style={{ padding: 14, background: 'var(--bg-glass)', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        Add Prospect to Sequence
                      </div>
                      <button
                        className={bulkMode ? 'secondary' : 'ghost'}
                        style={{ fontSize: '0.72rem', padding: '2px 7px' }}
                        onClick={() => {
                          setBulkMode(m => !m);
                          setBulkSelected(new Set());
                        }}
                      >
                        {bulkMode ? '✕ Cancel Bulk' : '☑ Bulk Select'}
                      </button>
                    </div>

                    {/* Status filter chips */}
                    <div className="pill-group" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
                      {ENROLL_STATUS_FILTERS.map(f => (
                        <button
                          key={f.key}
                          className={`pill-btn${enrollStatusFilter === f.key ? ' active' : ''}`}
                          onClick={() => { setEnrollStatusFilter(f.key); setBulkSelected(new Set()); }}
                        >
                          {f.label}
                          <span style={{
                            marginLeft: 4,
                            fontSize: '0.65rem',
                            background: 'rgba(255,255,255,0.07)',
                            padding: '0 4px',
                            borderRadius: 'var(--radius-full)',
                            color: 'var(--text-muted)',
                          }}>
                            {f.key === 'all'
                              ? unenrolledPool.length
                              : f.key === 'not_enrolled'
                                ? unenrolledPool.filter(p => !p.sequenceEnrollments || p.sequenceEnrollments.length === 0).length
                                : unenrolledPool.filter(p => (p.status || 'Uncontacted') === f.key).length}
                          </span>
                        </button>
                      ))}
                    </div>

                    {bulkMode ? (
                      /* MODE B: Bulk select */
                      <div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                          Showing up to 50 prospects. Check to select.
                        </div>
                        <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', background: 'var(--bg-secondary)', maxHeight: 320, overflowY: 'auto' }}>
                          {bulkListSlice.length > 0 ? bulkListSlice.map(p => {
                            const checked = bulkSelected.has(p.id);
                            return (
                              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', background: checked ? 'var(--accent-dim)' : 'transparent', transition: 'background var(--transition-fast)' }}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    setBulkSelected(prev => {
                                      const next = new Set(prev);
                                      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                                      return next;
                                    });
                                  }}
                                  style={{ flexShrink: 0 }}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 600, fontSize: '0.84rem' }}>{p.firstName} {p.lastName}</div>
                                  <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginTop: 1 }}>
                                    {[p.title, p.companyName].filter(Boolean).join(' · ')}
                                    {p.email && <span style={{ marginLeft: 6 }}>{p.email}</span>}
                                  </div>
                                </div>
                                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: p.status === 'Replied' ? 'var(--status-success)' : p.status === 'In Sequence' ? 'var(--status-info)' : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>
                                  {p.status || 'Uncontacted'}
                                </span>
                              </label>
                            );
                          }) : (
                            <div style={{ padding: '16px 12px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                              No prospects available to enroll.
                            </div>
                          )}
                        </div>
                        {/* Sticky enroll button */}
                        {bulkSelected.size > 0 && (
                          <div style={{ marginTop: 10, position: 'sticky', bottom: 0 }}>
                            <button
                              disabled={isEnrolling}
                              onClick={handleBulkEnroll}
                              style={{ width: '100%', fontWeight: 700 }}
                            >
                              {isEnrolling ? 'Enrolling…' : `Enroll ${bulkSelected.size} selected`}
                            </button>
                            {!googleReady && (
                              <div style={{ fontSize: '0.72rem', color: 'var(--status-warning)', marginTop: 5, textAlign: 'center' }}>
                                ⚠ Connect Gmail in Integrations to send emails automatically
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      /* MODE A: Search + individual enroll */
                      <>
                        <input
                          placeholder="Search by name, company, title, email…"
                          value={prospectSearch}
                          onChange={(e) => setProspectSearch(e.target.value)}
                          style={{ width: '100%', fontSize: '0.85rem' }}
                        />

                        {/* Results dropdown */}
                        {prospectSearch.length > 1 && (
                          searchMatches.length > 0 ? (
                            <div style={{ marginTop: 8, border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', background: 'var(--bg-secondary)' }}>
                              {searchMatches.map(p => (
                                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', borderBottom: '1px solid var(--border-subtle)', transition: 'background var(--transition-fast)' }}>
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: '0.84rem' }}>{p.firstName} {p.lastName}</div>
                                    <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginTop: 1 }}>
                                      {[p.title, p.companyName].filter(Boolean).join(' · ')}
                                      {p.email && <span style={{ marginLeft: 6 }}>{p.email}</span>}
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                    <span style={{
                                      fontSize: '0.68rem', fontWeight: 700,
                                      color: p.status === 'Replied' ? 'var(--status-success)' : p.status === 'In Sequence' ? 'var(--status-info)' : 'var(--text-muted)',
                                      textTransform: 'uppercase', letterSpacing: '0.05em',
                                    }}>
                                      {p.status || 'Uncontacted'}
                                    </span>
                                    <button
                                      className="ghost"
                                      disabled={isEnrolling}
                                      onClick={() => { handleEnrollProspect(p.id); setProspectSearch(''); }}
                                      style={{ fontSize: '0.75rem', padding: '3px 10px', color: 'var(--accent-light)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-sm)' }}
                                    >
                                      + Enroll
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--text-muted)', padding: '8px 0' }}>
                              No prospects match — try adjusting filters or search terms.
                            </div>
                          )
                        )}

                        {/* Hint when no search yet */}
                        {prospectSearch.length <= 1 && (
                          <div style={{ marginTop: 8, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {statusMatches.length} prospect{statusMatches.length !== 1 ? 's' : ''} available to enroll. Type to search.
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Enrollment roster */}
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Prospect</th>
                      <th>Step</th>
                      <th>Last Contact</th>
                      <th>Next Due</th>
                      <th>Status</th>
                      <th style={{ width: 120 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {(activeSequence.prospectEnrollments || []).map(enrollment => {
                      const isOoo = enrollment.status === 'paused' && enrollment.pausedReason === 'ooo';
                      const s = isOoo
                        ? { bg: 'var(--status-warning-dim)', color: 'var(--status-warning)', border: 'var(--status-warning-border)' }
                        : ENROLLMENT_STATUS_STYLES[enrollment.status] || ENROLLMENT_STATUS_STYLES.active;
                      return (
                        <tr key={enrollment.id}>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                              {enrollment.prospect?.firstName} {enrollment.prospect?.lastName}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{enrollment.prospect?.email}</div>
                          </td>
                          <td style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                            {enrollment.currentStepOrder > 0 ? `Step ${enrollment.currentStepOrder} done` : 'Not started'}
                          </td>
                          <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {enrollment.lastContactedAt ? new Date(enrollment.lastContactedAt).toLocaleDateString() : '—'}
                          </td>
                          <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {enrollment.nextStepDue && enrollment.status === 'active'
                              ? new Date(enrollment.nextStepDue).toLocaleDateString()
                              : isOoo && enrollment.resumeAt
                              ? <span style={{ color: 'var(--status-warning)', fontWeight: 600 }}>Resumes {new Date(enrollment.resumeAt).toLocaleDateString()}</span>
                              : '—'}
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
                              <span style={{ display: 'inline-flex', padding: '2px 8px', background: s.bg, color: s.color, border: `1px solid ${s.border}`, borderRadius: 'var(--radius-full)', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase' }}>
                                {isOoo ? '✈ OOO' : enrollment.status.replace('_', ' ')}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4 }}>
                              {enrollment.status === 'active' && (
                                <button className="ghost" style={{ fontSize: '0.72rem', padding: '2px 6px' }} onClick={() => handleEnrollmentAction(enrollment, 'pause')}>Pause</button>
                              )}
                              {enrollment.status === 'paused' && (
                                <button className="ghost" style={{ fontSize: '0.72rem', padding: '2px 6px', color: 'var(--status-info)' }} onClick={() => handleEnrollmentAction(enrollment, 'resume')}>Resume now</button>
                              )}
                              {(enrollment.status === 'active' || enrollment.status === 'paused') && (
                                <button className="ghost" style={{ fontSize: '0.72rem', padding: '2px 6px', color: 'var(--status-danger)' }} onClick={() => handleEnrollmentAction(enrollment, 'opt_out')}>Opt Out</button>
                              )}
                              <button className="ghost" style={{ fontSize: '0.72rem', padding: '2px 6px', color: 'var(--text-muted)' }} onClick={() => handleEnrollmentAction(enrollment, 'remove')}>✕</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {(!activeSequence.prospectEnrollments || activeSequence.prospectEnrollments.length === 0) && (
                  <div className="empty-state">
                    <div className="empty-state-icon">👥</div>
                    <h4>No prospects enrolled</h4>
                    <p>Search for prospects above to start adding them to this sequence.</p>
                  </div>
                )}
              </div>
            </div>
            )}

            {/* ── EMAILS TAB ─────────────────────────────────────────────────── */}
            {activeTab === 'emails' && (() => {
              const EMAIL_STATUS_FILTERS = [
                { key: 'all',           label: 'All' },
                { key: 'scheduled',     label: 'Scheduled' },
                { key: 'draft_pending', label: 'Awaiting review' },
                { key: 'approved',      label: 'Approved' },
                { key: 'sent',          label: 'Sent' },
                { key: 'opened',        label: 'Opened' },
                { key: 'failed',        label: 'Failed' },
                { key: 'cancelled',     label: 'Cancelled' },
              ];

              const STATUS_PILL = {
                scheduled:     { bg: 'var(--status-info-dim,rgba(59,130,246,0.12))',    color: 'var(--status-info)',    border: 'rgba(59,130,246,0.3)'  },
                draft_pending: { bg: 'rgba(167,139,250,0.12)',                          color: '#a78bfa',               border: 'rgba(167,139,250,0.3)' },
                approved:      { bg: 'rgba(56,189,248,0.12)',                           color: '#38bdf8',               border: 'rgba(56,189,248,0.3)'  },
                sent:          { bg: 'var(--bg-tertiary)',                               color: 'var(--text-secondary)', border: 'var(--border-color)'   },
                opened:        { bg: 'var(--status-success-dim)',                        color: 'var(--status-success)', border: 'rgba(34,197,94,0.3)'   },
                failed:        { bg: 'var(--status-danger-dim)',                         color: 'var(--status-danger)',  border: 'rgba(239,68,68,0.3)'   },
                cancelled:     { bg: 'var(--bg-tertiary)',                               color: 'var(--text-muted)',     border: 'var(--border-subtle)'  },
                rejected:      { bg: 'var(--status-danger-dim)',                         color: 'var(--status-danger)',  border: 'rgba(239,68,68,0.3)'   },
              };

              const filtered = emailStatusFilter === 'all'
                ? emailItems
                : emailItems.filter(it => it.status === emailStatusFilter);

              const allFilteredKeys = filtered.map(emailKey);
              const allSelected = allFilteredKeys.length > 0 && allFilteredKeys.every(k => selectedEmailKeys.has(k));

              const toggleAll = () => {
                if (allSelected) {
                  setSelectedEmailKeys(prev => {
                    const next = new Set(prev);
                    allFilteredKeys.forEach(k => next.delete(k));
                    return next;
                  });
                } else {
                  setSelectedEmailKeys(prev => new Set([...prev, ...allFilteredKeys]));
                }
              };

              const toggleOne = (key) => {
                setSelectedEmailKeys(prev => {
                  const next = new Set(prev);
                  next.has(key) ? next.delete(key) : next.add(key);
                  return next;
                });
              };

              const selectedCancellable = Array.from(selectedEmailKeys)
                .map(k => emailItems.find(it => emailKey(it) === k))
                .filter(it => it && (it.status === 'scheduled' || it.status === 'sent' || it.status === 'failed'));

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Filter + refresh row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div className="pill-group">
                      {EMAIL_STATUS_FILTERS.map(f => (
                        <button
                          key={f.key}
                          className={`pill-btn${emailStatusFilter === f.key ? ' active' : ''}`}
                          onClick={() => { setEmailStatusFilter(f.key); setSelectedEmailKeys(new Set()); }}
                        >
                          {f.label}
                          <span style={{ marginLeft: 4, fontSize: '0.65rem', background: 'rgba(255,255,255,0.07)', padding: '0 4px', borderRadius: 'var(--radius-full)', color: 'var(--text-muted)' }}>
                            {f.key === 'all' ? emailItems.length : emailItems.filter(it => it.status === f.key).length}
                          </span>
                        </button>
                      ))}
                    </div>
                    <button
                      className="ghost"
                      style={{ fontSize: '0.78rem', padding: '4px 10px', marginLeft: 'auto' }}
                      onClick={() => fetchEmails(activeSequenceId)}
                    >
                      ↻ Refresh
                    </button>
                  </div>

                  {/* Bulk action bar */}
                  {selectedEmailKeys.size > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-sm)' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--accent-secondary)' }}>
                        {selectedEmailKeys.size} selected
                      </span>
                      <div style={{ width: 1, height: 16, background: 'var(--border-accent)' }} />
                      {selectedCancellable.length > 0 && (
                        <button
                          className="ghost"
                          style={{ fontSize: '0.78rem', color: 'var(--status-danger)', padding: '3px 10px' }}
                          onClick={handleBulkEmailCancel}
                        >
                          Cancel {selectedCancellable.length} email{selectedCancellable.length !== 1 ? 's' : ''}
                        </button>
                      )}
                      <button
                        className="ghost"
                        style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: '3px 8px' }}
                        onClick={() => setSelectedEmailKeys(new Set())}
                      >
                        ✕ Clear
                      </button>
                    </div>
                  )}

                  {/* Table */}
                  {emailsLoading ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 52, borderRadius: 'var(--radius-sm)' }} />)}
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-state-icon">✉</div>
                      <h4>{emailItems.length === 0 ? 'No emails yet' : 'No emails match this filter'}</h4>
                      <p>{emailItems.length === 0 ? 'Emails will appear here once prospects are enrolled and the sequence starts sending.' : 'Try selecting a different status filter.'}</p>
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table>
                        <thead>
                          <tr>
                            <th style={{ width: 40, paddingLeft: 16 }}>
                              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                            </th>
                            <th>Prospect</th>
                            <th>Subject</th>
                            <th>Step</th>
                            <th>Status</th>
                            <th>Date</th>
                            <th style={{ width: 160 }} />
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map(item => {
                            const key = emailKey(item);
                            const pill = STATUS_PILL[item.status] || STATUS_PILL.sent;
                            const prospect = item.prospect;
                            // For drafts and approved-but-unsent items, show
                            // scheduledFor (when it'll go out) instead of
                            // createdAt, so the user sees the actionable date.
                            const dateVal = item.type === 'scheduled'
                              ? item.scheduledFor
                              : (item.status === 'draft_pending' || item.status === 'approved')
                                ? (item.scheduledFor || item.createdAt)
                                : (item.sentAt || item.createdAt);
                            const isRescheduling = reschedulingKey === key;

                            return (
                              <tr key={key} className={selectedEmailKeys.has(key) ? 'row-selected' : ''}>
                                <td style={{ paddingLeft: 16, width: 40 }}>
                                  <input
                                    type="checkbox"
                                    checked={selectedEmailKeys.has(key)}
                                    onChange={() => toggleOne(key)}
                                  />
                                </td>
                                <td>
                                  <div style={{ fontWeight: 600, fontSize: '0.855rem' }}>
                                    {prospect?.firstName} {prospect?.lastName}
                                  </div>
                                  <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginTop: 1 }}>
                                    {prospect?.email}
                                  </div>
                                </td>
                                <td style={{ maxWidth: 200 }}>
                                  <div style={{ fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.subject}>
                                    {item.subject || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No subject</span>}
                                  </div>
                                </td>
                                <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                  {item.sequenceStep ? `Step ${item.sequenceStep.order}` : '—'}
                                </td>
                                <td>
                                  <span style={{
                                    display: 'inline-flex', padding: '2px 8px',
                                    background: pill.bg, color: pill.color, border: `1px solid ${pill.border}`,
                                    borderRadius: 'var(--radius-full)', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', whiteSpace: 'nowrap',
                                  }}>
                                    {item.status}
                                  </span>
                                  {item.failureReason && (
                                    <div style={{ fontSize: '0.68rem', color: 'var(--status-danger)', marginTop: 2 }} title={item.failureReason}>
                                      {item.failureReason.length > 40 ? item.failureReason.slice(0, 40) + '…' : item.failureReason}
                                    </div>
                                  )}
                                </td>
                                <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                  {dateVal ? new Date(dateVal).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                                </td>
                                <td>
                                  {isRescheduling ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                      <input
                                        type="datetime-local"
                                        value={rescheduleDate}
                                        onChange={e => setRescheduleDate(e.target.value)}
                                        style={{ fontSize: '0.72rem', padding: '3px 6px', width: 160 }}
                                        autoFocus
                                      />
                                      <button
                                        className="ghost"
                                        style={{ fontSize: '0.72rem', padding: '3px 8px', color: 'var(--accent-secondary)', whiteSpace: 'nowrap' }}
                                        onClick={() => handleEmailReschedule(item)}
                                      >
                                        Save
                                      </button>
                                      <button
                                        className="ghost"
                                        style={{ fontSize: '0.72rem', padding: '3px 6px', color: 'var(--text-muted)' }}
                                        onClick={() => { setReschedulingKey(null); setRescheduleDate(''); }}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  ) : (
                                    <div style={{ display: 'flex', gap: 4 }}>
                                      {item.status === 'scheduled' && (
                                        <>
                                          <button
                                            className="ghost"
                                            style={{ fontSize: '0.72rem', padding: '2px 8px', color: 'var(--accent-secondary)' }}
                                            onClick={() => {
                                              const d = new Date(item.scheduledFor);
                                              const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                                              setRescheduleDate(local);
                                              setReschedulingKey(key);
                                            }}
                                          >
                                            Reschedule
                                          </button>
                                          <button
                                            className="ghost"
                                            style={{ fontSize: '0.72rem', padding: '2px 8px', color: 'var(--status-danger)' }}
                                            onClick={() => handleEmailCancel(item)}
                                          >
                                            Cancel
                                          </button>
                                        </>
                                      )}
                                      {item.status === 'failed' && (
                                        <button
                                          className="ghost"
                                          style={{ fontSize: '0.72rem', padding: '2px 8px', color: 'var(--status-info)' }}
                                          onClick={() => handleEmailRetry(item)}
                                        >
                                          Retry
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ── CALLS TAB ──────────────────────────────────────────────────── */}
            {activeTab === 'calls' && (() => {
              const CALL_STATUS_FILTERS = [
                { key: 'all',       label: 'All' },
                { key: 'planned',   label: 'Planned' },
                { key: 'completed', label: 'Completed' },
                { key: 'connected', label: 'Connected' },
                { key: 'voicemail', label: 'Voicemail' },
                { key: 'no_answer', label: 'No Answer' },
                { key: 'skipped',   label: 'Skipped' },
                { key: 'cancelled', label: 'Cancelled' },
              ];

              const OUTCOME_LABELS = {
                connected:    { label: 'Connected',   color: 'var(--status-success)', bg: 'var(--status-success-dim)', border: 'var(--status-success-border)' },
                voicemail:    { label: 'Voicemail',   color: 'var(--status-warning)', bg: 'var(--status-warning-dim)', border: 'var(--status-warning-border)' },
                no_answer:    { label: 'No Answer',   color: 'var(--text-muted)',     bg: 'var(--bg-tertiary)',        border: 'var(--border-color)' },
                left_message: { label: 'Left Message',color: 'var(--status-info)',    bg: 'var(--status-info-dim)',   border: 'var(--status-info-border)' },
                skipped:      { label: 'Skipped',     color: 'var(--text-muted)',     bg: 'var(--bg-tertiary)',        border: 'var(--border-subtle)' },
                planned:      { label: 'Planned',     color: 'var(--accent-secondary)',bg:'var(--accent-dim)',        border: 'var(--border-accent)' },
                completed:    { label: 'Completed',   color: 'var(--status-success)', bg: 'var(--status-success-dim)', border: 'var(--status-success-border)' },
                cancelled:    { label: 'Cancelled',   color: 'var(--text-muted)',     bg: 'var(--bg-tertiary)',        border: 'var(--border-subtle)' },
              };

              const GROUP_BY_OPTIONS = [
                { key: 'none',    label: 'No grouping' },
                { key: 'account', label: 'Account' },
                { key: 'outcome', label: 'Outcome' },
                { key: 'step',    label: 'Step' },
              ];

              // Determine effective status for each item
              const itemStatus = (item) => {
                if (item.status === 'planned') return 'planned';
                if (item.status === 'cancelled') return 'cancelled';
                if (item.status === 'skipped') return 'skipped';
                return item.outcome || item.status || 'completed';
              };

              const filtered = callStatusFilter === 'all'
                ? callItems
                : callItems.filter(it => itemStatus(it) === callStatusFilter);

              // Group items
              const groupItems = (items) => {
                if (callGroupBy === 'none') return [{ label: null, items }];
                const groups = {};
                items.forEach(it => {
                  let gKey;
                  if (callGroupBy === 'account') gKey = it.prospect?.companyName || 'Unknown Account';
                  else if (callGroupBy === 'outcome') gKey = OUTCOME_LABELS[itemStatus(it)]?.label || itemStatus(it);
                  else if (callGroupBy === 'step') gKey = it.sequenceStep ? `Step ${it.sequenceStep.order}` : 'Unknown Step';
                  if (!groups[gKey]) groups[gKey] = [];
                  groups[gKey].push(it);
                });
                return Object.entries(groups)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([label, items]) => ({ label, items }));
              };

              const grouped = groupItems(filtered);

              const allFilteredKeys = filtered.map(callKey);
              const allSelected = allFilteredKeys.length > 0 && allFilteredKeys.every(k => selectedCallKeys.has(k));
              const toggleAll = () => {
                if (allSelected) setSelectedCallKeys(prev => { const n = new Set(prev); allFilteredKeys.forEach(k => n.delete(k)); return n; });
                else setSelectedCallKeys(prev => new Set([...prev, ...allFilteredKeys]));
              };
              const toggleOne = (key) => setSelectedCallKeys(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

              const selectedPlannedCount = Array.from(selectedCallKeys)
                .map(k => callItems.find(it => callKey(it) === k))
                .filter(it => it?.status === 'planned').length;

              const fmtDuration = (secs) => {
                if (!secs) return null;
                const m = Math.floor(secs / 60), s = secs % 60;
                return m > 0 ? `${m}m ${s}s` : `${s}s`;
              };

              const CallRow = ({ item }) => {
                const key = callKey(item);
                const pill = OUTCOME_LABELS[itemStatus(item)] || OUTCOME_LABELS.completed;
                const isRescheduling = callReschedulingKey === key;
                const isLogging = logCallKey === key;
                const dateVal = item.type === 'planned' ? item.scheduledFor : (item.completedAt || item.createdAt);

                return (
                  <tr key={key} className={selectedCallKeys.has(key) ? 'row-selected' : ''}>
                    <td style={{ paddingLeft: 16, width: 40 }}>
                      <input type="checkbox" checked={selectedCallKeys.has(key)} onChange={() => toggleOne(key)} />
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: '0.855rem' }}>
                        {item.prospect?.firstName} {item.prospect?.lastName}
                      </div>
                      <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginTop: 1 }}>
                        {item.prospect?.companyName && <span>{item.prospect.companyName}</span>}
                        {item.prospect?.title && <span style={{ marginLeft: 6, opacity: 0.7 }}>{item.prospect.title}</span>}
                      </div>
                    </td>
                    <td style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                      {item.prospect?.phone
                        ? <a href={`tel:${item.prospect.phone}`} style={{ color: 'var(--accent-light)', textDecoration: 'none' }} onClick={e => e.stopPropagation()}>{item.prospect.phone}</a>
                        : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No phone</span>
                      }
                    </td>
                    <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {item.sequenceStep ? `Step ${item.sequenceStep.order}` : '—'}
                    </td>
                    <td>
                      <span style={{
                        display: 'inline-flex', padding: '2px 8px',
                        background: pill.bg, color: pill.color, border: `1px solid ${pill.border}`,
                        borderRadius: 'var(--radius-full)', fontSize: '0.68rem', fontWeight: 700,
                        textTransform: 'uppercase', whiteSpace: 'nowrap',
                      }}>
                        {pill.label}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {dateVal ? new Date(dateVal).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {item.durationSecs ? fmtDuration(item.durationSecs) : '—'}
                    </td>
                    <td style={{ maxWidth: 160 }}>
                      {item.notes
                        ? <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', whiteSpace: 'nowrap' }} title={item.notes}>{item.notes}</span>
                        : null
                      }
                    </td>
                    <td style={{ minWidth: 200 }}>
                      {isLogging ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
                          <select
                            value={callLogForm.outcome}
                            onChange={e => setCallLogForm(f => ({ ...f, outcome: e.target.value }))}
                            style={{ fontSize: '0.75rem', padding: '4px 6px' }}
                          >
                            <option value="connected">Connected</option>
                            <option value="voicemail">Voicemail</option>
                            <option value="no_answer">No Answer</option>
                            <option value="left_message">Left Message</option>
                            <option value="skipped">Skip</option>
                          </select>
                          <input
                            type="number"
                            placeholder="Duration (secs)"
                            value={callLogForm.durationSecs}
                            onChange={e => setCallLogForm(f => ({ ...f, durationSecs: e.target.value }))}
                            style={{ fontSize: '0.75rem', padding: '4px 6px', width: '100%' }}
                          />
                          <input
                            placeholder="Notes (optional)"
                            value={callLogForm.notes}
                            onChange={e => setCallLogForm(f => ({ ...f, notes: e.target.value }))}
                            style={{ fontSize: '0.75rem', padding: '4px 6px', width: '100%' }}
                          />
                          <div style={{ display: 'flex', gap: 5 }}>
                            <button
                              className="ghost"
                              style={{ fontSize: '0.72rem', padding: '3px 10px', color: 'var(--status-success)', flex: 1 }}
                              onClick={() => handleLogCall(item)}
                            >
                              Save
                            </button>
                            <button
                              className="ghost"
                              style={{ fontSize: '0.72rem', padding: '3px 8px', color: 'var(--text-muted)' }}
                              onClick={() => { setLogCallKey(null); setCallLogForm({ outcome: 'connected', durationSecs: '', notes: '' }); }}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ) : isRescheduling ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <input
                            type="datetime-local"
                            value={callRescheduleDate}
                            onChange={e => setCallRescheduleDate(e.target.value)}
                            style={{ fontSize: '0.72rem', padding: '3px 6px', width: 160 }}
                            autoFocus
                          />
                          <button className="ghost" style={{ fontSize: '0.72rem', padding: '3px 8px', color: 'var(--accent-secondary)', whiteSpace: 'nowrap' }}
                            onClick={() => handleCallReschedule(item)}>Save</button>
                          <button className="ghost" style={{ fontSize: '0.72rem', padding: '3px 6px', color: 'var(--text-muted)' }}
                            onClick={() => { setCallReschedulingKey(null); setCallRescheduleDate(''); }}>✕</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {item.status === 'planned' && (
                            <>
                              <button className="ghost"
                                style={{ fontSize: '0.72rem', padding: '2px 8px', color: 'var(--status-success)', border: '1px solid var(--status-success-border)', borderRadius: 'var(--radius-sm)' }}
                                onClick={() => { setLogCallKey(key); setCallLogForm({ outcome: 'connected', durationSecs: '', notes: '' }); }}>
                                Log Call
                              </button>
                              <button className="ghost"
                                style={{ fontSize: '0.72rem', padding: '2px 8px', color: 'var(--accent-secondary)' }}
                                onClick={() => {
                                  const d = new Date(item.scheduledFor);
                                  setCallRescheduleDate(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
                                  setCallReschedulingKey(key);
                                }}>
                                Reschedule
                              </button>
                              <button className="ghost"
                                style={{ fontSize: '0.72rem', padding: '2px 8px', color: 'var(--text-muted)' }}
                                onClick={() => handleCallSkip(item)}>
                                Skip
                              </button>
                              <button className="ghost"
                                style={{ fontSize: '0.72rem', padding: '2px 8px', color: 'var(--status-danger)' }}
                                onClick={() => handleCallCancel(item)}>
                                Cancel
                              </button>
                            </>
                          )}
                          {(item.status === 'completed' || item.outcome) && (
                            <button className="ghost"
                              style={{ fontSize: '0.72rem', padding: '2px 8px', color: 'var(--text-muted)' }}
                              onClick={() => { setLogCallKey(key); setCallLogForm({ outcome: item.outcome || 'connected', durationSecs: item.durationSecs || '', notes: item.notes || '' }); }}>
                              Edit
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              };

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Toolbar: filters + group-by + refresh */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div className="pill-group" style={{ flexWrap: 'wrap' }}>
                      {CALL_STATUS_FILTERS.map(f => (
                        <button key={f.key}
                          className={`pill-btn${callStatusFilter === f.key ? ' active' : ''}`}
                          onClick={() => { setCallStatusFilter(f.key); setSelectedCallKeys(new Set()); }}>
                          {f.label}
                          <span style={{ marginLeft: 4, fontSize: '0.65rem', background: 'rgba(255,255,255,0.07)', padding: '0 4px', borderRadius: 'var(--radius-full)', color: 'var(--text-muted)' }}>
                            {f.key === 'all' ? callItems.length : callItems.filter(it => itemStatus(it) === f.key).length}
                          </span>
                        </button>
                      ))}
                    </div>

                    {/* Group-by selector */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Group by</span>
                      <select
                        value={callGroupBy}
                        onChange={e => setCallGroupBy(e.target.value)}
                        style={{ fontSize: '0.78rem', padding: '4px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}
                      >
                        {GROUP_BY_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                      </select>
                      <button className="ghost" style={{ fontSize: '0.78rem', padding: '4px 10px' }}
                        onClick={() => fetchCalls(activeSequenceId)}>↻ Refresh</button>
                    </div>
                  </div>

                  {/* Bulk action bar */}
                  {selectedCallKeys.size > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-sm)' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--accent-secondary)' }}>
                        {selectedCallKeys.size} selected
                      </span>
                      <div style={{ width: 1, height: 16, background: 'var(--border-accent)' }} />
                      {selectedPlannedCount > 0 && (
                        <button className="ghost"
                          style={{ fontSize: '0.78rem', color: 'var(--status-danger)', padding: '3px 10px' }}
                          onClick={handleBulkCallCancel}>
                          Cancel {selectedPlannedCount} planned call{selectedPlannedCount !== 1 ? 's' : ''}
                        </button>
                      )}
                      <button className="ghost"
                        style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: '3px 8px' }}
                        onClick={() => setSelectedCallKeys(new Set())}>
                        ✕ Clear
                      </button>
                    </div>
                  )}

                  {/* Table / empty state */}
                  {callsLoading ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ height: 52, borderRadius: 'var(--radius-sm)' }} />)}
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-state-icon">📞</div>
                      <h4>{callItems.length === 0 ? 'No calls yet' : 'No calls match this filter'}</h4>
                      <p>{callItems.length === 0
                        ? 'Add CALL steps to this sequence. Planned calls will appear here once prospects reach that step.'
                        : 'Try a different status filter or group.'}</p>
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      {grouped.map(({ label, items: groupItems }) => (
                        <div key={label || 'all'} style={{ marginBottom: label ? 20 : 0 }}>
                          {label && (
                            <div style={{
                              padding: '5px 12px', marginBottom: 4,
                              background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
                              borderRadius: 'var(--radius-sm)',
                              fontSize: '0.75rem', fontWeight: 700,
                              color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em',
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            }}>
                              <span>{label}</span>
                              <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--text-muted)' }}>{groupItems.length} call{groupItems.length !== 1 ? 's' : ''}</span>
                            </div>
                          )}
                          <table>
                            <thead>
                              <tr>
                                <th style={{ width: 40, paddingLeft: 16 }}>
                                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                                </th>
                                <th>Prospect</th>
                                <th>Phone</th>
                                <th>Step</th>
                                <th>Status</th>
                                <th>{callStatusFilter === 'planned' ? 'Scheduled' : 'Date'}</th>
                                <th>Duration</th>
                                <th>Notes</th>
                                <th style={{ minWidth: 200 }} />
                              </tr>
                            </thead>
                            <tbody>
                              {groupItems.map(item => <CallRow key={callKey(item)} item={item} />)}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ── REPLIES TAB ─────────────────────────────────────────── */}
            {activeTab === 'replies' && (() => {
              const REPLY_CLASS_FILTERS = [
                { key: 'all',           label: 'All' },
                { key: 'ooo',           label: 'OOO' },
                { key: 'genuine_reply', label: 'Genuine Reply' },
                { key: 'unsubscribe',   label: 'Unsubscribe' },
                { key: 'bounce',        label: 'Bounce' },
                { key: 'unknown',       label: 'Unknown' },
              ];

              const CLASS_PILL = {
                ooo:           { bg: 'var(--status-warning-dim)',                        color: 'var(--status-warning)', border: 'var(--status-warning-border)' },
                genuine_reply: { bg: 'var(--status-success-dim)',                        color: 'var(--status-success)', border: 'rgba(34,197,94,0.3)' },
                unsubscribe:   { bg: 'var(--status-danger-dim)',                         color: 'var(--status-danger)',  border: 'rgba(239,68,68,0.3)' },
                bounce:        { bg: 'rgba(249,115,22,0.12)',                            color: '#f97316',               border: 'rgba(249,115,22,0.3)' },
                unknown:       { bg: 'var(--bg-tertiary)',                               color: 'var(--text-muted)',     border: 'var(--border-subtle)' },
              };

              const CLASS_LABELS = {
                ooo:           '✈ OOO',
                genuine_reply: 'Reply',
                unsubscribe:   'Unsubscribe',
                bounce:        'Bounce',
                unknown:       'Unknown',
              };

              const filtered = replyClassFilter === 'all'
                ? replyItems
                : replyItems.filter(r => r.classification === replyClassFilter);

              const handleReclassify = async (id, classification) => {
                try {
                  await api.patch(`/reply-activities/${id}/reclassify`, { classification });
                  fetchReplies(activeSequenceId);
                  toast('Reply reclassified', 'success', 2000);
                } catch (err) {
                  toast('Failed to reclassify', 'error');
                }
              };

              const triggerScan = async () => {
                try {
                  await api.post('/reply-activities/trigger-scan');
                  toast('Inbox scan triggered — check back shortly', 'info', 3000);
                  setTimeout(() => fetchReplies(activeSequenceId), 5000);
                } catch (err) {
                  toast('Scan failed', 'error');
                }
              };

              return (
                <div>
                  {/* Filter + scan bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
                      {REPLY_CLASS_FILTERS.map(f => (
                        <button
                          key={f.key}
                          className={`filter-chip${replyClassFilter === f.key ? ' active' : ''}`}
                          onClick={() => setReplyClassFilter(f.key)}
                        >
                          {f.label}
                          {f.key !== 'all' && replyItems.filter(r => r.classification === f.key).length > 0 && (
                            <span className="count-pill" style={{ marginLeft: 4 }}>
                              {replyItems.filter(r => r.classification === f.key).length}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <button
                      className="ghost"
                      style={{ fontSize: '0.76rem', padding: '4px 10px', color: 'var(--text-muted)' }}
                      onClick={triggerScan}
                    >
                      Scan inbox
                    </button>
                    <button
                      className="ghost"
                      style={{ fontSize: '0.76rem', padding: '4px 10px', color: 'var(--text-muted)' }}
                      onClick={() => fetchReplies(activeSequenceId)}
                    >
                      Refresh
                    </button>
                  </div>

                  {repliesLoading ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {[1,2,3].map(i => (
                        <div key={i} style={{ height: 52, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', animation: 'pulse 1.4s ease-in-out infinite' }} />
                      ))}
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-state-icon">📬</div>
                      <h4>No replies detected</h4>
                      <p>
                        {replyItems.length === 0
                          ? 'Once the system detects inbox replies to your sequence emails, they\'ll appear here — classified as OOO, genuine replies, unsubscribes, or bounces.'
                          : 'No replies match the current filter.'}
                      </p>
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 700 }}>Prospect</th>
                          <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 700 }}>Subject</th>
                          <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 700 }}>Classification</th>
                          <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 700 }}>OOO Return</th>
                          <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 700 }}>Received</th>
                          <th style={{ width: 110 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map(reply => {
                          const pill = CLASS_PILL[reply.classification] || CLASS_PILL.unknown;
                          return (
                            <tr key={reply.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '8px 8px' }}>
                                <div style={{ fontWeight: 600 }}>
                                  {reply.prospect?.firstName} {reply.prospect?.lastName}
                                </div>
                                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{reply.prospect?.companyName || reply.fromEmail}</div>
                              </td>
                              <td style={{ padding: '8px 8px', maxWidth: 220 }}>
                                <div style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={reply.subject}>
                                  {reply.subject || '(no subject)'}
                                </div>
                                {reply.bodySnippet && (
                                  <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={reply.bodySnippet}>
                                    {reply.bodySnippet}
                                  </div>
                                )}
                              </td>
                              <td style={{ padding: '8px 8px' }}>
                                <span style={{ display: 'inline-flex', padding: '2px 8px', background: pill.bg, color: pill.color, border: `1px solid ${pill.border}`, borderRadius: 'var(--radius-full)', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase' }}>
                                  {CLASS_LABELS[reply.classification] || reply.classification}
                                </span>
                              </td>
                              <td style={{ padding: '8px 8px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                                {reply.oooReturnDate
                                  ? new Date(reply.oooReturnDate).toLocaleDateString()
                                  : reply.classification === 'ooo' ? '7-day default' : '—'}
                              </td>
                              <td style={{ padding: '8px 8px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                                {new Date(reply.receivedAt).toLocaleDateString()}
                              </td>
                              <td style={{ padding: '8px 8px' }}>
                                <select
                                  value={reply.classification}
                                  onChange={e => handleReclassify(reply.id, e.target.value)}
                                  style={{ fontSize: '0.72rem', padding: '3px 6px', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                                  title="Reclassify this reply"
                                >
                                  <option value="ooo">OOO</option>
                                  <option value="genuine_reply">Genuine Reply</option>
                                  <option value="unsubscribe">Unsubscribe</option>
                                  <option value="bounce">Bounce</option>
                                  <option value="unknown">Unknown</option>
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}

                  {/* OOO summary callout if any OOO replies exist */}
                  {replyItems.filter(r => r.classification === 'ooo').length > 0 && (
                    <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--status-warning-dim)', border: '1px solid var(--status-warning-border)', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem', color: 'var(--status-warning)', lineHeight: 1.5 }}>
                      ✈ {replyItems.filter(r => r.classification === 'ooo').length} prospect{replyItems.filter(r => r.classification === 'ooo').length > 1 ? 's are' : ' is'} OOO — their enrollment{replyItems.filter(r => r.classification === 'ooo').length > 1 ? 's have' : ' has'} been paused and will automatically resume on their return date. You can see resume dates in the Enrolled Prospects tab.
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12, color: 'var(--text-secondary)', padding: 40, textAlign: 'center' }}>
            <div style={{ fontSize: '2.5rem', opacity: 0.25 }}>✉️</div>
            <h3 style={{ color: 'var(--text-primary)', marginBottom: 0 }}>No sequence selected</h3>
            <p style={{ margin: 0, maxWidth: 260 }}>
              Choose a sequence from the left, or create a new one to start building your outreach cadence.
            </p>
          </div>
        )}
      </div>

      {/* RIGHT PANE - STATS */}
      {activeSequence && (
        <div className="right-pane glass-card" style={{ flex: '0 0 220px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>

          {/* Cadence summary */}
          <div>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Cadence</div>
            <div style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              {activeSteps.length} step{activeSteps.length !== 1 ? 's' : ''} · {totalCadenceDays} day{totalCadenceDays !== 1 ? 's' : ''}
            </div>
          </div>

          {/* Enrollment breakdown */}
          <div>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Enrollments</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {Object.entries(enrollmentCounts).map(([status, count]) => (
                <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.8rem' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: STATUS_DOT_COLORS[status] || 'var(--text-muted)', flexShrink: 0, display: 'inline-block' }} />
                  <span style={{ flex: 1, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{status.replace('_', ' ')}</span>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Step timeline */}
          {stepTimeline.length > 0 && (
            <div>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Timeline</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {stepTimeline.map(({ step, day }) => {
                  const cfg = STEP_TYPE_CONFIG[step.stepType || 'AUTO_EMAIL'];
                  return (
                    <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.78rem' }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: cfg.color, flexShrink: 0, display: 'inline-block' }} />
                      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>D{day}:</span>
                      <span style={{ fontSize: '0.8rem' }}>{cfg.icon}</span>
                      <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{step.subject || cfg.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Quick actions */}
          <div>
            <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Quick Actions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                className="ghost"
                style={{ fontSize: '0.72rem', padding: '2px 7px', width: '100%', justifyContent: 'center' }}
                onClick={async () => {
                  try {
                    const res = await api.post('/sequences', { name: `${activeSequence.name} (Copy)` });
                    const newSeqId = res.data.id;
                    await Promise.all(
                      activeSteps.map(step =>
                        api.post('/sequenceSteps', {
                          sequenceId: newSeqId,
                          order: step.order,
                          stepType: step.stepType || 'AUTO_EMAIL',
                          delayDays: step.delayDays,
                          subject: step.subject,
                          body: step.body,
                        })
                      )
                    );
                    await fetchSequences();
                    setActiveSequenceId(newSeqId);
                    toast(`"${activeSequence.name}" copied`, 'success');
                  } catch (err) {
                    console.error('Copy failed', err);
                    toast('Copy failed — please try again', 'error');
                  }
                }}
              >
                Copy Sequence
              </button>
              <button
                className="ghost"
                style={{ fontSize: '0.72rem', padding: '2px 7px', width: '100%', justifyContent: 'center', color: 'var(--status-warning)' }}
                onClick={async () => {
                  try {
                    await api.post(`/sequences/${activeSequenceId}/pause-all`);
                    fetchSequences();
                    toast('All enrollments paused', 'info', 2200);
                  } catch (err) {
                    if (err?.response?.status !== 404) toast('Failed to pause enrollments', 'error');
                  }
                }}
              >
                Pause All
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
  );
};

export default SequenceManager;
