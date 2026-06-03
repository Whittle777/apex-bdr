import React, { useState, useEffect } from 'react';
import api from '../services/api';

const StatCard = ({ label, value, sub, trend, icon, color }) => (
  <div className="metric-card" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
    <div style={{
      width: 36, height: 36, borderRadius: 'var(--radius-sm)',
      backgroundColor: color || 'var(--accent-dim)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '1.05rem', flexShrink: 0,
    }}>
      {icon}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="metric-label" style={{ marginBottom: 3 }}>{label}</div>
      <div className="metric-value" style={{ fontSize: '1.45rem' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
    {trend !== undefined && (
      <div style={{
        fontSize: '0.78rem', fontWeight: 700, flexShrink: 0,
        color: trend >= 0 ? 'var(--status-success)' : 'var(--status-danger)',
        background: trend >= 0 ? 'var(--status-success-dim)' : 'var(--status-danger-dim)',
        padding: '3px 8px', borderRadius: 'var(--radius-full)',
        border: `1px solid ${trend >= 0 ? 'var(--status-success-border)' : 'var(--status-danger-border)'}`,
      }}>
        {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}%
      </div>
    )}
  </div>
);


// Compute calendar-aligned start/end for the chosen period.
// week    → Monday 00:00 of this week through Sunday 23:59
// month   → 1st of this month 00:00 through end of month 23:59
// quarter → 1st of the current quarter 00:00 through end of quarter 23:59
const periodRange = (period) => {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (period === 'week') {
    // ISO week: Monday start
    const day = (start.getDay() + 6) % 7; // Mon=0 ... Sun=6
    start.setDate(start.getDate() - day);
    end.setDate(start.getDate() + 6);
  } else if (period === 'month') {
    start.setDate(1);
    end.setMonth(start.getMonth() + 1, 0); // last day of month
  } else if (period === 'quarter') {
    const qStartMonth = Math.floor(start.getMonth() / 3) * 3;
    start.setMonth(qStartMonth, 1);
    end.setMonth(qStartMonth + 3, 0);
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const formatRange = ({ start, end }) => {
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
};

const AnalyticsDashboard = () => {
  const [period, setPeriod] = useState('week');
  const [prospects, setProspects] = useState([]);
  const [sequences, setSequences] = useState([]);
  const [emailStats, setEmailStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetch = async () => {
      try {
        const [pRes, sRes] = await Promise.all([api.get('/prospects'), api.get('/sequences')]);
        setProspects(pRes.data || []);
        setSequences(sRes.data || []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, []);

  // Re-fetch email stats when the period changes
  useEffect(() => {
    const { start, end } = periodRange(period);
    api.get('/email-activities/stats', {
      params: { since: start.toISOString(), until: end.toISOString() },
    })
      .then(r => setEmailStats(r.data))
      .catch(err => console.error('[analytics/stats]', err));
  }, [period]);

  const range = periodRange(period);

  const totalProspects = prospects.length;
  const replied = prospects.filter(p => p.status === 'Replied').length;
  const meetings = prospects.filter(p => p.status === 'Meeting Booked').length;
  const notInterested = prospects.filter(p => p.status === 'Not Interested').length;
  const inSequence = prospects.filter(p => p.status === 'In Sequence').length;
  const uncontacted = prospects.filter(p => !p.status || p.status === 'Uncontacted').length;
  const replyRate = totalProspects > 0 ? ((replied / totalProspects) * 100).toFixed(1) : 0;
  const meetingRate = totalProspects > 0 ? ((meetings / totalProspects) * 100).toFixed(1) : 0;

  // Total active enrollments across all sequences
  const totalEnrollments = sequences.reduce((acc, s) => acc + (s.prospectEnrollments?.filter(e => e.status === 'active').length || 0), 0);

  // Sequence performance rows (sort by enrollment count)
  const seqPerf = sequences
    .map(s => ({
      name: s.name,
      total: s.prospectEnrollments?.length || 0,
      active: s.prospectEnrollments?.filter(e => e.status === 'active').length || 0,
      completed: s.prospectEnrollments?.filter(e => e.status === 'completed').length || 0,
      optedOut: s.prospectEnrollments?.filter(e => e.status === 'opted_out').length || 0,
      steps: s._count?.sequenceSteps ?? 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  // Top companies by prospect count
  const companyCounts = prospects.reduce((acc, p) => {
    const co = p.companyName || p.company || '(No company)';
    acc[co] = (acc[co] || 0) + 1;
    return acc;
  }, {});
  const topCompanies = Object.entries(companyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  // Status distribution for the funnel
  const statusDist = [
    { label: 'Uncontacted', count: uncontacted, color: 'var(--text-muted)' },
    { label: 'In Sequence', count: inSequence, color: 'var(--status-info)' },
    { label: 'Replied', count: replied, color: 'var(--status-success)' },
    { label: 'Meeting Booked', count: meetings, color: 'var(--status-success)' },
    { label: 'Not Interested', count: notInterested, color: 'var(--status-danger)' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 style={{ marginBottom: 4 }}>Analytics</h1>
          <p className="page-header-meta">
            {formatRange(range)} · {period === 'week' ? 'this week' : period === 'month' ? 'this month' : 'this quarter'}
          </p>
        </div>
        <div className="pill-group">
          {['week', 'month', 'quarter'].map(p => (
            <button key={p} className={`pill-btn${period === p ? ' active' : ''}`} onClick={() => setPeriod(p)}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        {loading ? (
          [1,2,3,4,5].map(i => (
            <div key={i} className="metric-card" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 72 }}>
              <div className="skeleton" style={{ width: 36, height: 36, borderRadius: 'var(--radius-sm)', flexShrink: 0 }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="skeleton" style={{ height: 11, width: '55%', borderRadius: 4 }} />
                <div className="skeleton" style={{ height: 26, width: '75%', borderRadius: 4 }} />
                <div className="skeleton" style={{ height: 10, width: '45%', borderRadius: 4 }} />
              </div>
            </div>
          ))
        ) : (
          <>
            <StatCard label="Total Prospects" value={totalProspects} sub={`${uncontacted} uncontacted`} trend={undefined} icon="👥" color="var(--accent-dim)" />
            <StatCard
              label="Emails Sent"
              value={emailStats ? emailStats.sent : '—'}
              sub={emailStats
                ? `${emailStats.opened || 0} opened · ${emailStats.failed || 0} failed`
                : 'loading…'}
              trend={undefined}
              icon="📤"
              color="var(--accent-soft)"
            />
            <StatCard label="Active Enrollments" value={totalEnrollments} sub={`across ${sequences.length} sequences`} trend={undefined} icon="✉️" color="var(--accent-soft)" />
            <StatCard label="Reply Rate" value={`${replyRate}%`} sub={`${replied} of ${totalProspects} replied`} trend={undefined} icon="💬" color="var(--status-success-soft)" />
            <StatCard label="Meetings Booked" value={meetings} sub={`${meetingRate}% conversion`} trend={undefined} icon="📅" color="var(--status-warning-soft)" />
          </>
        )}
      </div>

      {/* Status Funnel + Sequence Performance */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Prospect Status Funnel */}
        <div style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 18 }}>
          <h4 style={{ marginBottom: 4 }}>Prospect Status Breakdown</h4>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: 16 }}>
            {totalProspects} total prospects
          </p>
          {loading ? (
            [1,2,3,4,5].map(i => <div key={i} className="skeleton" style={{ height: 28, marginBottom: 10, borderRadius: 4 }} />)
          ) : totalProspects === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>No prospect data yet.</div>
          ) : (
            statusDist.map(({ label, count, color }) => {
              const pct = totalProspects > 0 ? ((count / totalProspects) * 100).toFixed(1) : 0;
              return (
                <div key={label} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, display: 'inline-block', flexShrink: 0 }} />
                      {label}
                    </div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>{count}</span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', width: 38, textAlign: 'right' }}>{pct}%</span>
                    </div>
                  </div>
                  <div style={{ height: 6, backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', backgroundColor: color, borderRadius: 'var(--radius-full)', transition: 'width 0.6s ease' }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Sequence Performance */}
        <div style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 18 }}>
          <h4 style={{ marginBottom: 4 }}>Sequence Performance</h4>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: 14 }}>
            {sequences.length} sequences · ranked by enrollment
          </p>
          {loading ? (
            [1,2,3].map(i => <div key={i} className="skeleton" style={{ height: 44, marginBottom: 10, borderRadius: 4 }} />)
          ) : seqPerf.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>No sequences yet.</div>
          ) : (
            seqPerf.map((seq, i) => (
              <div key={seq.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < seqPerf.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                <div style={{ minWidth: 0, flex: 1, marginRight: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.855rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{seq.name}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 1 }}>
                    {seq.steps} steps · {seq.active} active · {seq.completed} done
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <div style={{ width: 60, height: 5, backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-xs)', overflow: 'hidden' }}>
                    <div style={{ width: `${seqPerf[0].total > 0 ? (seq.total / seqPerf[0].total) * 100 : 0}%`, height: '100%', backgroundColor: 'var(--accent-primary)', borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', minWidth: 24, textAlign: 'right' }}>{seq.total}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Top Companies */}
      {!loading && topCompanies.length > 0 && (
        <div style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
            <div>
              <h4 style={{ marginBottom: 4 }}>Top Accounts</h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0 }}>Prospect concentration by company</p>
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{Object.keys(companyCounts).length} total companies</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '6px 20px' }}>
            {topCompanies.map((co, i) => {
              const pct = topCompanies[0].count > 0 ? ((co.count / topCompanies[0].count) * 100) : 0;
              return (
                <div key={co.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', width: 16, textAlign: 'right', flexShrink: 0 }}>#{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }} title={co.name}>{co.name}</span>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0, marginLeft: 6 }}>{co.count}</span>
                    </div>
                    <div style={{ height: 3, backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary))', borderRadius: 'var(--radius-full)', transition: 'width 0.6s ease' }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* My Progress — rep-level activity summary */}
      <div style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 18 }}>
        <h4 style={{ marginBottom: 4 }}>My Progress</h4>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: 16 }}>{formatRange(range)} · key activities at a glance</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          {[
            { label: 'Meetings Booked', value: meetings, note: meetings > 0 ? `${meetings} from ${totalProspects} prospects` : 'No meetings yet', color: meetings > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' },
            { label: 'Reply Rate', value: totalProspects > 0 ? `${replyRate}%` : '—', note: replied > 0 ? `${replied} of ${totalProspects} replied` : 'No replies yet', color: replyRate >= 10 ? 'var(--status-success)' : replyRate > 0 ? 'var(--status-warning)' : 'var(--text-muted)' },
            { label: 'Meeting Conversion', value: totalProspects > 0 ? `${meetingRate}%` : '—', note: totalProspects > 0 ? `${meetings} meetings from ${totalProspects} prospects` : 'No prospects yet', color: totalProspects > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' },
            { label: 'Active Sequences', value: sequences.length, note: sequences.length > 0 ? `${totalEnrollments} enrolled prospects` : 'No sequences yet', color: sequences.length > 0 ? 'var(--status-info)' : 'var(--text-muted)' },
          ].map(item => (
            <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 2 }}>{item.label}</div>
                <div style={{ fontSize: '0.72rem', color: item.color }}>{item.note}</div>
              </div>
              <div style={{ fontWeight: 800, fontSize: '1.3rem', color: item.color, marginLeft: 12 }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AnalyticsDashboard;
