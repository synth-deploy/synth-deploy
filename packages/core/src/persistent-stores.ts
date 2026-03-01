import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  Partition,
  PartitionId,
  Environment,
  EnvironmentId,
  Operation,
  OperationId,
  Order,
  OrderId,
  Deployment,
  DeploymentId,
  DeploymentStep,
  DeploymentStepType,
  DeployConfig,
  AppSettings,
} from "./types.js";
import { DEFAULT_APP_SETTINGS, DEFAULT_DEPLOY_CONFIG } from "./types.js";
import type { CreateOrderParams } from "./order-store.js";

// ---------------------------------------------------------------------------
// Shared database setup
// ---------------------------------------------------------------------------

export function openEntityDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS partitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      deploy_config TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operation_environments (
      operation_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      PRIMARY KEY (operation_id, environment_id)
    );

    CREATE TABLE IF NOT EXISTS deployment_steps (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      command TEXT NOT NULL,
      step_order INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_steps_operation ON deployment_steps(operation_id);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      operation_name TEXT NOT NULL,
      partition_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      environment_name TEXT NOT NULL,
      version TEXT NOT NULL,
      steps TEXT NOT NULL,
      deploy_config TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_operation ON orders(operation_id);
    CREATE INDEX IF NOT EXISTS idx_orders_partition ON orders(partition_id);

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      partition_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '{}',
      debrief_entry_ids TEXT NOT NULL DEFAULT '[]',
      order_id TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      failure_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deployments_partition ON deployments(partition_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_operation ON deployments(operation_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

// ---------------------------------------------------------------------------
// PersistentPartitionStore
// ---------------------------------------------------------------------------

export class PersistentPartitionStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    list: Database.Statement;
    updateName: Database.Statement;
    updateVariables: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO partitions (id, name, variables, created_at) VALUES (@id, @name, @variables, @created_at)`,
      ),
      getById: db.prepare(`SELECT * FROM partitions WHERE id = ?`),
      list: db.prepare(`SELECT * FROM partitions ORDER BY created_at ASC`),
      updateName: db.prepare(`UPDATE partitions SET name = @name WHERE id = @id`),
      updateVariables: db.prepare(`UPDATE partitions SET variables = @variables WHERE id = @id`),
      deleteById: db.prepare(`DELETE FROM partitions WHERE id = ?`),
    };
  }

  create(name: string, variables: Record<string, string> = {}): Partition {
    const partition: Partition = {
      id: crypto.randomUUID(),
      name,
      variables,
      createdAt: new Date(),
    };
    this.stmts.insert.run({
      id: partition.id,
      name: partition.name,
      variables: JSON.stringify(partition.variables),
      created_at: partition.createdAt.toISOString(),
    });
    return partition;
  }

  get(id: PartitionId): Partition | undefined {
    const row = this.stmts.getById.get(id) as PartitionRow | undefined;
    return row ? rowToPartition(row) : undefined;
  }

  list(): Partition[] {
    const rows = this.stmts.list.all() as PartitionRow[];
    return rows.map(rowToPartition);
  }

  setVariables(id: PartitionId, variables: Record<string, string>): Partition {
    const partition = this.get(id);
    if (!partition) throw new Error(`Partition not found: ${id}`);
    const merged = { ...partition.variables, ...variables };
    this.stmts.updateVariables.run({ variables: JSON.stringify(merged), id });
    return { ...partition, variables: merged };
  }

  update(id: PartitionId, updates: { name?: string }): Partition {
    const partition = this.get(id);
    if (!partition) throw new Error(`Partition not found: ${id}`);
    if (updates.name !== undefined) {
      this.stmts.updateName.run({ name: updates.name, id });
      partition.name = updates.name;
    }
    return partition;
  }

  delete(id: PartitionId): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }
}

interface PartitionRow {
  id: string;
  name: string;
  variables: string;
  created_at: string;
}

function rowToPartition(row: PartitionRow): Partition {
  return {
    id: row.id,
    name: row.name,
    variables: JSON.parse(row.variables),
    createdAt: new Date(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// PersistentEnvironmentStore
// ---------------------------------------------------------------------------

export class PersistentEnvironmentStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO environments (id, name, variables) VALUES (@id, @name, @variables)`,
      ),
      getById: db.prepare(`SELECT * FROM environments WHERE id = ?`),
      list: db.prepare(`SELECT * FROM environments ORDER BY name ASC`),
      update: db.prepare(
        `UPDATE environments SET name = @name, variables = @variables WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM environments WHERE id = ?`),
    };
  }

  create(name: string, variables: Record<string, string> = {}): Environment {
    const env: Environment = { id: crypto.randomUUID(), name, variables };
    this.stmts.insert.run({
      id: env.id,
      name: env.name,
      variables: JSON.stringify(env.variables),
    });
    return env;
  }

  get(id: EnvironmentId): Environment | undefined {
    const row = this.stmts.getById.get(id) as EnvironmentRow | undefined;
    return row ? rowToEnvironment(row) : undefined;
  }

  list(): Environment[] {
    const rows = this.stmts.list.all() as EnvironmentRow[];
    return rows.map(rowToEnvironment);
  }

  update(
    id: EnvironmentId,
    updates: { name?: string; variables?: Record<string, string> },
  ): Environment {
    const env = this.get(id);
    if (!env) throw new Error(`Environment not found: ${id}`);
    const newName = updates.name ?? env.name;
    const newVars = updates.variables
      ? { ...env.variables, ...updates.variables }
      : env.variables;
    this.stmts.update.run({
      id,
      name: newName,
      variables: JSON.stringify(newVars),
    });
    return { id, name: newName, variables: newVars };
  }

  delete(id: EnvironmentId): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }
}

interface EnvironmentRow {
  id: string;
  name: string;
  variables: string;
}

function rowToEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    name: row.name,
    variables: JSON.parse(row.variables),
  };
}

// ---------------------------------------------------------------------------
// PersistentOperationStore
// ---------------------------------------------------------------------------

export class PersistentOperationStore {
  private stmts: {
    insertOp: Database.Statement;
    getOp: Database.Statement;
    listOps: Database.Statement;
    updateOpName: Database.Statement;
    deleteOp: Database.Statement;
    insertEnvLink: Database.Statement;
    deleteEnvLink: Database.Statement;
    getEnvLinks: Database.Statement;
    deleteAllEnvLinks: Database.Statement;
    insertStep: Database.Statement;
    getSteps: Database.Statement;
    updateStep: Database.Statement;
    deleteStep: Database.Statement;
    deleteAllSteps: Database.Statement;
    updateDeployConfig: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insertOp: db.prepare(
        `INSERT INTO operations (id, name, deploy_config) VALUES (@id, @name, @deploy_config)`,
      ),
      getOp: db.prepare(`SELECT * FROM operations WHERE id = ?`),
      listOps: db.prepare(`SELECT * FROM operations ORDER BY name ASC`),
      updateOpName: db.prepare(`UPDATE operations SET name = @name WHERE id = @id`),
      deleteOp: db.prepare(`DELETE FROM operations WHERE id = ?`),
      insertEnvLink: db.prepare(
        `INSERT OR IGNORE INTO operation_environments (operation_id, environment_id) VALUES (@operation_id, @environment_id)`,
      ),
      deleteEnvLink: db.prepare(
        `DELETE FROM operation_environments WHERE operation_id = @operation_id AND environment_id = @environment_id`,
      ),
      getEnvLinks: db.prepare(
        `SELECT environment_id FROM operation_environments WHERE operation_id = ? ORDER BY rowid ASC`,
      ),
      deleteAllEnvLinks: db.prepare(
        `DELETE FROM operation_environments WHERE operation_id = ?`,
      ),
      insertStep: db.prepare(
        `INSERT INTO deployment_steps (id, operation_id, name, type, command, step_order)
         VALUES (@id, @operation_id, @name, @type, @command, @step_order)`,
      ),
      getSteps: db.prepare(
        `SELECT * FROM deployment_steps WHERE operation_id = ? ORDER BY step_order ASC`,
      ),
      updateStep: db.prepare(
        `UPDATE deployment_steps SET name = @name, type = @type, command = @command, step_order = @step_order WHERE id = @id`,
      ),
      deleteStep: db.prepare(`DELETE FROM deployment_steps WHERE id = ?`),
      deleteAllSteps: db.prepare(`DELETE FROM deployment_steps WHERE operation_id = ?`),
      updateDeployConfig: db.prepare(
        `UPDATE operations SET deploy_config = @deploy_config WHERE id = @id`,
      ),
    };
  }

  create(name: string, environmentIds: EnvironmentId[] = []): Operation {
    const id = crypto.randomUUID();
    const deployConfig = { ...DEFAULT_DEPLOY_CONFIG };

    this.db.transaction(() => {
      this.stmts.insertOp.run({
        id,
        name,
        deploy_config: JSON.stringify(deployConfig),
      });
      for (const envId of environmentIds) {
        this.stmts.insertEnvLink.run({ operation_id: id, environment_id: envId });
      }
    })();

    return { id, name, environmentIds: [...environmentIds], steps: [], deployConfig };
  }

  get(id: OperationId): Operation | undefined {
    const row = this.stmts.getOp.get(id) as OperationRow | undefined;
    if (!row) return undefined;
    return this.assembleOperation(row);
  }

  list(): Operation[] {
    const rows = this.stmts.listOps.all() as OperationRow[];
    return rows.map((r) => this.assembleOperation(r));
  }

  update(id: OperationId, updates: { name?: string }): Operation {
    const op = this.get(id);
    if (!op) throw new Error(`Operation not found: ${id}`);
    if (updates.name !== undefined) {
      this.stmts.updateOpName.run({ name: updates.name, id });
      op.name = updates.name;
    }
    return op;
  }

  delete(id: OperationId): boolean {
    const result = this.db.transaction(() => {
      this.stmts.deleteAllEnvLinks.run(id);
      this.stmts.deleteAllSteps.run(id);
      return this.stmts.deleteOp.run(id);
    })();
    return result.changes > 0;
  }

  addEnvironment(id: OperationId, environmentId: EnvironmentId): Operation {
    const op = this.get(id);
    if (!op) throw new Error(`Operation not found: ${id}`);
    this.stmts.insertEnvLink.run({ operation_id: id, environment_id: environmentId });
    if (!op.environmentIds.includes(environmentId)) {
      op.environmentIds.push(environmentId);
    }
    return op;
  }

  removeEnvironment(id: OperationId, environmentId: EnvironmentId): Operation {
    const op = this.get(id);
    if (!op) throw new Error(`Operation not found: ${id}`);
    this.stmts.deleteEnvLink.run({ operation_id: id, environment_id: environmentId });
    op.environmentIds = op.environmentIds.filter((eid) => eid !== environmentId);
    return op;
  }

  addStep(id: OperationId, step: DeploymentStep): Operation {
    const op = this.get(id);
    if (!op) throw new Error(`Operation not found: ${id}`);
    this.stmts.insertStep.run({
      id: step.id,
      operation_id: id,
      name: step.name,
      type: step.type,
      command: step.command,
      step_order: step.order,
    });
    op.steps.push(step);
    op.steps.sort((a, b) => a.order - b.order);
    return op;
  }

  updateStep(
    id: OperationId,
    stepId: string,
    updates: { name?: string; type?: DeploymentStepType; command?: string; order?: number },
  ): Operation {
    const op = this.get(id);
    if (!op) throw new Error(`Operation not found: ${id}`);
    const step = op.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step not found: ${stepId}`);
    const updated = {
      id: stepId,
      name: updates.name ?? step.name,
      type: updates.type ?? step.type,
      command: updates.command ?? step.command,
      step_order: updates.order ?? step.order,
    };
    this.stmts.updateStep.run(updated);
    return this.get(id)!;
  }

  removeStep(id: OperationId, stepId: string): Operation {
    const op = this.get(id);
    if (!op) throw new Error(`Operation not found: ${id}`);
    this.stmts.deleteStep.run(stepId);
    op.steps = op.steps.filter((s) => s.id !== stepId);
    return op;
  }

  reorderSteps(id: OperationId, orderedStepIds: string[]): Operation {
    const op = this.get(id);
    if (!op) throw new Error(`Operation not found: ${id}`);

    this.db.transaction(() => {
      for (let i = 0; i < orderedStepIds.length; i++) {
        const step = op.steps.find((s) => s.id === orderedStepIds[i]);
        if (!step) throw new Error(`Step not found: ${orderedStepIds[i]}`);
        this.stmts.updateStep.run({
          id: step.id,
          name: step.name,
          type: step.type,
          command: step.command,
          step_order: i,
        });
      }
    })();

    return this.get(id)!;
  }

  updateDeployConfig(id: OperationId, config: Partial<DeployConfig>): Operation {
    const op = this.get(id);
    if (!op) throw new Error(`Operation not found: ${id}`);
    const merged = { ...op.deployConfig, ...config };
    this.stmts.updateDeployConfig.run({ id, deploy_config: JSON.stringify(merged) });
    op.deployConfig = merged;
    return op;
  }

  private assembleOperation(row: OperationRow): Operation {
    const envRows = this.stmts.getEnvLinks.all(row.id) as { environment_id: string }[];
    const stepRows = this.stmts.getSteps.all(row.id) as StepRow[];
    return {
      id: row.id,
      name: row.name,
      environmentIds: envRows.map((r) => r.environment_id),
      steps: stepRows.map(rowToStep),
      deployConfig: JSON.parse(row.deploy_config),
    };
  }
}

interface OperationRow {
  id: string;
  name: string;
  deploy_config: string;
}

interface StepRow {
  id: string;
  operation_id: string;
  name: string;
  type: string;
  command: string;
  step_order: number;
}

function rowToStep(row: StepRow): DeploymentStep {
  return {
    id: row.id,
    name: row.name,
    type: row.type as DeploymentStepType,
    command: row.command,
    order: row.step_order,
  };
}

// ---------------------------------------------------------------------------
// PersistentOrderStore
// ---------------------------------------------------------------------------

export class PersistentOrderStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    list: Database.Statement;
    getByOperation: Database.Statement;
    getByPartition: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO orders (id, operation_id, operation_name, partition_id, environment_id, environment_name, version, steps, deploy_config, variables, created_at)
         VALUES (@id, @operation_id, @operation_name, @partition_id, @environment_id, @environment_name, @version, @steps, @deploy_config, @variables, @created_at)`,
      ),
      getById: db.prepare(`SELECT * FROM orders WHERE id = ?`),
      list: db.prepare(`SELECT * FROM orders ORDER BY created_at ASC`),
      getByOperation: db.prepare(
        `SELECT * FROM orders WHERE operation_id = ? ORDER BY created_at ASC`,
      ),
      getByPartition: db.prepare(
        `SELECT * FROM orders WHERE partition_id = ? ORDER BY created_at ASC`,
      ),
    };
  }

  create(params: CreateOrderParams): Order {
    const order: Order = {
      id: crypto.randomUUID(),
      operationId: params.operationId,
      operationName: params.operationName,
      partitionId: params.partitionId,
      environmentId: params.environmentId,
      environmentName: params.environmentName,
      version: params.version,
      steps: structuredClone(params.steps),
      deployConfig: structuredClone(params.deployConfig),
      variables: { ...params.variables },
      createdAt: new Date(),
    };
    this.stmts.insert.run({
      id: order.id,
      operation_id: order.operationId,
      operation_name: order.operationName,
      partition_id: order.partitionId,
      environment_id: order.environmentId,
      environment_name: order.environmentName,
      version: order.version,
      steps: JSON.stringify(order.steps),
      deploy_config: JSON.stringify(order.deployConfig),
      variables: JSON.stringify(order.variables),
      created_at: order.createdAt.toISOString(),
    });
    return structuredClone(order);
  }

  get(id: OrderId): Order | undefined {
    const row = this.stmts.getById.get(id) as OrderRow | undefined;
    return row ? rowToOrder(row) : undefined;
  }

  list(): Order[] {
    const rows = this.stmts.list.all() as OrderRow[];
    return rows.map(rowToOrder);
  }

  getByOperation(operationId: OperationId): Order[] {
    const rows = this.stmts.getByOperation.all(operationId) as OrderRow[];
    return rows.map(rowToOrder);
  }

  getByPartition(partitionId: PartitionId): Order[] {
    const rows = this.stmts.getByPartition.all(partitionId) as OrderRow[];
    return rows.map(rowToOrder);
  }
}

interface OrderRow {
  id: string;
  operation_id: string;
  operation_name: string;
  partition_id: string;
  environment_id: string;
  environment_name: string;
  version: string;
  steps: string;
  deploy_config: string;
  variables: string;
  created_at: string;
}

function rowToOrder(row: OrderRow): Order {
  return {
    id: row.id,
    operationId: row.operation_id,
    operationName: row.operation_name,
    partitionId: row.partition_id,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    version: row.version,
    steps: JSON.parse(row.steps),
    deployConfig: JSON.parse(row.deploy_config),
    variables: JSON.parse(row.variables),
    createdAt: new Date(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// PersistentDeploymentStore
// ---------------------------------------------------------------------------

export class PersistentDeploymentStore {
  private stmts: {
    upsert: Database.Statement;
    getById: Database.Statement;
    getByPartition: Database.Statement;
    list: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT INTO deployments (id, operation_id, partition_id, environment_id, version, status, variables, debrief_entry_ids, order_id, created_at, completed_at, failure_reason)
         VALUES (@id, @operation_id, @partition_id, @environment_id, @version, @status, @variables, @debrief_entry_ids, @order_id, @created_at, @completed_at, @failure_reason)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           variables = excluded.variables,
           debrief_entry_ids = excluded.debrief_entry_ids,
           completed_at = excluded.completed_at,
           failure_reason = excluded.failure_reason`,
      ),
      getById: db.prepare(`SELECT * FROM deployments WHERE id = ?`),
      getByPartition: db.prepare(
        `SELECT * FROM deployments WHERE partition_id = ? ORDER BY created_at ASC`,
      ),
      list: db.prepare(`SELECT * FROM deployments ORDER BY created_at ASC`),
    };
  }

  save(deployment: Deployment): void {
    this.stmts.upsert.run({
      id: deployment.id,
      operation_id: deployment.operationId,
      partition_id: deployment.partitionId,
      environment_id: deployment.environmentId,
      version: deployment.version,
      status: deployment.status,
      variables: JSON.stringify(deployment.variables),
      debrief_entry_ids: JSON.stringify(deployment.debriefEntryIds),
      order_id: deployment.orderId,
      created_at: deployment.createdAt.toISOString(),
      completed_at: deployment.completedAt?.toISOString() ?? null,
      failure_reason: deployment.failureReason,
    });
  }

  get(id: DeploymentId): Deployment | undefined {
    const row = this.stmts.getById.get(id) as DeploymentRow | undefined;
    return row ? rowToDeployment(row) : undefined;
  }

  getByPartition(partitionId: string): Deployment[] {
    const rows = this.stmts.getByPartition.all(partitionId) as DeploymentRow[];
    return rows.map(rowToDeployment);
  }

  list(): Deployment[] {
    const rows = this.stmts.list.all() as DeploymentRow[];
    return rows.map(rowToDeployment);
  }
}

interface DeploymentRow {
  id: string;
  operation_id: string;
  partition_id: string;
  environment_id: string;
  version: string;
  status: string;
  variables: string;
  debrief_entry_ids: string;
  order_id: string | null;
  created_at: string;
  completed_at: string | null;
  failure_reason: string | null;
}

function rowToDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    operationId: row.operation_id,
    partitionId: row.partition_id,
    environmentId: row.environment_id,
    version: row.version,
    status: row.status as Deployment["status"],
    variables: JSON.parse(row.variables),
    debriefEntryIds: JSON.parse(row.debrief_entry_ids),
    orderId: row.order_id,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    failureReason: row.failure_reason,
  };
}

// ---------------------------------------------------------------------------
// PersistentSettingsStore
// ---------------------------------------------------------------------------

export class PersistentSettingsStore {
  private stmts: {
    get: Database.Statement;
    upsert: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare(`SELECT value FROM settings WHERE key = ?`),
      upsert: db.prepare(
        `INSERT INTO settings (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ),
    };

    // Seed defaults if no settings row exists
    const existing = this.stmts.get.get("app") as { value: string } | undefined;
    if (!existing) {
      this.stmts.upsert.run({
        key: "app",
        value: JSON.stringify(DEFAULT_APP_SETTINGS),
      });
    }
  }

  get(): AppSettings {
    const row = this.stmts.get.get("app") as { value: string } | undefined;
    return row ? JSON.parse(row.value) : structuredClone(DEFAULT_APP_SETTINGS);
  }

  update(partial: Partial<AppSettings>): AppSettings {
    const current = this.get();
    if (partial.environmentsEnabled !== undefined) {
      current.environmentsEnabled = partial.environmentsEnabled;
    }
    if (partial.agent) {
      current.agent = { ...current.agent, ...partial.agent };
    }
    if (partial.deploymentDefaults) {
      current.deploymentDefaults = {
        ...current.deploymentDefaults,
        ...partial.deploymentDefaults,
      };
    }
    if (partial.envoy) {
      current.envoy = { ...current.envoy, ...partial.envoy };
    }
    if ("coBranding" in partial) {
      current.coBranding = partial.coBranding ?? undefined;
    }
    if (partial.mcpServers !== undefined) {
      current.mcpServers = partial.mcpServers;
    }
    this.stmts.upsert.run({ key: "app", value: JSON.stringify(current) });
    return structuredClone(current);
  }
}
