import { useRef, useEffect } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  color: [number, number, number];
}

interface DeploymentParticlesProps {
  width?: number;
  height?: number;
}

export default function DeploymentParticles({ width = 800, height = 50 }: DeploymentParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;

    const spawn = (): Particle => ({
      x: 60 + Math.random() * 40,
      y: 10 + Math.random() * 30,
      vx: 1.5 + Math.random() * 2,
      vy: (Math.random() - 0.5) * 0.3,
      life: 1,
      size: 2 + Math.random() * 2,
      color: Math.random() > 0.5 ? [99, 225, 190] : [56, 152, 236],
    });

    // Initialize particles
    particlesRef.current = [];
    for (let i = 0; i < 8; i++) {
      const p = spawn();
      p.x = Math.random() * width * 0.7 + 60;
      particlesRef.current.push(p);
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      // Dashed guideline
      ctx.beginPath();
      ctx.moveTo(60, height / 2);
      ctx.lineTo(width - 60, height / 2);
      ctx.strokeStyle = "rgba(99, 225, 190, 0.06)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 8]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Update and draw particles
      particlesRef.current.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.003;

        if (p.x > width - 60 || p.life <= 0) {
          Object.assign(p, spawn());
        }

        const [r, g, b] = p.color;

        // Particle dot
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${p.life * 0.6})`;
        ctx.fill();

        // Trail
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 6, p.y - p.vy * 6);
        ctx.strokeStyle = `rgba(${r},${g},${b},${p.life * 0.15})`;
        ctx.lineWidth = p.size * 0.8;
        ctx.stroke();
      });

      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ display: "block", width: "100%" }}
    />
  );
}
