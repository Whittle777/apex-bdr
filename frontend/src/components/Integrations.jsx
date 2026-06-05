import React, { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import { useToast } from './Toast';

const CLAUDE_MODELS = [
  { value: 'claude-opus-4-6',          label: 'Claude Opus 4.6 — Most capable' },
  { value: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6 — Balanced' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — Fastest' },
];

const AI_PROVIDERS = [
  {
    key: 'claude',
    name: 'Anthropic Claude',
    description: 'Power the AI Command Center, NLQ queries, and email drafting with Claude. Sign in with your Anthropic enterprise account.',
    accentColor: '#d97706',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M13.827 3.52l8.01 14.222a.9.9 0 0 1-.778 1.35H2.94a.9.9 0 0 1-.778-1.35L10.173 3.52a.9.9 0 0 1 1.556 0l2.098 3.72" stroke="#d97706" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M12 15.5v.5" stroke="#d97706" strokeWidth="2" strokeLinecap="round"/>
        <path d="M12 9v4" stroke="#d97706" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    ),
    fields: [
      { key: 'clientId',     label: 'API Key',                  type: 'password', placeholder: 'sk-ant-api03-…', required: true },
      { key: 'clientSecret', label: 'Default Model',            type: 'select',   options: CLAUDE_MODELS },
      { key: 'email',        label: 'Workspace ID (optional)',  type: 'text',     placeholder: 'Enterprise org / workspace ID' },
    ],
    envNote: 'Or set ANTHROPIC_API_KEY in your .env file. Your key is validated against the Anthropic API before saving.',
    badge: 'Recommended',
  },
  {
    key: 'gemini',
    name: 'Google Gemini',
    description: 'Alternative AI provider for NLQ queries and email drafting. Requires a Gemini API key.',
    icon: <span style={{ fontSize: '1.2rem' }}>✦</span>,
    fields: [{ key: 'clientId', label: 'API Key', type: 'password', placeholder: 'AIza…', required: true }],
    envNote: 'Or set GEMINI_API_KEY in your .env file.',
  },
];

const PROVIDERS = [
  {
    key: 'google',
    name: 'Google Workspace / Gmail',
    description: 'Send sequence emails via Gmail using a one-time App Password. No OAuth app required.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
    ),
  },
  {
    key: 'microsoft',
    name: 'Microsoft 365',
    description: 'Send sequence emails from your own Outlook and read replies. Connected automatically when you sign in with Microsoft.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 23 23" fill="none">
        <rect x="1"  y="1"  width="10" height="10" fill="#F25022"/>
        <rect x="12" y="1"  width="10" height="10" fill="#7FBA00"/>
        <rect x="1"  y="12" width="10" height="10" fill="#00A4EF"/>
        <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
      </svg>
    ),
  },
];

const FIELD = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <label style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</label>
    {children}
  </div>
);

// ── Step pill used inside walkthrough guides ──────────────────────────────────
const Step = ({ n, title, children }) => (
  <div style={{ display: 'flex', gap: 12, paddingBottom: 14, borderBottom: '1px solid var(--border-subtle)', marginBottom: 2 }}>
    <div style={{
      flexShrink: 0, width: 22, height: 22, borderRadius: '50%',
      background: 'var(--accent-dim)', border: '1px solid var(--border-accent)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '0.65rem', fontWeight: 800, color: 'var(--accent-light)', marginTop: 1,
    }}>{n}</div>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>{children}</div>
    </div>
  </div>
);

const Code = ({ children }) => (
  <code style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '1px 5px', fontSize: '0.8em', color: 'var(--accent-light)', fontFamily: 'monospace' }}>
    {children}
  </code>
);

// ── Google App Password walkthrough form ──────────────────────────────────────
const GoogleSetupForm = ({ onSave, onCancel, loading, error }) => {
  const [email, setEmail] = useState('');
  const [appPass, setAppPass] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({ email, clientId: email, clientSecret: appPass.replace(/\s/g, '') });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, borderTop: '1px solid var(--border-color)', paddingTop: 16 }}>
      {/* Walkthrough */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 18 }}>
        <Step n={1} title='Enable 2-Step Verification'>
          Go to <a href='https://myaccount.google.com/security' target='_blank' rel='noreferrer' style={{ color: 'var(--accent-secondary)' }}>myaccount.google.com/security</a> and make sure <strong>2-Step Verification</strong> is turned on. App Passwords won't appear without it.
        </Step>
        <Step n={2} title='Generate an App Password'>
          Go to <a href='https://myaccount.google.com/apppasswords' target='_blank' rel='noreferrer' style={{ color: 'var(--accent-secondary)' }}>myaccount.google.com/apppasswords</a>. Under "Select app" choose <strong>Mail</strong>, under "Select device" choose <strong>Other</strong> and name it <em>Apex</em>. Click <strong>Generate</strong> and copy the 16-character password shown.
        </Step>
        <Step n={3} title='Paste your credentials below'>
          Enter your Gmail address and the App Password (spaces are fine — they'll be stripped automatically).
        </Step>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <FIELD label='Gmail Address'>
          <input type='email' required style={{ width: '100%' }} value={email} onChange={e => setEmail(e.target.value)} placeholder='you@gmail.com or you@yourcompany.com' />
        </FIELD>
        <FIELD label='App Password (16 characters)'>
          <input type='password' required style={{ width: '100%' }} value={appPass} onChange={e => setAppPass(e.target.value)} placeholder='xxxx xxxx xxxx xxxx' maxLength={19} />
        </FIELD>
        {error && (
          <div style={{ padding: '8px 12px', background: 'var(--status-danger-dim)', border: '1px solid var(--status-danger-border)', borderRadius: 'var(--radius-sm)', color: 'var(--status-danger)', fontSize: '0.82rem' }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type='submit' disabled={loading} style={{ flex: 1, padding: '9px' }}>{loading ? 'Verifying connection…' : 'Save & Verify'}</button>
          <button type='button' className='secondary' onClick={onCancel} style={{ padding: '9px 14px' }}>Cancel</button>
        </div>
      </form>
    </div>
  );
};

// ── Microsoft reconnect panel (shown when user clicks Reconfigure) ────────────
const MicrosoftReconnectPanel = ({ onCancel, error }) => {
  const [loading, setLoading] = useState(false);

  const handleReconnect = async () => {
    setLoading(true);
    try {
      const res = await api.post('/auth/microsoft/start');
      window.location.href = res.data.url;
    } catch (err) {
      setLoading(false);
      alert(err.response?.data?.message || 'Failed to start sign-in.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--border-color)', paddingTop: 16 }}>
      {error && (
        <div style={{ padding: '9px 13px', background: 'var(--status-danger-dim)', border: '1px solid var(--status-danger-border)', borderRadius: 'var(--radius-sm)', color: 'var(--status-danger)', fontSize: '0.82rem', lineHeight: 1.5 }}>
          {error}
        </div>
      )}
      <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        Click below to re-authorize Apex with your Microsoft account. You'll be redirected to Microsoft and brought straight back.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type='button'
          disabled={loading}
          onClick={handleReconnect}
          style={{ flex: 1, padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          <svg width="16" height="16" viewBox="0 0 23 23" fill="none" style={{ flexShrink: 0 }}>
            <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
            <rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>
            <rect x="1" y="12" width="10" height="10" fill="#00A4EF"/>
            <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
          </svg>
          {loading ? 'Redirecting…' : 'Reconnect Microsoft Account'}
        </button>
        <button type='button' className='secondary' onClick={onCancel} style={{ padding: '10px 16px' }}>Cancel</button>
      </div>
    </div>
  );
};

// ─── Voice (Beta) section — collapsed by default ──────────────────────────
const VoiceSection = ({ integrations, onUpdate, toast }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ clientId: '', email: '' });
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const eleven = integrations.find(i => i.provider === 'elevenlabs');
  const connected = !!eleven?.clientId;

  const handleConnect = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post('/integrations', { provider: 'elevenlabs', clientId: form.clientId, email: form.email, clientSecret: '', refreshToken: '' });
      await onUpdate();
      setConnecting(false);
      toast('ElevenLabs connected', 'success');
    } catch (err) {
      setError(err.response?.data?.message || 'Invalid API key');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await api.delete('/integrations/elevenlabs');
      await onUpdate();
      toast('ElevenLabs disconnected', 'warning');
    } catch {
      toast('Disconnect failed', 'error');
    }
  };

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Section toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 12px',
          color: 'var(--text-muted)',
        }}
      >
        <span style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Voice (Beta)</span>
        <span style={{ fontSize: '0.7rem', transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
        {connected && <span style={{ fontSize: '0.62rem', padding: '1px 7px', background: 'var(--status-success-dim)', color: 'var(--status-success)', border: '1px solid var(--status-success-border)', borderRadius: 'var(--radius-full)', fontWeight: 700, marginLeft: 4 }}>Connected</span>}
      </button>

      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
          <div style={{
            background: 'var(--bg-elevated)',
            border: `1px solid ${connected ? 'rgba(139,92,246,0.3)' : 'var(--border-color)'}`,
            borderTop: `3px solid ${connected ? '#8b5cf6' : 'var(--border-color)'}`,
            borderRadius: 'var(--radius-lg)', padding: 20,
            display: 'flex', flexDirection: 'column', gap: 14,
            boxShadow: connected ? '0 4px 20px rgba(139,92,246,0.1)' : 'var(--shadow-md)',
            transition: 'all var(--transition-fast)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: 10, background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', flexShrink: 0 }}>
                  🎙
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <h3 style={{ margin: 0, fontSize: '0.95rem' }}>ElevenLabs</h3>
                    <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '2px 6px', borderRadius: 'var(--radius-full)', background: 'rgba(139,92,246,0.1)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Voice</span>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.78rem', marginTop: 2, color: 'var(--text-secondary)' }}>
                    Real-time voice synthesis and STT for AI-powered outbound calls.
                  </p>
                </div>
              </div>
              {connected && !connecting && (
                <span style={{ padding: '4px 10px', flexShrink: 0, background: 'rgba(139,92,246,0.1)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.25)', borderRadius: 'var(--radius-full)', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  ● Active
                </span>
              )}
            </div>

            {connecting ? (
              <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border-color)', paddingTop: 14 }}>
                <FIELD label="API Key">
                  <input type="password" required style={{ width: '100%' }} value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} placeholder="sk_…" />
                </FIELD>
                <FIELD label="Default Voice ID (optional)">
                  <input type="text" style={{ width: '100%' }} value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="21m00Tcm4TlvDq8ikWAM" />
                </FIELD>
                <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Get your key at elevenlabs.io/settings/api-keys. Voice ID is optional — leave blank to use Rachel (default).
                </p>
                {error && <div style={{ padding: '8px 12px', background: 'var(--status-danger-dim)', border: '1px solid var(--status-danger-border)', borderRadius: 'var(--radius-sm)', color: 'var(--status-danger)', fontSize: '0.82rem' }}>{error}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" disabled={loading} style={{ flex: 1, padding: '9px', background: 'linear-gradient(135deg, #7c3aed, #8b5cf6)' }}>{loading ? 'Verifying…' : 'Connect'}</button>
                  <button type="button" className="secondary" onClick={() => setConnecting(false)} style={{ padding: '9px 14px' }}>Cancel</button>
                </div>
              </form>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="secondary" style={{ flex: 1, padding: '9px', borderStyle: connected ? 'solid' : 'dashed' }} onClick={() => { setConnecting(true); setForm({ clientId: '', email: '' }); }}>
                  {connected ? '⚙ Reconfigure' : '+ Connect ElevenLabs'}
                </button>
                {connected && (
                  <button className="danger" style={{ padding: '9px 14px' }} onClick={handleDisconnect}>Disconnect</button>
                )}
              </div>
            )}

            {connected && (
              <a href="/voice-agent" style={{ fontSize: '0.75rem', color: 'var(--accent-secondary)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }} onClick={e => { e.preventDefault(); window.history.pushState({}, '', '/voice-agent'); window.dispatchEvent(new PopStateEvent('popstate')); }}>
                → Open Voice Agent
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Claude Desktop MCP section ─────────────────────────────────────────────
const ClaudeDesktopMcpSection = ({ toast }) => {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);   // { configured, hint, createdAt }
  const [token, setToken] = useState(null);     // only present immediately after generate
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');     // 'config' | 'token'
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    api.get('/users/me/mcp-token').then(r => setStatus(r.data)).catch(() => {});
  }, []);

  // Pre-compute the claude_desktop_config.json snippet for this user.
  // Uses the current site origin as MCP_BRIDGE_URL so it points at
  // wherever they're hosted (Railway, localhost, etc.). The token is
  // baked in if we just generated one; otherwise <PASTE-YOUR-TOKEN-HERE>.
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-app.example.com';
  const configSnippet = JSON.stringify({
    mcpServers: {
      'apex-bdr': {
        command: 'node',
        args: ['/ABSOLUTE/PATH/TO/apex-bdr/mcp-server/index.js'],
        env: {
          MCP_BRIDGE_URL: origin,
          MCP_BRIDGE_TOKEN: token || '<PASTE-YOUR-TOKEN-HERE>',
        },
      },
    },
  }, null, 2);

  // A personalised prompt the user can paste into Claude Code (the CLI
  // agent that has filesystem + shell access). Claude Code reads the
  // existing claude_desktop_config.json, merges in the apex-bdr entry,
  // downloads the local MCP server files from this repo, and runs
  // npm install. The user just approves each tool call.
  const tokenForPrompt = token || (status?.configured ? '<the token you just generated — re-generate it above and paste here, or just rotate>' : '<click "Generate token" above first, then come back>');
  const setupPrompt = `Please set up the apex-bdr Claude Desktop MCP server on this machine. Below is everything you need; do it step by step and show me what you're about to write/run before each change so I can approve.

PARAMETERS:
- Bridge URL:   ${origin}
- Personal MCP token (treat as a password — don't echo it to other places):
  ${tokenForPrompt}

STEPS:

1. Create a folder for the MCP server at \`~/apex-bdr-mcp\` (Linux/macOS) or \`%USERPROFILE%\\apex-bdr-mcp\` (Windows). If it already exists, fine — keep it.

2. Download the two files below from the apex-bdr repo into that folder. Use curl on macOS/Linux or Invoke-WebRequest on Windows. They are public files in the public repo:
   - https://raw.githubusercontent.com/Whittle777/apex-bdr/main/mcp-server/index.js  → save as index.js
   - https://raw.githubusercontent.com/Whittle777/apex-bdr/main/mcp-server/package.json → save as package.json

3. In that folder, run \`npm install\`. Node 18+ is required; verify with \`node -v\` first and tell me if it's older.

4. Find Claude Desktop's config file:
   - macOS:   \`~/Library/Application Support/Claude/claude_desktop_config.json\`
   - Windows: \`%APPDATA%\\Claude\\claude_desktop_config.json\`
   - Linux:   \`~/.config/Claude/claude_desktop_config.json\`
   If the file or its parent directory doesn't exist, create them with an empty \`{}\` first.

5. Read that file. Parse it as JSON. If parsing fails, STOP and show me the file contents — don't overwrite.

6. Merge (don't overwrite) an \`apex-bdr\` entry under \`mcpServers\`:
   \`\`\`json
   {
     "mcpServers": {
       "apex-bdr": {
         "command": "node",
         "args": ["<absolute path to the index.js you just downloaded>"],
         "env": {
           "MCP_BRIDGE_URL": "${origin}",
           "MCP_BRIDGE_TOKEN": "${tokenForPrompt}"
         }
       }
     }
   }
   \`\`\`
   Preserve any other servers already in the file. Resolve \`~\` / env vars to an absolute path for the \`args\` entry — Claude Desktop does not expand them.

7. Write the merged JSON back, pretty-printed with 2-space indent.

8. Tell me to fully quit Claude Desktop (Cmd+Q on macOS, full Quit on Windows) and reopen it. After restart, the \`apex-bdr\` MCP server should appear in the tools list with a \`send_email\` tool.

9. Optional smoke test: from the same folder, suggest I run
   \`MCP_BRIDGE_URL=${origin} MCP_BRIDGE_TOKEN=${tokenForPrompt} node test-local.js me@c3.ai "Setup test" "Hello from MCP."\`
   to verify the bridge end-to-end before involving Claude Desktop. (You'd need to also download test-local.js from the same repo path to do this — only run this if I confirm.)

If anything fails along the way, stop and tell me exactly which step and what the error was. Never write a token to a logged location or paste it into a public chat.`;

  const handleGenerate = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/users/me/mcp-token');
      setToken(data.token);
      setStatus({ configured: true, hint: data.hint, createdAt: data.createdAt });
      toast('MCP token generated — copy the config now, it will not be shown again', 'success', 5000);
    } catch (err) {
      toast(err.response?.data?.message || 'Failed to generate token', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    setBusy(true);
    try {
      await api.delete('/users/me/mcp-token');
      setStatus({ configured: false, hint: null, createdAt: null });
      setToken(null);
      setConfirmRevoke(false);
      toast('MCP token revoked — Claude Desktop calls will now fail until you generate a new one', 'warning', 4500);
    } catch (err) {
      toast('Revoke failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      toast('Clipboard unavailable — select the text manually', 'warning');
    }
  };

  const configured = !!status?.configured;

  return (
    <div style={{ marginBottom: 28 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 12px',
          color: 'var(--text-muted)',
        }}
      >
        <span style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Claude Desktop</span>
        <span style={{ fontSize: '0.7rem', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
        {configured && <span style={{ fontSize: '0.62rem', padding: '1px 7px', background: 'var(--status-success-dim)', color: 'var(--status-success)', border: '1px solid var(--status-success-border)', borderRadius: 'var(--radius-full)', fontWeight: 700, marginLeft: 4 }}>Token set</span>}
      </button>

      {open && (
        <div style={{
          background: 'var(--bg-elevated)',
          border: `1px solid ${configured ? 'rgba(74,222,128,0.3)' : 'var(--border-color)'}`,
          borderTop: `3px solid ${configured ? '#4ade80' : 'var(--border-color)'}`,
          borderRadius: 'var(--radius-lg)', padding: 20,
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: 10, background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', flexShrink: 0 }}>
              💬
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Claude Desktop email tool</h3>
              <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Generates a personal MCP token so a local Claude Desktop MCP server can send emails through <strong>your</strong> connected Microsoft 365 account. Token is hashed at rest; you'll see the plaintext exactly once.
              </p>
            </div>
          </div>

          {status?.createdAt && (
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Current token: <code style={{ background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 4 }}>{status.hint || '…'}</code>
              <span style={{ marginLeft: 8 }}>Created {new Date(status.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
            </div>
          )}

          {token && (
            <div style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', borderRadius: 'var(--radius-md)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#38bdf8' }}>
                ⚠ Save this now — it will not be shown again.
              </div>
              <code style={{ background: 'var(--bg-primary)', padding: '8px 10px', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem', wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                {token}
              </code>
              <button
                type="button"
                onClick={() => copy('token', token)}
                className="secondary"
                style={{ alignSelf: 'flex-start', padding: '5px 12px', fontSize: '0.8rem' }}
              >
                {copied === 'token' ? '✓ Copied' : '📋 Copy token only'}
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" disabled={busy} onClick={handleGenerate} style={{ padding: '8px 14px', fontSize: '0.85rem' }}>
              {busy ? 'Working…' : configured ? '↻ Rotate token' : '✦ Generate token'}
            </button>
            {configured && !confirmRevoke && (
              <button type="button" className="danger" onClick={() => setConfirmRevoke(true)} style={{ padding: '8px 14px', fontSize: '0.85rem' }}>
                Revoke
              </button>
            )}
            {confirmRevoke && (
              <>
                <button type="button" className="danger" disabled={busy} onClick={handleRevoke} style={{ padding: '8px 14px', fontSize: '0.85rem' }}>
                  Confirm revoke
                </button>
                <button type="button" className="secondary" onClick={() => setConfirmRevoke(false)} style={{ padding: '8px 14px', fontSize: '0.85rem' }}>
                  Cancel
                </button>
              </>
            )}
          </div>

          {/* One-click setup via Claude Code */}
          <div style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.25)', borderRadius: 'var(--radius-md)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#a78bfa' }}>
                ⚡ One-click setup via Claude Code
              </div>
              <button
                type="button"
                onClick={() => copy('claudePrompt', setupPrompt)}
                disabled={!status?.configured}
                style={{ padding: '4px 12px', fontSize: '0.78rem', background: 'rgba(167,139,250,0.18)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 'var(--radius-sm)', fontWeight: 700, cursor: status?.configured ? 'pointer' : 'not-allowed', opacity: status?.configured ? 1 : 0.5 }}
              >
                {copied === 'claudePrompt' ? '✓ Copied setup prompt' : '📋 Copy setup prompt'}
              </button>
            </div>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {status?.configured ? (
                <>
                  Open <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer" style={{ color: '#a78bfa' }}>Claude Code</a> (the CLI agent), start a new chat, and paste this prompt. Claude Code will download the MCP server, merge the entry into your <code>claude_desktop_config.json</code> (preserving any other servers you have), run <code>npm install</code>, and tell you when to restart Claude Desktop. <strong>Approve each step</strong> as Claude Code asks — there's no auto-run.
                </>
              ) : (
                <>Generate a token above first, then this button activates.</>
              )}
            </div>
          </div>

          {/* Manual setup fallback snippet */}
          <div style={{ background: 'var(--bg-tertiary)', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                Or paste manually into <code>claude_desktop_config.json</code>:
              </div>
              <button
                type="button"
                onClick={() => copy('config', configSnippet)}
                style={{ padding: '4px 10px', fontSize: '0.78rem' }}
              >
                {copied === 'config' ? '✓ Copied config' : '📋 Copy config'}
              </button>
            </div>
            <pre style={{ margin: 0, padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', lineHeight: 1.45, overflowX: 'auto', color: 'var(--text-primary)' }}>
{configSnippet}
            </pre>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              <strong>Where this file lives:</strong>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                <li><strong>macOS:</strong> <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
                <li><strong>Windows:</strong> <code>%APPDATA%\Claude\claude_desktop_config.json</code></li>
              </ul>
              Replace <code>/ABSOLUTE/PATH/TO/apex-bdr/mcp-server/index.js</code> with the real path on your machine (run <code>pwd</code> inside that folder to get it). {token ? 'The token in the snippet above is yours and is already filled in — just copy and paste.' : 'Generate a token above to have it filled in automatically here.'} Restart Claude Desktop after pasting.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Apify (LinkedIn scraper) section ───────────────────────────────────────
const ApifySection = ({ integrations, onUpdate, toast }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ clientId: '' });
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const apify = integrations.find(i => i.provider === 'apify');
  const connected = !!apify?.clientId;

  const handleConnect = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post('/integrations', { provider: 'apify', clientId: form.clientId, clientSecret: '', refreshToken: '', email: '' });
      await onUpdate();
      setConnecting(false);
      toast('Apify connected', 'success');
    } catch (err) {
      setError(err.response?.data?.message || 'Invalid Apify token');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await api.delete('/integrations/apify');
      await onUpdate();
      toast('Apify disconnected', 'warning');
    } catch {
      toast('Disconnect failed', 'error');
    }
  };

  return (
    <div style={{ marginBottom: 28 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 12px',
          color: 'var(--text-muted)',
        }}
      >
        <span style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Research</span>
        <span style={{ fontSize: '0.7rem', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
        {connected && <span style={{ fontSize: '0.62rem', padding: '1px 7px', background: 'var(--status-success-dim)', color: 'var(--status-success)', border: '1px solid var(--status-success-border)', borderRadius: 'var(--radius-full)', fontWeight: 700, marginLeft: 4 }}>Connected</span>}
      </button>

      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
          <div style={{
            background: 'var(--bg-elevated)',
            border: `1px solid ${connected ? 'rgba(56,189,248,0.3)' : 'var(--border-color)'}`,
            borderTop: `3px solid ${connected ? '#38bdf8' : 'var(--border-color)'}`,
            borderRadius: 'var(--radius-lg)', padding: 20,
            display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: 10, background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', flexShrink: 0 }}>
                  🔬
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Apify (LinkedIn scraper)</h3>
                  <p style={{ margin: 0, fontSize: '0.78rem', marginTop: 2, color: 'var(--text-secondary)' }}>
                    Powers LinkedIn profile lookups in the Research tab. ~$10 per 1000 profiles.
                  </p>
                </div>
              </div>
              {connected && !connecting && (
                <span style={{ padding: '4px 10px', flexShrink: 0, background: 'rgba(56,189,248,0.1)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.25)', borderRadius: 'var(--radius-full)', fontSize: '0.7rem', fontWeight: 700 }}>
                  ● Active
                </span>
              )}
            </div>

            {connecting ? (
              <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border-color)', paddingTop: 14 }}>
                <FIELD label="API Token">
                  <input type="password" required style={{ width: '100%' }} value={form.clientId} onChange={e => setForm({ clientId: e.target.value })} placeholder="apify_api_…" />
                </FIELD>
                <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Get yours at <a href="https://console.apify.com/settings/integrations" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-secondary)' }}>console.apify.com/settings/integrations</a>.
                </p>
                {error && <div style={{ padding: '8px 12px', background: 'var(--status-danger-dim)', border: '1px solid var(--status-danger-border)', borderRadius: 'var(--radius-sm)', color: 'var(--status-danger)', fontSize: '0.82rem' }}>{error}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" disabled={loading} style={{ flex: 1, padding: '9px', background: 'linear-gradient(135deg, #0ea5e9, #38bdf8)' }}>{loading ? 'Verifying…' : 'Connect'}</button>
                  <button type="button" className="secondary" onClick={() => setConnecting(false)} style={{ padding: '9px 14px' }}>Cancel</button>
                </div>
              </form>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="secondary" style={{ flex: 1, padding: '9px', borderStyle: connected ? 'solid' : 'dashed' }} onClick={() => { setConnecting(true); setForm({ clientId: '' }); }}>
                  {connected ? '⚙ Reconfigure' : '+ Connect Apify'}
                </button>
                {connected && (
                  <button className="danger" style={{ padding: '9px 14px' }} onClick={handleDisconnect}>Disconnect</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const Integrations = () => {
  const [integrations, setIntegrations] = useState([]);
  const [isConnecting, setIsConnecting] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMap, setErrorMap] = useState({});
  const [form, setForm] = useState({ email: '', clientId: '', clientSecret: '', refreshToken: '' });
  const toast = useToast();

  const fetchIntegrations = useCallback(async () => {
    try {
      const res = await api.get('/integrations');
      setIntegrations(res.data || []);
    } catch (err) { console.error(err); }
  }, []);

  // Handle OAuth callback params (?ms_connected=1 or ?ms_error=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const msConnected = params.get('ms_connected');
    const msEmail = params.get('ms_email');
    const msError = params.get('ms_error');

    if (msConnected) {
      fetchIntegrations();
      toast(`Microsoft 365 connected${msEmail ? ` as ${msEmail}` : ''}`, 'success');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (msError) {
      setErrorMap(prev => ({ ...prev, microsoft: decodeURIComponent(msError) }));
      setIsConnecting('microsoft');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []); // eslint-disable-line

  useEffect(() => { fetchIntegrations(); }, [fetchIntegrations]);

  const handleConnectStart = (provider) => {
    setIsConnecting(provider);
    setErrorMap(prev => ({ ...prev, [provider]: null }));
    setForm({ email: '', clientId: '', clientSecret: '', refreshToken: '' });
  };

  const handleSave = async (e, provider) => {
    e.preventDefault();
    setLoading(true);
    setErrorMap(prev => ({ ...prev, [provider]: null }));
    try {
      await api.post('/integrations', { ...form, provider });
      setIsConnecting(null);
      await fetchIntegrations();
      toast(`${[...AI_PROVIDERS, ...PROVIDERS].find(p => p.key === provider)?.name || provider} connected`, 'success');
    } catch (err) {
      setErrorMap(prev => ({ ...prev, [provider]: err.response?.data?.message || 'Handshake failed — check your credentials.' }));
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async (provider) => {
    try {
      await api.delete(`/integrations/${provider}`);
      await fetchIntegrations();
      toast(`${[...AI_PROVIDERS, ...PROVIDERS].find(p => p.key === provider)?.name || provider} disconnected`, 'warning');
    } catch (err) {
      console.error(err);
      toast('Disconnect failed', 'error');
    }
  };

  const setupSteps = [
    {
      step: 1,
      provider: 'claude',
      label: 'Connect Claude AI',
      desc: 'Unlocks AI Command Center, email drafting, and data enrichment.',
      icon: '✦',
      color: '#d97706',
      action: () => handleConnectStart('claude'),
    },
    {
      step: 2,
      provider: 'google',
      label: 'Connect Google Workspace',
      desc: 'Unlocks email sequences and Gmail-powered cadences.',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57C21.36 18.09 22.56 15.27 22.56 12.25z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
      ),
      color: '#4285F4',
      action: () => handleConnectStart('google'),
    },
    {
      step: 3,
      provider: 'microsoft',
      label: 'Connect Microsoft 365',
      desc: 'Unlocks Teams calling and the power dialer.',
      icon: (
        <svg width="14" height="14" viewBox="0 0 23 23" fill="none">
          <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
          <rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>
          <rect x="1" y="12" width="10" height="10" fill="#00A4EF"/>
          <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
        </svg>
      ),
      color: '#00A4EF',
      action: async () => {
        try {
          const res = await api.post('/auth/microsoft/start');
          window.location.href = res.data.url;
        } catch (err) {
          alert(err.response?.data?.message || 'Failed to start Microsoft sign-in.');
        }
      },
    },
  ];

  const setupComplete = setupSteps.every(s => integrations.some(i => i.provider === s.provider));

  return (
    <div style={{ maxWidth: 900 }}>
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 style={{ marginBottom: 4 }}>Integrations</h1>
          <p className="page-header-meta">Connect email, telephony, and AI providers</p>
        </div>
      </div>

      {/* ── Setup Guide ──────────────────────────────────────────────────────── */}
      <div style={{
        marginBottom: 32,
        background: setupComplete ? 'var(--status-success-dim)' : 'var(--bg-elevated)',
        border: `1px solid ${setupComplete ? 'var(--status-success-border)' : 'var(--border-accent)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '18px 22px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: setupComplete ? 0 : 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: 2 }}>
              {setupComplete ? '✓ You\'re all set up' : 'Quick Setup'}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              {setupComplete
                ? 'All integrations are connected. Features are fully unlocked.'
                : 'Complete these steps to unlock all features. Buttons will be greyed out until each is connected.'}
            </div>
          </div>
          {setupComplete && (
            <span style={{ fontSize: '1.4rem' }}>🎉</span>
          )}
        </div>

        {!setupComplete && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {setupSteps.map(s => {
              const done = integrations.some(i => i.provider === s.provider);
              return (
                <div key={s.provider} style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '12px 16px',
                  background: done ? 'var(--status-success-dim)' : 'var(--bg-primary)',
                  border: `1px solid ${done ? 'var(--status-success-border)' : 'var(--border-color)'}`,
                  borderRadius: 'var(--radius-md)',
                  transition: 'all 0.2s',
                }}>
                  {/* Step number or checkmark */}
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: done ? 'var(--status-success)' : `${s.color}22`,
                    border: `1px solid ${done ? 'var(--status-success)' : `${s.color}44`}`,
                    fontSize: done ? '0.8rem' : '0.72rem',
                    fontWeight: 700,
                    color: done ? '#fff' : s.color,
                  }}>
                    {done ? '✓' : s.step}
                  </div>

                  {/* Icon */}
                  <div style={{ flexShrink: 0, opacity: done ? 0.5 : 1 }}>
                    {typeof s.icon === 'string'
                      ? <span style={{ fontSize: '1rem', color: s.color }}>{s.icon}</span>
                      : s.icon}
                  </div>

                  {/* Text */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: done ? 'var(--text-muted)' : 'var(--text-primary)', textDecoration: done ? 'line-through' : 'none' }}>
                      {s.label}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 1 }}>
                      {s.desc}
                    </div>
                  </div>

                  {/* CTA */}
                  {!done ? (
                    <button
                      onClick={s.action}
                      style={{
                        flexShrink: 0, fontSize: '0.78rem', padding: '6px 14px',
                        background: `${s.color}22`, color: s.color,
                        border: `1px solid ${s.color}44`,
                        borderRadius: 'var(--radius-sm)', fontWeight: 600, cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Connect →
                    </button>
                  ) : (
                    <span style={{ flexShrink: 0, fontSize: '0.72rem', color: 'var(--status-success)', fontWeight: 700 }}>
                      Connected
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* AI Providers */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>AI Models</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
          {AI_PROVIDERS.map((p) => {
            const connected = !!integrations.find(i => i.provider === p.key);
            const editing = isConnecting === p.key;
            const accent = p.accentColor || 'var(--accent-primary)';
            const accentDim = p.accentColor ? `${p.accentColor}22` : 'var(--accent-dim)';
            const accentBorder = p.accentColor ? `${p.accentColor}40` : 'var(--border-accent)';
            return (
              <div key={p.key} style={{
                background: 'var(--bg-elevated)',
                border: `1px solid ${connected ? accentBorder : 'var(--border-color)'}`,
                borderTop: `3px solid ${connected ? accent : 'var(--border-color)'}`,
                borderRadius: 'var(--radius-lg)',
                padding: 20,
                display: 'flex', flexDirection: 'column', gap: 14,
                boxShadow: connected ? `0 4px 20px ${accentDim}` : 'var(--shadow-md)',
                transition: 'all var(--transition-fast)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 42, height: 42, borderRadius: 10,
                      background: accentDim,
                      border: `1px solid ${accentBorder}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      {p.icon}
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{p.name}</h3>
                        {p.badge && (
                          <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '2px 6px', borderRadius: 'var(--radius-full)', background: accentDim, color: accent, border: `1px solid ${accentBorder}`, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                            {p.badge}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: 0, fontSize: '0.78rem', marginTop: 2, color: 'var(--text-secondary)' }}>{p.description}</p>
                    </div>
                  </div>
                  {connected && !editing && (
                    <span style={{
                      padding: '4px 10px', flexShrink: 0,
                      background: `${accent}22`, color: accent,
                      border: `1px solid ${accentBorder}`,
                      borderRadius: 'var(--radius-full)',
                      fontSize: '0.7rem', fontWeight: 700,
                      letterSpacing: '0.05em', textTransform: 'uppercase',
                    }}>
                      ● Active
                    </span>
                  )}
                </div>
                {editing ? (
                  <form onSubmit={(e) => handleSave(e, p.key)} style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border-color)', paddingTop: 14 }}>
                    {p.fields.map(f => (
                      <FIELD key={f.key} label={f.label}>
                        {f.type === 'select' ? (
                          <select style={{ width: '100%' }} value={form[f.key] || ''} onChange={e => setForm({ ...form, [f.key]: e.target.value })}>
                            <option value="">Choose a model…</option>
                            {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        ) : (
                          <input
                            type={f.type}
                            required={f.required}
                            style={{ width: '100%' }}
                            value={form[f.key] || ''}
                            onChange={e => setForm({ ...form, [f.key]: e.target.value })}
                            placeholder={f.placeholder}
                          />
                        )}
                      </FIELD>
                    ))}
                    {p.envNote && <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{p.envNote}</p>}
                    {errorMap[p.key] && (
                      <div style={{ padding: '8px 12px', background: 'var(--status-danger-dim)', border: '1px solid var(--status-danger-border)', borderRadius: 'var(--radius-sm)', color: 'var(--status-danger)', fontSize: '0.82rem' }}>{errorMap[p.key]}</div>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="submit" disabled={loading} style={{ flex: 1, padding: '9px', background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
                        {loading ? 'Verifying…' : 'Connect'}
                      </button>
                      <button type="button" className="secondary" onClick={() => setIsConnecting(null)} style={{ padding: '9px 14px' }}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="secondary"
                      style={{ flex: 1, padding: '9px', borderStyle: connected ? 'solid' : 'dashed' }}
                      onClick={() => {
                        setIsConnecting(p.key);
                        setForm(connected ? {} : { clientSecret: p.key === 'claude' ? 'claude-opus-4-6' : '' });
                      }}
                    >
                      {connected ? '⚙ Reconfigure' : `+ Connect ${p.name}`}
                    </button>
                    {connected && (
                      <button
                        className="danger"
                        style={{ padding: '9px 14px' }}
                        onClick={() => handleDisconnect(p.key)}
                        title="Disconnect"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Email / Telephony Providers */}
      <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>Email &amp; Telephony</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
        {PROVIDERS.filter((p) => {
          // Hide the Gmail card once Microsoft 365 is connected — sending
          // goes through Outlook in that case, so the Gmail card is just
          // noise. Show it again only if the user disconnects Microsoft.
          if (p.key === 'google') {
            const msConnected = integrations.some(i => i.provider === 'microsoft');
            const gmailConnected = integrations.some(i => i.provider === 'google');
            return !msConnected || gmailConnected;
          }
          return true;
        }).map((p) => {
          const integration = integrations.find(i => i.provider === p.key);
          const connected = !!integration;
          const editing = isConnecting === p.key;

          return (
            <div key={p.key} style={{
              background: 'var(--bg-elevated)',
              border: `1px solid ${connected ? 'var(--status-success-border)' : 'var(--border-color)'}`,
              borderTop: connected ? '3px solid var(--status-success)' : '3px solid var(--border-accent)',
              borderRadius: 'var(--radius-lg)',
              padding: 20,
              display: 'flex', flexDirection: 'column', gap: 14,
              boxShadow: connected ? '0 4px 20px var(--status-success-dim)' : 'var(--shadow-md)',
              transition: 'all var(--transition-fast)',
            }}>
              {/* Card header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{
                    width: 46, height: 46, borderRadius: 12,
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-color)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    {p.icon}
                  </div>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1rem' }}>{p.name}</h3>
                    <p style={{ margin: 0, fontSize: '0.8rem', marginTop: 3, color: 'var(--text-secondary)' }}>{p.description}</p>
                  </div>
                </div>
                {connected && !editing && (
                  <span style={{
                    padding: '4px 10px',
                    background: 'var(--status-success-dim)',
                    color: 'var(--status-success)',
                    border: '1px solid var(--status-success-border)',
                    borderRadius: 'var(--radius-full)',
                    fontSize: '0.7rem', fontWeight: 700,
                    letterSpacing: '0.05em', textTransform: 'uppercase',
                    flexShrink: 0,
                  }}>
                    ● Connected
                  </span>
                )}
              </div>

              {/* Editing form — provider-specific */}
              {editing ? (
                p.key === 'google' ? (
                  <GoogleSetupForm
                    loading={loading}
                    error={errorMap[p.key]}
                    onCancel={() => setIsConnecting(null)}
                    onSave={async (data) => {
                      setLoading(true);
                      setErrorMap(prev => ({ ...prev, google: null }));
                      try {
                        await api.post('/integrations', { ...data, provider: 'google' });
                        setIsConnecting(null);
                        await fetchIntegrations();
                        toast('Gmail connected', 'success');
                      } catch (err) {
                        setErrorMap(prev => ({ ...prev, google: err.response?.data?.message || 'Verification failed — check your App Password.' }));
                      } finally {
                        setLoading(false);
                      }
                    }}
                  />
                ) : p.key === 'microsoft' ? (
                  <MicrosoftReconnectPanel
                    error={errorMap[p.key]}
                    onCancel={() => { setIsConnecting(null); setErrorMap(prev => ({ ...prev, microsoft: null })); }}
                  />
                ) : (
                  <form onSubmit={(e) => handleSave(e, p.key)} style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--border-color)', paddingTop: 16 }}>
                    <FIELD label="Email Address">
                      <input type="email" required style={{ width: '100%' }} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="sender@yourcompany.com" />
                    </FIELD>
                    <FIELD label="Client ID">
                      <input type="password" required style={{ width: '100%' }} value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} placeholder="••••••••" />
                    </FIELD>
                    <FIELD label="Client Secret">
                      <input type="password" required style={{ width: '100%' }} value={form.clientSecret} onChange={e => setForm({ ...form, clientSecret: e.target.value })} placeholder="••••••••" />
                    </FIELD>
                    {errorMap[p.key] && (
                      <div style={{ padding: '9px 13px', background: 'var(--status-danger-dim)', border: '1px solid var(--status-danger-border)', borderRadius: 'var(--radius-sm)', color: 'var(--status-danger)', fontSize: '0.83rem' }}>{errorMap[p.key]}</div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <button type="submit" disabled={loading} style={{ flex: 1, padding: '10px' }}>{loading ? 'Validating…' : 'Save & Verify'}</button>
                      <button type="button" className="secondary" onClick={() => setIsConnecting(null)} style={{ padding: '10px 16px' }}>Cancel</button>
                    </div>
                  </form>
                )
              ) : connected ? (
                /* Connected state */
                <div style={{ background: 'var(--bg-tertiary)', padding: '12px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div className="tl-dot tl-green" />
                    <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>{integration.email || 'Configured'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="ghost" style={{ fontSize: '0.8rem', padding: '5px 10px', color: 'var(--text-secondary)' }}
                      onClick={() => {
                        setIsConnecting(p.key);
                        setForm({ email: integration.email || '', clientId: '', clientSecret: '', refreshToken: '' });
                      }}>
                      Edit
                    </button>
                    <button className="ghost" style={{ fontSize: '0.8rem', padding: '5px 10px', color: 'var(--status-danger)' }} onClick={() => handleDisconnect(p.key)}>
                      Disconnect
                    </button>
                  </div>
                </div>
              ) : (
                /* Not connected */
                <button
                  className="secondary"
                  style={{ width: '100%', padding: '10px', fontWeight: 600, borderStyle: 'dashed' }}
                  onClick={() => handleConnectStart(p.key)}
                >
                  {p.key === 'google' ? '+ Connect Gmail (App Password)' : p.key === 'microsoft' ? '+ Connect Microsoft 365' : `+ Configure ${p.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Voice — collapsed section */}
      <VoiceSection integrations={integrations} onUpdate={fetchIntegrations} toast={toast} />

      {/* Research / LinkedIn enrichment — Apify */}
      <ApifySection integrations={integrations} onUpdate={fetchIntegrations} toast={toast} />

      {/* Claude Desktop MCP — per-user bridge token */}
      <ClaudeDesktopMcpSection toast={toast} />

      {/* Help notes */}
      <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ padding: '12px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Sequence emails</strong> are sent automatically every 15 minutes once Gmail is connected. Emails respect the delay days configured on each step.
        </div>
        <div style={{ padding: '12px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Microsoft 365 Power Dialer:</strong> For PSTN calling, your Azure Entra app also needs{' '}
          <Code>Calls.InitiateGroupCall.All</Code> and <Code>Calls.AccessMedia.All</Code> permissions (Application type).
        </div>
        <div style={{ padding: '12px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Claude API keys:</strong> Get yours at{' '}
          <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-secondary)' }}>console.anthropic.com</a>. Enterprise plans require a workspace admin to generate API keys under Settings → API Keys.
        </div>
      </div>
    </div>
  );
};

export default Integrations;
