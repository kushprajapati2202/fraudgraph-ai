"""Document AI as a second, independent reader of supporting documents.

Gemini extracts the fields; a Document AI Invoice/Expense parser reads the same file in parallel. Code compares the
two readings field by field. Where both readers agree, the extraction is corroborated; where they disagree on a
field the verdict depends on (amount, date), a SUPPORTS verdict is lowered to PARTIALLY_SUPPORTS and the analyst
is told to read that field themselves. Off unless DOCAI_PROCESSOR is set.
"""
import logging
from datetime import date
from difflib import SequenceMatcher

from backend.config import settings

logger = logging.getLogger("fraudgraph.docai")

AMOUNT_FIELDS = ("total_amount", "net_amount", "amount_due")
DATE_FIELDS = ("invoice_date", "receipt_date", "purchase_date", "due_date")
PAYEE_FIELDS = ("supplier_name", "remit_to_name", "supplier_registration")
PAYER_FIELDS = ("receiver_name", "ship_to_name", "bill_to_name")
REF_FIELDS = ("invoice_id", "purchase_order", "receipt_id")


def enabled() -> bool:
    return bool(settings.docai_processor)


def _location() -> str:
    parts = (settings.docai_processor or "").split("/")
    return parts[3] if len(parts) > 3 else "us"


def process(raw: bytes, mime_type: str) -> dict:
    """Return the fields Document AI found: amount, date, payee, payer, references, plus processor info."""
    from google.api_core.client_options import ClientOptions
    from google.cloud import documentai

    client = documentai.DocumentProcessorServiceClient(
        client_options=ClientOptions(api_endpoint=f"{_location()}-documentai.googleapis.com"))
    result = client.process_document(request=documentai.ProcessRequest(
        name=settings.docai_processor, raw_document=documentai.RawDocument(content=raw, mime_type=mime_type)),
        timeout=30)
    entities: dict[str, list] = {}
    for e in result.document.entities:
        entities.setdefault(e.type_, []).append(e)

    def first(types: tuple[str, ...]):
        for t in types:
            if entities.get(t):
                return max(entities[t], key=lambda e: e.confidence)
        return None

    out = {"amount": 0.0, "date": "", "payee": "", "payer": "", "references": [], "confidence": {}}
    if e := first(AMOUNT_FIELDS):
        money = e.normalized_value.money_value if e.normalized_value else None
        if money and (money.units or money.nanos):
            out["amount"] = float(money.units) + money.nanos / 1e9
        else:
            try:
                out["amount"] = float("".join(c for c in e.mention_text if c.isdigit() or c == "."))
            except ValueError:
                pass
        out["confidence"]["amount"] = round(e.confidence, 3)
    if e := first(DATE_FIELDS):
        d = e.normalized_value.date_value if e.normalized_value else None
        if d and d.year:
            out["date"] = date(d.year, d.month or 1, d.day or 1).isoformat()
        out["confidence"]["date"] = round(e.confidence, 3)
    if e := first(PAYEE_FIELDS):
        out["payee"] = e.mention_text.strip()[:200]
        out["confidence"]["payee"] = round(e.confidence, 3)
    if e := first(PAYER_FIELDS):
        out["payer"] = e.mention_text.strip()[:200]
        out["confidence"]["payer"] = round(e.confidence, 3)
    out["references"] = [e.mention_text.strip()[:60] for t in REF_FIELDS for e in entities.get(t, [])][:6]
    out["entity_types"] = sorted(entities)[:30]
    return out


def _name_agree(a: str, b: str) -> bool:
    from backend.services.document_check import _norm_name

    a, b = _norm_name(a), _norm_name(b)
    if not a or not b:
        return False
    return SequenceMatcher(None, a, b).ratio() >= 0.75 or set(a.split()) <= set(b.split()) or set(b.split()) <= set(a.split())


def compare(gemini: dict, docai: dict) -> list[dict]:
    """Field-by-field agreement between the two readers (pure; unit-tested)."""
    rows = []

    def add(field: str, g, d, agree):
        if not g and not d:
            state = "NEITHER"
        elif not d:
            state = "ONLY_GEMINI"
        elif not g:
            state = "ONLY_DOCUMENT_AI"
        else:
            state = "AGREE" if agree else "DISAGREE"
        rows.append({"field": field, "gemini": g, "document_ai": d, "agreement": state})

    ga, da = float(gemini.get("amount") or 0), float(docai.get("amount") or 0)
    add("Amount", f"{ga:,.2f}" if ga else "", f"{da:,.2f}" if da else "",
        bool(ga and da and abs(ga - da) <= max(1.0, 0.005 * max(ga, da))))
    gd, dd = (gemini.get("document_date") or "")[:10], (docai.get("date") or "")[:10]
    add("Date", gd, dd, gd == dd)
    gp = gemini.get("payee_name") or gemini.get("issuer_name") or ""
    add("Payee", gp, docai.get("payee") or "", _name_agree(gp, docai.get("payee") or ""))
    add("Payer", gemini.get("payer_name") or "", docai.get("payer") or "",
        _name_agree(gemini.get("payer_name") or "", docai.get("payer") or ""))
    return rows


def adjust_verdict(verdict: str, rows: list[dict]) -> tuple[str, str | None]:
    disagree = [r["field"] for r in rows if r["agreement"] == "DISAGREE" and r["field"] in ("Amount", "Date")]
    if disagree and verdict == "SUPPORTS":
        return "PARTIALLY_SUPPORTS", (f"Gemini and Document AI read the {' and '.join(f.lower() for f in disagree)} "
                                      "differently; check it on the document before relying on it.")
    if disagree:
        return verdict, f"The two readers disagree on {', '.join(disagree)}."
    return verdict, None
