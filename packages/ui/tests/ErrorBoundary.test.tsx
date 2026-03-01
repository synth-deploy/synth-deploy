import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import ErrorBoundary from "../src/components/ErrorBoundary";

function ProblemChild(): JSX.Element {
  throw new Error("Boom! Something broke.");
}

function GoodChild() {
  return <div>Everything is fine</div>;
}

describe("ErrorBoundary", () => {
  // Suppress React's error boundary console.error noise during tests
  const originalConsoleError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Everything is fine")).toBeInTheDocument();
  });

  it("renders error UI when a child throws", () => {
    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Panel failed to render")).toBeInTheDocument();
    expect(screen.getByText("Boom! Something broke.")).toBeInTheDocument();
  });

  it("displays the error message from the thrown Error", () => {
    function CustomError(): JSX.Element {
      throw new Error("Custom failure reason");
    }
    render(
      <ErrorBoundary>
        <CustomError />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Custom failure reason")).toBeInTheDocument();
  });

  it("shows a 'Try Again' button in the error state", () => {
    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Try Again")).toBeInTheDocument();
  });

  it("resets to normal rendering when 'Try Again' is clicked (if error is resolved)", async () => {
    const user = userEvent.setup();
    let shouldFail = true;

    function ConditionalChild(): JSX.Element {
      if (shouldFail) {
        throw new Error("Transient error");
      }
      return <div>Recovered</div>;
    }

    render(
      <ErrorBoundary>
        <ConditionalChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Panel failed to render")).toBeInTheDocument();

    // Fix the error condition before clicking Try Again
    shouldFail = false;
    await user.click(screen.getByText("Try Again"));

    expect(screen.getByText("Recovered")).toBeInTheDocument();
    expect(screen.queryByText("Panel failed to render")).not.toBeInTheDocument();
  });

  it("handles non-Error thrown values gracefully", () => {
    function ThrowsString(): JSX.Element {
      throw "string error"; // eslint-disable-line no-throw-literal
    }
    render(
      <ErrorBoundary>
        <ThrowsString />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Panel failed to render")).toBeInTheDocument();
    expect(screen.getByText("An unexpected error occurred")).toBeInTheDocument();
  });
});
