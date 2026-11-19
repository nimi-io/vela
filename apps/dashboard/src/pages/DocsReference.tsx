import { useMemo, useState } from "react";
import apiMd from "../../../../docs/api.md?raw";
import { parseMarkdown, plain, Inline, type MdBlock } from "../lib/markdown";
import { useDocs, useCopy, CodeBlock, AUTH } from "../components/docs";

const blocks = parseMarkdown(apiMd);

const ERRORS: { status: number; type: string; when: string }[] = [
  { status: 400, type: "invalid_parameters", when: "A field is missing or invalid; messages name the field" },
  { status: 400, type: "invalid_request", when: "The request isn't possible in the current state (e.g. cancelling an upload that already finished)" },
  { status: 400, type: "invalid_json", when: "The body isn't valid JSON" },
  { status: 400, type: "missing_environment", when: "Dashboard session without an X-Vela-Environment header" },
  { status: 401, type: "unauthorized", when: "Missing or invalid access token" },
  { status: 403, type: "forbidden", when: "Not allowed, e.g. a read-only token writing, or a dashboard-only endpoint" },
  { status: 404, type: "not_found", when: "No such object in this environment" },
  { status: 409, type: "upload_incomplete", when: "Completing a direct upload before the file arrived" },
  { status: 429, type: "rate_limited", when: "Too many requests per minute per API key (RATE_LIMIT_PER_MINUTE, default 1200)" },
];

const METHOD_CLS: Record<string, string> = { GET: "info", POST: "ok", PUT: "warn", PATCH: "warn", DELETE: "bad" };

/** Placeholder for a path parameter, named after the collection before it. */
const PARAM: Record<string, string> = {
  assets: "ASSET_ID",
  uploads: "UPLOAD_ID",
  "live-streams": "LIVE_STREAM_ID",
  "playback-ids": "PLAYBACK_ID",
  "signing-keys": "SIGNING_KEY_ID",
  webhooks: "WEBHOOK_ID",
  tracks: "TRACK_ID",
  deliveries: "DELIVERY_ID",
  "simulcast-targets": "SIMULCAST_TARGET_ID",
};

export function fillPath(path: string, assetId?: string) {
  const segs = path.split("/");
  return segs
    .map((s, i) => {
      if (!s.startsWith(":")) return s;
      const prev = segs[i - 1] ?? "";
      if (prev === "assets" && assetId) return assetId;
      return PARAM[prev] ?? s.slice(1).toUpperCase();
    })
    .join("/");
}

/** A curl command for a row with exactly one method and one path, else null. */
export function rowCurl(methodCell: string, pathCell: string, api: string, assetId?: string) {
  const method = methodCell.trim();
  const m = pathCell.trim().match(/^`(\/[^`\s,[\]]+)`$/);
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) || !m) return null;
  const lines = [`curl -X ${method} "${api}${fillPath(m[1]!, assetId)}"`, `  ${AUTH}`];
  if (method === "POST" || method === "PUT" || method === "PATCH") lines.push(`  -H "Content-Type: application/json"`, `  -d '{}'`);
  return lines.join(" \\\n");
}

const matches = (cells: string[], terms: string[]) => {
  const hay = plain(cells.join(" ")).toLowerCase();
  return terms.every((t) => hay.includes(t));
};

export function ReferenceSection() {
  const { v } = useDocs();
  const [q, setQ] = useState("");
  const terms = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const toc = blocks.filter((b): b is Extract<MdBlock, { type: "heading" }> => b.type === "heading" && b.level === 2);
  const shown = terms.length
    ? blocks.reduce((n, b) => n + (b.type === "table" ? b.rows.filter((r) => matches(r, terms)).length : 0), 0)
    : null;

  return (
    <>
      <section className="panel">
        <div className="panel-body stack-sm doc">
          <p>
            Base URL <code>{v.api}</code>. Authenticate with HTTP Basic: token ID as the username, secret as the password. Lists accept <code>?page=&limit=</code>.
          </p>
          <CodeBlock
            label="curl"
            code={`curl "${v.api}/v1/assets?limit=10" \\
  ${AUTH}`}
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Errors</h2>
            <p>
              Errors return <code>{'{ "error": { "type": "...", "messages": ["..."] } }'}</code>; successes return <code>{'{ "data": ... }'}</code>.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table doc-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Type</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {ERRORS.map((e) => (
                <tr key={e.type}>
                  <td>
                    <span className={`badge ${e.status === 409 || e.status === 429 ? "warn" : "bad"}`}>{e.status}</span>
                  </td>
                  <td>
                    <code>{e.type}</code>
                  </td>
                  <td>{e.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Endpoints</h2>
            <p>
              Rendered from <code>docs/api.md</code> in the Vela repo.
            </p>
          </div>
          <input className="input doc-search" type="search" placeholder="Filter endpoints" aria-label="Filter endpoints" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="panel-body doc md">
          {!terms.length && (
            <nav className="doc-toc" aria-label="Contents">
              <span className="small muted">Contents</span>
              {toc.map((h) => (
                <a
                  key={h.id}
                  href={`#${h.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  {plain(h.text)}
                </a>
              ))}
            </nav>
          )}
          {shown === 0 && <p className="muted">No endpoints match “{q}”.</p>}
          {shown !== null && shown > 0 && (
            <p className="small muted">
              {shown} matching row{shown === 1 ? "" : "s"}
            </p>
          )}
          {blocks.map((b, i) => (
            <Block key={i} block={b} terms={terms} />
          ))}
        </div>
      </section>
    </>
  );
}

function Block({ block: b, terms }: { block: MdBlock; terms: string[] }) {
  switch (b.type) {
    case "heading":
      if (b.level === 1) return null; // The page has its own title.
      if (b.level === 2)
        return (
          <h2 id={b.id} className="md-h2">
            <Inline text={b.text} />
          </h2>
        );
      return (
        <h3 id={b.id}>
          <Inline text={b.text} />
        </h3>
      );
    case "paragraph":
      return (
        <p>
          <Inline text={b.text} />
        </p>
      );
    case "list":
      return (
        <ul>
          {b.items.map((it, i) => (
            <li key={i}>
              <Inline text={it} />
            </li>
          ))}
        </ul>
      );
    case "code":
      return <CodeBlock code={b.text} label={b.lang ? b.lang.toUpperCase() : undefined} />;
    case "table":
      return <MdTable header={b.header} rows={b.rows} terms={terms} />;
  }
}

function MdTable({ header, rows, terms }: { header: string[]; rows: string[][]; terms: string[] }) {
  const { v } = useDocs();
  const copy = useCopy();
  const endpoint = header[0] === "Method" && header[1] === "Path";
  const visible = terms.length ? rows.filter((r) => matches(r, terms)) : rows;
  if (!visible.length) return null;
  return (
    <div className="table-wrap md-table-wrap">
      <table className="table doc-table md-table">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
            {endpoint && (
              <th>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {visible.map((r, ri) => {
            const cmd = endpoint ? rowCurl(r[0] ?? "", r[1] ?? "", v.api, v.real ? v.assetId : undefined) : null;
            return (
              <tr key={ri}>
                {r.map((c, ci) =>
                  endpoint && ci === 0 ? (
                    <td key={ci} className="md-method">
                      {c.split("/").map((m) => (
                        <span key={m} className={`badge ${METHOD_CLS[m.trim()] ?? ""}`}>
                          {m.trim()}
                        </span>
                      ))}
                    </td>
                  ) : (
                    <td key={ci} className={(endpoint ? ci === 1 : ci === 0) ? "md-path" : undefined}>
                      <Inline text={c} />
                    </td>
                  ),
                )}
                {endpoint && (
                  <td className="md-actions">
                    {cmd && (
                      <button type="button" className="btn sm" onClick={() => copy(cmd, "curl command copied")}>
                        Copy curl
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
