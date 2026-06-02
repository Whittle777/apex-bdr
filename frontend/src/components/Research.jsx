import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { parseZoomInfoCsv } from '../utils/zoomInfoCsv';
import { useIntegrations } from '../contexts/IntegrationContext';
import { useToast } from './Toast';

const STATUS_STYLES = {
  pending:     { bg: 'rgba(148,163,184,0.12)', color: 'var(--text-muted)',  border: 'rgba(148,163,184,0.25)' },
  scraping:    { bg: 'rgba(56,189,248,0.12)',  color: '#38bdf8',            border: 'rgba(56,189,248,0.3)'  },
  summarizing: { bg: 'rgba(167,139,250,0.12)', color: '#a78bfa',            border: 'rgba(167,139,250,0.3)' },
  done:        { bg: 'rgba(74,222,128,0.12)',  color: '#4ade80',            border: 'rgba(74,222,128,0.3)'  },
  failed:      { bg: 'rgba(248,113,113,0.12)', color: '#f87171',            border: 'rgba(248,113,113,0.3)' },
};

const StatusPill = ({ status }) => {
  const s = STATUS_STYLES[status] || STATUS_STYLES.pending;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      borderRadius: 'var(--radius-full)',
      fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.05em',
      textTransform: 'uppercase',
    }}>{status}</span>
  );
};

export default function Research() {
  const { isConfigured } = useIntegrations();
  const toast = useToast();
  const apifyReady = isConfigured('apify');

  const [phase, setPhase] = useState('idle'); // idle | running | complete | error
  const [job, setJob] = useState(null);       // current job snapshot
  const [error, setError] = useState(null);
  const [parsing, setParsing] = useState(false);
  const fileInputRef = useRef();
  const pollRef = useRef();

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  const startPolling = useCallback((jobId) => {
    stopPolling();
    const tick = async () => {
      try {
        const res = await api.get(`/research/jobs/${jobId}`);
        setJob(res.data);
        if (res.data.status === 'complete' || res.data.status === 'failed') {
          stopPolling();
          setPhase(res.data.status === 'complete' ? 'complete' : 'error');
        }
      } catch (err) {
        // Job missing → backend probably restarted
        stopPolling();
        setError('Lost connection to the research job. The backend may have restarted.');
        setPhase('error');
      }
    };
    tick();
    pollRef.current = setInterval(tick, 2000);
  }, []);

  const handleFile = async (file) => {
    if (!file) return;
    setParsing(true);
    setError(null);
    try {
      const prospects = await parseZoomInfoCsv(file);
      if (prospects.length === 0) {
        setError('No prospects found in the CSV. Check that the column headers match a ZoomInfo export (e.g., First Name, Email Address, LinkedIn URL).');
        setParsing(false);
        return;
      }
      const res = await api.post('/research/upload', { prospects });
      setPhase('running');
      toast(`Researching ${res.data.prospectCount} prospect${res.data.prospectCount !== 1 ? 's' : ''}…`, 'info');
      startPolling(res.data.jobId);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to start research job.');
      setPhase('error');
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleReset = () => {
    stopPolling();
    setJob(null);
    setError(null);
    setPhase('idle');
  };

  const exportUrl = job ? `${api.defaults.baseURL || ''}/research/jobs/${job.id}/export` : null;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>Research</h1>
        <p style={{ color: 'var(--text-muted)', margin: '4px 0 0', fontSize: '0.88rem' }}>
          Upload a ZoomInfo CSV. We'll scrape LinkedIn (where present) and
          generate a natural-language research brief per prospect, then save
          it on the prospect and offer the enriched CSV as a download.
        </p>
      </header>

      {!apifyReady && (
        <div style={{
          background: 'rgba(251,191,36,0.08)',
          border: '1px solid rgba(251,191,36,0.25)',
          color: '#fbbf24',
          padding: '10px 14px',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.85rem',
          marginBottom: 16,
        }}>
          Apify isn't connected — research will still run using title/company
          context, but no LinkedIn enrichment. Add an API token in{' '}
          <Link to="/integrations" style={{ color: '#fbbf24', textDecoration: 'underline' }}>Integrations</Link> for richer briefs.
        </div>
      )}

      {phase === 'idle' && (
        <div
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) handleFile(f);
          }}
          style={{
            border: '2px dashed var(--border-medium)',
            borderRadius: 'var(--radius-lg)',
            padding: '48px 32px',
            textAlign: 'center',
            background: 'var(--bg-tertiary)',
            cursor: 'pointer',
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>📄</div>
          <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 4 }}>
            {parsing ? 'Parsing CSV…' : 'Drop a ZoomInfo CSV here or click to browse'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
            We use First/Last Name, Email, Title, Company, and (optionally) LinkedIn URL.
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          {error && (
            <div style={{ color: '#f87171', marginTop: 14, fontSize: '0.85rem' }}>{error}</div>
          )}
        </div>
      )}

      {(phase === 'running' || phase === 'complete' || phase === 'error') && job && (
        <>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            marginBottom: 16,
          }}>
            <div>
              <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>
                {job.completed} / {job.total} complete
                {job.failed > 0 && (
                  <span style={{ color: '#f87171', marginLeft: 10 }}>· {job.failed} failed</span>
                )}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: 2 }}>
                {job.accountsCreated > 0 && `${job.accountsCreated} new account${job.accountsCreated !== 1 ? 's' : ''} · `}
                {job.prospectsCreated > 0 && `${job.prospectsCreated} new prospect${job.prospectsCreated !== 1 ? 's' : ''} · `}
                Status: {job.status}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {phase === 'complete' && exportUrl && (
                <a
                  href={exportUrl}
                  className="btn-primary"
                  style={{ textDecoration: 'none' }}
                  download
                >
                  Download enriched CSV
                </a>
              )}
              {(phase === 'complete' || phase === 'error') && (
                <button className="btn-secondary" onClick={handleReset}>
                  Run another upload
                </button>
              )}
            </div>
          </div>

          {error && (
            <div style={{ color: '#f87171', marginBottom: 12, fontSize: '0.85rem' }}>{error}</div>
          )}

          <div style={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead style={{ background: 'var(--bg-secondary)' }}>
                <tr>
                  <th style={th}>Prospect</th>
                  <th style={th}>Title</th>
                  <th style={th}>Company</th>
                  <th style={th}>LinkedIn</th>
                  <th style={th}>Status</th>
                  <th style={th}>Brief</th>
                </tr>
              </thead>
              <tbody>
                {job.items.map((item, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-soft)' }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{item.firstName} {item.lastName}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{item.email}</div>
                    </td>
                    <td style={td}>{item.title || '—'}</td>
                    <td style={td}>{item.companyName || '—'}</td>
                    <td style={td}>
                      {item.linkedIn ? (
                        <a href={item.linkedIn} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>
                          {item.scraped ? '✓ scraped' : 'link'}
                        </a>
                      ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>
                    <td style={td}><StatusPill status={item.status} /></td>
                    <td style={{ ...td, maxWidth: 480, whiteSpace: 'normal' }}>
                      {item.error ? (
                        <span style={{ color: '#f87171' }}>{item.error}</span>
                      ) : item.brief ? (
                        <span style={{ color: 'var(--text-primary)' }}>{item.brief}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const th = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: '0.72rem',
  fontWeight: 700,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
};

const td = {
  padding: '12px 14px',
  verticalAlign: 'top',
};
