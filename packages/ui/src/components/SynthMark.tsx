import { useRef, useEffect } from "react";

interface SynthMarkProps {
  size?: number;
  active?: boolean;
}

export default function SynthMark({ size = 20, active = true }: SynthMarkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 2;
    c.width = size * dpr;
    c.height = size * dpr;
    ctx.scale(dpr, dpr);

    let animId: number;

    const draw = () => {
      frameRef.current++;
      const f = frameRef.current;
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2;
      const cy = size / 2;
      const r = size * 0.34;

      // Read accent color from CSS custom properties
      const style = getComputedStyle(document.documentElement);
      const accent = style.getPropertyValue("--accent").trim() || "#2d5bf0";
      const textMuted = style.getPropertyValue("--text-muted").trim() || "#9a9590";

      for (let i = 0; i < 3; i++) {
        const base = (i * Math.PI * 2) / 3;
        const speed = active ? 0.012 + i * 0.004 : 0;
        const angle = base + f * speed;
        const len = active ? 0.55 + Math.sin(f * 0.02 + i) * 0.15 : 0.5;

        ctx.beginPath();
        ctx.arc(cx, cy, r - i * 1.5, angle, angle + len);
        ctx.strokeStyle = active
          ? hexToRgba(accent, 0.6 - i * 0.12)
          : hexToRgba(textMuted, 0.3 - i * 0.06);
        ctx.lineWidth = 1.8 - i * 0.3;
        ctx.lineCap = "round";
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(
        cx,
        cy,
        active ? 1.8 + Math.sin(f * 0.04) * 0.4 : 1.5,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = active ? accent : hexToRgba(textMuted, 0.3);
      ctx.fill();

      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, [size, active]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  );
}

function hexToRgba(hex: string, alpha: number): string {
  // Handle rgb/rgba passthrough
  if (hex.startsWith("rgb")) return hex;
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
