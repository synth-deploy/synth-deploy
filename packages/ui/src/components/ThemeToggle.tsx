import { useTheme } from "../context/ThemeContext.js";

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";

  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span className={`theme-toggle-knob ${dark ? "theme-toggle-dark" : ""}`}>
        {dark ? "\u263E" : "\u2600"}
      </span>
    </button>
  );
}
