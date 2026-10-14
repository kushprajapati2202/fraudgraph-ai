# Deploying to Hugging Face Spaces (free, no card)

Docker Spaces are a paid feature, so the app runs in a free **Gradio** Space instead. A Gradio Space installs `requirements.txt` and runs `python app.py`. Our `app.py` starts the same FastAPI app on port 7860, serving the prebuilt UI from `frontend/dist`. Gemini is called with an AI Studio API key.

## 1. Build the upload folder

Rebuild the UI (`wsl --cd <repo> -- bash -lc "source scripts/wsl/env.sh && cd frontend && npm run build"`). Then assemble a folder containing only:

```
README.md   (Space header below + short description)
app.py  requirements.txt  backend/ (without tests/)  scripts/  data/  frontend/dist/
```

Never include `.env`. It holds your API key, and the Space is public.

The Space's `README.md` must start with:

```yaml
---
title: FraudGraph AI
emoji: 🕸️
colorFrom: indigo
colorTo: blue
sdk: gradio
sdk_version: 5.29.0
python_version: "3.12"
app_file: app.py
pinned: false
---
```

## 2. Create the Space

On https://huggingface.co/new-space, choose **Gradio** with the **Blank** template, **CPU basic (free)** hardware and **Public** visibility.

## 3. Add secrets

Under **Settings → Variables and secrets**, add these as **secrets**:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | Your key from https://aistudio.google.com/apikey |
| `DEMO_TOKEN` | A long random string. It protects **Restore baseline** and the simulator's write endpoint |

## 4. Upload

Open **Files → Contribute → Upload files**, drag in the *contents* of the folder, replace the existing README and app.py, and commit. The build takes about 3–5 minutes.

## 5. Check it

The app is served at `https://<username>-<space-name>.hf.space`.

- Open `<URL>/api/ai/status?refresh=true`. It should show `"state": "CONNECTED"`.
- From Windows, run `.\scripts\windows\fg.ps1 smoke -BaseUrl <URL> -DemoToken <token>`.

## Things to know

- **The Space sleeps after about 48 hours without visitors.** The next visit wakes it in under a minute.
- **State is temporary.** SQLite lives in `/tmp`, so a restart reloads the baseline dataset.
- **Gemini free-tier rate limits** apply to the key.
- **Redeploy**: rebuild the UI if the frontend changed, then upload the changed files again.
