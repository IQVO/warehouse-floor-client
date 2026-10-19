import { useEffect, useId, useRef, useState } from "react";
import { createScanDeduper, isEditable, isPrintableKey, normalizeScan } from "../lib/scan";

/**
 * The one way the app takes a barcode.
 *
 * - Focus-locked: it grabs focus on mount, takes it back when focus is dropped
 *   on nothing (a tap on empty space), and pulls in stray typing -- a
 *   keyboard-wedge scanner types into whatever has focus, and a scan that lands
 *   on <body> would otherwise be lost. It never steals from another field or
 *   button the operator deliberately focused.
 * - A scan is whatever was typed up to Enter (the wedge's terminator). It is
 *   cleaned (control characters stripped), de-bounced, then handed to onScan.
 * - Manual-entry fallback: "Type instead" switches to a normal keyboard and
 *   adds a large Enter button for touch-only terminals. In scan mode the
 *   soft keyboard is suppressed (inputMode="none") so it does not cover the
 *   screen on an RF gun.
 */
export function ScanInput({
  label,
  hint,
  onScan,
  disabled = false,
}: {
  label: string;
  hint?: string;
  onScan: (value: string) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const deduper = useRef(createScanDeduper());
  const [value, setValue] = useState("");
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (!disabled) inputRef.current?.focus();
  }, [disabled]);

  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPrintableKey(event) || isEditable(document.activeElement)) return;
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [disabled]);

  function submit() {
    const scan = normalizeScan(value);
    setValue("");
    if (scan === "" || !deduper.current.accept(scan)) return;
    onScan(scan);
  }

  function toggleManual() {
    setManual((m) => !m);
    // The toggle button took focus; hand it back so the next scan is not lost.
    queueMicrotask(() => inputRef.current?.focus());
  }

  return (
    <div className="floor-scan">
      <label className="floor-scan__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="floor-scan__row">
        <input
          ref={inputRef}
          id={inputId}
          className="floor-scan__input"
          type="text"
          value={value}
          disabled={disabled}
          inputMode={manual ? "text" : "none"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={hint ? hintId : undefined}
          placeholder={manual ? "Type, then press Enter" : "Scan now"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          onBlur={() => {
            if (disabled) return;
            // Re-take focus only if it fell on nothing, not if it moved to another control.
            setTimeout(() => {
              if (document.activeElement === null || document.activeElement === document.body) {
                inputRef.current?.focus();
              }
            }, 0);
          }}
        />
        {manual && (
          <button type="button" className="floor-btn floor-btn--primary" disabled={disabled} onClick={submit}>
            Enter
          </button>
        )}
      </div>
      {hint && (
        <p id={hintId} className="floor-scan__hint">
          {hint}
        </p>
      )}
      <button type="button" className="floor-btn floor-btn--quiet" disabled={disabled} onClick={toggleManual}>
        {manual ? "Back to scanning" : "Type instead"}
      </button>
    </div>
  );
}
