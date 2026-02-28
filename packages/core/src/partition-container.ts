import type {
  PartitionId,
  Partition,
  Environment,
  Deployment,
  DeploymentId,
  DebriefEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Variable precedence types
// ---------------------------------------------------------------------------

export interface PrecedenceEntry {
  variable: string;
  resolvedValue: string;
  source: "environment" | "partition" | "trigger";
  overrode: {
    value: string;
    source: "environment" | "partition";
  } | null;
  reason: string;
}

export interface VariableResolution {
  resolved: Record<string, string>;
  precedenceLog: PrecedenceEntry[];
}

// ---------------------------------------------------------------------------
// Scoped store interfaces
// ---------------------------------------------------------------------------

/**
 * Read-only deployment access scoped to a single partition.
 * Implementations MUST enforce that only deployments belonging
 * to the bound partitionId are returned.
 */
export interface ScopedDeploymentReader {
  get(id: DeploymentId): Deployment | undefined;
  list(): Deployment[];
}

/**
 * Read-only debrief access scoped to a single partition.
 */
export interface ScopedDebriefReader {
  list(): DebriefEntry[];
}

// ---------------------------------------------------------------------------
// PartitionContainer -- the isolation boundary
// ---------------------------------------------------------------------------

/**
 * The isolation boundary for a single partition.
 *
 * All access to partition-specific data flows through this container.
 * The container enforces:
 *   1. Data scoping -- only this partition's data is accessible
 *   2. State isolation -- variables are owned copies, not shared references
 *   3. Variable precedence -- deterministic resolution with full audit trail
 *
 * A PartitionContainer is NOT a copy of stored data. Scoped readers are live
 * views that delegate to shared stores but filter by partitionId. Variables
 * are owned copies that cannot affect other containers.
 */
export class PartitionContainer {
  readonly id: PartitionId;
  readonly name: string;
  readonly createdAt: Date;

  private _variables: Record<string, string>;
  private _deployments: ScopedDeploymentReader;
  private _debrief: ScopedDebriefReader;

  constructor(
    partition: Partition,
    deployments: ScopedDeploymentReader,
    debrief: ScopedDebriefReader,
  ) {
    this.id = partition.id;
    this.name = partition.name;
    this.createdAt = partition.createdAt;
    this._variables = { ...partition.variables };
    this._deployments = deployments;
    this._debrief = debrief;
  }

  // -----------------------------------------------------------------------
  // Variables -- owned copy, no shared state
  // -----------------------------------------------------------------------

  getVariables(): Record<string, string> {
    return { ...this._variables };
  }

  setVariables(variables: Record<string, string>): void {
    this._variables = { ...this._variables, ...variables };
  }

  /**
   * Resolve variables using precedence: trigger > partition > environment.
   *
   * Returns the merged variable set and a complete precedence log that
   * records -- for every variable -- which value was used, where it came
   * from, what it overrode, and a plain-language explanation of why.
   *
   * This is the single source of truth for "what variables does this
   * partition get in this environment, and why."
   */
  resolveVariables(
    environment: Environment,
    triggerOverrides?: Record<string, string>,
  ): VariableResolution {
    const envVars = environment.variables;
    const partitionVars = this._variables;
    const triggerVars = triggerOverrides ?? {};

    // Build the merged set -- last write wins per precedence
    const resolved: Record<string, string> = {};
    const finalSource: Map<
      string,
      "environment" | "partition" | "trigger"
    > = new Map();

    for (const [key, value] of Object.entries(envVars)) {
      resolved[key] = value;
      finalSource.set(key, "environment");
    }
    for (const [key, value] of Object.entries(partitionVars)) {
      resolved[key] = value;
      finalSource.set(key, "partition");
    }
    for (const [key, value] of Object.entries(triggerVars)) {
      resolved[key] = value;
      finalSource.set(key, "trigger");
    }

    // Build the precedence log -- one entry per variable
    const precedenceLog: PrecedenceEntry[] = [];

    for (const [key, value] of Object.entries(resolved)) {
      const source = finalSource.get(key)!;
      let overrode: PrecedenceEntry["overrode"] = null;
      let reason: string;

      if (source === "trigger") {
        // Trigger won -- check what it overrode
        if (key in partitionVars && partitionVars[key] !== value) {
          overrode = { value: partitionVars[key], source: "partition" };
          reason =
            `Trigger override "${value}" takes precedence over ` +
            `partition value "${partitionVars[key]}" for ${key}`;
        } else if (key in envVars && envVars[key] !== value) {
          overrode = { value: envVars[key], source: "environment" };
          reason =
            `Trigger override "${value}" takes precedence over ` +
            `environment default "${envVars[key]}" for ${key}`;
        } else {
          reason = `Trigger-only variable ${key} -- not defined at lower levels`;
        }
      } else if (source === "partition") {
        if (key in envVars && envVars[key] !== value) {
          overrode = { value: envVars[key], source: "environment" };
          reason =
            `Partition value "${value}" overrides environment ` +
            `default "${envVars[key]}" for ${key}`;
        } else {
          reason = `Partition-only variable ${key} -- not defined at environment level`;
        }
      } else {
        reason = `Environment default applied for ${key} -- no higher-level override`;
      }

      precedenceLog.push({ variable: key, resolvedValue: value, source, overrode, reason });
    }

    return { resolved, precedenceLog };
  }

  // -----------------------------------------------------------------------
  // Scoped data access -- only this partition's data
  // -----------------------------------------------------------------------

  getDeployments(): Deployment[] {
    return this._deployments.list();
  }

  getDeployment(id: DeploymentId): Deployment | undefined {
    return this._deployments.get(id);
  }

  getDebriefEntries(): DebriefEntry[] {
    return this._debrief.list();
  }

  /**
   * Snapshot of partition metadata. Safe to pass to code that needs a Partition
   * object without exposing container internals.
   */
  toPartition(): Partition {
    return {
      id: this.id,
      name: this.name,
      variables: this.getVariables(),
      createdAt: this.createdAt,
    };
  }
}
