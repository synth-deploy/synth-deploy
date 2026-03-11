import fs from "node:fs/promises";
import path from "node:path";
import type { PlannedStep } from "@synth-deploy/core";
import type { Platform } from "../platform.js";
import type { OperationHandler, HandlerResult, DryRunResult } from "../operation-registry.js";

// ---------------------------------------------------------------------------
// ConfigHandler — template substitution and config transforms
// ---------------------------------------------------------------------------

/**
 * Handles configuration file operations: reading templates, substituting
 * `{{variable}}` patterns with values from params, and writing the result.
 *
 * Matches actions containing: config, template, substitute, transform
 *
 * Template format: `{{VARIABLE_NAME}}` — double-brace Mustache style.
 * All variables in the template must have corresponding values in params
 * or the substitution fails explicitly (no silent partial rendering).
 */
export class ConfigHandler implements OperationHandler {
  readonly name = "config";
  readonly actionKeywords = ["config", "template", "substitute", "transform"] as const;
  readonly toolDependencies = [] as const;

  canHandle(action: string, _platform: Platform): boolean {
    const lower = action.toLowerCase();
    return (
      lower.includes("config") ||
      lower.includes("template") ||
      lower.includes("substitute") ||
      lower.includes("transform")
    );
  }

  async execute(
    action: string,
    target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    try {
      const lower = action.toLowerCase();

      if (lower.includes("template") || lower.includes("substitute")) {
        return await this.processTemplate(target, params);
      }

      if (lower.includes("transform") || lower.includes("config")) {
        return await this.processTemplate(target, params);
      }

      return {
        success: false,
        output: "",
        error: `Unrecognized config operation: "${action}"`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: "",
        error: `Config operation "${action}" on "${target}" failed: ${message}`,
      };
    }
  }

  async verify(_action: string, target: string): Promise<boolean> {
    try {
      await fs.access(target);
      // Verify no unsubstituted variables remain
      const content = await fs.readFile(target, "utf-8");
      return !content.includes("{{");
    } catch {
      return false;
    }
  }

  async dryRun(
    step: PlannedStep,
    _predictedOutcomes: Map<number, Record<string, unknown>>,
  ): Promise<DryRunResult> {
    const preconditions: DryRunResult["preconditions"] = [];
    const target = step.target;

    try {
      // Check that the template source exists and is readable
      let templateContent: string | null = null;
      try {
        templateContent = await fs.readFile(target, "utf-8");
        preconditions.push({
          check: "template-readable",
          passed: true,
          detail: `Template/config file "${target}" exists and is readable (${templateContent.length} bytes)`,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        preconditions.push({
          check: "template-readable",
          passed: false,
          detail: `Cannot read template/config file "${target}": ${message}`,
        });
      }

      // If we could read the template, check that all required variables are provided in params
      if (templateContent !== null) {
        const pattern = /\{\{(\w+)\}\}/g;
        const required = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(templateContent)) !== null) {
          required.add(match[1]);
        }

        if (required.size > 0) {
          // Build the same variable set that processTemplate() will use at execution time
          const params = step.params ?? {};
          const variables = (params.variables as Record<string, string>) ?? {};
          const allVars: Record<string, unknown> = { ...variables };
          for (const [key, value] of Object.entries(params)) {
            if (
              key !== "templatePath" &&
              key !== "outputPath" &&
              key !== "variables" &&
              key !== "description" &&
              key !== "rollbackAction" &&
              key !== "reversible"
            ) {
              allVars[key] = value;
            }
          }

          const missing = [...required].filter((v) => !(v in allVars));
          if (missing.length > 0) {
            preconditions.push({
              check: "template-variables-present",
              passed: false,
              detail:
                `Template requires ${missing.length} variable(s) not provided in step params: ` +
                `${missing.join(", ")}. Add these to the step's "params.variables" object.`,
            });
          } else {
            preconditions.push({
              check: "template-variables-present",
              passed: true,
              detail: `All ${required.size} template variable(s) are provided: ${[...required].join(", ")}`,
            });
          }
        } else {
          preconditions.push({
            check: "template-variables-present",
            passed: true,
            detail: `Template contains no {{variable}} patterns — no substitution needed`,
          });
        }
      }

      // Check output directory is writable
      const outputDir = path.dirname(target);
      try {
        await fs.access(outputDir, (await import("node:fs")).constants.W_OK);
        preconditions.push({
          check: "output-directory-writable",
          passed: true,
          detail: `Output directory "${outputDir}" is writable`,
        });
      } catch {
        preconditions.push({
          check: "output-directory-writable",
          passed: false,
          detail: `Output directory "${outputDir}" is not writable — config output will fail`,
        });
      }

      const allPassed = preconditions.every((p) => p.passed);

      return {
        canExecute: allPassed,
        preconditions,
        predictedOutcome: { configWritten: target },
        fidelity: "deterministic",
        recoverable: true,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        canExecute: false,
        preconditions: [
          {
            check: "dry-run-error",
            passed: false,
            detail: `Dry-run check failed unexpectedly: ${message}`,
          },
        ],
        fidelity: "deterministic",
        recoverable: true,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internal: template processing
  // -------------------------------------------------------------------------

  private async processTemplate(
    target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    // Read the template (or the file to transform in place)
    const templatePath = (params.templatePath as string) ?? target;
    const outputPath = (params.outputPath as string) ?? target;
    const variables = (params.variables as Record<string, string>) ?? {};

    // Also accept top-level params as variables for convenience
    const allVariables: Record<string, string> = { ...variables };
    for (const [key, value] of Object.entries(params)) {
      if (
        key !== "templatePath" &&
        key !== "outputPath" &&
        key !== "variables" &&
        key !== "description" &&
        key !== "rollbackAction" &&
        key !== "reversible" &&
        typeof value === "string"
      ) {
        allVariables[key] = value;
      }
    }

    let content: string;
    try {
      content = await fs.readFile(templatePath, "utf-8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: "",
        error: `Cannot read template file "${templatePath}": ${message}`,
      };
    }

    // Find all {{variable}} patterns
    const pattern = /\{\{(\w+)\}\}/g;
    const required = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      required.add(match[1]);
    }

    // Check that all required variables are provided
    const missing = [...required].filter((v) => !(v in allVariables));
    if (missing.length > 0) {
      return {
        success: false,
        output: "",
        error:
          `Template "${templatePath}" requires variables that were not provided: ` +
          `${missing.join(", ")}. All template variables must be resolved — ` +
          `partial substitution is not allowed.`,
      };
    }

    // Perform substitution
    let result = content;
    for (const [key, value] of Object.entries(allVariables)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    // Write output
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outputPath, result, "utf-8");

    const substitutionCount = required.size;
    return {
      success: true,
      output:
        `Processed template "${templatePath}" -> "${outputPath}" ` +
        `with ${substitutionCount} variable substitution(s)`,
    };
  }
}
