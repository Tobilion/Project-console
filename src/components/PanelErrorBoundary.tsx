import { Component, type ErrorInfo, type ReactNode } from 'react';

interface PanelErrorBoundaryProps {
  children: ReactNode;
  /** Re-mounts the boundary when it changes, so switching panels resets the error state. */
  resetKey?: string | number | null;
  label?: string;
}

interface PanelErrorBoundaryState {
  error: Error | null;
}

// A panel throwing must never take down the whole UI. Each tool panel (12+) renders behind
// this boundary: an error inside one panel shows a contained fallback card, and the rest of
// the console (chat, terminal, other panels) keeps working. resetKey is the active panel id,
// so navigating to another panel automatically clears the failed state.
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[panel] panel render error:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: PanelErrorBoundaryProps) {
    if (this.props.resetKey !== prevProps.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-panel rounded-xl border border-border-soft p-6 text-center">
            <p className="text-sm font-semibold text-fg-strong mb-1">
              {this.props.label ?? 'This panel hit an error'}
            </p>
            <p className="text-xs text-fg-muted leading-relaxed mb-4">
              The rest of the console is unaffected — chat still works. Reload the panel to
              try again.
            </p>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-3 py-2 text-xs font-bold rounded-lg bg-accent-blue text-white hover:opacity-90 transition-opacity"
            >
              Reload panel
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}