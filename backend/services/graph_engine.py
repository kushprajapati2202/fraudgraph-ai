"""Directed transaction graph (accounts = nodes, transactions = edges keyed by transaction ID)."""
from datetime import datetime, timedelta

import networkx as nx

from backend.services.risk_engine import parse_ts


def build_graph(rows: list[dict]) -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    for r in rows:
        graph.add_edge(
            r["source_account"], r["destination_account"], key=r["transaction_id"],
            amount=float(r["amount"]), timestamp=r["timestamp"], channel=r.get("channel"),
            currency=r.get("currency"), is_synthetic_added=bool(r.get("is_synthetic_added")),
        )
    return graph


def time_respecting_paths(rows: list[dict], max_gap_minutes: int = 60, limit: int = 10) -> list[dict]:
    """Maximal chains tx1 -> tx2 -> ... where each tx starts at the previous destination, later in time,
    within max_gap_minutes. Only chains with 2+ transfers are returned (longest first)."""
    graph = build_graph(rows)
    gap = timedelta(minutes=max_gap_minutes)

    def successors(tx_id: str, dst: str, ts: datetime) -> list[tuple[str, str, datetime]]:
        out = []
        for _, nxt_dst, key, data in graph.out_edges(dst, keys=True, data=True):
            nxt_ts = parse_ts(data["timestamp"])
            if key != tx_id and ts < nxt_ts <= ts + gap:
                out.append((key, nxt_dst, nxt_ts))
        return sorted(out, key=lambda x: (x[2], x[0]))

    edges = sorted(
        ((key, u, v, parse_ts(d["timestamp"])) for u, v, key, d in graph.edges(keys=True, data=True)),
        key=lambda e: (e[3], e[0]),
    )
    has_pred = set()
    for key, _, v, ts in edges:
        for nxt, _, _ in successors(key, v, ts):
            has_pred.add(nxt)

    paths: list[list[tuple[str, str, str, datetime]]] = []

    def dfs(chain: list[tuple[str, str, str, datetime]]) -> None:
        if len(paths) >= 200:
            return
        key, _, dst, ts = chain[-1]
        seen_accounts = {chain[0][1]} | {c[2] for c in chain}
        nxt = [s for s in successors(key, dst, ts) if s[1] not in seen_accounts]
        if not nxt:
            if len(chain) >= 2:
                paths.append(list(chain))
            return
        for nkey, ndst, nts in nxt:
            chain.append((nkey, dst, ndst, nts))
            dfs(chain)
            chain.pop()

    for key, u, v, ts in edges:
        if key not in has_pred:
            dfs([(key, u, v, ts)])

    paths.sort(key=lambda p: (-len(p), p[0][3], [c[0] for c in p]))
    result = []
    for p in paths[:limit]:
        minutes = int((p[-1][3] - p[0][3]).total_seconds() // 60)
        result.append({
            "transaction_ids": [c[0] for c in p],
            "accounts": [p[0][1]] + [c[2] for c in p],
            "start": p[0][3].isoformat(),
            "end": p[-1][3].isoformat(),
            "duration_minutes": minutes,
        })
    return result


def to_payload(
    rows: list[dict],
    assessments: dict[str, dict],
    accounts: dict[str, dict],
    focus_tx_ids: set[str] | None = None,
    highlight_paths: list[dict] | None = None,
) -> dict:
    """Serialize a set of transactions into nodes/edges for the UI. Every edge is a real transaction."""
    graph = build_graph(rows)
    focus_tx_ids = focus_tx_ids or set()
    focus_accounts = set()
    for r in rows:
        if r["transaction_id"] in focus_tx_ids:
            focus_accounts.update((r["source_account"], r["destination_account"]))

    node_score: dict[str, int] = {}
    edges = []
    for u, v, key, data in sorted(graph.edges(keys=True, data=True), key=lambda e: (e[3]["timestamp"], e[2])):
        a = assessments.get(key) or {}
        score = a.get("score")
        if score is not None:
            node_score[u] = max(node_score.get(u, 0), score)
            node_score[v] = max(node_score.get(v, 0), score)
        edges.append({
            "id": key, "source": u, "target": v, "amount": data["amount"], "currency": data.get("currency"),
            "timestamp": data["timestamp"], "channel": data.get("channel"),
            "score": score, "risk_band": a.get("risk_band"),
            "in_focus": key in focus_tx_ids, "is_synthetic_added": data.get("is_synthetic_added", False),
        })

    nodes = []
    for node in sorted(graph.nodes):
        info = accounts.get(node, {})
        nodes.append({
            "id": node,
            "holder_name": info.get("holder_name"),
            "city": info.get("city"),
            "kyc_tier": info.get("kyc_tier"),
            "account_type": info.get("account_type"),
            "created_at": info.get("created_at"),
            "in_focus": node in focus_accounts,
            "max_score": node_score.get(node),
            "in_degree": graph.in_degree(node),
            "out_degree": graph.out_degree(node),
        })
    return {"nodes": nodes, "edges": edges, "paths": highlight_paths or []}
