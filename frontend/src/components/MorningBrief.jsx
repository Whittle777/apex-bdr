import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useToast } from './Toast';

const cardStyle = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-md)',
};

const formatDate = (value, withTime = true) => {
  if (!value) return 'Not run yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], withTime
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
};

const getAccounts = (brief) => (
  brief?.accounts ||
  brief?.rankedAccounts ||
  brief?.cards ||
  brief?.targets ||
  brief?.accountCards ||
  []
);

const getCompany = (account) => {
  const value = account?.account || account || {};
  return (
    value.company ||
    value.companyName ||
    value.name ||
    value.domain ||
  'Unnamed account'
  );
};

const getScore = (account) => {
  const score = account.score ?? account.totalScore ?? account.priorityScore;
  const parsed = Number(score);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

const getSignals = (account) => (
  account.signals ||
  account.evidence ||
  account.triggers ||
  []
);

const getSources = (signal) => {
  if (Array.isArray(signal?.sourceUrls)) return signal.sourceUrls;
  if (Array.isArray(signal?.sources)) return signal.sources;
  if (signal?.sourceUrl) return [signal.sourceUrl];
  if (typeof signal?.url === 'string') return [signal.url];
  return [];
};

const getSignalText = (signal) => (
  typeof signal === 'string'
    ? signal
    : signal?.text || signal?.claim || signal?.label || signal?.trigger || signal?.description || 'Signal'
);

const getActionText = (account) => (
  typeof account?.recommendedAction === 'string'
    ? account.recommendedAction
    : account?.recommendedAction?.action || account?.nextAction || 'Verify the trigger, identify the right buyer, then prepare a relevant opening.'
);

const getActionRationale = (account) => (
  account?.recommendedAction?.rationale || account?.rationale || ''
);

const scoreColor = (score) => (
  score >= 80 ? 'var(--status-success)' :
    score >= 60 ? 'var(--status-warning)' :
      'var(--status-danger)'
);

const scoreLabel = (score) => (
  score >= 80 ? 'Priority now' :
    score >= 60 ? 'Worth pursuing' :
      'Needs verification'
);

const StatusPill = ({ children, tone = 'info' }) => {
  const palette = {
    info: ['var(--status-info-dim)', 'var(--status-info)', 'var(--status-info-border)'],
    success: ['var(--status-success-dim)', 'var(--status-success)', 'var(--status-success-border)'],
    warning: ['var(--status-warning-dim)', 'var(--status-warning)', 'var(--status-warning-border)'],
    danger: ['var(--status-danger-dim)', 'var(--status-danger)', 'var(--status-danger-border)'],
  }[tone] || [];
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '4px 9px',
      borderRadius: 'var(--radius-full)',
      background: palette[0],
      color: palette[1],
      border: `1px solid ${palette[2]}`,
      fontSize: '0.68rem',
      fontWeight: 800,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
};

const Metric = ({ label, value, detail }) => (
  <div className="metric-card" style={{ minHeight: 92 }}>
    <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
      {label}
    </div>
    <div className="metric-value" style={{ fontSize: '1.55rem' }}>{value}</div>
    {detail && <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{detail}</div>}
  </div>
);

const ScoreBar = ({ label, value, max = 25, suffix = '' }) => {
  const numeric = Number(value) || 0;
  const percentage = Math.max(0, Math.min(100, (numeric / max) * 100));
  return (
    <div style={{ marginBottom: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 5, fontSize: '0.78rem' }}>
        <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <strong style={{ color: 'var(--text-primary)' }}>
          {numeric.toFixed(numeric % 1 ? 2 : 0)}{suffix}{suffix ? '' : `/${max}`}
        </strong>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'var(--bg-primary)', overflow: 'hidden' }}>
        <div style={{ width: `${percentage}%`, height: '100%', borderRadius: 999, background: 'var(--grad-brand)' }} />
      </div>
    </div>
  );
};

function EmptyState({ onRun, running }) {
  return (
    <div style={{ ...cardStyle, padding: '58px 32px', textAlign: 'center', maxWidth: 760, margin: '30px auto' }}>
      <div style={{ fontSize: '2.8rem', marginBottom: 12 }}>🌅</div>
      <h2 style={{ margin: 0, fontSize: '1.35rem' }}>Your overnight brief is waiting</h2>
      <p style={{ maxWidth: 560, margin: '10px auto 22px', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
        Run the deterministic demo pass to see how Apex can research a territory,
        rank accounts, explain the ranking, and prepare the next sales action without sending anything.
      </p>
      <button onClick={onRun} disabled={running} style={{ padding: '11px 18px' }}>
        {running ? 'Running brief…' : 'Run demo overnight brief'}
      </button>
    </div>
  );
}

export default function MorningBrief() {
  const navigate = useNavigate();
  const toast = useToast();
  const [brief, setBrief] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewText, setReviewText] = useState('');
  const [reviewState, setReviewState] = useState(null);

  const accounts = useMemo(() => getAccounts(brief), [brief]);
  const selected = accounts.find((account, index) => (
    String(account.id ?? account.key ?? getCompany(account) ?? index) === String(selectedKey)
  )) || accounts[0] || null;
  const selectedDetails = selected?.account || selected || {};
  const selectedScore = selected ? getScore(selected) : 0;
  const selectedSignals = selected ? getSignals(selected) : [];
  const selectedTrigger = selected?.triggerSignal || selectedSignals.find(signal => signal.type !== 'fit');
  const summary = brief?.summary || {};

  const loadLatest = async () => {
    try {
      const response = await api.get('/morning-brief/latest');
      setBrief(response.data?.brief || response.data || null);
      setError(null);
    } catch (err) {
      if (err.response?.status !== 404) {
        setError(err.response?.data?.message || 'Could not load the latest brief.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadLatest(); }, []);

  const runBrief = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const response = await api.post('/morning-brief/run', { demo: true });
      const nextBrief = response.data?.brief || response.data;
      setBrief(nextBrief);
      setSelectedKey(null);
      setReviewState(null);
      toast('Morning Brief is ready. Nothing was sent.', 'success');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Morning Brief failed.');
      toast('Morning Brief could not be generated.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const scanLiveSignals = async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    try {
      const accountsResponse = await api.get('/accounts');
      const accounts = (accountsResponse.data || [])
        .filter(account => account?.name)
        .map(account => ({
          name: account.name,
          domain: account.domain || account.website || null,
          industry: account.industry || null,
          employees: account.employees || null,
          revenue: account.revenue || null,
          region: account.region || account.country || null,
          icp: account.icp || {},
          disqualifiers: account.status === 'customer' ? ['existing_customer'] : [],
          signals: [],
        }));
      if (accounts.length === 0) {
        throw new Error('No accounts found. Import accounts first, or run the CLI with a target JSON file.');
      }
      const response = await api.post('/morning-brief/run', {
        targets: accounts,
        discover: true,
      });
      const nextBrief = response.data?.brief || response.data;
      setBrief(nextBrief);
      setSelectedKey(null);
      setReviewState(null);
      toast(`Found ${nextBrief.discovery?.freshSignals || 0} fresh signal${nextBrief.discovery?.freshSignals === 1 ? '' : 's'} across ${nextBrief.discovery?.accountsWithSignals || 0} accounts.`, 'success', 5000);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Live signal scan failed.');
      toast('Live signal scan failed.', 'error');
    } finally {
      setScanning(false);
    }
  };

  const submitReview = async (decision) => {
    if (!brief?.runId && !brief?.id) return;
    try {
      const response = await api.post(`/morning-brief/runs/${brief.runId || brief.id}/review`, {
        accountKey: selected?.id || selected?.key || getCompany(selected),
        decision,
        editedAction: reviewText,
      });
      setBrief(response.data?.brief || response.data || brief);
      setReviewState(decision);
      setReviewOpen(false);
      toast(decision === 'approved' ? 'Action approved for your next step. No message was sent.' : 'Action recorded.', 'success');
    } catch (err) {
      toast(err.response?.data?.message || 'Could not record the review.', 'error');
    }
  };

  if (loading) {
    return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading Morning Brief…</div>;
  }

  if (!brief || accounts.length === 0) {
    return (
      <div style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
        <PageHeader onRun={runBrief} onScan={scanLiveSignals} running={running} scanning={scanning} />
        {error && <ErrorBanner message={error} />}
        <EmptyState onRun={runBrief} running={running} />
      </div>
    );
  }

  const topScore = getScore(accounts[0]);
  const sourceCount = summary.sources ?? summary.sourcesChecked ?? accounts.reduce((count, account) => (
    count + getSignals(account).reduce((inner, signal) => inner + getSources(signal).length, 0)
  ), 0);
  const reviewCount = summary.needsReview ?? summary.reviewCount ?? accounts.filter(a => getScore(a) < 85).length;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', width: '100%' }}>
      <PageHeader onRun={runBrief} onScan={scanLiveSignals} running={running} scanning={scanning} lastRun={brief.finishedAt || brief.generatedAt || brief.createdAt || brief.runAt} />
      {error && <ErrorBanner message={error} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 18 }}>
        <Metric label="Accounts ranked" value={summary.accounts ?? accounts.length} detail="from this run" />
        <Metric label="Top priority" value={`${topScore}/100`} detail={scoreLabel(topScore)} />
        <Metric label="Evidence links" value={sourceCount} detail="source-backed signals" />
        <Metric label="Human review" value={reviewCount} detail="nothing auto-sent" />
      </div>

      <div style={{ ...cardStyle, padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', background: 'linear-gradient(110deg, rgba(14,165,233,0.13), var(--bg-elevated) 55%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: '1.35rem' }}>✓</span>
          <div>
            <strong style={{ fontSize: '0.92rem' }}>Overnight run complete</strong>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.77rem', marginTop: 2 }}>
              Ranked from dated triggers, ICP fit, urgency, and evidence coverage.
            </div>
          </div>
        </div>
        <StatusPill tone="success">Safe by default · approval required</StatusPill>
      </div>

      {brief.discovery?.enabled && (
        <div style={{ marginBottom: 18, padding: '10px 14px', background: 'var(--status-success-dim)', border: '1px solid var(--status-success-border)', borderRadius: 'var(--radius-md)', color: '#86efac', fontSize: '0.8rem' }}>
          Live public-web scan complete: {brief.discovery.freshSignals || 0} fresh trigger{brief.discovery.freshSignals === 1 ? '' : 's'} found across {brief.discovery.accountsWithSignals || 0} accounts.
          {brief.discovery.errors > 0 && <span style={{ color: '#fbbf24' }}> {brief.discovery.errors} feed{brief.discovery.errors === 1 ? '' : 's'} failed and should be retried.</span>}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(290px, 0.86fr) minmax(0, 1.7fr)', gap: 18, alignItems: 'start' }}>
        <section style={{ ...cardStyle, overflow: 'hidden' }}>
          <div style={{ padding: '17px 18px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800 }}>Today’s territory</div>
            <h2 style={{ margin: '5px 0 0', fontSize: '1.05rem' }}>Recommended accounts</h2>
          </div>
          <div>
            {accounts.map((account, index) => {
              const key = String(account.id ?? account.key ?? getCompany(account) ?? index);
              const score = getScore(account);
              const active = key === String(selectedKey ?? String(accounts[0]?.id ?? accounts[0]?.key ?? getCompany(accounts[0]) ?? 0));
              return (
                <button
                  key={key}
                  onClick={() => setSelectedKey(key)}
                  style={{
                    width: '100%',
                    display: 'block',
                    textAlign: 'left',
                    padding: '15px 18px',
                    background: active ? 'var(--accent-dim)' : 'transparent',
                    border: 'none',
                    borderLeft: active ? '3px solid var(--accent-primary)' : '3px solid transparent',
                    borderBottom: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 800, color: active ? 'var(--accent-secondary)' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {index + 1}. {getCompany(account)}
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem', marginTop: 3 }}>
                        {account.persona || account.primaryStakeholder || 'Buyer to verify'}
                      </div>
                    </div>
                    <strong style={{ color: scoreColor(score), fontSize: '0.92rem', flexShrink: 0 }}>{score}</strong>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
                    <div style={{ flex: 1, height: 5, background: 'var(--bg-primary)', borderRadius: 999 }}>
                      <div style={{ width: `${Math.max(4, Math.min(score, 100))}%`, height: '100%', borderRadius: 999, background: scoreColor(score) }} />
                    </div>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>{scoreLabel(score)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section style={{ ...cardStyle, padding: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800 }}>Account brief</div>
              <h2 style={{ fontSize: '1.55rem', margin: '5px 0 3px' }}>{getCompany(selected)}</h2>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>
                {selectedDetails.domain || selectedDetails.industry || 'Target account'} {selectedDetails.persona ? `· ${selectedDetails.persona}` : ''}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ color: scoreColor(selectedScore), fontSize: '2rem', lineHeight: 1, fontWeight: 900 }}>{selectedScore}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: 4 }}>priority score / 100</div>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 18, paddingTop: 17 }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800, marginBottom: 7 }}>Why this account?</div>
            {selected?.outreachAngle && (
              <div style={{ color: 'var(--accent-secondary)', fontSize: '0.9rem', fontWeight: 700, lineHeight: 1.55, marginBottom: 7 }}>
                {selected.outreachAngle}
              </div>
            )}
            <p style={{ margin: 0, color: 'var(--text-primary)', lineHeight: 1.68, fontSize: '0.95rem' }}>
              {selectedTrigger
                ? `${selectedTrigger.type || 'Recent'} signal: ${getSignalText(selectedTrigger)}${selectedTrigger.date ? ` (${selectedTrigger.date})` : ''}`
                : selected?.whyNow || selected?.rationale || selected?.angle || 'The overnight run found a potentially useful account signal. Verify the evidence before outreach.'}
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(230px, 0.75fr)', gap: 22, marginTop: 22 }}>
            <div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800, marginBottom: 12 }}>Signals found</div>
              {selectedSignals.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.83rem' }}>No signals were supplied. This account should not be treated as verified.</div>
              )}
              {selectedSignals.map((signal, index) => {
                const text = getSignalText(signal);
                const urls = getSources(typeof signal === 'string' ? {} : signal);
                return (
                  <div key={`${text}-${index}`} style={{ display: 'flex', gap: 10, marginBottom: 13, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--accent-secondary)', marginTop: 2 }}>↗</span>
                    <div style={{ flex: 1, fontSize: '0.84rem', lineHeight: 1.5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                        <span>{text}</span>
                        {signal.fresh && <StatusPill tone="success">fresh</StatusPill>}
                        {signal.thirdParty && <StatusPill tone="warning">third-party</StatusPill>}
                      </div>
                      {signal.description && <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: 3 }}>{signal.description}</div>}
                      {urls.length > 0 && (
                        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginTop: 3 }}>
                          {urls.map(url => (
                            <a key={url} href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-secondary)', fontSize: '0.72rem' }}>
                              Source ↗
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {(selected?.unsourcedSignals || []).length > 0 && (
                <div style={{ marginTop: 4, padding: '9px 10px', background: 'var(--status-warning-dim)', border: '1px solid var(--status-warning-border)', borderRadius: 'var(--radius-sm)', color: '#fbbf24', fontSize: '0.75rem', lineHeight: 1.45 }}>
                  {(selected.unsourcedSignals || []).length} signal{selected.unsourcedSignals.length !== 1 ? 's are' : ' is'} missing a source and was not used as evidence.
                </div>
              )}
            </div>
            <div style={{ borderLeft: '1px solid var(--border-subtle)', paddingLeft: 20 }}>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800, marginBottom: 12 }}>Score breakdown</div>
              {Object.entries(selected?.scoreBreakdown || selected?.breakdown || {}).length > 0
                ? Object.entries(selected.scoreBreakdown || selected.breakdown)
                  .filter(([, value]) => value && (typeof value.raw === 'number' || typeof value.multiplier === 'number'))
                  .map(([label, value]) => (
                  <ScoreBar
                    key={label}
                    label={label.replace(/([A-Z])/g, ' $1')}
                    value={value.raw ?? value.multiplier}
                    max={1}
                    suffix={value.raw !== undefined ? '' : '×'}
                  />
                ))
                : <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>The scoring model did not return component scores.</div>}
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 6, paddingTop: 18 }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800, marginBottom: 8 }}>Recommended first touch</div>
            {selected?.outreachPlan?.persona && (
              <div style={{ marginBottom: 8, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                <strong style={{ color: 'var(--text-primary)' }}>Persona to hunt:</strong> {selected.outreachPlan.persona}
              </div>
            )}
            {selected?.outreachPlan?.question && (
              <div style={{ marginBottom: 8, color: 'var(--accent-secondary)', fontSize: '0.84rem', lineHeight: 1.5 }}>
                <strong style={{ color: 'var(--text-primary)' }}>Question:</strong> {selected.outreachPlan.question}
              </div>
            )}
            <div style={{ padding: '13px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', lineHeight: 1.55, fontSize: '0.87rem' }}>
              {getActionText(selected)}
              {getActionRationale(selected) && (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: 6 }}>{getActionRationale(selected)}</div>
              )}
            </div>
            {(selected?.callOpener || selected?.draftCallOpener) && (
              <div style={{ marginTop: 10, padding: '13px 14px', background: 'rgba(14,165,233,0.06)', borderLeft: '3px solid var(--accent-primary)', borderRadius: '0 var(--radius-sm) var(--radius-sm) 0', fontSize: '0.87rem', lineHeight: 1.6 }}>
                <strong style={{ display: 'block', color: 'var(--accent-secondary)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Call opener</strong>
                {selected.callOpener || selected.draftCallOpener}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginTop: 18, alignItems: 'center' }}>
            <button onClick={() => { setReviewText(getActionText(selected)); setReviewOpen(true); }}>
              Review action
            </button>
            <button className="ghost" onClick={() => navigate('/accounts')}>
              Open Accounts
            </button>
            <button className="ghost" onClick={() => navigate('/research')}>
              Add more research
            </button>
            {reviewState && <StatusPill tone={reviewState === 'approved' ? 'success' : 'warning'}>{reviewState}</StatusPill>}
          </div>
        </section>
      </div>

      {reviewOpen && (
        <div onClick={() => setReviewOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={event => event.stopPropagation()} style={{ ...cardStyle, width: 'min(640px, 100%)', padding: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 800 }}>Human review</div>
                <h2 style={{ margin: '4px 0 0', fontSize: '1.2rem' }}>Approve the next action for {getCompany(selected)}</h2>
              </div>
              <button className="ghost" onClick={() => setReviewOpen(false)}>✕</button>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.84rem', lineHeight: 1.55, margin: '15px 0 10px' }}>
              This records your decision for the demo. It does not send an email, place a call, or modify an external system.
            </p>
            <textarea value={reviewText} onChange={event => setReviewText(event.target.value)} rows={5} style={{ width: '100%', resize: 'vertical', lineHeight: 1.5 }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
              <button className="ghost" onClick={() => submitReview('rejected')}>Reject</button>
              <button onClick={() => submitReview('approved')}>Approve next step</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PageHeader({ onRun, onScan, running, scanning, lastRun }) {
  return (
    <header style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-end', marginBottom: 20, flexWrap: 'wrap' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <h1 style={{ fontSize: '1.55rem', margin: 0, fontWeight: 850 }}>Morning Brief</h1>
          <StatusPill tone="info">Overnight agent</StatusPill>
        </div>
        <p style={{ color: 'var(--text-muted)', margin: '5px 0 0', fontSize: '0.88rem' }}>
          Wake up to a ranked territory, evidence-backed reasoning, and a human-approved next move.
          {lastRun && <span> Last run {formatDate(lastRun)}.</span>}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={onScan} disabled={scanning} style={{ padding: '9px 14px' }}>
          {scanning ? 'Scanning public signals…' : 'Search live signals'}
        </button>
        <button className="ghost" onClick={onRun} disabled={running} style={{ padding: '9px 14px' }}>
          {running ? 'Running…' : '↻ Run demo'}
        </button>
      </div>
    </header>
  );
}

function ErrorBanner({ message }) {
  return (
    <div style={{ marginBottom: 16, padding: '10px 13px', background: 'var(--status-danger-dim)', border: '1px solid var(--status-danger-border)', borderRadius: 'var(--radius-md)', color: '#fca5a5', fontSize: '0.83rem' }}>
      {message}
    </div>
  );
}
