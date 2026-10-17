# FraudGraph AI

> See the connection. Understand the risk. Act with evidence.

FraudGraph AI is a human-in-the-loop prototype for investigating connected transactions. It turns synthetic transfers into a directed account graph and scores them with transparent, deterministic rules. It then groups flagged transfers into cases with stable evidence IDs. Gemini explains each case using only that evidence, and every citation is validated before it is displayed. A human analyst records the decision, and every step is audited.

> **Disclaimer.** FraudGraph AI is a competition prototype for demonstrating connected transaction analysis and evidence-grounded AI investigation. It uses synthetic fictional data only. Its risk score is a rule-based prioritization signal, not a calibrated probability or a determination of fraud. AI output is advisory and requires human review. The prototype is not intended for production financial decisions or for blocking real transactions.

## Quick start (local)

There's one entry point for Windows, `scripts\windows\fg.ps1`. By default it runs everything **inside WSL (Ubuntu)**, so nothing needs installing on Windows. It installs into your Linux home directory without sudo:
- `uv` in `~/.local/bin`
- a Python 3.12 virtualenv in `~/.venvs/fraudgraph`
- Node 20 in `~/.local/node`
- the SQLite database in `~/.cache/fraudgraph`

### Windows (PowerShell, using WSL)
```powershell
.\scripts\windows\fg.ps1 setup            # one-time: uv, Python 3.12 venv, Node 20, npm install, dataset, .env
.\scripts\windows\fg.ps1 dev              # API :8000 + Vite :5173, then open http://127.0.0.1:5173
.\scripts\windows\fg.ps1 check            # pytest + TypeScript typecheck + production build
.\scripts\windows\fg.ps1 check -Eval      # ...and regenerate docs/evaluation.md
.\scripts\windows\fg.ps1 serve            # built UI + API on one URL: http://127.0.0.1:8000
.\scripts\windows\fg.ps1 smoke -BaseUrl http://127.0.0.1:8000
```
If script execution is blocked, use `powershell -ExecutionPolicy Bypass -File scripts\windows\fg.ps1 <command>`. In VS Code, the same commands are available as tasks (*Terminal > Run Task > FraudGraph: ...*). Each task asks whether to use WSL or `-Native`.

Use `http://127.0.0.1` rather than `localhost`. On some machines `localhost` resolves to IPv6 first, and WSL forwards only IPv4.

### Inside WSL directly
```bash
bash scripts/wsl/setup.sh
bash scripts/wsl/dev.sh        # or: dev.sh api | dev.sh web
bash scripts/wsl/check.sh [--eval]
bash scripts/wsl/serve.sh
```

### Native Windows (only where installing Python and Node is allowed)
Install Python 3.12 and Node 20+, then add `-Native` to any command, for example `.\scripts\windows\fg.ps1 setup -Native` and `.\scripts\windows\fg.ps1 dev -Native`. This mode uses `.venv\` in the repo.

`frontend/node_modules` contains platform-specific binaries (esbuild). The setup scripts record which platform installed it and reinstall automatically when you switch between WSL and native Windows.

On first start the API loads the synthetic baseline and runs an initial analysis. Gemini is optional: without a key, the AI panel shows its fallback state and every deterministic feature still works. To enable it, put `GEMINI_API_KEY` in `.env`.

## From detection to mitigation

The case page covers the full loop:

1. **Detect:** rule scores and linked cases.
2. **See:** the money-flow graph and traced paths.
3. **Understand:** Gemini's evidence-grounded investigation.
4. **Mitigate:** actions recommended by a deterministic playbook and by the AI draft, limited to a fixed catalogue (hold for review, customer verification, source of funds, KYC refresh, enhanced monitoring, notify counterparty, internal suspicion report). An analyst approves each one, and it then takes effect inside the workspace:
   - **Hold for review** stops every new transfer to or from the account. Each held transfer waits for an analyst to release or reject it, with a reason.
   - **Enhanced monitoring** flags every new transfer on the account for 30 days, whatever its score.
   - The other actions become **tasks** with an owning queue and a due date, and stay open until an analyst completes them with an outcome.
   - A control can be lifted with a reason. The overview shows the funds held and rejected, and every step is in the audit history. No external banking system is called.
5. **Document:** an AI-drafted escalation report and a downloadable case file.

Between steps 3 and 4 an analyst can also **verify a supporting document**: upload a receipt or invoice (image or PDF), Gemini reads it, and fixed rules compare amount, date, parties and bank reference with the transfer. Two fictional samples are in [docs/samples/](docs/samples/); try `booking-receipt.png` on the property-payment case.

Submission material:
- [docs/pitch.md](docs/pitch.md): submission brief, demo script, likely judge questions
- [docs/awards.md](docs/awards.md): readiness against each award, with honest gaps
- [docs/deploy.md](docs/deploy.md): Cloud Run deployment with Vertex AI
- [docs/social.md](docs/social.md): sharing kit for the public vote

## Product tour of the interface

Screenshots are in [docs/screenshots/](docs/screenshots/). Regenerate them with `.\scripts\windows\screenshot.ps1 -BaseUrl http://127.0.0.1:8000`.

| Area | What it does |
|---|---|
| **Overview** | KPIs, *Recommended for you* (up to five next steps for the analyst named in Settings: overdue tasks, transfers waiting on their holds, evidence follow-ups, cases similar to ones they escalated, then unreviewed high-priority cases), daily transfer activity with the flagged portion, cases by priority, signal frequency, the review queue and recent activity |
| **Cases** and case page | Queue with status tabs. The case page shows the score ring, amount moved, money-flow graph, accounts involved, signals, timeline, evidence, the Gemini panel, the decision form and the audit history. |
| **Transactions** | Every transfer with holder names, bank-style references and filters |
| **Network** | The flagged network. Click an account to focus on it. |
| **Simulator** | Score a hypothetical transfer live and see what changed |
| **Settings** | Analyst profile, theme, AI connection, data environment (restore baseline), detection rules, labeled test scenarios |

Global search (`Ctrl+K`) finds cases, account holders and transfer references. Light and dark themes are both supported. The workspace is labeled **Sandbox, synthetic data** in the sidebar: the dataset uses invented names, account numbers and references, and no real customer data.

## AI connection status and model fallback

The top bar and the dashboard show whether Gemini is usable right now:

| Indicator | Meaning | What to do |
|---|---|---|
| **AI connected** (green) | The key is accepted and a model answered | Nothing |
| **AI busy** (amber) | The key is valid, but no configured model answered just now (overloaded, rate-limited or slow) | Wait and click the indicator to re-check. The app falls back to rule findings meanwhile. |
| **AI key rejected** (red) | Google rejected `GEMINI_API_KEY` | Fix the key in `.env` (no quotes or spaces) and restart |
| **AI unreachable** (red) | The server couldn't reach Google's API | Check the network or proxy |
| **AI not configured** (grey) | No key set | Add `GEMINI_API_KEY` to `.env` and restart |

Models are tried in order: `GEMINI_MODEL` first, then each entry in `GEMINI_FALLBACK_MODELS`. The app moves to the next model when one is retired, overloaded, rate-limited or times out, and it remembers the last model that answered. Each investigation records which model produced it.

To diagnose from the terminal without printing the key, run this inside WSL with the venv active. It also lists the models your key can use:
```bash
python scripts/check_gemini.py --investigate
```

## Guided tour

The **Tour** button in the top bar starts a 24-step walkthrough that moves through the dashboard, a case, transactions, the network and the what-if page, highlighting each area. It starts automatically on a first visit. Use Next and Back or the arrow keys, and Esc to close.

## Demo path (3 minutes)
1. **Dashboard.** Start with **Reset demo**, then **Run analysis**. Point out the synthetic-data banner.
2. Open the **layered-transfer-01** case (HIGH). Choose an `EV-PATH` under *Highlight path* to show the chain and its timestamps. Click an edge to open the source record.
3. Walk through the rule signals and their contributions. Click a signal chip to open the evidence.
4. Click **Investigate with Gemini**. Click the citation chips, and point out alternative explanations, uncertainty, and the "AI-generated / advisory" label. One transfer description contains a prompt-injection string. It is shown as untrusted text, and Gemini is instructed to treat it as data.
5. On **What-if**, click *Use demo suggestion*, then *Add synthetic transaction and re-run analysis*. Show the new dotted edge, the updated case, and the changed signals.
6. Under **Mitigation actions**, approve *Hold for manual review* on the collector account. Go back to the Simulator and send the suggested transfer again: it is **held** and the money does not move. On the case, reject it with a reason. The overview's *Funds held by controls* tile updates.
7. Record a human decision with a rationale and show the audit history (System / AI / Human icons).
8. Show the measured synthetic results in [docs/evaluation.md](docs/evaluation.md).

Say during the demo: *"These are synthetic transactions. The application processes the event live, but no real bank transaction is being created or modified."*

## Risk rules (`rules-v1`)

`score = min(100, round(sum(weight_i x value_i)))`, where each `value_i` is in [0, 1]. Bands: LOW 0-29, MEDIUM 30-59, HIGH 60-100. A transaction with a score of 30 or more joins a case.

| Signal | Weight | Fires when | Guardrail |
|---|---|---|---|
| Unusual amount | 20 | Amount is at least 3x the source's 90th-percentile prior outgoing amount (full weight at 10x). Gets half weight if there's no baseline and the amount is at least 100,000. | A missing baseline (fewer than 3 prior payments) is disclosed as uncertainty |
| Transfer velocity | 15 | At least 4 outgoing transfers from the source within plus or minus the analysis window (default 60 minutes) | The window is shown in the signal |
| Rapid onward movement | 25 | At least 70% of the amount moves onward within 30 minutes, either from the destination afterwards or as funds just received by the source. Half weight at 40% or more. | The onward transfers are listed as supporting records |
| Many-in / rapid-out | 25 | At least 4 inbound transfers from at least 3 senders within the window before an outbound transfer | Counts and records are shown |
| Relationship novelty | 5 | First observed source-to-destination pair | Context only, and limited by the history window |
| Shared device | 10 | Device used by at least 3 accounts | Context only, and can never reach MEDIUM alone |

The weights were chosen so that each labeled scenario lands in its intended band. Context-only signals cannot push a case to MEDIUM by themselves. Thresholds live as constants in `backend/services/risk_engine.py`, and the same rules appear at `GET /api/rules`.

## API summary

All routes use the `/api` prefix and return JSON. Errors use `{"error": {"code", "message", "details"}}`.

| Method and path | Purpose |
|---|---|
| `GET /health` | Status, versions, and whether Gemini is configured (never the key) |
| `GET /ai/status` | Live Gemini check: key accepted, which model is answering, and why not if it isn't. Cached for about 2 minutes; `?refresh=true` forces a new check. |
| `GET /rules` | Rule catalogue, weights and bands |
| `GET /dashboard` | Counts, bands, recent cases, last analysis |
| `GET /recommendations` | `?analyst=<name>` returns up to five rule-based next steps for that analyst, most urgent first. Without a name (or with the placeholder `Analyst`) the list is team-wide. |
| `POST /demo/reset` | Restore the ds-v1 baseline. Needs `X-Demo-Token` when `DEMO_TOKEN` is set. |
| `GET /demo/scenarios` | Labeled scenarios, their cases, and the suggested what-if |
| `GET /transactions` | Filters: `account_id, from, to, min_amount, max_amount, q, channel, risk_band, synthetic_only, sort, order, page, page_size` |
| `GET /transactions/{id}` | Record, rule assessment, linked cases, evidence ID |
| `POST /transactions/demo` | Add a fictional transaction (validated; new accounts only in `AC-900..AC-999`). Controls in force are enforced: the response's `control` says whether it was `HELD` or `FLAGGED`. Needs the token when one is set. |
| `POST /analysis/run` | `{scenario_id?, time_window_minutes?}` returns `analysis_id`, counts, `focus_case_ids` and a `diff` |
| `GET /analysis/latest` | The last run and its diff |
| `GET /graph` | `case_id`, `account_id`, or nothing (the flagged network) returns nodes, directed edges (one per transaction) and paths |
| `GET /cases`, `GET /cases/{id}` | Case list and detail: signals, timeline, evidence, decisions, audit, AI history |
| `POST /cases/{id}/investigate` | `{question?}` returns a validated Gemini investigation or the `UNAVAILABLE` fallback |
| `POST /cases/{id}/chat` | `{message}` returns a follow-up answer scoped to the case's evidence |
| `GET /cases/{id}/similar` | Resolved cases with a similar pattern, ranked by Gemini embeddings blended with rule-signal overlap. Falls back to signal overlap alone if embeddings are unavailable. |
| `POST /cases/{id}/documents` | Verify a supporting document: `{filename, mime_type, data_base64, transaction_id}`. Gemini extracts the fields and code compares them with the transfer. The file is not stored. |
| `POST /cases/{id}/report` | AI-drafted escalation report (roles, chronology, indicators, mitigating factors, gaps, recommended actions). Citations are validated, and accounts or actions outside the case are removed. |
| `POST /cases/{id}/actions` | A human approves a mitigation action from the fixed catalogue: `{action_code, target_account?, note?, source}`. It takes effect in the workspace (control `ACTIVE` or task `OPEN`) and is audited; nothing is executed externally. |
| `POST /cases/{id}/actions/{action_id}/close` | Lift a control or complete a task: `{outcome}` |
| `POST /cases/{id}/held-transfers/{transaction_id}` | Release or reject a held transfer: `{resolution: RELEASE or REJECT, note}` |
| `POST /cases/{id}/decision` | `{decision: ESCALATE_FOR_REVIEW, DISMISS_ALERT or REQUEST_MORE_EVIDENCE, rationale, actor_label?}` |

Interactive docs are at `/docs` when the server is running.

## Architecture
See [docs/architecture.md](docs/architecture.md). In short: React + Vite + Cytoscape.js → FastAPI + Pydantic → a pure-Python risk engine, NetworkX graph and evidence builder → Gemini through `google-genai` with structured output and allow-list citation validation → SQLite. Everything ships as one container on Cloud Run.

## Evaluation
Run `.\scripts\windows\fg.ps1 check -Eval` (or `python scripts/evaluate.py --latency`) to regenerate [docs/evaluation.md](docs/evaluation.md). It reports transaction-level precision, recall and false-positive rate against the synthetic labels, per-scenario results, and in-process API p50/p95. Report the numbers it measures; don't round them up.

An independent test is in [docs/evaluation-external.md](docs/evaluation-external.md): the same rules, unchanged, on a two-day slice (1.35 million transfers) of IBM's public anti-money-laundering dataset. The results there are much weaker (12.1% recall and 0.10% precision at MEDIUM+), which shows how much the self-made scenarios flatter the rules. To reproduce it, download `HI-Small_Trans.csv` and `HI-Small_Patterns.txt` from the Kaggle page linked in that file into `~/.cache/fraudgraph/external/ibm-aml` and run `python -I scripts/evaluate_external.py` (about 8 minutes). The data files are not kept in this repository.

## Deploying to Google Cloud Run

```powershell
gcloud config set project <PROJECT_ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
# store the key in Secret Manager (never in git, the Dockerfile, or frontend code)
"<GEMINI_API_KEY>" | Out-File -NoNewline -Encoding ascii key.txt; gcloud secrets create gemini-api-key --data-file=key.txt; Remove-Item key.txt
gcloud run deploy fraudgraph-ai --source . --region <REGION> --allow-unauthenticated `
  --max-instances=1 --memory=1Gi `
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest `
  --set-env-vars "GEMINI_MODEL=gemini-3.8-flash,DEMO_TOKEN=<choose-a-token>"
# grant the Cloud Run service account roles/secretmanager.secretAccessor on the secret if prompted
./scripts/smoke.ps1 -BaseUrl https://<service-url> -DemoToken <choose-a-token>
```

Notes:
- The container listens on `0.0.0.0:$PORT` and serves the built UI and the API from a single URL.
- State lives in SQLite under `/tmp`, so it's lost when the container restarts. That's by design: startup and **Reset demo** restore the same baseline. `--max-instances=1` keeps all requests on one database.
- Set a budget alert on the project. Reset and synthetic-add require `DEMO_TOKEN` when it's set.

## Repository layout
```
backend/   FastAPI app (api/, services/, models/, prompts/, tests/)
frontend/  React + TypeScript + Vite UI (pages/, components/, graph/, api/)
data/      deterministic synthetic CSVs + README (labels, scenarios, limitations)
docs/      architecture.md, evaluation.md
scripts/   generate_dataset.py, evaluate.py, smoke.ps1
           wsl/      setup.sh, dev.sh, check.sh, serve.sh (no-sudo WSL toolchain)
           windows/  fg.ps1 (Windows entry point: WSL by default, -Native optional)
.vscode/   tasks.json (setup / dev / check / serve / evaluate)
```

## Known limitations
- Synthetic data only. The same team designed the scenarios and the rules, so the metrics overstate what real data would show.
- The score is a rule-based prioritization index and isn't calibrated. Thresholds were tuned on the labeled synthetic set.
- Baselines and relationship novelty only cover the two-month synthetic window.
- Mitigation is enforced inside the sandbox only, on transfers submitted after a control is approved. A held or rejected transfer is still scored as an attempted transfer, so it still counts in a case's signals and amount.
- Demo access is token-gated for writes only. There are no user accounts or roles.
- SQLite in `/tmp` is ephemeral. Use Firestore if you need durable multi-instance state.
- Gemini output can still be wrong even when every citation is valid. Validation proves that the cited evidence exists, not that the reasoning is correct. Human review is required.
