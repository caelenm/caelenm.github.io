import { useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h1>{title}</h1>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function QR({ value, size = 216 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    void QRCode.toCanvas(ref.current, value, {
      width: size,
      margin: 0,
      errorCorrectionLevel: "M",
      color: { dark: "#000000ff", light: "#ffffffff" },
    }).catch(() => {});
  }, [value, size]);
  return (
    <div className="qr-wrap">
      <canvas ref={ref} width={size} height={size} />
    </div>
  );
}

/**
 * Copy with a transient confirmation. Falls back to a selectable prompt where
 * the clipboard API is unavailable (it needs a secure context).
 */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          window.prompt("Copy this:", value);
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Banner({
  kind = "warn",
  children,
  onDismiss,
}: {
  kind?: "warn" | "danger";
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`banner ${kind}`}>
      <div className="banner-body">{children}</div>
      {onDismiss && (
        <button className="icon-btn" style={{ fontSize: 14 }} onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

/** Every irreversible action gets an explicit confirm (§5). */
export function Confirm({
  title,
  body,
  confirmLabel,
  danger,
  requirePhrase,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the user must type this exact word before the button enables. */
  requirePhrase?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = !requirePhrase || typed.trim().toUpperCase() === requirePhrase.toUpperCase();
  return (
    <Sheet title={title} onClose={onCancel}>
      <div>{body}</div>
      {requirePhrase && (
        <label className="field" style={{ marginTop: 16 }}>
          <span>
            Type <strong>{requirePhrase}</strong> to continue
          </span>
          <input
            type="text"
            value={typed}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
      )}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className={`btn ${danger ? "danger" : "primary"}`} disabled={!ready} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}
