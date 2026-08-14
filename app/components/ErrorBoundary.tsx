import { useEffect } from 'react';
import { useRouteError, isRouteErrorResponse } from 'react-router-dom';

export function ErrorBoundary() {
  const error = useRouteError();
  
  let errorMessage = 'An unexpected error occurred';
  let errorStack: string | undefined;
  let errorDetails: Record<string, unknown> = {};
  
  if (isRouteErrorResponse(error)) {
    errorMessage = error.statusText || error.data?.message || errorMessage;
    if (error.data instanceof Error) {
      errorStack = error.data.stack;
      errorMessage = error.data.message || errorMessage;
      errorDetails = {
        name: error.data.name,
        cause: error.data.cause,
      };
    }
  } else if (error instanceof Error) {
    errorMessage = error.message;
    errorStack = error.stack;
    errorDetails = {
      name: error.name,
      cause: error.cause,
    };
  } else if (typeof error === 'string') {
    errorMessage = error;
  } else {
    try {
      errorMessage = JSON.stringify(error);
    } catch {
      errorMessage = String(error);
    }
  }
  
  console.error('Error Boundary caught error:', {
    error,
    message: errorMessage,
    stack: errorStack,
    details: errorDetails,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    url: window.location.href,
  });
  
  const isModuleImportError = errorMessage.includes('Failed to fetch dynamically imported module') ||
                              errorMessage.includes('Failed to fetch') ||
                              (error instanceof Error && error.message.includes('Failed to fetch'));

  // Self-heal stale-chunk errors: a tab left open across a deploy tries to lazy-load
  // an old chunk hash the deploy replaced → import fails. Clear caches + reload ONCE to
  // the fresh build. Guarded by a 15s sessionStorage stamp so a genuinely persistent
  // failure shows the real error page instead of reload-looping. `canSelfHeal` is also
  // read at render time to show a calm "updating…" screen instead of the red crash.
  const RELOAD_KEY = 'nexus_chunk_reload_ts';
  const lastReloadAt = Number((typeof sessionStorage !== 'undefined' && sessionStorage.getItem(RELOAD_KEY)) || 0);
  const canSelfHeal = isModuleImportError && (Date.now() - lastReloadAt >= 15000);
  useEffect(() => {
    if (!canSelfHeal) return;
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* ignore */ }
    (async () => {
      try {
        if ('caches' in window) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
      } catch { /* best-effort */ }
      // Cache-bust the HTML fetch so a wedged/edge-cached index.html can't be reused —
      // a plain reload can re-serve the same stale document graph.
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('_v', String(Date.now()));
        window.location.replace(u.toString());
      } catch { window.location.reload(); }
    })();
  }, [canSelfHeal]);

  // Stale-chunk error that we're about to auto-recover from → show a calm "updating"
  // screen, not the alarming red error dump. If the reload also fails (guard blocks
  // canSelfHeal on the next mount), we fall through to the full error below.
  if (canSelfHeal) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f0f11', color: '#a1a1aa', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, fontFamily: 'var(--nx-font-mono), monospace' }}>
        <div style={{ fontSize: 24, color: '#ededf0' }}>◆</div>
        <div style={{ fontSize: 13, letterSpacing: '0.04em', color: '#ededf0' }}>Updating Nexus to the latest version…</div>
        <div style={{ fontSize: 11, color: '#52525b' }}>A new build just shipped — reloading.</div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f0f11',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{
        maxWidth: '800px',
        width: '100%',
        background: '#1a1a1e',
        border: '1px solid #333',
        borderRadius: '8px',
        padding: '2rem',
      }}>
        <h1 style={{ 
          fontSize: '1.5rem', 
          fontWeight: 'bold', 
          marginBottom: '1rem',
          color: '#f7525f',
        }}>
          Unexpected Application Error!
        </h1>
        
        <div style={{
          background: '#0a0a0b',
          padding: '1rem',
          borderRadius: '4px',
          marginBottom: '1rem',
          fontSize: '0.9rem',
          fontFamily: "var(--nx-font-mono)",
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          <div style={{ color: '#f7525f', marginBottom: '0.5rem' }}>
            {errorMessage}
          </div>
          
          {errorStack && (
            <details style={{ marginTop: '1rem' }}>
              <summary style={{ 
                cursor: 'pointer', 
                color: '#888',
                marginBottom: '0.5rem',
              }}>
                Stack Trace (click to expand)
              </summary>
              <pre style={{
                margin: '0.5rem 0',
                padding: '0.5rem',
                background: '#000',
                borderRadius: '4px',
                overflow: 'auto',
                maxHeight: '300px',
                fontSize: '0.8rem',
                color: '#ccc',
              }}>
                {errorStack}
              </pre>
            </details>
          )}
          
          {isModuleImportError && (
            <div style={{
              marginTop: '1rem',
              padding: '0.75rem',
              background: '#2a1a00',
              borderLeft: '3px solid #fbbf24',
              borderRadius: '4px',
            }}>
              <strong style={{ color: '#fbbf24' }}>Module Import Error Detected</strong>
              <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#ccc' }}>
                A dynamic module import failed and an automatic refresh didn&apos;t clear it. This usually means a new build shipped mid-session. Do a hard refresh (Ctrl/Cmd+Shift+R) to pull the latest version.
              </div>
            </div>
          )}
        </div>
        
        {errorDetails && Object.keys(errorDetails).length > 0 && (
          <details style={{ marginTop: '1rem' }}>
            <summary style={{ 
              cursor: 'pointer', 
              color: '#888',
              marginBottom: '0.5rem',
            }}>
              Additional Error Details
            </summary>
            <pre style={{
              margin: '0.5rem 0',
              padding: '0.5rem',
              background: '#0a0a0b',
              borderRadius: '4px',
              overflow: 'auto',
              fontSize: '0.8rem',
              color: '#ccc',
            }}>
              {JSON.stringify(errorDetails, null, 2)}
            </pre>
          </details>
        )}
        
        <div style={{
          marginTop: '1.5rem',
          padding: '1rem',
          background: '#232327',
          borderLeft: '3px solid #4a9',
          borderRadius: '4px',
        }}>
          <strong style={{ color: '#4a9' }}>Developer Information</strong>
          <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#aaa' }}>
            Full error details including stack trace have been logged to the browser console. 
            Check the console for complete debugging information.
          </div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#aaa' }}>
            URL: {window.location.href}
          </div>
          <div style={{ marginTop: '0.25rem', fontSize: '0.85rem', color: '#aaa' }}>
            Time: {new Date().toISOString()}
          </div>
        </div>
        
        <div style={{ marginTop: '1.5rem' }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.75rem 1.5rem',
              background: '#4a9',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
            }}
            onMouseOver={(e) => e.currentTarget.style.background = '#5ba'}
            onMouseOut={(e) => e.currentTarget.style.background = '#4a9'}
            onFocus={(e) => e.currentTarget.style.background = '#5ba'}
            onBlur={(e) => e.currentTarget.style.background = '#4a9'}
          >
            Reload Page
          </button>
        </div>
      </div>
    </div>
  );
}

