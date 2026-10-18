export type RiskBand = "LOW" | "MEDIUM" | "HIGH";
export type CaseStatus = "OPEN" | "ESCALATED" | "DISMISSED" | "NEEDS_EVIDENCE";
export type DecisionValue = "ESCALATE_FOR_REVIEW" | "DISMISS_ALERT" | "REQUEST_MORE_EVIDENCE";

export interface Signal {
  code: string;
  label: string;
  weight: number;
  value: number;
  contribution: number;
  explanation: string;
  supporting_tx_ids: string[];
  params: Record<string, unknown>;
  context_only: boolean;
}

export interface Transaction {
  transaction_id: string;
  source_account: string;
  destination_account: string;
  amount: number;
  currency: string;
  timestamp: string;
  channel: string;
  device_id: string | null;
  description: string | null;
  reference?: string | null;
  source_name?: string | null;
  destination_name?: string | null;
  is_synthetic_added: number;
  score?: number | null;
  risk_band?: RiskBand | null;
  control_status?: ControlStatus | null;
}

/** What a mitigation control did to a transfer: stopped it (HELD, then RELEASED or REJECTED) or FLAGGED it. */
export type ControlStatus = "HELD" | "RELEASED" | "REJECTED" | "FLAGGED";

export interface TransferControl {
  transaction_id: string;
  action_id: number;
  case_id: string;
  account_id: string;
  control: string;
  status: ControlStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface ControlledTransfer extends TransferControl {
  amount: number;
  currency: string;
  timestamp: string;
  source_account: string;
  destination_account: string;
  source_name: string | null;
  destination_name: string | null;
}

export interface AccountControl {
  action_id: number;
  action_code: string;
  label: string;
  case_id: string;
  actor_label?: string;
  created_at: string;
  expires_at: string | null;
}

export interface CaseTransaction extends Transaction {
  signals: Signal[];
  uncertainties: string[];
}

export interface Baseline {
  account_id: string;
  available: boolean;
  prior_outgoing_count: number;
  median_amount?: number;
  p90_amount?: number;
}

export interface TransactionDetail {
  transaction: Transaction;
  accounts: Record<string, AccountInfo>;
  control: TransferControl | null;
  assessment: {
    score: number;
    risk_band: RiskBand;
    signals: Signal[];
    uncertainties: string[];
    baseline: Baseline;
    time_window_minutes: number;
    rule_version: string;
    analysis_id: string;
  } | null;
  cases: { case_id: string; title: string; status: CaseStatus; risk_score: number; risk_band: RiskBand }[];
  evidence_id: string;
  ground_truth: { scenario_id: string; label: string } | null;
  ground_truth_note: string;
}

export interface AccountInfo {
  account_id: string;
  account_type: string;
  created_at: string;
  holder_name: string | null;
  account_number: string | null;
  city: string | null;
  branch_code?: string | null;
  kyc_tier: string | null;
}

export interface AccountProfile {
  account: AccountInfo;
  summary: {
    outgoing_count: number;
    outgoing_total: number;
    incoming_count: number;
    incoming_total: number;
    first_activity: string | null;
    last_activity: string | null;
    max_score: number | null;
    devices: string[];
  };
  counterparties: { account_id: string; holder_name: string | null; transfers: number; total: number }[];
  controls: AccountControl[];
  cases: { case_id: string; title: string; status: CaseStatus; risk_score: number; risk_band: RiskBand }[];
  recent_transactions: Transaction[];
}

export interface SearchResults {
  query: string;
  cases: { case_id: string; title: string; status: CaseStatus; risk_score: number; risk_band: RiskBand }[];
  accounts: { account_id: string; holder_name: string | null; account_type: string; city: string | null; account_number: string | null }[];
  transactions: { transaction_id: string; reference: string | null; amount: number; currency: string; timestamp: string; source_account: string; destination_account: string; risk_band: RiskBand | null; score: number | null }[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface CaseSummary {
  case_id: string;
  title: string;
  status: CaseStatus;
  risk_score: number;
  risk_band: RiskBand;
  transaction_count: number;
  account_count: number;
  signal_codes: string[];
  rule_version: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  latest_decision: { decision: DecisionValue; created_at: string } | null;
  /** Review priority from the latest Gemini investigation, for the "second opinion" chip. */
  ai_priority?: RiskBand | null;
  total_amount: number;
  first_activity: string | null;
  last_activity: string | null;
  origin_account: string | null;
  origin_name: string | null;
}

export interface Evidence {
  case_id: string;
  evidence_id: string;
  source_type: "TRANSACTION" | "RULE_FINDING" | "GRAPH_PATH" | "BASELINE";
  source_id: string;
  description: string;
  timestamp: string | null;
  payload: Record<string, any>;
  sort_order: number;
}

export interface AuditEvent {
  event_id: number;
  case_id: string | null;
  event_type: string;
  actor_type: "SYSTEM" | "AI" | "HUMAN";
  event_payload: Record<string, any>;
  created_at: string;
}

/** One row of the workspace audit trail, with the title of its case (null for workspace-level events). */
export interface AuditLogEntry extends AuditEvent {
  title: string | null;
}

export interface AuditLog extends Paged<AuditLogEntry> {
  /** Filter options: cases with at least one audit event, most recently audited first. */
  cases: { case_id: string; title: string | null; events: number }[];
  workspace_events: number;
  /** The most recent AI safety check in this workspace, or null if none has been run. */
  last_guardrail_test: GuardrailRun | null;
}

export interface GuardrailRun {
  case_id: string;
  title: string | null;
  created_at: string;
  actor_label: string;
  attacks: number;
  stopped: number;
  all_passed: boolean;
  evidence_sent: number;
  failed_checks: string[];
}

export interface DecisionRecord {
  decision_id: number;
  case_id: string;
  decision: DecisionValue;
  rationale: string;
  actor_label: string;
  created_at: string;
}

export interface Validation {
  removed_ids: string[];
  removed_accounts?: string[];
  unsupported_claims: { section: string; text: string }[];
  total_citations: number;
  valid_citations: number;
  citation_validity: number | null;
  allowed_evidence_count: number;
}

export interface InvestigationResult {
  case_summary: string;
  observed_facts: { statement: string; evidence_ids: string[] }[];
  risk_indicators: { indicator: string; reasoning: string; evidence_ids: string[] }[];
  alternative_explanations: string[];
  uncertainties: string[];
  recommended_next_steps: string[];
  review_priority: RiskBand;
}

export interface ReportAction {
  action_code: string;
  target_account: string | null;
  rationale: string;
  evidence_ids: string[];
}

export interface CaseReport {
  headline: string;
  executive_summary: string;
  subject_accounts: { account_id: string; role: string; evidence_ids: string[] }[];
  chronology: { timestamp: string; event: string; evidence_ids: string[] }[];
  suspicious_indicators: { text: string; evidence_ids: string[] }[];
  mitigating_factors: string[];
  information_gaps: string[];
  recommended_actions: ReportAction[];
}

export interface SuggestedAction {
  action_code: string;
  label: string;
  target_account: string | null;
  rationale: string;
  basis: string[];
  source: "PLAYBOOK";
}

export interface ApprovedAction {
  action_id: number;
  case_id: string;
  action_code: string;
  target_account: string | null;
  note: string | null;
  source: "PLAYBOOK" | "AI" | "ANALYST";
  /** A control is ACTIVE until LIFTED; a task is OPEN until COMPLETED. */
  status: "ACTIVE" | "OPEN" | "LIFTED" | "COMPLETED";
  actor_label: string;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
  outcome: string | null;
  label: string;
  kind: ActionKind;
  queue: string | null;
  due_at: string | null;
  expires_at: string | null;
}

export type ActionKind = "CONTROL" | "TASK" | "RECORD";

export interface ActionCatalogItem {
  code: string;
  label: string;
  description: string;
  needs_target: boolean;
  kind: ActionKind;
  effect: string;
}

export interface DocumentRecord {
  document_id: number;
  case_id: string;
  transaction_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: "OK" | "UNAVAILABLE";
  verdict: "SUPPORTS" | "PARTIALLY_SUPPORTS" | "DOES_NOT_SUPPORT" | "UNREADABLE" | null;
  actor_label: string;
  created_at: string;
  response: {
    status: "OK" | "UNAVAILABLE";
    reason?: string;
    message?: string;
    model?: string;
    extraction?: {
      document_type: string;
      issuer_name: string;
      payer_name: string;
      payee_name: string;
      amount: number;
      currency: string;
      document_date: string;
      reference_numbers: string[];
      purpose: string;
      legibility: string;
      observations: string[];
      tamper_indicators: string[];
      regions?: { label: string; kind: "FIELD" | "ANOMALY"; box_2d: [number, number, number, number] }[];
    };
    checks?: { check: string; result: "MATCH" | "PARTIAL" | "MISMATCH" | "NOT_FOUND"; document: string; record: string; note: string }[];
    verdict_before_cross_check?: string;
    second_reader?: SecondReader;
  };
}

/** Document AI read the same file independently; fields are compared with Gemini's reading in code. */
export interface SecondReader {
  status: "OK" | "UNAVAILABLE";
  reader: string;
  processor?: string;
  detail?: string;
  note?: string | null;
  agreed?: number;
  disagreed?: number;
  fields?: { field: string; gemini: string; document_ai: string; agreement: "AGREE" | "DISAGREE" | "ONLY_GEMINI" | "ONLY_DOCUMENT_AI" | "NEITHER" }[];
}

export interface CloudService {
  key: string;
  name: string;
  enabled: boolean;
  detail: string | null;
  state?: Record<string, any>;
}

export interface CloudStatus {
  project: string | null;
  services: CloudService[];
}

export interface StreamEvent {
  message_id: string;
  transaction_id: string | null;
  status: string;
  detail: string | null;
  published_at: string | null;
  processed_at: string;
  latency_ms: number | null;
  score: number | null;
  risk_band: RiskBand | null;
}

export interface BigQueryAskResult {
  question: string;
  interpretation: string;
  columns: string[];
  rows: Record<string, any>[];
  row_count: number;
  chart: "BAR" | "LINE" | "TABLE";
  x_column: string;
  y_column: string;
  answer: string;
  answer_source: "GEMINI" | "SYSTEM";
  bytes_estimated: number;
  bytes_billed: number;
  /** How many times the generated query was rejected and rewritten before it passed the checks. */
  repairs: number;
}

export interface MlFeature {
  feature: string;
  label: string;
  attribution: number;
}

export interface MlInfo {
  enabled: boolean;
  state: "NOT_TRAINED" | "TRAINING" | "TRAINED" | "FAILED";
  error: string | null;
  trained_at: string | null;
  metrics: Record<string, number | null> | null;
  global_explain: MlFeature[] | null;
  scored: number;
  scored_at: string | null;
  model: string | null;
}

export interface CaseMlTransfer {
  transaction_id: string;
  rule_score: number | null;
  probability: number;
  top_features: MlFeature[];
  scored_at: string;
}

export interface CaseMl {
  enabled: boolean;
  case_id: string;
  case_rule_score: number;
  agreement: "AGREE" | "MODEL_HIGHER" | "RULES_HIGHER" | null;
  top: CaseMlTransfer | null;
  transfers: CaseMlTransfer[];
}

export interface GuardrailCheck {
  key: string;
  title: string;
  attack: string;
  outcome: "BLOCKED" | "CONTAINED" | "PASSED" | "FAILED";
  detail: string;
}

export interface GuardrailTest {
  case_id: string;
  evidence_sent: number;
  attacks: number;
  stopped: number;
  all_passed: boolean;
  model_called: boolean;
  checks: GuardrailCheck[];
}

export interface PolicyResult {
  query: string;
  passages: { id: string; title: string; link: string; text: string }[];
  summary: string;
  steps: { step: string; citations: string[] }[];
}

export interface SimilarMatch {
  archive_id: string;
  title: string;
  pattern: string;
  similarity: number;
  outcome: "CONFIRMED_FRAUD" | "LEGITIMATE" | "INCONCLUSIVE";
  outcome_label: string;
  resolution: string;
  days_to_resolve: number;
  actions_taken: string[];
  shared_signals: { code: string; label: string }[];
}

export interface SimilarCasesResult {
  case_id: string;
  method: "GEMINI_EMBEDDINGS" | "SIGNAL_OVERLAP";
  model: string | null;
  fallback_reason: string | null;
  case_description: string;
  archive_size: number;
  matches: SimilarMatch[];
  counter_example: SimilarMatch | null;
  scoring: string;
  outcome_summary: Record<string, number>;
  note: string;
}

export interface ChatResult {
  answer: string;
  evidence_ids: string[];
  grounded: boolean;
}

export type AiState = "CONNECTED" | "DEGRADED" | "INVALID_KEY" | "UNREACHABLE" | "NOT_CONFIGURED";

export interface AiStatus {
  state: AiState;
  configured: boolean;
  connected: boolean;
  key_valid: boolean | null;
  key_format_ok: boolean | null;
  category: string;
  message: string;
  detail: string | null;
  model: string;
  backend?: string;
  model_chain: string[];
  active_model: string | null;
  attempts: { model: string; ok: boolean; category: string; detail: string | null; seconds: number }[];
  checked_at: string | null;
  cached: boolean;
}

export interface AIResponse<T> {
  status: "OK" | "UNAVAILABLE";
  reason?: string;
  message?: string;
  detail?: string | null;
  model?: string;
  prompt_version: string;
  result?: T;
  validation?: Validation;
}

export interface AIRecord<T> {
  investigation_id: number;
  created_at: string;
  kind: "INVESTIGATION" | "CHAT" | "REPORT";
  question: string | null;
  response: AIResponse<T>;
  /** Investigation only: the case's evidence changed after Gemini read it. */
  stale?: boolean;
}

/** Response of the AI features beyond the investigation. source RULES = rule-based (Gemini not asked or unavailable). */
export interface InsightResponse<T> {
  status: "OK" | "UNAVAILABLE";
  source: "GEMINI" | "RULES" | null;
  model: string | null;
  prompt_version: string;
  result?: T;
  validation?: { removed_ids: string[]; removed_sentences?: string[]; unsupported_claims?: { section: string; text: string }[] };
  fallback_reason?: string | null;
  reason?: string;
  message?: string | null;
  detail?: string | null;
}

export interface Insight<T> {
  insight_id: number | null;
  scope: string;
  kind: string;
  created_at: string;
  stale: boolean;
  request: Record<string, any>;
  response: InsightResponse<T>;
}

export interface BriefingResult {
  headline: string;
  summary: string;
  highlights: { text: string; case_ids: string[] }[];
  next_actions: { case_id: string; action: string; reason: string }[];
}

export interface PatternCluster {
  pattern_id: string;
  case_ids: string[];
  size: number;
  name: string;
  summary: string;
  watch_for: string;
  common_signal_labels: string[];
  amount_text: string;
  total_amount: number;
  accounts: number;
  highest_band: RiskBand;
  shared_accounts: string[];
  shared_devices: string[];
  named_by?: "GEMINI";
}

export interface PatternsResult {
  overview: string;
  method: "GEMINI_EMBEDDINGS" | "SIGNAL_OVERLAP";
  case_count: number;
  patterns: PatternCluster[];
}

export interface DayExplanationResult {
  headline: string;
  explanation: string;
  drivers: { text: string; case_ids: string[] }[];
  facts: { day: string; transfers: number; flagged: number; flagged_amount_text: string; median_flagged_per_day: number; flagged_vs_median: number | null; peak_hour_utc: string | null };
}

export interface QueryPlan {
  target: "TRANSFERS" | "CASES" | "ACCOUNTS";
  min_amount: number;
  max_amount: number;
  channels: string[];
  risk_bands: RiskBand[];
  case_statuses: CaseStatus[];
  signal_codes: string[];
  account_ids: string[];
  flagged_only: boolean;
  new_account_days: number;
  min_kyc_only: boolean;
  account_side: "ANY" | "SENDER" | "RECEIVER";
  date_from: string;
  date_to: string;
  sort: string;
  limit: number;
}

export interface AskResult {
  question: string;
  plan: QueryPlan;
  interpretation: string;
  plan_summary: string;
  unsupported: string;
  rows: Record<string, any>[];
  total: number;
  total_amount: number;
}

export interface TuningSuggestion {
  parameter: string;
  current_value: number;
  proposed_value: number;
  rationale: string;
  rule: string;
  rule_label: string;
  meaning: string;
  impact: {
    flagged_before: number;
    flagged_after: number;
    cases_before: number;
    cases_after: number;
    dismissed_cases_cleared: string[];
    escalated_cases_lost: string[];
    open_cases_cleared: string[];
  };
}

export interface RuleTuningResult {
  summary: string;
  suggestions: TuningSuggestion[];
  decided_cases: number;
  signals: { code: string; label: string; flagged_transfers: number; decided_cases: number; escalated: number; dismissed: number; needs_evidence: number }[];
  applied: false;
  note: string;
}

export interface NarrationResult {
  overview: string;
  takeaway: string;
  steps: { step: number; transaction_id: string; caption: string }[];
}

export interface CounterfactualResult {
  summary: string;
  points: { text: string; transaction_ids: string[] }[];
  facts: {
    current_score: number;
    current_band: RiskBand;
    queue_threshold: number;
    remove_one_transfer: { step: number; transaction_id: string; from: string; to: string; amount_text: string; score_without: number; band_without: RiskBand; change: number; would_leave_queue: boolean }[];
    turn_off_one_rule: { code: string; label: string; context_only: boolean; score_without: number; band_without: RiskBand; change: number }[];
  };
}

export type LanguageCode = "en" | "hi" | "gu" | "mr" | "ta" | "te" | "bn" | "kn";

export interface ContactScriptResult {
  opening: string;
  verification_questions: string[];
  if_confirmed: string;
  if_not_recognised: string;
  closing: string;
  sms_text: string;
  language: LanguageCode;
  requested_language: LanguageCode;
  compliance_notes: string[];
  account_id: string;
  channel: "CALL" | "SMS" | "EMAIL";
}

export interface StrDraftResult {
  report_reference: string;
  reporting_entity: string;
  period: { from: string | null; to: string | null };
  total_amount: number;
  subjects: { account_id: string; holder_name: string | null; account_number: string | null; account_type: string | null; kyc_tier: string | null; city: string | null; opened: string | null; sent: number; received: number }[];
  transactions: { transaction_id: string; timestamp: string; from: string; to: string; amount: number; currency: string; channel: string; reference: string | null; score: number | null }[];
  actions_taken: { label: string; target_account: string | null; status: string; approved_by: string; approved_at: string }[];
  analyst_decision: { decision: DecisionValue; rationale: string; by: string; at: string } | null;
  summary_of_suspicion: string;
  grounds: { text: string; evidence_ids: string[] }[];
  red_flags: string[];
  red_flag_labels: Record<string, string>;
  sequence_of_events: { text: string; evidence_ids: string[] }[];
  information_gaps: string[];
  draft_note: string;
}

export interface TranslationResult {
  summary: string;
  key_points: string[];
  next_steps: string[];
  language: LanguageCode;
}

export interface CaseDetail {
  case: CaseSummary & { transaction_ids: string[]; accounts: string[]; analysis_id: string };
  ai_extras: Partial<{
    NARRATION: Insight<NarrationResult>;
    COUNTERFACTUAL: Insight<CounterfactualResult>;
    CONTACT_SCRIPT: Insight<ContactScriptResult>;
    STR_DRAFT: Insight<StrDraftResult>;
    TRANSLATION: Insight<TranslationResult>;
  }>;
  suggested_contact_account: string | null;
  accounts: Record<string, AccountInfo>;
  transactions: CaseTransaction[];
  signal_summary: {
    code: string;
    label: string;
    weight: number;
    context_only: boolean;
    transactions: number;
    max_contribution: number;
  }[];
  uncertainties: string[];
  evidence: Evidence[];
  decisions: DecisionRecord[];
  audit_events: AuditEvent[];
  latest_investigation: AIRecord<InvestigationResult> | null;
  latest_report: AIRecord<CaseReport> | null;
  suggested_actions: SuggestedAction[];
  actions: ApprovedAction[];
  controlled_transfers: ControlledTransfer[];
  account_controls: Record<string, AccountControl[]>;
  action_catalog: ActionCatalogItem[];
  documents: DocumentRecord[];
  chat_history: AIRecord<ChatResult>[];
  ground_truth: { scenario_id: string; label: string; n: number }[];
  ground_truth_note: string;
}

export interface GraphNode {
  id: string;
  holder_name: string | null;
  city: string | null;
  kyc_tier: string | null;
  account_type: string | null;
  created_at: string | null;
  in_focus: boolean;
  max_score: number | null;
  in_degree: number;
  out_degree: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  amount: number;
  currency: string | null;
  timestamp: string;
  channel: string | null;
  score: number | null;
  risk_band: RiskBand | null;
  in_focus: boolean;
  is_synthetic_added: boolean;
}

export interface GraphPath {
  evidence_id?: string;
  transaction_ids: string[];
  accounts: string[];
  start: string;
  end: string;
  duration_minutes: number;
}

export interface GraphData {
  scope: Record<string, unknown>;
  time_window_minutes: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: GraphPath[];
}

export interface Dashboard {
  dataset_version: string | null;
  reset_at: string | null;
  totals: {
    transactions: number;
    accounts: number;
    synthetic_added: number;
    cases: number;
    open_cases: number;
    reviewed_cases: number;
    decisions: number;
    flagged_transactions: number;
    flagged_amount: number;
    total_volume: number;
  };
  activity_by_day: { day: string; transactions: number; volume: number; flagged: number; flagged_amount: number }[];
  by_channel: { channel: string; transfers: number; flagged: number; flagged_amount: number }[];
  top_accounts: {
    account_id: string;
    holder_name: string | null;
    account_type: string | null;
    city: string | null;
    kyc_tier: string | null;
    flagged_transfers: number;
    flagged_amount: number;
    max_score: number;
  }[];
  ai: {
    answered: number;
    unavailable: number;
    citations_total: number;
    citations_valid: number;
    references_removed: number;
    investigations: number;
    reports: number;
    follow_ups: number;
    documents_checked: number;
    documents_by_verdict: Record<string, number>;
  };
  pipeline: { stage: string; value: number }[];
  mitigation: {
    accounts_on_hold: number;
    accounts_monitored: number;
    held: { count: number; amount: number };
    rejected: { count: number; amount: number };
    released: { count: number; amount: number };
    flagged: { count: number; amount: number };
    tasks_open: number;
    tasks_completed: number;
  };
  actions_approved: number;
  top_signals: { code: string; label: string; count: number }[];
  recent_activity: (AuditEvent & { title: string | null })[];
  transactions_by_band: Record<RiskBand, number>;
  cases_by_band: Record<RiskBand, number>;
  cases_by_status: Record<string, number>;
  recent_cases: (Pick<CaseSummary, "case_id" | "title" | "status" | "risk_score" | "risk_band" | "updated_at" | "signal_codes"> & {
    transaction_count: number;
    account_count: number;
    total_amount: number;
    first_activity: string | null;
    origin_name: string | null;
    ai_priority: RiskBand | null;
  })[];
  last_analysis: {
    analysis_id: string;
    params: { time_window_minutes: number; scenario_id: string | null };
    transactions_analyzed: number;
    rule_version: string;
    created_at: string;
  } | null;
}

export type RecommendationKind =
  | "OVERDUE_TASK"
  | "TASK_DUE_SOON"
  | "HELD_TRANSFERS"
  | "FOLLOW_UP"
  | "SIMILAR_TO_ESCALATED"
  | "HIGH_RISK_UNREVIEWED";

export interface Recommendation {
  kind: RecommendationKind;
  case_id: string;
  title: string;
  reason: string;
  risk_score: number;
  risk_band: RiskBand;
  account_id?: string | null;
  due_at?: string;
  queue?: string | null;
  count?: number;
  amount?: number;
  similar_case_id?: string;
}

export interface Recommendations {
  personalized: boolean;
  analyst: string | null;
  items: Recommendation[];
}

export interface Health {
  status: string;
  app_version: string;
  dataset_version: string | null;
  data_loaded: boolean;
  rule_version: string;
  prompt_version: string;
  gemini_configured: boolean;
  gemini_model: string;
  gemini_backend: string | null;
  demo_token_required: boolean;
}

export interface AnalysisDiff {
  first_run: boolean;
  new_cases: { case_id: string; title: string; risk_score: number; risk_band: RiskBand }[];
  updated_cases: {
    case_id: string;
    title: string;
    score_before: number;
    score_after: number;
    band_before: RiskBand;
    band_after: RiskBand;
    added_transaction_ids: string[];
  }[];
  deactivated_cases: string[];
  new_transactions: string[];
  changed_transactions: {
    transaction_id: string;
    score_before: number | null;
    score_after: number;
    band_before: RiskBand | null;
    band_after: RiskBand;
    added_signals: string[];
    removed_signals: string[];
  }[];
  changed_transactions_total: number;
}

export interface AnalysisRun {
  analysis_id: string;
  rule_version: string;
  time_window_minutes: number;
  transactions_analyzed: number;
  cases_created: number;
  active_cases: number;
  focus_case_ids: string[];
  diff: AnalysisDiff;
}

export interface Scenario {
  scenario_id: string;
  label: string;
  title: string;
  description: string;
  transaction_ids: string[];
  case_ids: string[];
}

export interface SuggestedWhatIf {
  label: string;
  source_account: string;
  destination_account: string;
  amount: number;
  timestamp: string;
  channel: string;
  description: string;
}

export interface RulesInfo {
  rule_version: string;
  bands: Record<RiskBand, number>;
  case_min_score: number;
  rules: { code: string; weight: number; rule: string }[];
  note: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: unknown[] = []) {
    super(message);
  }
}

const TOKEN_KEY = "fraudgraph.demoToken";

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable: token used for this request only */
  }
}

async function request<T>(method: string, path: string, body?: unknown, retry = true, token?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const demoToken = token ?? readToken();
  if (demoToken) headers["X-Demo-Token"] = demoToken;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data?.error;
    if (res.status === 401 && err?.code === "DEMO_TOKEN_REQUIRED" && retry) {
      const entered = window.prompt("This administrative action needs the workspace access token:");
      if (entered) {
        storeToken(entered);
        return request<T>(method, path, body, false, entered);
      }
    }
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Request failed (${res.status}).`, err?.details ?? []);
  }
  return data as T;
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const api = {
  health: () => request<Health>("GET", "/api/health"),
  aiStatus: (refresh = false) => request<AiStatus>("GET", `/api/ai/status${refresh ? "?refresh=true" : ""}`),
  rules: () => request<RulesInfo>("GET", "/api/rules"),
  dashboard: () => request<Dashboard>("GET", "/api/dashboard"),
  recommendations: (analyst: string) => request<Recommendations>("GET", `/api/recommendations${qs({ analyst })}`),
  reset: () => request<{ dataset_version: string; transactions: number; accounts: number; message: string }>("POST", "/api/demo/reset"),
  scenarios: () => request<{ scenarios: Scenario[]; suggested_what_if: SuggestedWhatIf | null }>("GET", "/api/demo/scenarios"),
  runAnalysis: (body: { scenario_id?: string; time_window_minutes?: number } = {}) =>
    request<AnalysisRun>("POST", "/api/analysis/run", body),
  transactions: (params: Record<string, string | number | boolean | undefined>) =>
    request<Paged<Transaction>>("GET", `/api/transactions${qs(params)}`),
  account: (id: string) => request<AccountProfile>("GET", `/api/accounts/${encodeURIComponent(id)}`),
  search: (q: string) => request<SearchResults>("GET", `/api/search${qs({ q })}`),
  transaction: (id: string) => request<TransactionDetail>("GET", `/api/transactions/${encodeURIComponent(id)}`),
  addSyntheticTransaction: (body: Record<string, unknown>) =>
    request<TransactionDetail & { created_accounts: string[]; message: string }>("POST", "/api/transactions/demo", body),
  cases: (params: Record<string, string | undefined>) => request<{ items: CaseSummary[]; total: number }>("GET", `/api/cases${qs(params)}`),
  case: (id: string) => request<CaseDetail>("GET", `/api/cases/${encodeURIComponent(id)}`),
  audit: (params: { case_id?: string; page?: number; page_size?: number }) => request<AuditLog>("GET", `/api/audit${qs(params)}`),
  graph: (params: { case_id?: string; account_id?: string; time_window_minutes?: number }) =>
    request<GraphData>("GET", `/api/graph${qs(params)}`),
  investigate: (id: string, question?: string) =>
    request<AIRecord<InvestigationResult>>("POST", `/api/cases/${encodeURIComponent(id)}/investigate`, question ? { question } : {}),
  chat: (id: string, message: string) => request<AIRecord<ChatResult>>("POST", `/api/cases/${encodeURIComponent(id)}/chat`, { message }),
  verifyDocument: (id: string, body: { filename: string; mime_type: string; data_base64: string; transaction_id: string; actor_label?: string }) =>
    request<DocumentRecord>("POST", `/api/cases/${encodeURIComponent(id)}/documents`, body),
  similarCases: (id: string) => request<SimilarCasesResult>("GET", `/api/cases/${encodeURIComponent(id)}/similar`),
  draftReport: (id: string) => request<AIRecord<CaseReport>>("POST", `/api/cases/${encodeURIComponent(id)}/report`),
  approveAction: (id: string, body: { action_code: string; target_account?: string | null; note?: string; source: "PLAYBOOK" | "AI" | "ANALYST"; actor_label?: string }) =>
    request<{ action: ApprovedAction; effect: string }>("POST", `/api/cases/${encodeURIComponent(id)}/actions`, body),
  closeAction: (id: string, actionId: number, body: { outcome: string; actor_label?: string }) =>
    request<{ action: ApprovedAction }>("POST", `/api/cases/${encodeURIComponent(id)}/actions/${actionId}/close`, body),
  resolveHeldTransfer: (id: string, transactionId: string, body: { resolution: "RELEASE" | "REJECT"; note: string; actor_label?: string }) =>
    request<{ transfer: TransferControl }>("POST", `/api/cases/${encodeURIComponent(id)}/held-transfers/${encodeURIComponent(transactionId)}`, body),
  decide: (id: string, body: { decision: DecisionValue; rationale: string; actor_label?: string }) =>
    request<{ decision: DecisionRecord; case_status: CaseStatus }>("POST", `/api/cases/${encodeURIComponent(id)}/decision`, body),
  // Workspace AI
  briefing: () => request<Insight<BriefingResult>>("GET", "/api/ai/briefing"),
  makeBriefing: () => request<Insight<BriefingResult>>("POST", "/api/ai/briefing"),
  patterns: () => request<Insight<PatternsResult>>("GET", "/api/ai/patterns"),
  makePatterns: () => request<Insight<PatternsResult>>("POST", "/api/ai/patterns"),
  explainDay: (day: string, refresh = false) => request<Insight<DayExplanationResult>>("POST", "/api/ai/explain-day", { day, refresh }),
  askPortfolio: (question: string) => request<Insight<AskResult>>("POST", "/api/ai/ask", { question }),
  ruleTuning: () => request<Insight<RuleTuningResult>>("GET", "/api/ai/rule-tuning"),
  makeRuleTuning: () => request<Insight<RuleTuningResult>>("POST", "/api/ai/rule-tuning"),
  // Case assistants
  narrate: (id: string) => request<Insight<NarrationResult>>("POST", `/api/cases/${encodeURIComponent(id)}/narrate`),
  guardrailTest: (id: string, body: { actor_label?: string }) =>
    request<GuardrailTest>("POST", `/api/cases/${encodeURIComponent(id)}/guardrail-test`, body),
  counterfactual: (id: string) => request<Insight<CounterfactualResult>>("POST", `/api/cases/${encodeURIComponent(id)}/counterfactual`),
  contactScript: (id: string, body: { account_id: string; channel: string; language: LanguageCode }) =>
    request<Insight<ContactScriptResult>>("POST", `/api/cases/${encodeURIComponent(id)}/contact-script`, body),
  strDraft: (id: string) => request<Insight<StrDraftResult>>("POST", `/api/cases/${encodeURIComponent(id)}/str`),
  // Google Cloud
  cloudStatus: () => request<CloudStatus>("GET", "/api/cloud/status"),
  streamPublish: (body: Record<string, unknown>) =>
    request<{ status: string; message_id: string; transaction_id: string; topic: string }>("POST", "/api/cloud/stream/publish", body),
  streamEvents: (limit = 20) => request<{ enabled: boolean; events: StreamEvent[] }>("GET", `/api/cloud/stream/events${qs({ limit })}`),
  askBigQuery: (question: string) => request<Insight<BigQueryAskResult>>("POST", "/api/cloud/bigquery/ask", { question }),
  syncBigQuery: () => request<Record<string, any>>("POST", "/api/cloud/bigquery/sync"),
  mlInfo: () => request<MlInfo>("GET", "/api/cloud/ml"),
  trainMl: () => request<{ state: string }>("POST", "/api/cloud/ml/train"),
  caseMl: (id: string) => request<CaseMl>("GET", `/api/cases/${encodeURIComponent(id)}/ml`),
  casePolicy: (id: string) => request<Insight<PolicyResult> | null>("GET", `/api/cases/${encodeURIComponent(id)}/policy`),
  makeCasePolicy: (id: string) => request<Insight<PolicyResult>>("POST", `/api/cases/${encodeURIComponent(id)}/policy`),
  translate: (id: string, language: LanguageCode) =>
    request<Insight<TranslationResult>>("POST", `/api/cases/${encodeURIComponent(id)}/translate`, { language }),
};
