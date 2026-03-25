import type {
  ScriptedPlan,
  SecurityBoundary,
} from "@synth-deploy/core";

// ---------------------------------------------------------------------------
// Types — validation results
// ---------------------------------------------------------------------------

/**
 * Result of validating a scripted plan against security boundaries.
 */
export interface ScriptValidationResult {
  allowed: boolean;
  violations: string[];
}

// ---------------------------------------------------------------------------
// BoundaryValidator — validates scripted plans against security boundaries
// ---------------------------------------------------------------------------

/**
 * Validates scripted plans against security boundaries.
 *
 * With scripted plans, boundary enforcement shifts from per-step handler-based
 * classification to script-level analysis. The validator inspects the script
 * text for references to paths, commands, and hosts that violate boundaries.
 *
 * This is a best-effort static analysis — the LLM audit pass (when enabled)
 * provides deeper semantic analysis as a complement.
 */
export class BoundaryValidator {
  /**
   * Validate a scripted plan against the provided boundaries.
   * If no boundaries are configured, allow everything (boundaries are opt-in).
   */
  validatePlan(
    plan: ScriptedPlan,
    boundaries: SecurityBoundary[],
  ): ScriptValidationResult {
    if (boundaries.length === 0) {
      return { allowed: true, violations: [] };
    }

    const violations: string[] = [];
    const scriptText = [
      plan.executionScript,
      plan.rollbackScript ?? "",
    ].join("\n");

    for (const boundary of boundaries) {
      const result = this.checkBoundary(scriptText, boundary);
      if (result) {
        violations.push(result);
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: boundary checking against script text
  // -------------------------------------------------------------------------

  private checkBoundary(
    scriptText: string,
    boundary: SecurityBoundary,
  ): string | undefined {
    const config = boundary.config;

    switch (boundary.boundaryType) {
      case "filesystem": {
        const allowedPaths = config.allowedPaths as string[] | undefined;
        if (!allowedPaths || allowedPaths.length === 0) return undefined;

        // Extract path-like references from the script
        const pathRefs = this.extractPaths(scriptText);
        for (const ref of pathRefs) {
          const inAllowed = allowedPaths.some((p) =>
            ref === p || ref.startsWith(p.endsWith("/") ? p : p + "/"),
          );
          if (!inAllowed) {
            return (
              `Script references path "${ref}" which is outside the allowed ` +
              `filesystem paths: ${allowedPaths.join(", ")}.`
            );
          }
        }
        return undefined;
      }

      case "execution": {
        const allowedCommands = config.allowedCommands as string[] | undefined;
        if (!allowedCommands || allowedCommands.length === 0) return undefined;

        // Extract command references from the script
        const commands = this.extractCommands(scriptText);
        for (const cmd of commands) {
          const inAllowed = allowedCommands.some((c) =>
            cmd.toLowerCase().includes(c.toLowerCase()),
          );
          if (!inAllowed) {
            return (
              `Script uses command "${cmd}" which is not in the allowed ` +
              `execution commands: ${allowedCommands.join(", ")}.`
            );
          }
        }
        return undefined;
      }

      case "network": {
        const allowedHosts = config.allowedHosts as string[] | undefined;
        if (!allowedHosts || allowedHosts.length === 0) return undefined;

        // Extract host references from the script
        const hosts = this.extractHosts(scriptText);
        for (const host of hosts) {
          const inAllowed = allowedHosts.some((h) => host.includes(h));
          if (!inAllowed) {
            return (
              `Script references host "${host}" which is not in the allowed ` +
              `network hosts: ${allowedHosts.join(", ")}.`
            );
          }
        }
        return undefined;
      }

      case "service": {
        const allowedServices = config.allowedServices as string[] | undefined;
        if (!allowedServices || allowedServices.length === 0) return undefined;

        // Check for systemctl/service/launchctl references
        const servicePattern = /(?:systemctl\s+\w+\s+|service\s+|launchctl\s+\w+\s+)([\w.-]+)/g;
        let match;
        while ((match = servicePattern.exec(scriptText)) !== null) {
          const svcName = match[1];
          if (!allowedServices.includes(svcName)) {
            return (
              `Script manages service "${svcName}" which is not in the allowed ` +
              `service list: ${allowedServices.join(", ")}.`
            );
          }
        }
        return undefined;
      }

      case "credential":
        // Credential boundaries require semantic understanding —
        // delegate to the LLM audit pass when enabled
        return undefined;
    }

    return undefined;
  }

  /** Extract absolute path references from script text */
  private extractPaths(script: string): string[] {
    const paths = new Set<string>();
    // Match absolute paths (Unix-style)
    const pathPattern = /(?:^|\s|["'=])(\/([\w.-]+\/)+[\w.*-]*)/gm;
    let match;
    while ((match = pathPattern.exec(script)) !== null) {
      const p = match[1];
      // Skip common non-path references
      if (p.startsWith("/dev/") || p.startsWith("/proc/") || p === "/dev/null") continue;
      paths.add(p);
    }
    return [...paths];
  }

  /** Extract command names from script text (first word of each line) */
  private extractCommands(script: string): string[] {
    const cmds = new Set<string>();
    for (const line of script.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
      // Skip shell builtins and control structures
      if (/^(if|then|else|elif|fi|for|do|done|while|case|esac|function|return|exit|echo|printf|set|export|local|readonly|declare|unset|shift|trap|cd|pwd|true|false|test|\[|\[\[)(\s|$)/.test(trimmed)) continue;
      // Extract the command (first word, possibly with path)
      const cmdMatch = trimmed.match(/^(?:sudo\s+)?([^\s|;&]+)/);
      if (cmdMatch) {
        const cmd = cmdMatch[1].replace(/^.*\//, ""); // strip path prefix
        if (cmd) cmds.add(cmd);
      }
    }
    return [...cmds];
  }

  /** Extract hostname/URL references from script text */
  private extractHosts(script: string): string[] {
    const hosts = new Set<string>();
    // Match URLs
    const urlPattern = /https?:\/\/([\w.-]+)/g;
    let match;
    while ((match = urlPattern.exec(script)) !== null) {
      hosts.add(match[1]);
    }
    // Match curl/wget/ssh targets
    const cmdHostPattern = /(?:curl|wget|ssh|scp|rsync)\s+(?:-[^\s]*\s+)*(?:[\w]+@)?([\w.-]+(?:\.\w{2,}))/g;
    while ((match = cmdHostPattern.exec(script)) !== null) {
      hosts.add(match[1]);
    }
    return [...hosts];
  }
}
