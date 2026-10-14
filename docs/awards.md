# Award readiness

This is a working checklist for the team, mapping what is built to each prize. Confirm every award's official criteria and eligibility on the competition site; this page was written without access to them.

## Status at a glance

| Award | Where the project stands | Still to do (team) |
|---|---|---|
| Winner / runners-up | Complete end-to-end product with 65 automated tests and measured results | Deploy, record the video, write the proposal |
| Best use of Google Cloud AI tools | Five distinct Gemini uses (including vision and embeddings), Vertex AI and Cloud Run support | Deploy on Cloud Run in Vertex AI mode and confirm it works |
| Most Impactful Solution | Covers detect, explain, verify documents, mitigate and document | Add one impact number from a real analyst if you can |
| Best UI/UX | Redesigned console, verified in light and dark themes | Click through once; check the tour and a phone-width view |
| Social Choice Award | Sharing kit prepared in [social.md](social.md) | Publish the demo and video, then gather votes |

## Best use of Google Cloud AI tools

**What the project uses**

| Google capability | How it is used | Where |
|---|---|---|
| Gemini structured output | Investigation summary, follow-up answers and escalation report are returned as JSON against a fixed schema | `backend/services/gemini_service.py` |
| Gemini multimodal (vision) | Reads uploaded invoices, receipts and agreements (image or PDF) into a fixed schema | `backend/services/document_check.py` |
| Gemini embeddings | "Similar resolved cases": each case is described without names or IDs, embedded with `gemini-embedding-001`, and ranked against an archive of resolved cases. The score blends embedding similarity (60%) with rule-signal overlap (40%). | `backend/services/similarity.py` |
| Constrained recommendations | The model may only pick mitigation actions from an 8-item catalogue, on accounts in the case | `backend/services/mitigation.py` |
| Model fallback chain | Four Gemini models tried in order, with a second pass on overload | `gemini_service.generate_json` |
| Vertex AI | Optional backend using the Cloud Run service account, with no API key | `backend/config.py`, `scripts/deploy.sh` |
| Cloud Run, Cloud Build, Artifact Registry | One-container deployment | `Dockerfile`, `scripts/deploy.sh` |
| Secret Manager, IAM | Least-privilege service account; secrets never in code | `scripts/deploy.sh` |
| Cloud Logging | Structured JSON request logs | `backend/main.py` |

**The point to make to judges:** the model's output is treated as untrusted until verified. Citations are checked against an allow-list, out-of-case accounts and off-catalogue actions are rejected, document fields are compared with the record by plain code, and the AI never decides or executes.

**Honest gaps**
- Vertex AI mode is implemented but has not been run. Until you deploy and see `"backend": "Vertex AI"` on `/api/ai/status`, describe it as supported, not as proven.
- The similar-cases archive is 14 synthetic precedents written by the team to cover the same patterns as the test scenarios, so the good matches are expected. Describe it as a demonstration of the technique, not as evidence it works on real case history.
- The project does not use BigQuery, Firestore or Vertex AI Search. Don't claim them. State is still temporary SQLite.

## Most Impactful Solution

**The argument:** fraud teams lose time connecting accounts by hand and writing up cases, and legitimate customers are held up while they wait. FraudGraph AI shortens both.

- **Faster triage:** related transfers are grouped into one case with the pattern drawn out.
- **Faster clearance of legitimate payments:** a matching receipt verifies in about 10 seconds in testing (amount, date, parties and bank reference all matched).
- **Fewer wrong calls:** every score is explained point by point, with uncertainty stated.
- **Audit-ready by default:** each AI output, document check, approved action and decision is logged with who did it.

**Numbers you can quote** (all on synthetic data; see [evaluation.md](evaluation.md))
- 100% recall and 84.6% precision at medium priority or above; 0.3% false-positive rate.
- 140 cited evidence items assembled automatically across 6 cases.
- Live Gemini runs during development: 40 of 40 and 60 of 60 citations valid.

**Do not overstate:** the "18 minutes saved per case" figure in the evaluation rests on an assumed 2 minutes per record. Say it is an assumption, or replace it with a timing from a real analyst.

## Best UI/UX

- Sidebar navigation, global search (`Ctrl+K`), light and dark themes, and a guided tour.
- Overview with KPIs, an activity chart, a review queue and an activity feed.
- Case page: score ring, money-flow graph with traceable paths, named accounts, signals, timeline, evidence, AI panels, mitigation and decision.
- Accessibility: priority is always shown with a shape and a label as well as colour; the graph has a keyboard-accessible table; focus outlines are visible; dialogs close with Esc; reduced-motion is respected.
- Every panel has loading, empty and error states, and the AI panels explain why they are unavailable.

**Check before submitting:** the tour overlay, the search dropdown, the account drawer and a phone-width layout have not been viewed in a real browser session by the developer assistant. Screenshots of the main pages in both themes are in [screenshots/](screenshots/).

## Social Choice Award

This is normally decided by public votes, so it depends on reach, not code. What helps:
- A public URL that works without setup and opens with the guided tour.
- A short video (under 60 seconds) showing the graph, a Gemini citation click, and a document check.
- Ready-to-post text and a sharing plan: see [social.md](social.md).

## Before you submit

- [ ] Deployed URL opens over HTTPS and the smoke test passes
- [ ] AI indicator is green on the deployed URL
- [ ] 3-minute video recorded from [pitch.md](pitch.md) and publicly viewable
- [ ] Proposal PDF written (use pitch.md, evaluation.md and the screenshots)
- [ ] No API keys or tokens in the repository, video or screenshots
- [ ] Official rules, eligibility, team registration and deadline re-checked
