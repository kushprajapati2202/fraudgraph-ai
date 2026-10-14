"""Archive of resolved cases used for "similar cases" lookup.

These are fictional, synthetic precedents written for the sandbox: no real case, customer or institution is
described. Each entry records the pattern, how it was resolved and which actions were taken, so an analyst
looking at a new case can see how comparable ones ended. Outcomes are precedents, not predictions.
"""

OUTCOME_LABELS = {
    "CONFIRMED_FRAUD": "Confirmed fraud",
    "LEGITIMATE": "Legitimate",
    "INCONCLUSIVE": "Inconclusive",
}

ARCHIVE: list[dict] = [
    {
        "archive_id": "ARC-2025-0117", "title": "Mule layering through newly opened accounts",
        "pattern": "One established account sent five large transfers within fifteen minutes to accounts opened in "
                   "the previous two weeks. Each recipient forwarded almost the full amount within ten minutes to two "
                   "intermediaries, which consolidated the money into a single collector account.",
        "signal_codes": ["RAPID_ONWARD", "VELOCITY", "UNUSUAL_AMOUNT", "SHARED_DEVICE", "RELATIONSHIP_NOVELTY"],
        "outcome": "CONFIRMED_FRAUD", "days_to_resolve": 3,
        "resolution": "The originating customer confirmed they had not made the transfers (account takeover). The "
                      "recipient accounts shared one device and had minimum KYC.",
        "actions_taken": ["HOLD_FOR_REVIEW", "REQUEST_CUSTOMER_VERIFICATION", "KYC_REFRESH", "FILE_INTERNAL_SUSPICION_REPORT"],
    },
    {
        "archive_id": "ARC-2025-0142", "title": "Fan-out to new accounts, funds withdrawn before hold",
        "pattern": "A single source fanned out six transfers in ten minutes to recently opened accounts that sent the "
                   "money onward to a consolidation account, which moved it out to another institution within the hour.",
        "signal_codes": ["RAPID_ONWARD", "VELOCITY", "UNUSUAL_AMOUNT", "RELATIONSHIP_NOVELTY"],
        "outcome": "CONFIRMED_FRAUD", "days_to_resolve": 5,
        "resolution": "Confirmed as an investment scam. The hold was placed after the final transfer had left, so "
                      "recovery depended on the receiving institution.",
        "actions_taken": ["HOLD_FOR_REVIEW", "NOTIFY_COUNTERPARTY_INSTITUTION", "FILE_INTERNAL_SUSPICION_REPORT"],
    },
    {
        "archive_id": "ARC-2025-0203", "title": "Structured small deposits followed by one large transfer out",
        "pattern": "Six inbound transfers just under ten thousand each arrived from six different senders within "
                   "twenty-five minutes into one personal account, which then sent nearly the whole total to a newly "
                   "opened account minutes later.",
        "signal_codes": ["FAN_IN_RAPID_OUT", "RAPID_ONWARD", "UNUSUAL_AMOUNT", "RELATIONSHIP_NOVELTY"],
        "outcome": "CONFIRMED_FRAUD", "days_to_resolve": 4,
        "resolution": "The collecting account holder admitted renting out the account. Senders were victims of a fake "
                      "marketplace listing.",
        "actions_taken": ["HOLD_FOR_REVIEW", "REQUEST_CUSTOMER_VERIFICATION", "FILE_INTERNAL_SUSPICION_REPORT"],
    },
    {
        "archive_id": "ARC-2025-0219", "title": "Many small inbound payments then a payout: community savings group",
        "pattern": "Seven members sent similar small amounts to one account within half an hour and the account "
                   "holder paid the pooled total to one member the same evening.",
        "signal_codes": ["FAN_IN_RAPID_OUT", "RAPID_ONWARD", "RELATIONSHIP_NOVELTY"],
        "outcome": "LEGITIMATE", "days_to_resolve": 1,
        "resolution": "The holder explained it was a monthly rotating savings group (chit) and provided the member "
                      "list. The same pattern recurred on the same date in earlier months.",
        "actions_taken": ["REQUEST_CUSTOMER_VERIFICATION", "NO_ACTION"],
    },
    {
        "archive_id": "ARC-2025-0251", "title": "Large payment forwarded twice within minutes",
        "pattern": "A large incoming transfer was sent on almost in full seven minutes later to a second account, "
                   "which forwarded it again nine minutes after that to an account opened that month.",
        "signal_codes": ["RAPID_ONWARD", "UNUSUAL_AMOUNT", "RELATIONSHIP_NOVELTY"],
        "outcome": "CONFIRMED_FRAUD", "days_to_resolve": 6,
        "resolution": "Pass-through chain used to distance funds from a business email compromise. Neither "
                      "intermediary could explain the purpose.",
        "actions_taken": ["HOLD_FOR_REVIEW", "REQUEST_SOURCE_OF_FUNDS", "FILE_INTERNAL_SUSPICION_REPORT"],
    },
    {
        "archive_id": "ARC-2025-0266", "title": "Rapid pass-through between a customer's own accounts",
        "pattern": "A large inbound transfer was moved on within ten minutes to a second account and then to a third. "
                   "All three accounts had long histories.",
        "signal_codes": ["RAPID_ONWARD", "UNUSUAL_AMOUNT"],
        "outcome": "LEGITIMATE", "days_to_resolve": 1,
        "resolution": "All accounts belonged to the same customer and a family member, who was moving a matured "
                      "deposit to a home-loan account. Statements confirmed it.",
        "actions_taken": ["REQUEST_CUSTOMER_VERIFICATION", "NO_ACTION"],
    },
    {
        "archive_id": "ARC-2025-0301", "title": "High-value property payment passed to a supplier",
        "pattern": "A long-standing personal customer made one very large transfer to a builder, far above their usual "
                   "amounts. The builder paid about forty percent of it to a materials supplier twenty minutes later.",
        "signal_codes": ["UNUSUAL_AMOUNT", "RAPID_ONWARD", "RELATIONSHIP_NOVELTY"],
        "outcome": "LEGITIMATE", "days_to_resolve": 1,
        "resolution": "The customer supplied a booking receipt and sale agreement matching the amount, date and "
                      "payee. The builder's onward payment matched a supplier invoice.",
        "actions_taken": ["REQUEST_SOURCE_OF_FUNDS", "NO_ACTION"],
    },
    {
        "archive_id": "ARC-2025-0318", "title": "Unusually large transfer to a new payee with a forged invoice",
        "pattern": "A personal customer sent one transfer many times larger than usual to a business payee they had "
                   "never paid before. The payee moved most of it onward within half an hour.",
        "signal_codes": ["UNUSUAL_AMOUNT", "RAPID_ONWARD", "RELATIONSHIP_NOVELTY"],
        "outcome": "CONFIRMED_FRAUD", "days_to_resolve": 4,
        "resolution": "The invoice supplied named a different payee and amount from the transfer. The customer had "
                      "been directed by a caller impersonating a government office.",
        "actions_taken": ["HOLD_FOR_REVIEW", "REQUEST_SOURCE_OF_FUNDS", "NOTIFY_COUNTERPARTY_INSTITUTION",
                          "FILE_INTERNAL_SUSPICION_REPORT"],
    },
    {
        "archive_id": "ARC-2025-0344", "title": "Several accounts on one device: family household",
        "pattern": "Four personal accounts used the same device for ordinary small payments over two weeks. One of "
                   "them made a single larger transfer to a new payee.",
        "signal_codes": ["SHARED_DEVICE", "UNUSUAL_AMOUNT", "RELATIONSHIP_NOVELTY"],
        "outcome": "LEGITIMATE", "days_to_resolve": 1,
        "resolution": "The accounts belonged to members of one household sharing a phone. The larger transfer was a "
                      "tuition fee supported by a fee receipt.",
        "actions_taken": ["REQUEST_CUSTOMER_VERIFICATION", "NO_ACTION"],
    },
    {
        "archive_id": "ARC-2025-0359", "title": "Several new accounts operated from one device",
        "pattern": "Five accounts opened within a week were operated from one device. Each received one large "
                   "transfer and forwarded it within minutes.",
        "signal_codes": ["SHARED_DEVICE", "RAPID_ONWARD", "UNUSUAL_AMOUNT", "RELATIONSHIP_NOVELTY"],
        "outcome": "CONFIRMED_FRAUD", "days_to_resolve": 2,
        "resolution": "The accounts were opened with minimum KYC by one operator recruiting account holders. Identity "
                      "re-verification failed for four of the five.",
        "actions_taken": ["HOLD_FOR_REVIEW", "KYC_REFRESH", "FILE_INTERNAL_SUSPICION_REPORT"],
    },
    {
        "archive_id": "ARC-2025-0388", "title": "Burst of outgoing transfers: payroll run",
        "pattern": "A business account sent more than a dozen transfers within an hour to personal accounts it had "
                   "paid in previous months, in amounts consistent with earlier cycles.",
        "signal_codes": ["VELOCITY"],
        "outcome": "LEGITIMATE", "days_to_resolve": 0,
        "resolution": "Monthly salary payments on the usual date to known payees. Closed without customer contact.",
        "actions_taken": ["NO_ACTION"],
    },
    {
        "archive_id": "ARC-2025-0402", "title": "First large transfer from a newly opened account",
        "pattern": "An account opened a few days earlier made its first transfer, a moderate amount to an established "
                   "account. There was no earlier history and no device information.",
        "signal_codes": ["RELATIONSHIP_NOVELTY", "UNUSUAL_AMOUNT"],
        "outcome": "INCONCLUSIVE", "days_to_resolve": 7,
        "resolution": "The customer did not respond to verification. No further activity followed, so the account was "
                      "placed under enhanced monitoring and the case closed.",
        "actions_taken": ["REQUEST_CUSTOMER_VERIFICATION", "ENHANCED_MONITORING"],
    },
    {
        "archive_id": "ARC-2025-0417", "title": "Small coincidental pass-through between friends",
        "pattern": "A small transfer between two personal accounts was followed within half an hour by an unrelated "
                   "small payment from the recipient to a third person.",
        "signal_codes": ["RAPID_ONWARD", "RELATIONSHIP_NOVELTY"],
        "outcome": "LEGITIMATE", "days_to_resolve": 0,
        "resolution": "Amounts were small and in line with both customers' normal spending. Treated as coincidence.",
        "actions_taken": ["NO_ACTION"],
    },
    {
        "archive_id": "ARC-2025-0433", "title": "Collector account receiving from two intermediaries",
        "pattern": "Two intermediary accounts each received several transfers and sent the combined amounts to one "
                   "account opened the same week, which had minimum KYC and no outgoing history.",
        "signal_codes": ["RAPID_ONWARD", "UNUSUAL_AMOUNT", "RELATIONSHIP_NOVELTY"],
        "outcome": "INCONCLUSIVE", "days_to_resolve": 9,
        "resolution": "The collector's funds were held and KYC refreshed. The holder gave a partial explanation that "
                      "could not be verified; the case was referred to compliance.",
        "actions_taken": ["HOLD_FOR_REVIEW", "KYC_REFRESH", "FILE_INTERNAL_SUSPICION_REPORT"],
    },
]


def fingerprint(entry: dict) -> str:
    """Text used for embedding an archive entry (pattern only: no outcome, so similarity is about behaviour)."""
    return f"{entry['title']}. {entry['pattern']}"
