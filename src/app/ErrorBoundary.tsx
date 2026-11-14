import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last line: an error while drawing the app would otherwise leave an empty (black)
 * page. This says what happened and offers a reload; edits are saved as they are made.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Focused stopped drawing:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p>Focused hit an error and stopped drawing. Your photos and edits are saved; reloading opens them again.</p>
        <pre>{error.message}</pre>
        <button type="button" className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
