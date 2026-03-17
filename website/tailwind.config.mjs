/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        ds: {
          bg: "#1e2028",
          surface: "#272a33",
          "surface-alt": "#2e313b",
          border: "rgba(255,255,255,0.07)",
          "border-strong": "rgba(255,255,255,0.12)",
          text: "#e4e2de",
          "text-secondary": "#9a9790",
          "text-muted": "#6a6660",
          accent: "#6b8aff",
          "accent-dim": "rgba(107,138,255,0.1)",
          "accent-border": "rgba(107,138,255,0.22)",
          "accent-hover": "rgba(107,138,255,0.18)",
          "header-bg": "rgba(30,32,40,0.8)",
          // Entity colors (dark mode)
          server: "#a78bfa",
          envoy: "#22d3ee",
          partition: "#818cf8",
          order: "#c084fc",
          debrief: "#f472b6",
          // Status colors (dark mode)
          succeeded: "#4cbe7a",
          failed: "#e05555",
          running: "#6b8aff",
          warning: "#e0923a",
          // Decision type colors (dark mode)
          "dt-plan": "#818cf8",
          "dt-config": "#a78bfa",
          "dt-conflict": "#fbbf24",
          "dt-health": "#22d3ee",
          "dt-execution": "#60a5fa",
          "dt-verification": "#34d399",
          "dt-completion": "#4cbe7a",
          "dt-failure": "#e05555",
          "dt-diagnostic": "#f472b6",
          "dt-scan": "#2dd4bf",
          "dt-system": "#6a6660",
          "dt-order": "#c084fc",
        },
      },
      fontFamily: {
        sans: ['"Libre Franklin"', "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", "sans-serif"],
        mono: ['"IBM Plex Mono"', '"SF Mono"', '"Fira Code"', "Menlo", "monospace"],
        display: ['"Playfair Display"', "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
