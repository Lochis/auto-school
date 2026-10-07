"use client";

import {
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  ChevronDownIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";

/* ── Panel ────────────────────────────────────────────────────────────── */

export interface PanelProps {
  title?: ReactNode;
  /** node rendered inside a 28px icon tile next to the title */
  icon?: ReactNode;
  /** optional uppercase micro-label above the title */
  eyebrow?: ReactNode;
  /** right-aligned header content (chips, buttons, inputs) */
  actions?: ReactNode;
  /** secondary one-liner under the title */
  subtitle?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Panel({
  title,
  icon,
  eyebrow,
  actions,
  subtitle,
  children,
  className = "",
}: PanelProps) {
  const hasHeader = title || icon || eyebrow || actions;
  return (
    <section className={`panel ${className}`}>
      {hasHeader && (
        <PanelHeader icon={icon} title={title} eyebrow={eyebrow} actions={actions} subtitle={subtitle} />
      )}
      {hasHeader && (subtitle || children) && <div style={{ height: 12 }} />}
      {children}
    </section>
  );
}

export interface PanelHeaderProps {
  icon?: ReactNode;
  title?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  subtitle?: ReactNode;
  className?: string;
}

export function PanelHeader({ icon, title, eyebrow, actions, subtitle, className = "" }: PanelHeaderProps) {
  return (
    <header className={className} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {icon && <span className="icon-tile">{icon}</span>}
          {title && <h2 className="panel-title">{title}</h2>}
        </div>
        {subtitle && <p className="panel-sub">{subtitle}</p>}
      </div>
      {actions && <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{actions}</div>}
    </header>
  );
}

/* ── Eyebrow ──────────────────────────────────────────────────────────── */

export interface EyebrowProps {
  children?: ReactNode;
  className?: string;
  /** emerald accent instead of neutral */
  tone?: "neutral" | "emerald";
}

export function Eyebrow({ children, className = "", tone = "neutral" }: EyebrowProps) {
  return <span className={`eyebrow ${tone === "emerald" ? "eyebrow--emerald" : ""} ${className}`}>{children}</span>;
}

/* ── StatCard ─────────────────────────────────────────────────────────── */

export type StatTone = "neutral" | "emerald" | "indigo" | "cyan" | "red";

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  valueClass?: string;
  tone?: StatTone;
  /** node rendered inside the tinted icon tile (a heroicon element) */
  icon?: ReactNode;
  className?: string;
}

export function StatCard({ label, value, valueClass = "", tone = "neutral", icon, className = "" }: StatCardProps) {
  return (
    <div className={`stat-card ${className}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span className={`stat-card-label ${tone === "red" ? "stat-card-value--red" : ""}`.trim()}>{label}</span>
        <span className={`stat-card-value stat-card-value--${tone} ${valueClass}`.trim()}>{value}</span>
      </div>
      {icon && (
        <span className={`icon-tile icon-tile--lg ${tone !== "neutral" ? `icon-tile--${tone}` : ""}`}>{icon}</span>
      )}
    </div>
  );
}

/* ── Chips / badges ───────────────────────────────────────────────────── */

export interface ChipProps {
  children?: ReactNode;
  tone?: "neutral" | "emerald" | "indigo" | "cyan" | "red";
  pill?: boolean;
  className?: string;
  title?: string;
}

export function Chip({ children, tone = "neutral", pill = false, className = "", title }: ChipProps) {
  return (
    <span className={`chip chip--${tone} ${pill ? "chip--pill" : ""} ${className}`.trim()} title={title}>
      {children}
    </span>
  );
}

export type BadgeVariant = "emerald" | "indigo" | "cyan" | "red" | "neutral";

export interface BadgeProps {
  variant?: BadgeVariant;
  children?: ReactNode;
  className?: string;
  title?: string;
}

export function Badge({ variant = "neutral", children, className = "", title }: BadgeProps) {
  return (
    <span className={`badge badge-${variant} ${className}`.trim()} title={title}>
      {children}
    </span>
  );
}

export interface CodeChipProps {
  children?: ReactNode;
  className?: string;
  title?: string;
}

export function CodeChip({ children, className = "", title }: CodeChipProps) {
  return (
    <span className={`code-chip ${className}`.trim()} title={title}>
      {children}
    </span>
  );
}

/* ── Buttons ──────────────────────────────────────────────────────────── */

export interface PrimaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
}

export function PrimaryButton({ icon, children, className = "", ...rest }: PrimaryButtonProps) {
  return (
    <button className={`btn btn-primary ${className}`.trim()} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export interface GhostButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
}

export function GhostButton({ icon, children, className = "", ...rest }: GhostButtonProps) {
  return (
    <button className={`btn btn-ghost ${className}`.trim()} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export interface MicroButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
}

export function MicroButton({ icon, children, className = "", ...rest }: MicroButtonProps) {
  return (
    <button className={`btn btn-micro ${className}`.trim()} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/* ── Segmented tabs ───────────────────────────────────────────────────── */

export interface SegmentedTabItem {
  label: ReactNode;
  /** optional trailing count, e.g. tab label "Sessions" count 8 */
  count?: number | string;
  active?: boolean;
  href?: string;
  onClick?: () => void;
  title?: string;
}

export interface SegmentedTabsProps {
  items: SegmentedTabItem[];
  /** emerald-filled active pill (course tabs); default neutral fill (header nav) */
  variant?: "neutral" | "emerald";
  className?: string;
}

export function SegmentedTabs({ items, variant = "neutral", className = "" }: SegmentedTabsProps) {
  return (
    <nav className={`segmented-tabs ${variant === "emerald" ? "segmented-tabs--emerald" : ""} ${className}`.trim()} aria-label="Tabs">
      {items.map((item, i) => (
        <TabLink key={i} item={item} variant={variant} />
      ))}
    </nav>
  );
}

function TabLink({ item, variant }: { item: SegmentedTabItem; variant: "neutral" | "emerald" }) {
  const cls = `segmented-tab ${item.active ? "segmented-tab--active" : ""}`.trim();
  const inner = (
    <>
      {item.label}
      {item.count !== undefined && (
        <span className={`segmented-tab-count ${variant === "emerald" && item.active ? "segmented-tab-count--on" : ""}`}>
          {typeof item.count === "number" ? `(${item.count})` : item.count}
        </span>
      )}
    </>
  );
  if (item.href) {
    return (
      <Link href={item.href} className={cls} title={item.title} aria-current={item.active ? "page" : undefined}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} onClick={item.onClick} title={item.title} aria-current={item.active ? "page" : undefined}>
      {inner}
    </button>
  );
}

/* ── Progress ─────────────────────────────────────────────────────────── */

export interface ProgressBarProps {
  /** 0–100 */
  value: number;
  showScrubber?: boolean;
  className?: string;
  trackClassName?: string;
}

export function ProgressBar({ value, showScrubber = true, className = "", trackClassName = "" }: ProgressBarProps) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`progress-bar ${trackClassName}`.trim()}
      role="progressbar"
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-bar-fill" style={{ width: `${v}%` }} />
      {showScrubber && v > 0 && v < 100 && (
        <span className="progress-bar-scrubber" style={{ left: `${v}%` }} />
      )}
      <span className={className} style={{ position: "absolute", inset: 0, pointerEvents: "none", clipPath: `inset(0 ${100 - v}% 0 0)` }} />
    </div>
  );
}

export interface ProgressRingProps {
  /** 0–100 */
  value: number;
  size?: number;
  strokeWidth?: number;
  /** small center label, e.g. "65%" */
  label?: ReactNode;
  className?: string;
}

export function ProgressRing({ value, size = 64, strokeWidth = 6, label, className = "" }: ProgressRingProps) {
  const v = Math.max(0, Math.min(100, value));
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div
      className={className}
      style={{ position: "relative", width: size, height: size, flex: "none" }}
      role="progressbar"
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-container-high)" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--primary-container)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (c * v) / 100}
          style={{ transition: "stroke-dashoffset 0.3s" }}
        />
      </svg>
      {label !== undefined && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: size / 4,
            fontWeight: 600,
            color: "var(--on-surface)",
            fontFeatureSettings: '"tnum" 1',
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

/* ── Toggle ───────────────────────────────────────────────────────────── */

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  id?: string;
  className?: string;
}

export function Toggle({ checked, onChange, title, id, className = "" }: ToggleProps) {
  return (
    <label className={`toggle ${className}`.trim()} title={title}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" />
      <span className="toggle-thumb" />
    </label>
  );
}

/* ── Stepper ──────────────────────────────────────────────────────────── */

export interface StepperProps {
  label?: ReactNode;
  /** small unit chip, e.g. "SEGMENTS" */
  unit?: ReactNode;
  description?: ReactNode;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  className?: string;
}

export function Stepper({ label, unit, description, value, min = 0, max = 9999, onChange, className = "" }: StepperProps) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {(label || unit) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {label && <span style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--on-surface)" }}>{label}</span>}
          {unit && <CodeChip>{unit}</CodeChip>}
        </div>
      )}
      <div className="stepper">
        <button type="button" className="stepper-btn" onClick={() => onChange(clamp(value - 1))} aria-label="decrement" disabled={value <= min}>
          −
        </button>
        <span className="stepper-value">{value}</span>
        <button type="button" className="stepper-btn" onClick={() => onChange(clamp(value + 1))} aria-label="increment" disabled={value >= max}>
          +
        </button>
      </div>
      {description && <span className="muted" style={{ fontSize: "0.75rem" }}>{description}</span>}
    </div>
  );
}

/* ── LiveDot ──────────────────────────────────────────────────────────── */

export interface LiveDotProps {
  className?: string;
  /** static dot (no ping animation) */
  static?: boolean;
  tone?: "emerald" | "red";
  style?: React.CSSProperties;
}

export function LiveDot({ className = "", static: isStatic = false, tone = "emerald", style }: LiveDotProps) {
  return (
    <span
      className={`live-dot ${isStatic ? "live-dot--static" : ""} ${className}`.trim()}
      style={tone === "red" ? { background: "var(--error)" } : style}
    />
  );
}

/* ── Collapsible ──────────────────────────────────────────────────────── */

export interface CollapsibleProps {
  summary: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  /** right-aligned summary content (chips, counts) */
  right?: ReactNode;
  className?: string;
}

export function Collapsible({ summary, children, defaultOpen = false, right, className = "" }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className} style={{ borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 0" }}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, color: "var(--on-surface)", font: "inherit", fontWeight: 500, fontSize: "0.8125rem" }}
          aria-expanded={open}
        >
          <ChevronDownIcon
            className="heroicon"
            style={{ display: "inline", transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}
          />
          {summary}
        </button>
        {right && <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>{right}</div>}
      </div>
      {open && <div style={{ padding: "6px 0 10px 18px" }}>{children}</div>}
    </div>
  );
}

/* ── SearchInput ──────────────────────────────────────────────────────── */

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** render inside a bordered well with a magnifier glyph */
  well?: boolean;
}

export function SearchInput({ well = true, className = "", ...rest }: SearchInputProps) {
  if (!well) return <input type="search" className={className} {...rest} />;
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: "var(--radius-md)",
        background: "var(--surface-container-lowest)",
        border: "1px solid var(--line)",
        color: "var(--outline)",
        minWidth: 0,
      }}
    >
      <MagnifyingGlassIcon className="heroicon" style={{ display: "inline" }} />
      <input
        type="search"
        {...rest}
        style={{
          all: "unset",
          font: "inherit",
          fontSize: "0.8125rem",
          color: "var(--on-surface)",
          minWidth: 0,
          width: rest.style?.width ?? 180,
        }}
      />
    </label>
  );
}
