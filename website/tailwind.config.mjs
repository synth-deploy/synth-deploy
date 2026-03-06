/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        ds: {
          bg: "#080b14",
          surface: "rgba(15, 20, 30, 0.6)",
          border: "rgba(140, 150, 165, 0.1)",
          text: "#e2e8f0",
          "text-secondary": "#8c96a5",
          "text-muted": "#6b7280",
          accent: "#63e1be",
          "accent-dim": "rgba(99, 225, 190, 0.15)",
          "accent-hover": "rgba(99, 225, 190, 0.25)",
          // Entity colors
          server: "#63e1be",
          envoy: "#34d399",
          partition: "#818cf8",
          order: "#f59e0b",
          debrief: "#e879f9",
          // Decision type colors
          "dt-plan": "#6366f1",
          "dt-config": "#8b5cf6",
          "dt-conflict": "#f59e0b",
          "dt-health": "#06b6d4",
          "dt-execution": "#3b82f6",
          "dt-verification": "#10b981",
          "dt-completion": "#16a34a",
          "dt-failure": "#dc2626",
          "dt-diagnostic": "#ec4899",
        },
      },
      fontFamily: {
        sans: ['"Instrument Sans"', "system-ui", "sans-serif"],
        mono: ['"Space Mono"', '"SF Mono"', "monospace"],
      },
    },
  },
  plugins: [],
};
