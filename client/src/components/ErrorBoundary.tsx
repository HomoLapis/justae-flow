import { Component, type ReactNode, type ErrorInfo } from 'react';

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Top-level boundary. If a component throws during render, show the actual
 * error and stack instead of unmounting silently (which leaves the panel
 * black and leaves the user with no signal).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, info });
    console.error('[ErrorBoundary]', error, info);
  }

  reset = (): void => {
    this.setState({ error: null, info: null });
  };

  resetAndClear = (): void => {
    try {
      // Clear justaeflow2.* localStorage — common cause of regressions when the
      // persisted shape drifts from the code.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('justaeflow2.')) localStorage.removeItem(k);
      }
    } catch {
      /* ignore */
    }
    location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-4 h-full overflow-auto text-xs">
        <h2 className="text-sm font-semibold text-err mb-2">Something broke during render.</h2>
        <p className="text-ink-dim mb-2">
          The panel caught the error so you can see it. The most common cause is a stale
          localStorage shape — clearing it usually fixes the problem.
        </p>
        <pre className="bg-bg-raised border border-line rounded-md p-2 font-mono text-[10px] whitespace-pre-wrap break-all max-h-48 overflow-auto">
          {this.state.error.message}
          {this.state.info?.componentStack ?? ''}
        </pre>
        <div className="mt-3 flex gap-2">
          <button className="btn-primary text-xs" onClick={this.resetAndClear}>
            Clear stored data and reload
          </button>
          <button className="btn-ghost text-xs" onClick={this.reset}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
