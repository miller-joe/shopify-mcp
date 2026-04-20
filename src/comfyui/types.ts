export interface PromptSubmitResponse {
  prompt_id: string;
  number: number;
  node_errors?: Record<string, unknown>;
}

export interface HistoryEntry {
  prompt: unknown;
  outputs: Record<
    string,
    { images?: Array<{ filename: string; subfolder: string; type: string }> }
  >;
  status?: { status_str: string; completed: boolean; messages: unknown[] };
}

export interface WorkflowNode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: Record<string, unknown>;
}

export type Workflow = Record<string, WorkflowNode>;
