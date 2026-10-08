/* Button and Checkbox, ported from the SIL Language Technology design system bundle
   (components/forms/Button.jsx and Checkbox.jsx) so the app matches the design without
   loading the design tool's runtime. */
import React from "react";

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<
  Variant,
  { background: string; color: string; border: string; hover: string }
> = {
  primary: {
    background: "var(--sil-blue)",
    color: "#fff",
    border: "1px solid var(--sil-blue)",
    hover: "var(--sil-blue-dark)",
  },
  secondary: {
    background: "#fff",
    color: "var(--sil-blue)",
    border: "1px solid var(--sil-blue)",
    hover: "var(--sil-blue-05)",
  },
  ghost: {
    background: "transparent",
    color: "var(--sil-blue)",
    border: "1px solid transparent",
    hover: "var(--sil-blue-05)",
  },
};

export function Button({
  variant = "primary",
  disabled = false,
  onClick,
  children,
}: {
  variant?: Variant;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const v = VARIANTS[variant];
  const [hover, setHover] = React.useState(false);
  const [down, setDown] = React.useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setDown(false);
      }}
      onMouseDown={() => setDown(true)}
      onMouseUp={() => setDown(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: "8px 16px",
        fontSize: 13,
        fontFamily: "var(--font-label)",
        fontWeight: 600,
        letterSpacing: "0.02em",
        lineHeight: 1,
        borderRadius: "var(--radius-md)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition:
          "background var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard)",
        whiteSpace: "nowrap",
        color: v.color,
        border: v.border,
        background: hover && !disabled ? v.hover : v.background,
        transform: down && !disabled ? "translateY(1px)" : "none",
      }}
    >
      {children}
    </button>
  );
}

export function Checkbox({
  id,
  label,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  label?: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontSize: 14,
        color: "var(--app-text)",
      }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label={label ? undefined : "Select"}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: "var(--radius-sm)",
          border: `2px solid ${checked ? "var(--sil-blue)" : "var(--border-default)"}`,
          background: checked ? "var(--sil-blue)" : "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "background var(--duration-fast), border-color var(--duration-fast)",
          flex: "none",
        }}
      >
        {checked && (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      {label}
    </label>
  );
}

export function Chevron({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 140ms" }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}
