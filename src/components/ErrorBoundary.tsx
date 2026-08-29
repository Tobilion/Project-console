import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level safety net. Without this, any uncaught render-time exception anywhere in the tree
 * unmounts the whole app to a blank white page with no way to recover except a manual refresh —
 * which is indistinguishable, from a user's perspective, from "the app crashed and reloaded."
 * Catching it here at least gives the user a message and a one-click way back in instead of a
 * silent blank screen.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Unhandled error in app tree:', error, info.componentStack);
    try {
      const payload = JSON.stringify({ ts: new Date().toISOString(), error: error.message, stack: error.stack, componentStack: info.componentStack });
      // Best-effort: persist so a stranger can attach it via export-logs without devtools.
      // Uses localStorage because the file logger is server-side only.
      const key = 'console.lastError';
      localStorage.setItem(key, payload);
    } catch {}
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen flex flex-col items-center justify-center gap-4 bg-overlay text-fg p-6 text-center">
          <div className="text-lg font-bold">Something went wrong.</div>
          <div className="text-xs font-mono text-fg-dim max-w-lg break-words">{this.state.error.message}</div>
          <button
            onClick={this.handleReset}
            className="px-4 py-2 bg-accent-blue/20 border border-accent-blue/40 text-accent-blue rounded-lg text-sm font-bold hover:bg-accent-blue/30 transition-colors"
          >
            Try to recover
          </button>
          <button
            onClick={() => window.location.reload()}
            className="text-xs text-fg-dim hover:text-fg-muted underline"
          >
            Or reload the page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
