import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: null };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred";
    return { hasError: true, errorMessage: message };
  }

  componentDidCatch(error: unknown, info: { componentStack: string }) {
    console.error("[ErrorBoundary] Panel rendering failed:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="canvas-empty">
          <p style={{ fontWeight: 600, color: "var(--status-failed)", marginBottom: 8 }}>
            Panel failed to render
          </p>
          <p style={{ marginBottom: 16 }}>
            {this.state.errorMessage ?? "An unexpected error occurred."}
          </p>
          <button className="btn btn-primary" onClick={this.handleReset}>
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
