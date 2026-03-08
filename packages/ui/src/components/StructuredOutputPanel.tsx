import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface StructuredOutputPanelProps {
  content: string;
  onDismiss: () => void;
}

export default function StructuredOutputPanel({ content, onDismiss }: StructuredOutputPanelProps) {
  return (
    <div className="canvas-split-output">
      <div className="canvas-split-output-header">
        <span className="canvas-split-output-label">STRUCTURED OUTPUT</span>
        <button className="canvas-split-output-dismiss" onClick={onDismiss} title="Dismiss">
          &times;
        </button>
      </div>
      <div className="canvas-split-output-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
