"""Hugging Face Spaces entry point (Gradio SDK slot).

The Space runs `python app.py` and serves whatever listens on port 7860. This starts the same FastAPI app
that the Dockerfile runs, serving the prebuilt UI from frontend/dist. See docs/deploy-huggingface.md.
"""
import os

import uvicorn

# The app directory may be read-only on Spaces; keep SQLite in /tmp like the container image does.
os.environ.setdefault("DB_PATH", "/tmp/fraudgraph.db")

if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
