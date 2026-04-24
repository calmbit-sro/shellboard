import { Component, type ReactNode } from "react";
import "./ErrorBoundary.css";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("ErrorBoundary caught:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h1>Something went wrong.</h1>
          <pre className="error-boundary__message">
            {this.state.error.message}
          </pre>
          <p className="error-boundary__hint">
            Try reloading. If the problem persists, delete the session file to
            reset state.
          </p>
          <button
            type="button"
            className="error-boundary__reload"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
