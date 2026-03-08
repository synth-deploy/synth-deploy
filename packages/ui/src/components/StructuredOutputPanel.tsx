import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface StructuredOutputPanelProps {
  content: string;
  title?: string;
  onDismiss: () => void;
  onNavigate?: (view: string, params: Record<string, string>) => void;
}

export default function StructuredOutputPanel({ content, title, onDismiss, onNavigate }: StructuredOutputPanelProps) {
  const [rawMode, setRawMode] = useState(false);

  function handleDownload() {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const slug = (title ?? "synth-export").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    a.download = `${slug}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Custom link renderer: intercept synth:// deep-links for canvas navigation
  const components = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      if (href?.startsWith("synth://") && onNavigate) {
        const withScheme = href.replace("synth://", "https://synth/");
        try {
          const url = new URL(withScheme);
          const view = url.pathname.replace(/^\//, "");
          const params = Object.fromEntries(url.searchParams.entries());
          return (
            <button className="canvas-split-output-entity-link" onClick={() => onNavigate(view, params)}>
              {children}
            </button>
          );
        } catch {
          // Malformed synth:// url — fall through to plain text
        }
      }
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
  };

  return (
    <div className="canvas-split-output">
      <div className="canvas-split-output-header">
        <span className="canvas-split-output-label">{title ?? "STRUCTURED OUTPUT"}</span>
        <div className="canvas-split-output-actions">
          <button
            className={`canvas-split-output-toggle ${rawMode ? "active" : ""}`}
            onClick={() => setRawMode((v) => !v)}
            title={rawMode ? "Show rendered preview" : "Show raw markdown"}
          >
            {rawMode ? "PREVIEW" : "RAW"}
          </button>
          <button className="canvas-split-output-download" onClick={handleDownload} title="Download as .md">
            &#8595; .md
          </button>
          <button className="canvas-split-output-dismiss" onClick={onDismiss} title="Dismiss">
            &times;
          </button>
        </div>
      </div>
      <div className="canvas-split-output-body">
        {rawMode ? (
          <pre className="canvas-split-output-raw">{content}</pre>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as never}>
            {content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}
