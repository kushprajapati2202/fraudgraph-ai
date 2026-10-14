# FraudGraph AI: submission brief

Track: **BFSI: Intelligent Risk, Fraud & Financial Experiences**

> See the connection. Understand the risk. Act with evidence.

## The problem
Transaction monitoring raises alerts one transfer at a time, but fraud such as mule layering, structuring and rapid pass-through is spread across several accounts and a short burst of transfers. An analyst has to open each record, work out how the accounts connect, decide why a rule fired, write up the case and choose a response. That is slow and inconsistent, and a bare risk score is hard to defend to a customer or a regulator.

## What FraudGraph AI does
It takes a case from alert to accountable action in one workspace:

1. **Detect.** Six transparent rules score every transfer from 0 to 100. Transfers that share accounts within a time window are linked into one case, so the analyst sees the pattern as a whole.
2. **See.** A directed money-flow graph shows who paid whom, how much and when. Chains of transfers can be traced with one click.
3. **Understand.** Gemini explains the case using only the evidence the backend supplies: facts, indicators, alternative explanations and what is still unknown.
4. **Verify.** Upload a receipt, invoice or agreement. Gemini reads it (image or PDF) and fixed rules compare amount, date, parties and bank reference with the transfer, so a genuine payment is cleared quickly and a mismatch is obvious.
5. **Mitigate.** A fixed playbook and the AI draft recommend proportionate actions, such as holding transfers for review, verifying with the customer, refreshing KYC, or filing an internal report. A human approves each one, and it then takes effect in the workspace: a hold stops new transfers on that account until an analyst releases or rejects them, enhanced monitoring flags them, and follow-ups become tasks with an owner and a due date.
6. **Document.** Gemini drafts the internal escalation report (roles, chronology, indicators, mitigating factors, gaps). The full case file downloads in one click, and every step is in the audit history.

## How it answers the track brief

| The brief asks for | How FraudGraph AI delivers it |
|---|---|
| An AI-powered solution | Gemini is used five ways: the investigation summary, follow-up answers, the escalation report with recommended actions, reading uploaded documents, and embeddings that find similar resolved cases. |
| A meaningful BFSI challenge | Connected-account fraud investigation is a daily, high-cost task for fraud and AML operations teams. |
| Detecting fraud or risk | Rule-based scoring, case linking and graph path tracing over 1,539 transfers and 300 accounts. |
| Mitigating fraud or risk | Catalogue-based mitigation actions recommended by rules and AI and approved by a human. Approved holds are enforced on new transfers (held until released or rejected), monitoring flags them, and follow-up tasks are tracked to completion. The overview shows the funds held and rejected. |
| Automating complex processes | Evidence assembly, case building, report drafting and the case file are automated. An average of 23 cited evidence items are assembled per case. |

## Why the AI can be trusted
Most projects stop at "the model wrote a summary". This one treats the model's output as untrusted until it is checked.

- **Evidence allow-list.** Gemini only receives the evidence for one case. Every evidence ID it cites is checked against the IDs that were sent. Unknown IDs are removed and flagged, and a claim left without valid evidence is never shown as fact.
- **Bounded actions.** The model can only recommend action codes from a fixed catalogue, on accounts that belong to the case. Anything else is rejected by schema or removed.
- **Prompt-injection handling.** Free text from transfer remarks is passed as labeled untrusted data. The dataset contains a deliberate injection string to prove it.
- **Data minimisation.** For case analysis the model sees account IDs only, never holder names. An uploaded document is sent to the model as it is, and the file is not stored afterwards; only its hash and the extracted fields are kept.
- **Code decides the document verdict.** The model only extracts fields. The match against the transfer record is computed by fixed rules, so it is repeatable.
- **Precedents without bias.** Similar cases are context, not a prediction. When the closest matches all ended the same way, the nearest case with a different outcome is shown as well.
- **Human accountability.** The AI never decides and never executes. Decisions and action approvals are recorded under the analyst's name, separately from AI events in the audit history.
- **Resilience.** The model chain falls back across four Gemini models and retries on overload. If none answers, scores, graph, evidence and playbook actions all still work, and the interface says why the AI is unavailable.

## Measured results
All figures are measured on the project's own synthetic dataset. See [evaluation.md](evaluation.md) for the method and limitations.

| Measure | Result |
|---|---|
| Recall, transfers flagged at medium priority or above | 100% (22 of 22 labeled suspicious transfers) |
| Precision at medium priority or above | 84.6% (4 false positives, all from deliberate legitimate lookalikes or background coincidences) |
| False-positive rate | 0.3% of 1,517 legitimate transfers |
| Citation validity in live Gemini runs during development | 40 of 40 (investigation) and 60 of 60 (escalation report) |
| Evidence assembled automatically | 140 cited items across 6 cases |
| Document check, live test | Matching receipt: SUPPORTS in about 10 s (amount, date, parties and bank reference matched). Unrelated invoice: DOES NOT SUPPORT, with each field compared. |
| Similar cases, live test | For all five scenario cases, the top-ranked precedent was the one written for that pattern. The archive is synthetic and was written by the team, so this shows the technique working, not real-world accuracy. |
| Automated tests | 65 backend tests, including citation, injection, fallback, action-validation, document-check and similarity cases |

The evaluation also contains an illustrative effort estimate of about 18 minutes of manual record-gathering per case. That rests on an assumed 2 minutes per record and has not been measured with analysts, so present it as an assumption.

## Architecture in one line
React and Cytoscape.js → FastAPI → a pure-Python rule engine, NetworkX graph and evidence builder → Gemini (structured output, validated) → SQLite. It ships as one container on Google Cloud Run.

## Three-minute demo script

| Time | Say | Show |
|---|---|---|
| 0:00 | "Alerts arrive one transfer at a time. Fraud doesn't." | Overview: open cases, amount under review, activity chart |
| 0:25 | "Here twelve transfers became one case." | Open the layered case: score ring, amount moved, time span |
| 0:45 | "Money fans out to five new accounts and regroups within half an hour." | Trace a path on the graph; click an arrow to open the record |
| 1:10 | "Every point of the score is explained, including what we don't know." | Signals table, uncertainty box, an account opened days earlier |
| 1:30 | "Gemini explains it from this evidence only. Click any citation." | Investigate with Gemini; open a citation; point to alternatives and uncertainty |
| 1:50 | "A genuine payment? Upload the receipt." | On the legitimate property case, upload `docs/samples/booking-receipt.png`; show the green field-by-field match |
| 2:05 | "Then we act, proportionately, with a person in control." | Mitigation actions: approve "Hold for manual review"; show AI-draft and playbook sources. In the Simulator, send the suggested transfer from the held account: it is held and the money does not move. Back on the case, reject it. |
| 2:25 | "The compliance report writes itself, with verified citations." | Draft report; download the case file |
| 2:40 | "And it's all accountable." | Record a decision; show the audit history with System, AI and Human markers |
| 2:50 | "This runs on synthetic data, and the same rules can be tested live." | Simulator, briefly; the sandbox badge |

Record when the AI indicator in the top bar is green. If Gemini is busy, the retry usually succeeds within seconds.

## Likely judge questions

**Why not let the AI detect the fraud?**
Detection has to be repeatable and auditable, so it uses deterministic rules whose contributions are shown point by point. The AI is used where it adds the most and risks the least: explaining, drafting and recommending, with every claim checked.

**Is this real data?**
No. The dataset is synthetic, with invented names and accounts, and the sidebar says so. It includes labeled suspicious patterns and legitimate lookalikes so results can be measured honestly.

**What happens when the model is wrong or unavailable?**
Invalid citations and out-of-case accounts are removed before display, unsupported claims are separated, and the app keeps working without AI.

**Does it block payments?**
Inside the sandbox, yes: once an analyst approves a hold, every new transfer to or from that account is held until an analyst releases or rejects it, with a reason. It does not touch real payments. In production the same approved control would be sent to the bank's core banking or payment system, which is the next integration step.

**What would production need?**
Real authentication and roles, a durable database, integration with the bank's case and payment systems, tuning rules on real data, and a model-risk review.

## Limitations to state openly
- Rules and scenarios were designed by the same team, so the detection figures overstate real-world performance. We measured by how much: on IBM's public anti-money-laundering dataset, with the rules unchanged, recall falls to 12.1% and precision to 0.10% (see `docs/evaluation-external.md`).
- The score is a priority index, not a calibrated probability.
- Citation checks prove that cited evidence exists. They don't prove the reasoning is right, which is why a human reviews every case.
- Mitigation actions are enforced inside the sandbox only, on transfers submitted after approval. Nothing is sent to an external system.
- A held or rejected transfer is still scored as an attempted transfer, so it still counts in a case's signals and amount.
