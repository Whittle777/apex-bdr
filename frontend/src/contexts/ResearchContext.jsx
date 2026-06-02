import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import api from '../services/api';

const STORAGE_KEY = 'research:activeJobId';
const POLL_INTERVAL_MS = 3000;

const ResearchContext = createContext({
  activeJob: null,
  startJob: () => {},
  clearJob: () => {},
});

/**
 * Wraps the app so any page (sidebar pill, Research page, command palette)
 * can see and resume the in-flight research job. Persists the active job ID
 * in localStorage so navigation away from /research — or even a full page
 * reload — doesn't lose track of progress.
 */
export function ResearchProvider({ children }) {
  const [activeJob, setActiveJob] = useState(null);
  const [activeJobId, setActiveJobId] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  });
  const pollRef = useRef(null);

  const clearJob = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    setActiveJobId(null);
    setActiveJob(null);
  }, []);

  const startJob = useCallback((jobId) => {
    if (!jobId) return;
    try { localStorage.setItem(STORAGE_KEY, jobId); } catch {}
    setActiveJobId(jobId);
  }, []);

  useEffect(() => {
    if (!activeJobId) return undefined;

    // When the active job changes (new upload), clear the prior snapshot so
    // we don't briefly show stale items until the first poll lands.
    setActiveJob(null);

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.get(`/research/jobs/${activeJobId}`);
        if (cancelled) return;
        setActiveJob(res.data);
        // We deliberately keep terminal jobs visible (so the user can find
        // them when they return); the Research page is responsible for
        // calling clearJob() once the user dismisses the result.
      } catch (err) {
        if (cancelled) return;
        // 404 → job gone (backend restart). Stop polling.
        if (err.response?.status === 404) clearJob();
      }
    };
    tick();
    pollRef.current = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeJobId, clearJob]);

  return (
    <ResearchContext.Provider value={{ activeJob, activeJobId, startJob, clearJob }}>
      {children}
    </ResearchContext.Provider>
  );
}

export function useResearch() {
  return useContext(ResearchContext);
}
