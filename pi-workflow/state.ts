export type WorkflowRole =
  | "planner"
  | "scout"
  | "executor"
  | "reviewer";

export interface ModelRef {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
}

export type PlanStatus =
  | "active"
  | "partial"
  | "superseded"
  | "abandoned";

export interface PlanRecord {
  id: number;

  title: string;

  /** Assistant entry holding the plan text. */
  planEntryId: string;

  status: PlanStatus;

  createdAt: number;

  /** Set when this plan was produced by revising an earlier one. */
  revisedFromId?: number;

  /**
   * True once an implementation turn was dispatched for
   * this plan. Used to decide "partial" vs "superseded"
   * when a newer plan demotes it.
   */
  dispatched?: boolean;
}

export interface WorkflowState {
  version: 1;

  /**
   * A role only exists here when explicitly configured.
   *
   * Missing role = preserve Pi's currently selected model.
   */
  models: Partial<Record<WorkflowRole, ModelRef>>;

  /** Plans recorded in this session (newest last). */
  plans?: PlanRecord[];

  /** Next sequential plan id. */
  nextPlanId?: number;
}

export function createInitialState(): WorkflowState {
  return {
    version: 1,
    models: {},
  };
}
