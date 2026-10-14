"""Regenerate the fixed synthetic dataset into data/ (deterministic; seed 2026).

Usage: python scripts/generate_dataset.py [--out data]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.services import synthetic_data  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data"))
    args = parser.parse_args()
    counts = synthetic_data.write_csvs(args.out)
    print(f"Wrote {counts['transactions']} transactions and {counts['accounts']} accounts to {args.out}")


if __name__ == "__main__":
    main()
