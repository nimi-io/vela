import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/* ------------------------------ Toasts ------------------------------ */
type Toast = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ------------------------------ Modal ------------------------------ */
export function Modal({
  title,
  description,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------ Bits ------------------------------ */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function CopyField({ value, label, display }: { value: string; label?: string; display?: string }) {
  const toast = useToast();
  return (
    <div className="copy" title={display ? undefined : value}>
      <code>{display ?? value}</code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(value).then(() => toast(label ? `${label} copied` : "Copied"));
        }}
      >
        Copy
      </button>
    </div>
  );
}

export function Code({ children }: { children: string }) {
  return <pre className="code">{children}</pre>;
}

const STATUS: Record<string, { cls: string; label?: string }> = {
  ready: { cls: "ok", label: "Ready" },
  preparing: { cls: "info", label: "Processing" },
  errored: { cls: "bad", label: "Failed" },
  waiting: { cls: "warn", label: "Waiting for file" },
  asset_created: { cls: "ok", label: "Video created" },
  cancelled: { cls: "", label: "Cancelled" },
  timed_out: { cls: "", label: "Timed out" },
  idle: { cls: "", label: "Idle" },
  disabled: { cls: "warn", label: "Disabled" },
  success: { cls: "ok", label: "Delivered" },
  pending: { cls: "warn", label: "Retrying" },
  failed: { cls: "bad", label: "Failed" },
  broadcasting: { cls: "ok", label: "Broadcasting" },
  starting: { cls: "info", label: "Starting" },
};

export function StatusBadge({ status }: { status: string }) {
  if (status === "active")
    return (
      <span className="badge tally">
        <span className="dot" />
        Live
      </span>
    );
  const s = STATUS[status] ?? { cls: "" };
  return <span className={`badge ${s.cls}`}>{s.label ?? status}</span>;
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

export function Loading() {
  return (
    <div className="center">
      <Spinner />
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p style={{ maxWidth: "52ch" }}>{children}</p>}
      {action}
    </div>
  );
}

export function PageHead({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Panel({ title, description, actions, children, flush }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <div className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {flush ? children : <div className="panel-body">{children}</div>}
    </section>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Pager({ page, limit, total, onPage }: { page: number; limit: number; total?: number; onPage: (p: number) => void }) {
  const pages = total !== undefined ? Math.max(1, Math.ceil(total / limit)) : undefined;
  if (pages === 1) return null;
  return (
    <div className="pager">
      <span>
        Page {page}
        {pages ? ` of ${pages}` : ""}
      </span>
      <div className="row">
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button className="btn sm" disabled={pages !== undefined && page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

/** Confirm dialog helper. */
export function Confirm({ title, body, confirmLabel, danger, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{body}</p>
    </Modal>
  );
}
