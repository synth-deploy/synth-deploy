# Synth Website

Product website for Synth, built with [Astro](https://astro.build/) and [Tailwind CSS](https://tailwindcss.com/). Generates a fully static site — no client-side JavaScript frameworks.

**Live URL:** https://synthdeploy.com

## Prerequisites

- Node.js 20+
- npm 10+

## Local Development

```bash
cd website
npm install
npm run dev
```

The dev server starts at `http://localhost:4321` with hot reload.

## Building

```bash
npm run build
```

Output goes to `website/dist/`. This is a static build — every page is pre-rendered HTML.

## Previewing the Production Build

```bash
npm run preview
```

Serves the `dist/` directory locally so you can verify the production build before deploying.

## Deploying

Deployment targets **GitHub Pages** via a manual GitHub Actions workflow.

### To deploy:

1. Go to **Actions** > **Deploy Website** in the GitHub repo
2. Click **Run workflow** on the `main` branch
3. The workflow installs dependencies, builds the site, and deploys to GitHub Pages

The workflow is defined in [.github/workflows/website.yml](../.github/workflows/website.yml). It runs on `workflow_dispatch` only — pushes to `main` do not auto-deploy the website.

### What the workflow does:

1. Checks out the repo
2. Sets up Node.js 20
3. Runs `npm install` and `npm run build` in the `website/` directory
4. Uploads `website/dist/` as a GitHub Pages artifact
5. Deploys to the `github-pages` environment

### DNS / Custom Domain

The site is configured for `https://synthdeploy.com` in [astro.config.mjs](astro.config.mjs). If you change the domain, update the `site` property there.

## Site Structure

```
website/
├── src/
│   ├── pages/
│   │   ├── index.astro              # Homepage (hero, features, architecture, CTA)
│   │   └── docs/
│   │       ├── index.astro          # Getting Started guide
│   │       ├── architecture.astro   # Architecture documentation
│   │       └── step-types.astro     # Step Type Library reference
│   ├── layouts/
│   │   ├── Layout.astro             # Main site layout (nav, footer)
│   │   └── DocsLayout.astro         # Docs layout with sidebar
│   └── styles/
│       └── global.css               # Tailwind directives + custom animations
├── public/
│   └── favicon.svg
├── astro.config.mjs
├── tailwind.config.mjs
└── tsconfig.json
```

## Design System

The site uses a dark theme with a custom Tailwind color palette under the `ds` namespace:

| Token | Purpose |
|-------|---------|
| `ds-bg` | Page background (dark navy) |
| `ds-surface` | Card/panel backgrounds (glass morphism) |
| `ds-border` | Subtle borders |
| `ds-text` | Primary text |
| `ds-text-secondary` | Secondary/muted text |
| `ds-accent` | Teal accent color (CTAs, highlights) |

Fonts: **Instrument Sans** (UI) and **Space Mono** (code/terminal), loaded from Google Fonts.

## Adding a New Page

1. Create a `.astro` file in `src/pages/` (file path becomes the URL route)
2. Import and use `Layout.astro` (marketing pages) or `DocsLayout.astro` (documentation)
3. The page is automatically included in the build — no routing config needed

## Tests

The website has no automated tests. Verify changes by:

1. Running `npm run dev` and checking pages visually
2. Running `npm run build` to confirm the build succeeds (catches broken imports, bad markup, etc.)
3. Running `npm run preview` to verify the production build renders correctly
