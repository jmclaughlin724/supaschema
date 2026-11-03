import type { SupaschemaConfig } from "./config/schema.js";

export type DiagnosticSeverity = "info" | "warning" | "error";

export type ObjectKind =
  | "schema"
  | "extension"
  | "type"
  | "domain"
  | "enum"
  | "sequence"
  | "table"
  | "foreign-data-wrapper"
  | "foreign-server"
  | "foreign-table"
  | "constraint"
  | "index"
  | "function"
  | "procedure"
  | "view"
  | "materialized-view"
  | "trigger"
  | "rls"
  | "policy"
  | "grant"
  | "default-privilege"
  | "comment";

export interface ObjectRef {
  kind: ObjectKind;
  name: string;
  schema?: string;
  signature?: string;
  table?: string;
}

export type CommentTargetKind =
  | "column"
  | "constraint"
  | "domain"
  | "extension"
  | "foreign-table"
  | "function"
  | "index"
  | "materialized-view"
  | "policy"
  | "procedure"
  | "schema"
  | "sequence"
  | "table"
  | "trigger"
  | "type"
  | "view";

export interface CommentTarget {
  kind: CommentTargetKind;
  name: string;
  schema?: string;
  signature?: string;
  table?: string;
}

export interface Diagnostic {
  code: string;
  file?: string;
  hint?: string;
  message: string;
  ref?: ObjectRef;

  schemas?: string[];
  severity: DiagnosticSeverity;
  statement?: string;
}

export interface SchemaObject {
  dependencies: string[];
  file?: string;
  hash: string;
  key: string;
  metadata: Record<string, unknown>;
  normalizedSql: string;
  ordinal: number;
  ref: ObjectRef;
  sql: string;
}

export interface SchemaModel {
  declaredRoutineRevokes?: SchemaObject[];
  diagnostics: Diagnostic[];
  fingerprint: string;
  formatVersion?: number;
  objects: SchemaObject[];
  source: string;
}

export type MigrationOperationKind = "alter" | "create" | "replace" | "drop" | "rename";

export interface MigrationOperation {
  after?: SchemaObject;
  before?: SchemaObject;
  blocked: boolean;
  destructive: boolean;
  diagnostics: Diagnostic[];
  key: string;
  kind: MigrationOperationKind;
  metadata: Record<string, unknown>;
  ref: ObjectRef;
}

export interface MigrationPlan {
  diagnostics: Diagnostic[];
  fingerprint: string;
  from: string;

  fromFingerprint: string;
  operations: MigrationOperation[];
  to: string;

  toFingerprint: string;
}

export interface ExtractOptions {
  config?: Partial<SupaschemaConfig>;
  cwd?: string;
  excludeMigrationFiles?: readonly string[];
}

export interface RenderOptions {
  config?: Partial<SupaschemaConfig>;
  includeHeader?: boolean;
  version?: string;
}

export interface CheckOptions {
  config?: Partial<SupaschemaConfig>;
  cwd?: string;
  parse?: boolean;
}

export interface VerifyMigrationOptions {
  config?: Partial<SupaschemaConfig>;
  cwd?: string;
  databaseUrl: string;

  ensureEnvironment?: boolean;

  ensureRoles?: boolean;
  from: string;

  keepDatabases?: boolean;
  migrationPath: string;
  to: string;
}

export type { TableColumn } from "./sql/table-shape.js";
export type MigrationCorpusOperationKind =
  | "constraint"
  | "data-statement"
  | "do-block"
  | "drop"
  | "enum-rewrite"
  | "index"
  | "routine"
  | "table-column-default"
  | "table-column-drop"
  | "table-column-generated"
  | "table-column-identity"
  | "table-column-type";

export interface MigrationCorpusOperation {
  file: string;
  key?: string;
  kind: MigrationCorpusOperationKind;
  statementTag: string;
}

export interface MigrationCorpus {
  destructiveKeys: string[];
  diagnostics: Diagnostic[];
  operations: MigrationCorpusOperation[];
  tableColumnDrops: string[];
}

export interface MigrationBaselineProof {
  file: string;
  fingerprint: string;
  modelFormatVersion?: number;
  source: string;
  version?: string;
}

export interface MigrationContext {
  corpus: MigrationCorpus;
  directory: string;
  files: string[];
  latestGeneratedBaseline?: MigrationBaselineProof;
  unprovenBaselineFiles: string[];
}

export interface RenameHint {
  from: string;
  to: string;
}

export interface SupaschemaHints {
  allowedGrantees?: string[];
  destructive?: string[];
  renames?: RenameHint[];
  requiredPolicyColumns?: Record<string, string[]>;
}

export type { SupaschemaConfig } from "./config/schema.js";
