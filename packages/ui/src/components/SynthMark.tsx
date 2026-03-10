/**
 * SynthMark — V5 Synthetic Print animated logo component.
 *
 * Drop-in replacement for the existing SynthEye.tsx component.
 * Renders the V5 tapered fingerprint mark with a breathing animation
 * on the organic (left) side. The geometric (right) side stays still.
 *
 * Usage:
 *   <SynthMark size={20} />           // header nav
 *   <SynthMark size={64} />           // login page
 *   <SynthMark size={44} />           // plan generation overlay
 *   <SynthMark size={16} />           // inline assessment label
 *   <SynthMark size={20} active={false} />  // disabled/idle state
 *
 * The component reads its color from a CSS custom property:
 *   --synth-mark-color (defaults to currentColor if not set)
 *
 * Or pass accentRgb prop directly: accentRgb="45,91,240"
 */

import { useEffect, useRef } from "react";

interface Props {
  /** Rendered size in px. The canvas is crisp at any size. */
  size?: number;
  /** Whether the breathing animation is active. Default true. */
  active?: boolean;
  /** Animation speed multiplier. Default 1. */
  speed?: number;
  /** RGB triplet string for the stroke color, e.g. "45,91,240". */
  accentRgb?: string;
}

export default function SynthMark({ size = 20, active = true, speed = 1, accentRgb }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const rgbRef = useRef(accentRgb);
  rgbRef.current = accentRgb;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = size * dpr;
    c.height = size * dpr;
    ctx.scale(dpr, dpr);

    let animId: number;

    const draw = () => {
      frameRef.current++;
      const f = frameRef.current * speed * 3; // base speed tripled
      ctx.clearRect(0, 0, size, size);

      // Resolve color — prop > CSS variable > fallback
      const rgb = rgbRef.current || "107,138,255";

      const cx = size / 2;
      const cy = size / 2;
      const sc = size / 78;
      const lines = 7;
      const spacing = 5.5;
      const sX = -36;
      const eX = 36;
      const segs = 36; // fixed high segment count for smooth curves at all sizes

      for (let i = 0; i < lines; i++) {
        const y = (i - (lines - 1) / 2) * spacing;
        const center = Math.abs(i - (lines - 1) / 2) / ((lines - 1) / 2);
        const baseA = 0.35 + (1 - center) * 0.65;

        for (let s = 0; s < segs; s++) {
          const t1 = s / segs;
          const t2 = (s + 1) / segs;
          const x1 = sX + t1 * (eX - sX);
          const x2 = sX + t2 * (eX - sX);

          // V5 taper: weight increases left to right
          const w1 = (1.2 + t1 * 3) * (1 - center * 0.5);

          // Breathing: organic side oscillates, geometric side stays still
          const breathe = active
            ? 1 + Math.sin(f * 0.012 + i * 0.6) * 0.15 * (1 - t1)
            : 1;

          const wave1 = (1 - t1) * (1 - t1) * breathe;
          const wave2 = (1 - t2) * (1 - t2) * breathe;
          const amp1 = (5 + Math.sin(i * 1.3) * 2.5) * wave1;
          const amp2 = (5 + Math.sin(i * 1.3) * 2.5) * wave2;
          const freq = 2.8 + i * 0.5;
          const wy1 = Math.sin(t1 * freq * Math.PI + i * 0.8) * amp1;
          const wy2 = Math.sin(t2 * freq * Math.PI + i * 0.8) * amp2;

          // Per-line shimmer: size-independent, visible even at 16px
          const shimmer = active ? 0.85 + Math.sin(f * 0.02 + i * 0.6) * 0.15 : 1;
          const alpha = baseA * (0.45 + t1 * 0.55) * shimmer;
          ctx.strokeStyle = `rgba(${rgb},${alpha})`;
          ctx.lineWidth = Math.max(0.8, w1 * sc);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(cx + x1 * sc, cy + (y + wy1) * sc);
          ctx.lineTo(cx + x2 * sc, cy + (y + wy2) * sc);
          ctx.stroke();
        }
      }

      // Endpoint dot
      const dotAlpha = active ? 0.6 + Math.sin(f * 0.025) * 0.2 : 0.3;
      const dotSize = active ? 3 + Math.sin(f * 0.02) * 0.3 : 3;
      ctx.fillStyle = `rgba(${rgb},${dotAlpha})`;
      ctx.beginPath();
      ctx.arc(cx + 38 * sc, cy, Math.max(1.5, dotSize * sc), 0, Math.PI * 2);
      ctx.fill();

      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, [size, active, speed]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      aria-label="Synth logo"
      role="img"
    />
  );
}
