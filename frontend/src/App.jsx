import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route, Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import Prospects from './components/Prospects';
import SequenceSteps from './components/SequenceSteps';
import WebsocketViewer from './components/WebsocketViewer';
import PowerDialerView from './components/PowerDialerView';
import SequenceManager from './components/SequenceManager';
import Integrations from './components/Integrations';
import HITLReviewView from './components/HITLReviewView';
import AnalyticsDashboard from './components/AnalyticsDashboard';
import DeliverabilityGate from './components/DeliverabilityGate';
import VoiceFleetCommand from './components/VoiceFleetCommand';
import SuccessPlans from './components/SuccessPlans';
import TaskInbox from './components/TaskInbox';
import VoiceAgentLanding from './components/VoiceAgentLanding';
import Accounts from './components/Accounts';
import EmailSafety from './components/EmailSafety';
import Research from './components/Research';
import { ToastProvider } from './components/Toast';
import { IntegrationProvider, useIntegrations } from './contexts/IntegrationContext';
import { ResearchProvider, useResearch } from './contexts/ResearchContext';
import TourOverlay, { useTourAutoStart, TOUR_LS_KEY } from './components/TourOverlay';
import DemoMode from './components/DemoMode';
import api from './services/api';

const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
};

// Handles the redirect back from Microsoft OAuth — stores JWT and sends to dashboard
const MicrosoftAuthCallback = () => {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      localStorage.setItem('token', token);
      window.location.replace('/');
    } else {
      window.location.replace('/login?ms_error=No+token+received.');
    }
  }, []);
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100%' }}>
      <p style={{ color:'var(--text-muted)' }}>Signing you in…</p>
    </div>
  );
};

const getInitials = (name, email) => {
  if (name && name !== 'Guest') {
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }
  if (email) return email[0].toUpperCase();
  return '?';
};

// ─── localStorage keys — must match PowerDialerView.jsx ────────────────────
// CALL_TS_KEY is written by PowerDialerView every time a dial is initiated and
// read here to compute the "calls today" progress bar in the sidebar.
const CALL_TS_KEY = 'calls_prospect_timestamps';
const GOALS_KEY   = 'bdr_daily_goals';

// ─── Daily activity helpers ─────────────────────────────────────────────────
const DEFAULT_CALLS_GOAL   = 20;  // shown until the user sets their own target
const GOAL_REFRESH_MS      = 30_000; // how often the sidebar call counter polls localStorage

const getTodayCallCount = () => {
  try {
    const ts    = JSON.parse(localStorage.getItem(CALL_TS_KEY) || '{}');
    const today = new Date().toDateString();
    // Count entries whose timestamp falls on today's date
    return Object.values(ts).filter(t => new Date(t).toDateString() === today).length;
  } catch { return 0; }
};

const getGoals   = () => { try { return JSON.parse(localStorage.getItem(GOALS_KEY) || JSON.stringify({ calls: DEFAULT_CALLS_GOAL })); } catch { return { calls: DEFAULT_CALLS_GOAL }; } };
const saveGoals  = (g) => { try { localStorage.setItem(GOALS_KEY, JSON.stringify(g)); } catch {} };

const NAV = [
  {
    label: 'Platform',
    links: [
      { path: '/',                 label: 'Command Center', icon: '✦', desc: 'AI chat · call lists · pipeline overview (G+D)' },
      { path: '/dialer',           label: 'Calls',          icon: '📞', desc: 'Power dial & sequential calling (G+C)' },
      { path: '/sequence-manager', label: 'Sequences',      icon: '✉️', desc: 'Email cadences & prospect enrollment (G+S)' },
      { path: '/prospects',        label: 'Prospects',      icon: '👥', desc: 'Contact CRM — search, filter, bulk import (G+P)' },
      { path: '/accounts',         label: 'Accounts',       icon: '🏢', desc: 'Company accounts — linked prospects & engagement (G+B)' },
      { path: '/tasks',            label: 'Task Inbox',     icon: '✅', desc: 'Unified queue of all due sequence tasks (G+T)' },
      { path: '/success-plans',    label: 'Success Plans',  icon: '🤝', desc: 'Mutual action plans & buyer-seller checklists (G+M)' },
    ],
  },
  {
    label: 'Intelligence',
    links: [
      { path: '/analytics',     label: 'Analytics',  icon: '📊', desc: 'Your pipeline health & activity metrics (G+A)' },
      { path: '/research',      label: 'Research',   icon: '🔬', desc: 'Upload a prospect list and generate AI research briefs' },
    ],
  },
  {
    label: 'Config',
    links: [
      { path: '/integrations',  label: 'Integrations',  icon: '🔗', desc: 'CRM · Teams · Gmail · API keys' },
      { path: '/email-safety',  label: 'Email Safety',  icon: '🛡️', desc: 'Sending limits, bounce rules & compliance' },
    ],
  },
  {
    label: 'Labs',
    isLabs: true,
    links: [
      { path: '/hitl',          label: 'AI Review Queue', icon: '🛡️', desc: 'Human-in-the-loop review for AI-drafted emails — not yet active' },
      { path: '/voice-fleet',   label: 'Voice Fleet',     icon: '🎙️', desc: 'Autonomous AI voice agents — not yet active' },
      { path: '/deliverability',label: 'Deliverability',  icon: '📡', desc: 'Domain health · SPF, DKIM & inbox placement' },
    ],
  },
];

const FULL_HEIGHT_PATHS = ['/hitl', '/voice-fleet', '/dialer', '/accounts'];

const SHORTCUTS = [
  { keys: ['⌘','K'],     desc: 'Open command palette' },
  { keys: ['?'],          desc: 'Toggle this help' },
  { keys: ['G','D'],      desc: 'Go → Command Center' },
  { keys: ['G','C'],      desc: 'Go → Calls' },
  { keys: ['G','S'],      desc: 'Go → Sequences' },
  { keys: ['G','P'],      desc: 'Go → Prospects' },
  { keys: ['G','B'],      desc: 'Go → Accounts' },
  { keys: ['G','A'],      desc: 'Go → Analytics' },
  { keys: ['G','R'],      desc: 'Go → Review Queue' },
  { keys: ['G','T'],      desc: 'Go → Task Inbox' },
  { keys: ['G','M'],      desc: 'Go → Success Plans' },
  { keys: ['G','I'],      desc: 'Go → Integrations' },
  { keys: ['G','V'],      desc: 'Go → Voice Fleet' },
  { keys: ['Esc'],        desc: 'Close overlays' },
];

const KBD = ({ children }) => (
  <span style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', padding:'1px 6px', background:'var(--bg-primary)', border:'1px solid var(--border-color)', borderRadius:4, fontSize:'0.72rem', fontWeight:700, color:'var(--text-secondary)', fontFamily:'monospace', lineHeight:'18px', minWidth:20 }}>
    {children}
  </span>
);

const NAV_ACTIONS = [
  { icon:'✦', label:'Command Center',  path:'/',                 sub:'Daily workspace & AI orchestration' },
  { icon:'📞', label:'Calls',           path:'/dialer',           sub:'Manual, sequential & power dialing' },
  { icon:'✉️', label:'Sequences',       path:'/sequence-manager', sub:'Email cadences & enrollment' },
  { icon:'👥', label:'Prospects',       path:'/prospects',        sub:'Browse, filter & enrich contacts' },
  { icon:'🏢', label:'Accounts',        path:'/accounts',         sub:'Company accounts & linked prospects' },
  { icon:'📊', label:'Analytics',       path:'/analytics',        sub:'Your pipeline health & activity metrics' },
  { icon:'🔬', label:'Research',        path:'/research',         sub:'Upload a CSV and generate AI research briefs' },
  { icon:'🔗', label:'Integrations',    path:'/integrations',     sub:'CRM, Teams, Gmail config' },
  { icon:'🛡️', label:'Email Safety',   path:'/email-safety',     sub:'Sending limits, bounce rules & compliance' },
  { icon:'✅', label:'Task Inbox',      path:'/tasks',            sub:'All due sequence tasks in one view' },
  { icon:'🤝', label:'Success Plans',   path:'/success-plans',    sub:'Mutual action plans with buyers' },
  { icon:'?',  label:'Take a tour',     path:null,                sub:'Guided walkthrough of the app' },
  { icon:'🎬', label:'Demo mode',       path:'__demo__',          sub:'Load a full realistic demo dataset in one click' },
  { icon:'🛡️', label:'AI Review Queue', path:'/hitl',             sub:'Labs — human-in-the-loop review for AI-drafted emails' },
  { icon:'🎙️', label:'Voice Fleet',     path:'/voice-fleet',      sub:'Labs — autonomous AI voice agents' },
  { icon:'📡', label:'Deliverability',  path:'/deliverability',   sub:'Labs — domain health & inbox placement' },
];

const CommandPalette = ({ onClose, navigate, prospects, onTour, onDemo }) => {
  const [query, setQuery]       = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30); }, []);

  const q = query.toLowerCase().trim();

  const matchedActions = NAV_ACTIONS.filter(a =>
    !q || a.label.toLowerCase().includes(q) || a.sub.toLowerCase().includes(q)
  );

  const matchedProspects = q.length > 1
    ? prospects.filter(p => `${p.firstName} ${p.lastName} ${p.companyName || p.company || ''} ${p.email}`.toLowerCase().includes(q)).slice(0, 6)
    : [];

  const allItems = [
    ...matchedActions.map(a => ({
      ...a,
      type: 'nav',
      action: a.path === null ? () => { onTour?.(); } : a.path === '__demo__' ? () => { onDemo?.(); } : () => navigate(a.path),
    })),
    ...matchedProspects.map(p => ({
      icon: '👤', label: `${p.firstName} ${p.lastName}`,
      sub: `${p.companyName || p.company || ''}${p.email ? ' · ' + p.email : ''}`,
      type: 'prospect',
      action: () => navigate('/prospects', { state: { openProspectId: p.id } }),
    })),
  ];

  const go = (idx) => { allItems[idx]?.action(); onClose(); };

  const onKey = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, allItems.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter')     { go(activeIdx); }
  };

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(0,0,0,0.65)', backdropFilter:'blur(5px)', display:'flex', alignItems:'flex-start', justifyContent:'center', paddingTop:'14vh' }}>
      <div onClick={e => e.stopPropagation()} style={{ width:580, background:'var(--bg-elevated)', border:'1px solid var(--border-color)', borderRadius:'var(--radius-lg)', boxShadow:'0 24px 80px rgba(0,0,0,0.7)', overflow:'hidden' }}>

        {/* Search bar */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 18px', borderBottom:'1px solid var(--border-color)' }}>
          <span style={{ fontSize:'1.1rem', color:'var(--text-muted)', flexShrink:0 }}>⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKey}
            placeholder="Search prospects, navigate, or trigger an action…"
            style={{ flex:1, background:'transparent', border:'none', outline:'none', fontSize:'1rem', color:'var(--text-primary)' }}
          />
          {query && <button style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', fontSize:'1rem' }} onClick={() => setQuery('')}>✕</button>}
          <KBD>esc</KBD>
        </div>

        {/* Results */}
        <div style={{ maxHeight:400, overflowY:'auto' }}>
          {matchedActions.length > 0 && (
            <>
              <div style={{ padding:'10px 18px 4px', fontSize:'0.7rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.1em' }}>
                {q ? 'Navigate' : 'Quick Actions'}
              </div>
              {matchedActions.map((item, i) => (
                <button key={item.path} onClick={() => go(i)}
                  style={{ width:'100%', display:'flex', alignItems:'center', gap:12, padding:'10px 18px', background: activeIdx === i ? 'var(--accent-dim)' : 'transparent', border:'none', borderLeft: activeIdx === i ? '2px solid var(--accent-primary)' : '2px solid transparent', cursor:'pointer', textAlign:'left', transition:'background 0.1s' }}
                  onMouseEnter={() => setActiveIdx(i)}>
                  <span style={{ fontSize:'1rem', width:22, textAlign:'center', flexShrink:0 }}>{item.icon}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:'0.9rem', fontWeight:600, color: activeIdx === i ? 'var(--accent-secondary)' : 'var(--text-primary)' }}>{item.label}</div>
                    <div style={{ fontSize:'0.76rem', color:'var(--text-muted)', marginTop:1 }}>{item.sub}</div>
                  </div>
                  <span style={{ fontSize:'0.7rem', color:'var(--text-muted)' }}>enter</span>
                </button>
              ))}
            </>
          )}
          {matchedProspects.length > 0 && (
            <>
              <div style={{ padding:'10px 18px 4px', fontSize:'0.7rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.1em' }}>Prospects</div>
              {matchedProspects.map((p, i) => {
                const idx = matchedActions.length + i;
                return (
                  <button key={p.id} onClick={() => go(idx)}
                    style={{ width:'100%', display:'flex', alignItems:'center', gap:12, padding:'10px 18px', background: activeIdx === idx ? 'var(--accent-dim)' : 'transparent', border:'none', borderLeft: activeIdx === idx ? '2px solid var(--accent-primary)' : '2px solid transparent', cursor:'pointer', textAlign:'left', transition:'background 0.1s' }}
                    onMouseEnter={() => setActiveIdx(idx)}>
                    <span style={{ fontSize:'1rem', width:22, textAlign:'center', flexShrink:0 }}>👤</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:'0.9rem', fontWeight:600, color: activeIdx === idx ? 'var(--accent-secondary)' : 'var(--text-primary)' }}>{p.firstName} {p.lastName}</div>
                      <div style={{ fontSize:'0.76rem', color:'var(--text-muted)', marginTop:1 }}>{p.companyName || p.company || ''}{p.email ? ' · ' + p.email : ''}</div>
                    </div>
                  </button>
                );
              })}
            </>
          )}
          {allItems.length === 0 && (
            <div style={{ padding:'24px 18px', textAlign:'center', color:'var(--text-muted)', fontSize:'0.88rem' }}>No results for "{query}"</div>
          )}
        </div>

        {/* Footer hints */}
        <div style={{ padding:'10px 18px', borderTop:'1px solid var(--border-color)', display:'flex', gap:16, fontSize:'0.74rem', color:'var(--text-muted)' }}>
          {[['↑↓','navigate'],['↵','select'],['esc','close']].map(([k,d]) => (
            <span key={k} style={{ display:'flex', alignItems:'center', gap:4 }}><KBD>{k}</KBD> {d}</span>
          ))}
        </div>
      </div>
    </div>
  );
};

const ShortcutsOverlay = ({ onClose }) => (
  <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(0,0,0,0.65)', backdropFilter:'blur(5px)', display:'flex', alignItems:'center', justifyContent:'center' }}>
    <div onClick={e=>e.stopPropagation()} style={{ width:420, background:'var(--bg-elevated)', border:'1px solid var(--border-color)', borderRadius:'var(--radius-lg)', boxShadow:'0 24px 80px rgba(0,0,0,0.7)', overflow:'hidden' }}>
      <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border-color)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span style={{ fontWeight:700, fontSize:'0.9rem' }}>Keyboard Shortcuts</span>
        <button style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)' }} onClick={onClose}>✕</button>
      </div>
      <div style={{ padding:'8px 0 16px' }}>
        {SHORTCUTS.map(s => (
          <div key={s.desc} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 20px' }}>
            <span style={{ fontSize:'0.88rem', color:'var(--text-secondary)' }}>{s.desc}</span>
            <div style={{ display:'flex', gap:4 }}>
              {s.keys.map(k => <KBD key={k}>{k}</KBD>)}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding:'10px 20px', borderTop:'1px solid var(--border-color)', fontSize:'0.75rem', color:'var(--text-muted)', textAlign:'center' }}>
        Press <KBD>?</KBD> anywhere to toggle this panel
      </div>
    </div>
  </div>
);

function AppInner() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isConfigured } = useIntegrations();
  const { activeJob: researchJob, activeJobId: researchJobId } = useResearch();
  const setupIncomplete = !isConfigured('claude') || !isConfigured('google') || !isConfigured('microsoft');
  const [tourOpen, setTourOpen] = useState(() => useTourAutoStart());
  const [demoOpen, setDemoOpen] = useState(false);
  const [paletteOpen, setPaletteOpen]     = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [allProspects, setAllProspects]   = useState([]);
  const [callsToday, setCallsToday]       = useState(getTodayCallCount);
  const [goals, setGoals]                 = useState(getGoals);
  const [hitlCount, setHitlCount]         = useState(0);
  const [activeEnrollments, setActiveEnrollments] = useState(0);
  const [pendingTaskCount, setPendingTaskCount]   = useState(0);
  const [editingGoal, setEditingGoal]     = useState(false);
  const [goalDraft, setGoalDraft]         = useState('');
  const [currentUser, setCurrentUser]     = useState(null);

  useEffect(() => {
    if (localStorage.getItem('token')) {
      api.get('/auth/me').then(r => setCurrentUser(r.data)).catch(() => {});
    }
  }, []);

  // Fetch all prospects once on mount so the command palette can search them
  // without a network round-trip on every Cmd+K open. Errors are intentionally
  // silenced — the palette degrades gracefully to showing only nav actions.
  useEffect(() => {
    api.get('/prospects').then(r => setAllProspects(r.data || [])).catch(() => {});
    // Live badge counts
    api.get('/hitl/queue').then(r => setHitlCount((r.data || []).length)).catch(() => {});
    api.get('/sequences').then(r => {
      const seqs = r.data || [];
      const total = seqs.reduce((acc, s) =>
        acc + (s.prospectEnrollments?.filter(e => e.status === 'active').length || 0), 0);
      setActiveEnrollments(total);
      // Rough pending task count: active enrollments due today or overdue
      // (same 30/40/30 split used in TaskInbox)
      const now = new Date();
      let pending = 0;
      seqs.forEach(s => {
        (s.prospectEnrollments || []).forEach((enr, idx) => {
          if (enr.status !== 'active') return;
          const bucket = idx % 10;
          if (bucket < 7) pending++; // overdue or today
        });
      });
      setPendingTaskCount(pending);
    }).catch(() => {});
  }, []);

  // Poll localStorage for today's call count. We can't subscribe to storage
  // events across same-tab writes (PowerDialerView writes, App reads), so we
  // poll instead. 30 s is frequent enough to feel live without wasting cycles.
  useEffect(() => {
    const iv = setInterval(() => setCallsToday(getTodayCallCount()), GOAL_REFRESH_MS);
    return () => clearInterval(iv);
  }, []);

  // Global keyboard shortcuts — fires on every keydown outside form fields.
  //
  // Two-key "G + letter" navigation (inspired by GitHub/Linear):
  //   Press G, then within 800 ms press a letter to jump to that section.
  //   gHeld acts as a flag; the timer resets it if the second key is too slow.
  //
  // Single-key shortcuts:
  //   Cmd/Ctrl+K → command palette
  //   ?          → shortcuts overlay
  //   Esc        → close any open overlay
  const G_KEY_TIMEOUT_MS = 800;
  useEffect(() => {
    let gHeld = false, gTimer = null;
    const down = (e) => {
      const tag = e.target.tagName;
      if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return; // don't steal focus from fields

      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setPaletteOpen(true); return; }
      if (e.key === 'Escape') { setPaletteOpen(false); setShortcutsOpen(false); return; }
      if (e.key === '?') { setShortcutsOpen(s => !s); return; }

      // First key of a G+letter chord
      if (e.key.toLowerCase() === 'g' && !e.metaKey && !e.ctrlKey) {
        gHeld = true;
        clearTimeout(gTimer);
        gTimer = setTimeout(() => { gHeld = false; }, G_KEY_TIMEOUT_MS);
        return;
      }

      // Second key of the chord — navigate if recognised
      if (gHeld) {
        const map = { d:'/', c:'/dialer', s:'/sequence-manager', p:'/prospects', b:'/accounts', a:'/analytics', r:'/hitl', t:'/tasks', m:'/success-plans', i:'/integrations', v:'/voice-fleet' };
        if (map[e.key.toLowerCase()]) { navigate(map[e.key.toLowerCase()]); gHeld = false; }
      }
    };
    document.addEventListener('keydown', down);
    return () => { document.removeEventListener('keydown', down); clearTimeout(gTimer); };
  }, [navigate]);

  const isActive = (path) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  const isFullHeight = FULL_HEIGHT_PATHS.includes(location.pathname);

  const allLinks = NAV.flatMap(s => s.links);
  const activePage = allLinks.find(l => isActive(l.path));
  const activeSection = NAV.find(s => s.links.some(l => isActive(l.path)));

  return (
    <div className="layout">
      {/* ── Sidebar ── */}
      <nav className="sidebar">
        <div className="sidebar-header">
          <div className="logo-icon" />
          <h2>Apex</h2>
        </div>

        <div className="nav-links">
          {NAV.map((section, sIdx) => (
            <div key={section.label} style={{ marginBottom: 2 }}>
              <div className="nav-section-label" style={sIdx === 0 ? { paddingTop: 8 } : {}}>
                {section.label}
              </div>
              {section.links.map((link) => {
                const isLabs = !!section.isLabs;
                const researchBadge = (link.path === '/research' && researchJobId && researchJob)
                  ? (researchJob.status === 'complete' ? '✓' : `${researchJob.completed}/${researchJob.total}`)
                  : null;
                const badge =
                  link.path === '/sequence-manager' && activeEnrollments > 0 ? activeEnrollments :
                  link.path === '/tasks' && pendingTaskCount > 0 ? pendingTaskCount :
                  researchBadge;
                const researchRunning = link.path === '/research' && researchJobId && researchJob && researchJob.status === 'running';
                const showSetupBadge = link.path === '/integrations' && setupIncomplete;
                const tourAttr =
                  link.path === '/'                 ? 'nav-dashboard'    :
                  link.path === '/dialer'           ? 'nav-dialer'       :
                  link.path === '/sequence-manager' ? 'nav-sequences'    :
                  link.path === '/prospects'        ? 'nav-prospects'    :
                  link.path === '/tasks'            ? 'nav-tasks'        :
                  link.path === '/integrations'     ? 'nav-integrations' : null;
                return (
                  <Link
                    key={link.path}
                    to={link.path}
                    className={`nav-link${isActive(link.path) ? ' active' : ''}`}
                    title={link.desc}
                    style={isLabs ? { opacity: 0.5 } : {}}
                    {...(tourAttr ? { 'data-tour': tourAttr } : {})}
                  >
                    <span className="nav-icon">{link.icon}</span>
                    <span className="nav-label">{link.label}</span>
                    {isLabs && (
                      <span style={{
                        marginLeft: 'auto', fontSize: '0.55rem', fontWeight: 700,
                        padding: '1px 5px', borderRadius: 'var(--radius-full)',
                        background: 'rgba(139,92,246,0.15)', color: 'var(--accent-secondary)',
                        border: '1px solid rgba(139,92,246,0.25)', letterSpacing: '0.06em',
                        whiteSpace: 'nowrap', textTransform: 'uppercase',
                      }}>
                        soon
                      </span>
                    )}
                    {badge ? (
                      <span
                        className="nav-badge"
                        style={researchRunning ? {
                          background: 'rgba(56,189,248,0.15)',
                          color: '#38bdf8',
                          border: '1px solid rgba(56,189,248,0.3)',
                          animation: 'pulse 2s ease-in-out infinite',
                        } : researchBadge === '✓' ? {
                          background: 'rgba(74,222,128,0.15)',
                          color: '#4ade80',
                          border: '1px solid rgba(74,222,128,0.3)',
                        } : undefined}
                      >
                        {badge}
                      </span>
                    ) : null}
                    {showSetupBadge && (
                      <span style={{
                        marginLeft: 'auto', fontSize: '0.6rem', fontWeight: 700,
                        padding: '1px 6px', borderRadius: 'var(--radius-full)',
                        background: 'var(--status-warning-dim)', color: 'var(--status-warning)',
                        border: '1px solid var(--status-warning-border)', letterSpacing: '0.04em',
                        whiteSpace: 'nowrap',
                      }}>
                        Setup
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {/* ── Daily Activity Widget ── */}
        <div className="sidebar-widget" style={{ padding:'12px 14px', borderTop:'1px solid var(--border-subtle)', borderBottom:'1px solid var(--border-subtle)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
            <span style={{ fontSize:'0.68rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.1em' }}>Today</span>
            <span style={{ fontSize:'0.68rem', color:'var(--text-muted)' }}>
              {new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})}
            </span>
          </div>
          {/* Calls */}
          <div style={{ marginBottom:6 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:3 }}>
              <span style={{ fontSize:'0.75rem', color:'var(--text-primary)', fontWeight:500 }}>📞 Calls</span>
              <span style={{ fontSize:'0.75rem', fontWeight:700, color: callsToday >= goals.calls ? 'var(--status-success)' : 'var(--text-primary)' }}>
                {callsToday}<span style={{ color:'var(--text-muted)', fontWeight:400 }}>/{goals.calls}</span>
                <span style={{ marginLeft:5, fontSize:'0.68rem', color: callsToday >= goals.calls ? 'var(--status-success)' : 'var(--text-muted)', fontWeight:600 }}>
                  {Math.min(100,Math.round((callsToday/goals.calls)*100))}%
                </span>
              </span>
            </div>
            <div style={{ height:4, background:'var(--bg-primary)', borderRadius:2, overflow:'hidden' }}>
              <div style={{ width:`${Math.min(100,Math.round((callsToday/goals.calls)*100))}%`, height:'100%', background: callsToday >= goals.calls ? 'var(--status-success)' : 'var(--accent-primary)', borderRadius:2, transition:'width 0.5s ease' }} />
            </div>
          </div>
          {/* Goal edit */}
          <div style={{ display:'flex', justifyContent:'flex-end', marginTop:4 }}>
            {editingGoal ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = parseInt(goalDraft, 10);
                  if (n > 0) { const ng = {...goals, calls:n}; setGoals(ng); saveGoals(ng); }
                  setEditingGoal(false);
                }}
                style={{ display:'flex', gap:4, alignItems:'center' }}
              >
                <input
                  autoFocus
                  type="number"
                  min="1"
                  value={goalDraft}
                  onChange={e => setGoalDraft(e.target.value)}
                  onBlur={() => setEditingGoal(false)}
                  style={{ width:48, fontSize:'0.72rem', padding:'1px 5px', textAlign:'center' }}
                />
                <button type="submit" style={{ background:'none', border:'none', cursor:'pointer', fontSize:'0.7rem', color:'var(--accent-light)', padding:'2px 0', lineHeight:1 }}>✓</button>
              </form>
            ) : (
              <button style={{ background:'none', border:'none', cursor:'pointer', fontSize:'0.7rem', color:'var(--text-muted)', padding:'2px 0', lineHeight:1 }}
                onClick={() => { setGoalDraft(String(goals.calls)); setEditingGoal(true); }}>
                Edit target
              </button>
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          {/* User profile row */}
          <Link to="/login" className="nav-link" style={{ gap: 10, marginBottom: 6 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: currentUser?.isGuest ? 'var(--bg-tertiary)' : 'var(--grad-brand)',
              border: currentUser?.isGuest ? '1px solid var(--border-subtle)' : 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.62rem', fontWeight: 800, color: '#fff', flexShrink: 0,
              boxShadow: '0 0 10px rgba(14,165,233,0.25)',
            }}>
              {getInitials(currentUser?.name, currentUser?.email)}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                {currentUser?.name || currentUser?.email || 'Loading…'}
              </div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.3 }}>
                {currentUser?.isGuest ? 'Guest session' : currentUser?.email || ''}
              </div>
            </div>
          </Link>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 5 }}>
            <button
              onClick={() => setTourOpen(true)}
              className="ghost"
              style={{
                flex: 1, fontSize: '0.72rem', padding: '6px 8px',
                color: 'var(--text-muted)', border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
              }}
              title="Take a guided walkthrough of the app"
            >
              ? Tour
            </button>
            <button
              onClick={() => setDemoOpen(true)}
              style={{
                flex: 1, fontSize: '0.72rem', padding: '6px 8px',
                background: 'var(--accent-dim)', border: '1px solid var(--border-accent)',
                borderRadius: 'var(--radius-sm)', color: 'var(--accent-secondary)',
                fontWeight: 600,
              }}
              title="Load a full demo dataset for walkthroughs and demos"
            >
              🎬 Demo
            </button>
            <button
              onClick={() => { localStorage.removeItem('token'); window.location.href = '/login'; }}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.75rem' }}
              title="Sign out"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>

      {/* ── Main content ── */}
      <main className="main-content">
        <header className="topbar">
          <div className="topbar-breadcrumb">
            {activeSection && (
              <>
                <span>{activeSection.label}</span>
                <span style={{ opacity: 0.35 }}>/</span>
              </>
            )}
            <span className="topbar-breadcrumb-current">
              {activePage ? `${activePage.icon} ${activePage.label}` : 'Dashboard'}
            </span>
          </div>
          <div className="topbar-actions">
            <button
              onClick={() => setPaletteOpen(true)}
              style={{ display:'flex', alignItems:'center', gap:10, padding:'5px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border-subtle)', borderRadius:'var(--radius-sm)', cursor:'pointer', color:'var(--text-secondary)', fontSize:'0.82rem', transition:'all var(--transition-fast)', flex:'1 1 0', maxWidth:280, minWidth:0 }}
              title="Command Palette (⌘K)"
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-accent)'; e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              <span style={{ color:'var(--text-muted)', fontSize:'0.82rem', fontFamily:'monospace' }}>⌕</span>
              <span className="topbar-search-hint" style={{ flex:1, textAlign:'left', color:'var(--text-muted)', fontSize:'0.8rem', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis' }}>Search prospects, navigate…</span>
              <div style={{ display:'flex', gap:2, alignItems:'center' }}>
                <kbd style={{ fontSize:'0.64rem', padding:'1px 5px', background:'var(--bg-elevated)', border:'1px solid var(--border-color)', borderBottom:'2px solid var(--border-color)', borderRadius:4, color:'var(--text-muted)', fontFamily:'monospace', lineHeight:'16px' }}>⌘</kbd>
                <kbd style={{ fontSize:'0.64rem', padding:'1px 5px', background:'var(--bg-elevated)', border:'1px solid var(--border-color)', borderBottom:'2px solid var(--border-color)', borderRadius:4, color:'var(--text-muted)', fontFamily:'monospace', lineHeight:'16px' }}>K</kbd>
              </div>
            </button>
            <button
              onClick={() => setShortcutsOpen(s => !s)}
              className="ghost"
              style={{ border:'1px solid var(--border-subtle)', padding:'5px 9px', color:'var(--text-muted)', fontSize:'0.8rem', gap:5 }}
              title="Keyboard shortcuts (?)"
            >
              <span style={{ fontFamily:'monospace', fontSize:'0.9rem' }}>⌨</span>
            </button>
            <div className="avatar" title={currentUser?.name || currentUser?.email || 'Guest'} />
          </div>
        </header>

        <div className={`page-content${isFullHeight ? ' full-height' : ''}`}>
          <Routes>
            <Route path="/login"            element={<Login />} />
            <Route path="/auth/callback"    element={<MicrosoftAuthCallback />} />
            <Route path="/"                 element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/prospects"        element={<ProtectedRoute><Prospects /></ProtectedRoute>} />
            <Route path="/sequence-steps"   element={<ProtectedRoute><SequenceSteps /></ProtectedRoute>} />
            <Route path="/ws"               element={<ProtectedRoute><WebsocketViewer /></ProtectedRoute>} />
            <Route path="/dialer"           element={<ProtectedRoute><PowerDialerView /></ProtectedRoute>} />
            <Route path="/sequence-manager" element={<ProtectedRoute><SequenceManager /></ProtectedRoute>} />
            <Route path="/integrations"     element={<ProtectedRoute><Integrations /></ProtectedRoute>} />
            <Route path="/hitl"             element={<ProtectedRoute><HITLReviewView /></ProtectedRoute>} />
            <Route path="/analytics"        element={<ProtectedRoute><AnalyticsDashboard /></ProtectedRoute>} />
            <Route path="/research"         element={<ProtectedRoute><Research /></ProtectedRoute>} />
            <Route path="/deliverability"   element={<ProtectedRoute><DeliverabilityGate /></ProtectedRoute>} />
            <Route path="/voice-fleet"      element={<ProtectedRoute><VoiceFleetCommand /></ProtectedRoute>} />
            <Route path="/tasks"            element={<ProtectedRoute><TaskInbox /></ProtectedRoute>} />
            <Route path="/success-plans"    element={<ProtectedRoute><SuccessPlans /></ProtectedRoute>} />
            <Route path="/voice-agent"      element={<ProtectedRoute><VoiceAgentLanding /></ProtectedRoute>} />
            <Route path="/accounts"         element={<ProtectedRoute><Accounts /></ProtectedRoute>} />
            <Route path="/email-safety"     element={<ProtectedRoute><EmailSafety /></ProtectedRoute>} />
          </Routes>
        </div>
      </main>
      {paletteOpen   && <CommandPalette onClose={() => setPaletteOpen(false)} navigate={navigate} prospects={allProspects} onTour={() => { setPaletteOpen(false); setTourOpen(true); }} onDemo={() => { setPaletteOpen(false); setDemoOpen(true); }} />}
      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      {tourOpen      && <TourOverlay onClose={() => setTourOpen(false)} />}
      {demoOpen      && <DemoMode onClose={() => setDemoOpen(false)} onLoaded={() => { api.get('/prospects').then(r => setAllProspects(r.data || [])).catch(() => {}); }} />}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <IntegrationProvider>
        <ResearchProvider>
          <AppInner />
        </ResearchProvider>
      </IntegrationProvider>
    </ToastProvider>
  );
}
