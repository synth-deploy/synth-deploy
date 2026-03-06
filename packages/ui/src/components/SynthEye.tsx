import { useRef, useEffect } from "react";

interface SynthEyeProps {
  width?: number;
  height?: number;
}

export default function SynthEye({ width = 90, height = 90 }: SynthEyeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let animId: number;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;

      // Pulsing concentric rings
      for (let i = 0; i < 3; i++) {
        const r = 20 + i * 10;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(99, 225, 190, ${0.08 + 0.04 * Math.sin(frame * 0.015 + i)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Rotating arcs
      const a = frame * 0.02;
      ctx.beginPath();
      ctx.arc(cx, cy, 32, a, a + 1.2);
      ctx.strokeStyle = "rgba(99, 225, 190, 0.3)";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, 26, a + Math.PI, a + Math.PI + 0.8);
      ctx.strokeStyle = "rgba(56, 152, 236, 0.25)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Central glow
      const p = 0.5 + 0.5 * Math.sin(frame * 0.03);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 12);
      grad.addColorStop(0, `rgba(99, 225, 190, ${0.3 + p * 0.2})`);
      grad.addColorStop(1, "rgba(99, 225, 190, 0)");
      ctx.beginPath();
      ctx.arc(cx, cy, 12, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // Center dot
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(99, 225, 190, ${0.6 + p * 0.4})`;
      ctx.fill();

      frame++;
      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, [width, height]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block" }} />;
}
