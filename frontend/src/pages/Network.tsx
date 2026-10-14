import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { Empty, ErrorState, Loading } from "../components/common";
import { useInspector } from "../components/Inspector";
import NetworkGraph from "../graph/NetworkGraph";
import { useAsync } from "../util";

export default function NetworkPage() {
  const [params, setParams] = useSearchParams();
  const focus = params.get("account");
  const [account, setAccount] = useState(focus ?? "");
  const graph = useAsync(() => api.graph(focus ? { account_id: focus } : {}), [focus]);
  const { openTransaction, openAccount } = useInspector();

  useEffect(() => setAccount(focus ?? ""), [focus]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = account.trim().toUpperCase();
    setParams(v ? { account: v } : {});
  }

  const focusName = focus ? graph.data?.nodes.find((n) => n.id === focus)?.holder_name : null;

  return (
    <div className="stack">
      <div className="page-head" data-tour="network">
        <div>
          <h1>Network</h1>
          <p className="muted">
            {focus ? (
              <>
                Transfers in and out of <strong style={{ color: "var(--text)" }}>{focusName ?? focus}</strong> <span className="mono">({focus})</span>, most recent 150.{" "}
                <button className="link-button" onClick={() => openAccount(focus)}>Open profile</button>
              </>
            ) : (
              "Every transfer currently at medium or high priority. Click an account to focus on its activity."
            )}
          </p>
        </div>
        <form className="row-center" onSubmit={submit}>
          <label className="inline">
            <span className="label" style={{ margin: 0 }}>Account ID</span>
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="AC-101" style={{ width: 120 }} />
          </label>
          <button className="btn btn-primary" type="submit">Focus</button>
          {focus ? (
            <button className="btn" type="button" onClick={() => setParams({})}>
              Show flagged network
            </button>
          ) : null}
        </form>
      </div>
      {graph.loading && !graph.data ? <Loading label="Loading graph" /> : null}
      {graph.error ? <ErrorState message={graph.error} onRetry={graph.reload} /> : null}
      {graph.data ? (
        <section className="card">
          {graph.data.edges.length === 0 ? (
            <Empty>No transfers to show yet. Run analysis from the overview.</Empty>
          ) : (
            <NetworkGraph
              data={graph.data}
              layout={focus ? "flow" : "network"}
              height={620}
              onEdgeClick={openTransaction}
              onNodeClick={(id) => setParams({ account: id })}
            />
          )}
        </section>
      ) : null}
    </div>
  );
}
