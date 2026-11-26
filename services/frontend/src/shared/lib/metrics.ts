export const metrics = {
  trackTTI: () => {
    try {
      performance.mark('app-interactive');
      performance.measure('time-to-interactive', 'fetchStart', 'app-interactive');
    } catch {
      // ignore unsupported perf APIs
    }
  },

  trackSSELatency: (eventName: string, timestamp: number) => {
    if (!timestamp || Number.isNaN(timestamp)) return;
    const latency = Date.now() - timestamp;
    console.debug(`[SSE] ${eventName} latency: ${latency}ms`);
  },

  trackRender: (component: string, durationMs: number) => {
    if (durationMs > 16) {
      console.warn(`[Perf] Slow render: ${component} took ${durationMs.toFixed(1)}ms`);
    }
  },

  trackNavigation: (route: string, durationMs: number) => {
    console.info(`[Nav] ${route} rendered in ${durationMs.toFixed(1)}ms`);
  },

  apiTiming: {
    start: (label: string) => {
      try {
        performance.mark(`api-${label}-start`);
      } catch {
        // ignore
      }
    },
    end: (label: string) => {
      const endMark = `api-${label}-end`;
      try {
        performance.mark(endMark);
      } catch {
        // ignore
      }
      try {
        performance.measure(`api-${label}`, `api-${label}-start`, endMark);
      } catch {
        // ignore
      }
      const entry = performance.getEntriesByName(`api-${label}`).pop();
      if (entry && entry.duration > 200) {
        console.info(`[API] ${label} ${entry.duration.toFixed(1)}ms`);
      }
    },
  },

  sseReconnect: (sessionId: string, attempt: number) => {
    console.warn(`[SSE] reconnect attempt ${attempt} for session ${sessionId}`);
  },
};
