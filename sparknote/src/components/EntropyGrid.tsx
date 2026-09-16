import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EntropyPool, makeGridPermutation } from "../lib/mnemonic";

const COLS = 64;
const ROWS = 32;
const CELLS = COLS * ROWS; // 2048

/**
 * Optional user entropy (§3.2).
 *
 * The user drags across an undifferentiated grid and types. Each cell maps,
 * through a secret per-session permutation, to one of 2048 symbols; that
 * mapping is never shown, so the visible pattern of a drag reveals nothing.
 *
 * This can only add entropy — see EntropyPool. The wallet is perfectly safe
 * without touching it, which the copy says plainly rather than implying the
 * user must "charge up" randomness.
 */
export function EntropyGrid({ pool, onProgress }: { pool: EntropyPool; onProgress: () => void }) {
  const perm = useMemo(() => makeGridPermutation(CELLS), []);
  const [lit, setLit] = useState<Set<number>>(() => new Set());
  const gridRef = useRef<HTMLDivElement>(null);
  const lastCell = useRef(-1);

  const sample = useCallback(
    (clientX: number, clientY: number) => {
      const el = gridRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const col = Math.floor(((clientX - r.left) / r.width) * COLS);
      const row = Math.floor(((clientY - r.top) / r.height) * ROWS);
      if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
      const cell = row * COLS + col;
      if (cell === lastCell.current) return;
      lastCell.current = cell;

      pool.addGridSample(perm[cell], performance.now());
      setLit((prev) => {
        const next = new Set(prev);
        next.add(cell);
        return next;
      });
      onProgress();
    },
    [perm, pool, onProgress],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      pool.addKeystroke(e.code, performance.now());
      onProgress();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pool, onProgress]);

  return (
    <div
      ref={gridRef}
      className="entropy-grid"
      onPointerMove={(e) => {
        if (e.buttons > 0 || e.pointerType === "mouse") sample(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        sample(e.clientX, e.clientY);
      }}
      aria-label="Move your pointer across this area to add randomness"
    >
      {Array.from({ length: CELLS }, (_, i) => (
        <div key={i} className={`entropy-cell${lit.has(i) ? " hit" : ""}`} />
      ))}
    </div>
  );
}
