import React, { useState, useEffect } from 'react';
import api from '../services/api';

const Login = () => {
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [error, setError]     = useState('');
  const [config, setConfig]   = useState({ demoMode: false, microsoftConfigured: true });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const msError = params.get('ms_error');
    if (msError) setError(decodeURIComponent(msError));
    api.get('/auth/config').then(r => setConfig(r.data)).catch(() => {});
  }, []);

  const handleMicrosoftLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/microsoft/start');
      window.location.href = res.data.url;
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to start sign-in. Please try again.');
      setLoading(false);
    }
  };

  const handleDemoLogin = async () => {
    setError('');
    setDemoLoading(true);
    try {
      const res = await api.post('/auth/demo-login');
      localStorage.setItem('token', res.data.token);
      window.location.replace('/');
    } catch (err) {
      setError(err.response?.data?.message || 'Demo sign-in failed.');
      setDemoLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100%', padding: '40px 24px',
    }}>
      <div style={{
        width: '100%', maxWidth: 400,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-accent)',
        borderRadius: 'var(--radius-xl)',
        padding: '40px 36px',
        boxShadow: 'var(--shadow-glass), var(--shadow-glow)',
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Ambient glow */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 180,
          background: 'radial-gradient(ellipse 100% 80% at 50% -20%, rgba(14,165,233,0.2) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 36, position: 'relative' }}>
          <div style={{
            width: 52, height: 52, margin: '0 auto 16px',
            background: 'var(--grad-brand)',
            borderRadius: 14,
            boxShadow: 'var(--shadow-glow)',
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(255,255,255,0.25) 0%, transparent 60%)' }} />
          </div>
          <h2 style={{ marginBottom: 6 }}>Welcome to Apex</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
            Sign in with your company Microsoft account
          </p>
        </div>

        {error && (
          <div style={{
            padding: '10px 14px', marginBottom: 20,
            background: 'var(--status-danger-dim)',
            border: '1px solid var(--status-danger-border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--status-danger)', fontSize: '0.85rem', lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleMicrosoftLogin}
          disabled={loading}
          style={{
            width: '100%', padding: '13px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            fontSize: '0.95rem', fontWeight: 600,
            opacity: loading ? 0.7 : 1,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 23 23" fill="none" style={{ flexShrink: 0 }}>
            <rect x="1"  y="1"  width="10" height="10" fill="#F25022"/>
            <rect x="12" y="1"  width="10" height="10" fill="#7FBA00"/>
            <rect x="1"  y="12" width="10" height="10" fill="#00A4EF"/>
            <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
          </svg>
          {loading ? 'Redirecting to Microsoft…' : 'Sign in with Microsoft'}
        </button>

        {config.demoMode && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 14px', color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
              or
              <div style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
            </div>
            <button
              type="button"
              onClick={handleDemoLogin}
              disabled={demoLoading}
              className="secondary"
              style={{
                width: '100%', padding: '11px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                fontSize: '0.9rem', fontWeight: 600,
                opacity: demoLoading ? 0.7 : 1,
                border: '1px dashed var(--border-color)',
                background: 'var(--bg-tertiary)',
                color: 'var(--text-secondary)',
              }}
            >
              {demoLoading ? 'Signing in…' : '🎭 Demo Sign In (no Microsoft required)'}
            </button>
            <p style={{ textAlign: 'center', marginTop: 10, fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              Demo mode is enabled on this deployment. Disable by removing <code>DEMO_MODE</code> from env vars.
            </p>
          </>
        )}

        <p style={{ textAlign: 'center', marginTop: 20, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          You'll be redirected to Microsoft to sign in with your work account.
          First-time sign-in will ask you to grant Apex permission to send email on your behalf.
        </p>
      </div>
    </div>
  );
};

export default Login;
