from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class Decision(str, Enum):
    ESCALATE_FOR_REVIEW = "ESCALATE_FOR_REVIEW"
    DISMISS_ALERT = "DISMISS_ALERT"
    REQUEST_MORE_EVIDENCE = "REQUEST_MORE_EVIDENCE"


DECISION_TO_STATUS = {
    Decision.ESCALATE_FOR_REVIEW: "ESCALATED",
    Decision.DISMISS_ALERT: "DISMISSED",
    Decision.REQUEST_MORE_EVIDENCE: "NEEDS_EVIDENCE",
}

CHANNELS = ("UPI", "IMPS", "NEFT", "CARD", "WALLET")


# ---- Requests ----

class AnalysisRunRequest(BaseModel):
    scenario_id: str | None = Field(default=None, max_length=64, pattern=r"^[a-z0-9-]+$")
    time_window_minutes: int = Field(default=60, ge=10, le=1440)


class DecisionRequest(BaseModel):
    decision: Decision
    rationale: str = Field(min_length=5, max_length=2000)
    actor_label: str | None = Field(default=None, max_length=60, pattern=r"^[A-Za-z0-9 _.\-]+$")


class GuardrailTestRequest(BaseModel):
    actor_label: str | None = Field(default=None, max_length=60, pattern=r"^[A-Za-z0-9 _.\-]+$")


class InvestigateRequest(BaseModel):
    question: str | None = Field(default=None, max_length=500)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=500)


class DemoTransactionRequest(BaseModel):
    transaction_id: str | None = Field(default=None, pattern=r"^TX-D\d{3,6}$")
    source_account: str = Field(pattern=r"^AC-\d{3,4}$")
    destination_account: str = Field(pattern=r"^AC-\d{3,4}$")
    amount: float = Field(gt=0, le=10_000_000)
    timestamp: datetime | None = None
    channel: Literal["UPI", "IMPS", "NEFT", "CARD", "WALLET"] = "IMPS"
    device_id: str | None = Field(default=None, pattern=r"^DEV-[A-Z0-9-]{1,20}$")
    description: str | None = Field(default=None, max_length=300)


# ---- Gemini structured output (BRD 11.2) ----

class ObservedFact(BaseModel):
    statement: str
    evidence_ids: list[str]


class RiskIndicator(BaseModel):
    indicator: str
    reasoning: str
    evidence_ids: list[str]


class InvestigationResult(BaseModel):
    case_summary: str
    observed_facts: list[ObservedFact]
    risk_indicators: list[RiskIndicator]
    alternative_explanations: list[str]
    uncertainties: list[str]
    recommended_next_steps: list[str]
    review_priority: Literal["LOW", "MEDIUM", "HIGH"]


class ChatAnswer(BaseModel):
    answer: str
    evidence_ids: list[str]


# ---- Escalation report (AI-drafted, human-approved) ----

ActionCode = Literal[
    "HOLD_FOR_REVIEW", "REQUEST_CUSTOMER_VERIFICATION", "REQUEST_SOURCE_OF_FUNDS", "KYC_REFRESH",
    "ENHANCED_MONITORING", "NOTIFY_COUNTERPARTY_INSTITUTION", "FILE_INTERNAL_SUSPICION_REPORT", "NO_ACTION",
]


class ReportAccount(BaseModel):
    account_id: str
    role: str
    evidence_ids: list[str]


class ReportEvent(BaseModel):
    timestamp: str
    event: str
    evidence_ids: list[str]


class ReportIndicator(BaseModel):
    text: str
    evidence_ids: list[str]


class ReportAction(BaseModel):
    action_code: ActionCode
    target_account: str  # an account ID from the case, or "" for a case-level action
    rationale: str
    evidence_ids: list[str]


class CaseReport(BaseModel):
    headline: str
    executive_summary: str
    subject_accounts: list[ReportAccount]
    chronology: list[ReportEvent]
    suspicious_indicators: list[ReportIndicator]
    mitigating_factors: list[str]
    information_gaps: list[str]
    recommended_actions: list[ReportAction]


class DocumentRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=120)
    mime_type: Literal["image/png", "image/jpeg", "image/webp", "application/pdf"]
    data_base64: str = Field(min_length=8, max_length=5_700_000)  # ~4 MB of file content
    transaction_id: str = Field(pattern=r"^TX-[A-Z0-9]{1,12}$")
    actor_label: str | None = Field(default=None, max_length=60, pattern=r"^[A-Za-z0-9 _.\-]+$")


class ActionRequest(BaseModel):
    action_code: ActionCode
    target_account: str | None = Field(default=None, pattern=r"^AC-\d{3,4}$")
    note: str | None = Field(default=None, max_length=500)
    source: Literal["PLAYBOOK", "AI", "ANALYST"] = "ANALYST"
    actor_label: str | None = Field(default=None, max_length=60, pattern=r"^[A-Za-z0-9 _.\-]+$")


class CloseActionRequest(BaseModel):
    outcome: str = Field(min_length=5, max_length=500)
    actor_label: str | None = Field(default=None, max_length=60, pattern=r"^[A-Za-z0-9 _.\-]+$")


LanguageCode = Literal["en", "hi", "gu", "mr", "ta", "te", "bn", "kn"]


class ExplainDayRequest(BaseModel):
    day: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    refresh: bool = False


class AskRequest(BaseModel):
    question: str = Field(min_length=3, max_length=300)


class ContactScriptRequest(BaseModel):
    account_id: str = Field(pattern=r"^AC-\d{3,4}$")
    channel: Literal["CALL", "SMS", "EMAIL"] = "CALL"
    language: LanguageCode = "en"


class TranslateRequest(BaseModel):
    language: LanguageCode


class HeldTransferRequest(BaseModel):
    resolution: Literal["RELEASE", "REJECT"]
    note: str = Field(min_length=5, max_length=500)
    actor_label: str | None = Field(default=None, max_length=60, pattern=r"^[A-Za-z0-9 _.\-]+$")
