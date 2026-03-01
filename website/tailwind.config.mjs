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
