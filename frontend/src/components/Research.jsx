import React, { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { parseZoomInfoCsv, parseAccountResearchCsv } from '../utils/zoomInfoCsv';
import { useIntegrations } from '../contexts/IntegrationContext';
import { useResearch } from '../contexts/ResearchContext';
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

const TabButton = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    style={{
      background: 'none',
      border: 'none',
      padding: '10px 4px',
      marginRight: 20,
      fontSize: '0.92rem',
      fontWeight: 700,
      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
      borderBottom: active ? '2px solid var(--accent-primary)' : '2px solid transparent',
      cursor: 'pointer',
    }}
  >{children}</button>
);

export default function Research() {
  const [tab, setTab] = useState('prospects'); // 'prospects' | 'accounts'

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>Research</h1>
        <p style={{ color: 'var(--text-muted)', margin: '4px 0 0', fontSize: '0.88rem' }}>
          Upload ZoomInfo-style prospect lists for AI briefs, or seed
          account-level context that flows into every future prospect brief.
        </p>
      </header>

      <div style={{ borderBottom: '1px solid var(--border-soft)', marginBottom: 18 }}>
        <TabButton active={tab === 'prospects'} onClick={() => setTab('prospects')}>Prospect briefs</TabButton>
        <TabButton active={tab === 'accounts'} onClick={() => setTab('accounts')}>Account research</TabButton>
      </div>

      {tab === 'prospects' ? <ProspectResearchPanel /> : <AccountResearchPanel />}
    </div>
  );
}

// ─── Prospect briefs tab ─────────────────────────────────────────────────────
function ProspectResearchPanel() {
  const { isConfigured } = useIntegrations();
  const { activeJob: job, activeJobId, startJob, clearJob } = useResearch();
  const toast = useToast();
  const apifyReady = isConfigured('apify');

  const [error, setError] = useState(null);
  const [parsing, setParsing] = useState(false);
  const fileInputRef = useRef();

  const phase = !activeJobId
    ? 'idle'
    : job?.status === 'complete'
      ? 'complete'
      : job?.status === 'failed'
        ? 'error'
        : 'running';

  const handleFile = async (file) => {
    if (!file) return;
    setParsing(true);
    setError(null);
    try {
      const prospects = await parseZoomInfoCsv(file);
      if (prospects.length === 0) {
        setError('No prospects found. Check that the CSV column headers match a ZoomInfo export (First Name, Email Address, LinkedIn URL, etc.).');
        setParsing(false);
        return;
      }
      const res = await api.post('/research/upload', { prospects });
      toast(`Researching ${res.data.prospectCount} prospect${res.data.prospectCount !== 1 ? 's' : ''} in the background…`, 'info');
      startJob(res.data.jobId);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to start research job.');
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleReset = () => {
    clearJob();
    setError(null);
  };

  const exportUrl = job ? `${api.defaults.baseURL || ''}/research/jobs/${job.id}/export` : null;

  return (
    <>
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
          Apify isn't connected — research will still run using title/company/account
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
            {parsing ? 'Parsing CSV…' : 'Drop a ZoomInfo prospect CSV here or click to browse'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
            Uses First/Last Name, Email, Title, Company, and (optionally) LinkedIn URL.
            We'll pull in any matching Account research automatically.
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

      {phase !== 'idle' && !job && (
        <div style={{ padding: '32px 0', color: 'var(--text-muted)' }}>Loading research job…</div>
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
    </>
  );
}

// ─── Account research tab ────────────────────────────────────────────────────
function AccountResearchPanel() {
  const toast = useToast();
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [preview, setPreview] = useState(null); // last parsed rows for confirmation
  const fileInputRef = useRef();

  const handleFile = async (file) => {
    if (!file) return;
    setParsing(true);
    setError(null);
    setResult(null);
    try {
      const rows = await parseAccountResearchCsv(file);
      if (rows.length === 0) {
        setError('No usable rows found. Make sure your CSV has a company-name column and a research column (or that the first two columns hold those values).');
        return;
      }
      setPreview(rows);
      const res = await api.post('/accounts/research-upload', { rows });
      setResult(res.data);
      const total = res.data.updated + res.data.created;
      toast(`Appended research to ${total} account${total !== 1 ? 's' : ''}`, 'success');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to upload account research.');
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleReset = () => {
    setPreview(null);
    setResult(null);
    setError(null);
  };

  return (
    <>
      <div style={{
        background: 'rgba(56,189,248,0.06)',
        border: '1px solid rgba(56,189,248,0.18)',
        color: 'var(--text-secondary)',
        padding: '10px 14px',
        borderRadius: 'var(--radius-md)',
        fontSize: '0.85rem',
        marginBottom: 16,
        lineHeight: 1.55,
      }}>
        Upload a CSV with one row per account: a <strong>company name</strong> column and a <strong>research</strong> column. We'll <strong>append</strong> the new research to each matching Account (with a dated header), preserving anything already there. Accounts that don't exist yet are created. Subsequent prospect briefs at those companies will use the full accumulated context.
      </div>

      {!result && (
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
            padding: '40px 32px',
            textAlign: 'center',
            background: 'var(--bg-tertiary)',
            cursor: 'pointer',
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>🏢</div>
          <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 4 }}>
            {parsing ? 'Parsing CSV…' : 'Drop an account research CSV here or click to browse'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
            Recognised headers: Company / Account Name + Research / Brief / Summary. Falls back to columns 1 + 2.
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

      {result && (
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
                {result.updated} appended · {result.created} created
                {result.skipped > 0 && <span style={{ color: 'var(--text-muted)' }}> · {result.skipped} skipped</span>}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: 2 }}>
                Existing research was preserved — new content was added on top with today's date.
              </div>
            </div>
            <button className="btn-secondary" onClick={handleReset}>Upload another file</button>
          </div>

          {preview && (
            <div style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-soft)',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead style={{ background: 'var(--bg-secondary)' }}>
                  <tr>
                    <th style={th}>Account</th>
                    <th style={th}>Research</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border-soft)' }}>
                      <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{r.name}</td>
                      <td style={{ ...td, whiteSpace: 'normal' }}>{r.researchSummary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
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
