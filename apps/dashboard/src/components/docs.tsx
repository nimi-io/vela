import { createContext, useContext, type ReactNode } from "react";
import { useToast } from "./ui";

/* Shared building blocks for the Docs pages: the curl/Node preference and copyable code blocks. */

export type Lang = "curl" | "node";

export type DocVars = {
  /** API base URL without a trailing slash. */
  api: string;
  /** Stream service base URL without a trailing slash. */
  stream: string;
  /** A real ready asset ID, or the ASSET_ID placeholder. */
  assetId: string;
  /** Its public playback ID, or the PLAYBACK_ID placeholder. */
  pid: string;
  /** True when assetId / pid are real. */
  real: boolean;
  title: string | null;
  duration: number | null;
  envId: string;
};

type Ctx = { lang: Lang; setLang: (l: Lang) => void; v: DocVars };
export const DocsCtx = createContext<Ctx>(null as any);
export const useDocs = () => useContext(DocsCtx);

const LANG_KEY = "vela_docs_lang";

export function readLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === "node" ? "node" : "curl";
  } catch {
    return "curl";
  }
}
export function storeLang(l: Lang) {
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies): the choice just won't persist.
  }
}

export function useCopy() {
  const toast = useToast();
  return (text: string, what = "Copied") => {
    if (!navigator.clipboard) return toast("Copying isn't available in this browser", true);
    navigator.clipboard.writeText(text).then(
      () => toast(what),
      () => toast("Couldn't copy to the clipboard", true),
    );
  };
}

/** A dark code block with a label and a Copy button. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const copy = useCopy();
  return (
    <div className="doc-code">
      <div className="doc-code-head">
        <span>{label}</span>
        <button type="button" className="btn ghost sm" onClick={() => copy(code, label ? `${label} copied` : "Copied")} aria-label={label ? `Copy ${label}` : "Copy code"}>
          Copy
        </button>
      </div>
      <pre className="code">{code}</pre>
    </div>
  );
}

/** A sample with curl and/or Node variants; follows the page's curl/Node toggle. */
export function Sample({ curl, node }: { curl?: string; node?: string }) {
  const { lang } = useDocs();
  const showNode = node !== undefined && (lang === "node" || curl === undefined);
  return showNode ? <CodeBlock code={node!} label="Node.js" /> : <CodeBlock code={curl ?? ""} label="curl" />;
}

/** A numbered step inside a guide. */
export function Step({ n, title, children }: { n?: number; title: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {n !== undefined && <span className="doc-step">{n}</span>}
          {title}
        </h2>
      </div>
      <div className="panel-body doc">{children}</div>
    </section>
  );
}

/* ------------------------------ Snippet helpers ------------------------------ */

export const AUTH = '-u "$VELA_TOKEN_ID:$VELA_TOKEN_SECRET"';

/** JSON with 2-space indent, but short arrays of plain values kept on one line. */
export function pretty(value: unknown) {
  return JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, inner: string) => `[${inner.split(/,\s*/).join(", ")}]`);
}

/** A multi-line curl command with Basic auth and an optional JSON body. */
export function curlCmd(method: string, url: string, body?: unknown) {
  const lines = [`curl${method === "GET" ? "" : ` -X ${method}`} "${url}"`, `  ${AUTH}`];
  if (body !== undefined) lines.push(`  -H "Content-Type: application/json"`, `  -d '${pretty(body)}'`);
  return lines.join(" \\\n");
}

/** `const vela = new Vela(...)` preamble for Node samples. */
export function nodeInit(api: string, extra = "") {
  return `import Vela${extra ? `, { ${extra} }` : ""} from "@vela/node";

// Reads VELA_TOKEN_ID and VELA_TOKEN_SECRET from the environment.
const vela = new Vela({ baseUrl: "${api}" });
`;
}

/** Formats an object literal for JS samples (JSON with unquoted keys). */
export function js(value: unknown, indent = 0) {
  const s = pretty(value).replace(/"([a-z_][a-z0-9_]*)":/gi, "$1:");
  return indent ? s.replace(/\n/g, "\n" + " ".repeat(indent)) : s;
}
