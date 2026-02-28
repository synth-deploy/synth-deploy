import { useRef, useEffect } from "react";
import { useMode } from "../context/ModeContext.js";

export default function ModeToggle() {
  const { mode, toggleMode } = useMode();
  const isAgent = mode === "agent";
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cols = 6;
    const rows = 3;
    const dotSize = 3;
    const gap = 7;
    let frame = 0;
    let animId: number;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * gap + dotSize + 2;
          const y = r * gap + dotSize + 2;
          if (isAgent) {
            const phase = frame * 0.04 + r * 0.8 + c * 0.5;
            const pulse = 0.4 + 0.6 * Math.sin(phase);
            ctx.fillStyle = `rgba(99, 225, 190, ${pulse})`;
            ctx.beginPath();
            ctx.arc(x, y, dotSize * (0.8 + 0.3 * Math.sin(phase + 1)), 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = "rgba(160, 164, 184, 0.5)";
            ctx.beginPath();
            ctx.arc(x, y, dotSize * 0.7, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      frame++;
      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, [isAgent]);

  return (
    <button
      className={`mode-toggle-dot ${isAgent ? "mode-toggle-dot-active" : ""}`}
      onClick={toggleMode}
      aria-label={`Switch to ${isAgent ? "traditional" : "agent"} mode`}
      title={isAgent ? "Switch to Traditional Mode" : "Switch to Agent Mode"}
    >
      <canvas ref={canvasRef} width={46} height={26} className="mode-toggle-canvas" />
      <span className="mode-toggle-dot-label">
        {isAgent ? "Agent" : "Manual"}
      </span>
    </button>
  );
}
