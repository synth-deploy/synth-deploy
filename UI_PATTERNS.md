# Synth UI Patterns

**Source of truth for all visual design: `design/mockups/synth-ui-mockup-v6.jsx`**

This file is the behavioral contract for UI implementation. Follow these patterns exactly. Do not invent new UI patterns — match what already exists.

---

## Core Rules

1. **Always use CSS variables for color.** Never hardcode hex values. Use `var(--text)`, `var(--border)`, `var(--surface)`, `var(--accent)`, `var(--status-succeeded)`, etc.
2. **Inline styles are for dynamic values only.** If a value is computed at runtime (confidence percentage, conditional color based on data), inline style is acceptable. If it's static, it belongs in app.css or should use an existing CSS class.
3. **Never invent new CSS classes.** app.css has an extensive library. Search it before writing a new style. If a pattern genuinely doesn't exist, add a class to app.css — don't inline it.
4. **Read existing panels before writing new ones.** `ArtifactDetailPanel.tsx` and `TopologyPanel.tsx` are the canonical references.

---

## Panel Structure

Every canvas panel follows this exact wrapper structure:

```tsx
// Top-level panels (Deploy, Artifacts, Topology, Debriefs tabs)
<CanvasPanelHost title="Topology" noBreadcrumb>
  ...
</CanvasPanelHost>

// Sub-panels (detail views pushed onto the stack)
<CanvasPanelHost title={title} hideRootCrumb dismissible={false}>
  <div className="v2-detail-view">
    ...
  </div>
</CanvasPanelHost>
```

- `noBreadcrumb` — top-level tab panels only
- `hideRootCrumb` — sub-panels (suppresses the root breadcrumb entry)
- `dismissible={false}` — detail panels that shouldn't show an X button
- Always wrap detail panel content in `<div className="v2-detail-view">`

---

## Page Headers (Top-Level Panels)

```tsx
<h1 className="v6-page-title">Topology</h1>
<p className="v6-page-subtitle">Your deployment infrastructure — envoys, environments, and partitions.</p>
```

---

## Tabs / Segmented Control

Always use the `.segmented-control` pattern. Never use custom tab styling.

```tsx
type TabKey = "analysis" | "annotations" | "versions";

const [activeTab, setActiveTab] = useState<TabKey>("analysis");

<div style={{ display: "flex", justifyContent: "center", padding: "16px 16px 0" }}>
  <div className="segmented-control">
    {(["analysis", "annotations", "versions"] as const).map((tab) => (
      <button
        key={tab}
        className={`segmented-control-btn ${activeTab === tab ? "segmented-control-btn-active" : ""}`}
        onClick={() => setActiveTab(tab)}
      >
        {tab.charAt(0).toUpperCase() + tab.slice(1)}
      </button>
    ))}
  </div>
</div>
```

For tabs with counts (like TopologyPanel):

```tsx
<button className={`segmented-control-btn ${section === s.id ? "segmented-control-btn-active" : ""}`}>
  {s.label}
  {s.count > 0 && (
    <span style={{ fontSize: 10, color: section === s.id ? "var(--text-secondary)" : "var(--text-muted)", fontWeight: 400, marginLeft: 4 }}>
      {s.count}
    </span>
  )}
</button>
```

---

## Section Labels (Within Tab Content)

The repeating section label above content blocks — use the `.section-label` CSS class:

```tsx
<div className="section-label">Section Title</div>
```

Never write the inline equivalent (`fontSize: 10, fontWeight: 700, textTransform: "uppercase"...`). The class already handles all of it.

For section headers that introduce a list or a major content block within a tab, use `<SectionHeader>` instead:

```tsx
import SectionHeader from "../SectionHeader.js";

<SectionHeader color="var(--status-succeeded)" shape="circle" label="Related Deployments" />
<SectionHeader color="var(--accent)" shape="square" label="Versions" />
<SectionHeader color="var(--status-warning)" shape="diamond" label="Corrections & Annotations" />
```

Shapes: `"square"` | `"circle"` | `"hollow"` | `"diamond"`

---

## Buttons

**Primary action (Submit, Upload, Save):**
```tsx
<button className="btn btn-primary" onClick={handler} disabled={loading} style={{ fontSize: 12, padding: "6px 14px" }}>
  Submit
</button>
```

**Secondary/outline action (Add Envoy, Add Environment):**
```tsx
<button className="btn-accent-outline" onClick={handler}>
  + Add Envoy
</button>
```

**Danger action:**
```tsx
<button className="v2-btn v2-btn-danger" onClick={handler}>Delete</button>
```

**Clickable list row (navigates to detail panel):** Use a `<button>` with inline layout styles since this is a structural layout pattern, not a button style:
```tsx
<button
  onClick={() => pushPanel({ type: "envoy-detail", title: e.name, params: { id: e.id } })}
  style={{
    display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", width: "100%",
    background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
    cursor: "pointer", textAlign: "left",
  }}
>
```

**Never** style buttons with arbitrary inline colors/backgrounds for standard actions. Use the CSS classes above.

---

## Lists

**Deployment rows:**
```tsx
<div className="v2-scoped-list">
  {deployments.map((d) => (
    <div key={d.id} className="v2-deploy-row" onClick={() => pushPanel(...)}>
      <div className={`v2-deploy-dot v2-deploy-${d.status}`} />
      <div className="v2-deploy-info">
        <span className="v2-deploy-version">{d.version}</span>
        <span className="v2-deploy-env">{envName}</span>
      </div>
      <span className="v2-deploy-time">{new Date(d.createdAt).toLocaleString()}</span>
      <div className={`v2-deploy-status-pill v2-pill-${d.status}`}>{d.status}</div>
    </div>
  ))}
</div>
```

**Key-value / config table:**
```tsx
<div className="canvas-var-table">
  {entries.map(([key, val]) => (
    <div key={key} className="canvas-var-row">
      <span className="mono">{key}</span>
      <span className="mono">{val}</span>
    </div>
  ))}
</div>
```

**Empty state:**
```tsx
<div className="empty-state"><p>No envoys registered yet.</p></div>
```

---

## Cards / Surface Containers

Standard surface card (info block, deployment pattern, etc.):
```tsx
<div style={{ padding: "14px 18px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)" }}>
  ...
</div>
```

Accent-tinted card (Synth analysis, highlighted content):
```tsx
<div style={{
  padding: "16px 18px",
  borderRadius: 10,
  background: "color-mix(in srgb, var(--accent) 6%, transparent)",
  border: "1px solid color-mix(in srgb, var(--accent) 18%, transparent)",
}}>
```

Warning-tinted card:
```tsx
<div style={{
  padding: "12px 14px",
  borderRadius: 8,
  background: "color-mix(in srgb, var(--status-warning) 6%, transparent)",
  border: "1px solid color-mix(in srgb, var(--status-warning) 18%, transparent)",
}}>
```

Stat cards row (numbers with label):
```tsx
<div style={{ display: "flex", gap: 10, marginTop: 16 }}>
  <div style={{ flex: 1, padding: "12px 14px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
    <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
      Label
    </div>
    <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", fontFamily: "monospace", lineHeight: 1 }}>42</div>
    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>supporting detail</div>
  </div>
</div>
```

---

## Status & Badges

**Status pill (inline):**
```tsx
<div className={`v2-deploy-status-pill v2-pill-${status}`}>{status}</div>
```
Status values: `succeeded` | `failed` | `running` | `pending` | `awaiting-approval` | `rolled-back` | `rejected`

**Status pip (dot indicator):**
```tsx
<span className="status-pip" style={{ background: healthColor, width: 8, height: 8, flexShrink: 0 }} />
```
Use `var(--status-succeeded)` / `var(--status-warning)` / `var(--status-failed)` for the color.

**Tag/badge (monospace label):**
```tsx
<span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, background: "color-mix(in srgb, var(--text) 6%, transparent)", color: "var(--text-muted)", fontFamily: "monospace", border: "1px solid var(--border)" }}>
  node:18
</span>
```

---

## Typography

| Use case | Pattern |
|---|---|
| Page title | `className="v6-page-title"` |
| Page subtitle | `className="v6-page-subtitle"` |
| Artifact/entity name | `style={{ fontSize: 22, fontWeight: 500, fontFamily: "var(--font-display)" }}` |
| Section label | inline style block (see Section Labels above) |
| Body text | `style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}` |
| Secondary/muted | `style={{ fontSize: 12, color: "var(--text-muted)" }}` |
| Monospace value | `className="mono"` or `style={{ fontFamily: "monospace" }}` |
| Timestamp | `style={{ fontSize: 11, color: "var(--text-muted)" }}` |

---

## Navigation

Always use `useCanvas()` to push panels:

```tsx
const { pushPanel } = useCanvas();

pushPanel({ type: "deployment-authoring", title: "New Deployment", params: { artifactId: artifact.id } })
pushPanel({ type: "debrief", title: "Debriefs", params: { deploymentId: d.id } })
pushPanel({ type: "envoy-detail", title: e.name, params: { id: e.id } })
```

---

## Data Fetching

Always use `useQuery`. Never fetch in useEffect.

```tsx
const { data: artifact, loading } = useQuery(`artifact:${artifactId}`, () => getArtifact(artifactId));
```

Cache invalidation after mutations:
```tsx
import { invalidateExact, invalidate } from "../../hooks/useQuery.js";

invalidateExact(`artifact:${artifactId}`); // invalidate one key
invalidate("list:artifacts");              // invalidate all keys starting with prefix
```

---

## Loading & Error States

```tsx
if (loading)
  return (
    <CanvasPanelHost title={title} hideRootCrumb>
      <div className="loading">Loading...</div>
    </CanvasPanelHost>
  );

if (!data)
  return (
    <CanvasPanelHost title={title} hideRootCrumb>
      <div className="error-msg">Thing not found</div>
    </CanvasPanelHost>
  );
```

---

## Hover Effects on Clickable Cards

Since CSS `:hover` is limited on complex button layouts, use onMouseEnter/Leave for card hover only:

```tsx
onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
```

This is the one acceptable use of event-based style mutation.
