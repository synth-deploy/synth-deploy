---
name: exercise
description: Run Synth playbook scenarios and visual QA — tests all 6 operation types via API and UI
argument-hint: "[type] [visual]"
---

This skill exercises the Synth testing infrastructure across three layers: API playbooks, component tests, and visual QA.

**Arguments:**
- `/exercise` — run all playbooks + unit tests
- `/exercise maintain` — run only playbooks of type `maintain`
- `/exercise visual` — run visual QA via preview tools (boots UI, inspects flows)
- `/exercise query visual` — filter by type AND run visual QA
- `/exercise generate "check disk usage on staging"` — generate a new playbook YAML from natural language

Parse the arguments: if a known operation type is present (deploy, maintain, query, investigate, trigger, composite), use it as a filter. If `visual` is present, include visual QA. If `generate` is present followed by a quoted string, generate a new playbook.

---

## Mode 1 — API Playbooks (default)

Run playbook scenarios that exercise all 6 operation types against the in-process server+envoy harness.

**Step 1:** Run the playbooks.

```bash
npm run exercise [-- --type=<filter>]
```

If a type filter was specified, pass `--type=<type>`.

**Step 2:** Report results. Show a summary table:
- Playbook name
- Type
- Pass/Fail
- Duration
- Any failure details

If all pass, report the total count and confirm coverage of all operation types.

If any fail, investigate: read the playbook YAML, check the runner output, and diagnose what went wrong. Fix if it's a test issue, or flag if it's a product bug.

---

## Mode 2 — Component Tests

Run UI component tests alongside playbooks for full coverage.

```bash
npm test --workspace=packages/ui
```

Report test count and any failures. The UI tests cover:
- Operation authoring panel (all 6 types)
- Debrief entry rendering (all decision types)
- Theme/CSS compliance (status pills, dt-badges, entity colors, CSS variables)

---

## Mode 3 — Visual QA (when `visual` argument present)

Use preview tools to boot the Synth UI and verify visual correctness.

**Step 1:** Start the UI dev server.

```
preview_start("synth-ui")
```

**Step 2:** Navigate to the operation authoring panel and verify each operation type:

For each type in [deploy, maintain, query, investigate, trigger, composite]:
1. Use `preview_snapshot` to get the page state
2. Click the operation type button
3. Use `preview_snapshot` to verify the correct fields appear/disappear
4. Use `preview_inspect` on key elements to verify:
   - Font family uses `var(--font-mono)` (not hardcoded)
   - Colors use CSS variables (not hex)
   - Border-radius matches UI_PATTERNS.md conventions
5. Take `preview_screenshot` as proof

**Step 3:** Verify theme compliance:
- Check that status pills use correct CSS classes (`v2-pill-succeeded`, etc.)
- Check that the segmented-control pattern is used for tabs
- Verify dark/light mode works with `preview_resize` + `colorScheme`

**Step 4:** Report findings with screenshots.

---

## Mode 4 — Generate Playbook (when `generate` argument present)

Generate a new playbook YAML file from a natural-language description.

**Step 1:** Parse the description to determine:
- Operation type (deploy, maintain, query, investigate, trigger, composite)
- Intent / condition / response intent
- Required entities (environments, partitions, artifacts)
- Reasonable assertions

**Step 2:** Write the YAML file to `tests/playbooks/<type>-<slug>.yaml` following the schema:

```yaml
name: "<descriptive name>"
type: <type>
tags: [<type>, <relevant tags>]

setup:
  environments:
    - name: <env>
      variables: { ... }
  partitions:
    - name: <partition>
      variables: { ... }
  artifacts: []  # only for deploy

operation:
  type: <type>
  intent: "<from description>"
  environmentRef: <env>
  partitionRef: <partition>

assertions:
  - responseStatus: 201
  - statusIn: [pending, planning, awaiting_approval]
```

**Step 3:** Validate the playbook by running it:

```bash
npm run exercise -- --type=<type>
```

Report whether the new playbook passes.

---

## Summary

After running all requested modes, provide a concise summary:
- Playbook results (X/Y passed, by type)
- UI test results (X passed)
- Visual QA findings (if applicable)
- Any issues that need attention
