import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  badge,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 text-[11px] font-medium text-fg-faint">
            {eyebrow}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[23px] font-semibold tracking-[-0.035em] text-ink sm:text-[26px]">{title}</h1>
          {badge}
        </div>
        {description && <p className="mt-1 max-w-2xl text-[14px] leading-5 text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-0.5">{actions}</div>}
    </header>
  );
}

/** For pages that manage their own vertical rhythm; PageShell adds the default one on top. */
export const pageShellClass =
  "mx-auto w-full max-w-[1276px] px-4 pb-16 pt-8 sm:px-8 sm:pt-12 lg:px-12 lg:pt-14";

export function PageShell({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className={`${pageShellClass} ${compact ? "space-y-6" : "space-y-8"}`}>
      {children}
    </div>
  );
}

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const tones = {
    neutral: "border-ink-700 bg-ink-800 text-ink-300",
    success: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    warning: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
    danger: "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function SectionCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`rounded-xl border border-edge bg-canvas shadow-[0_1px_2px_rgba(0,0,0,0.025)] ${className}`}>{children}</section>;
}

export const primaryButton =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-ink px-5 text-[13px] font-medium text-on-ink shadow-[0_1px_2px_rgba(0,0,0,0.16)] transition hover:bg-ink-hover active:scale-[0.98] disabled:pointer-events-none disabled:opacity-35";

export const secondaryButton =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-edge-strong bg-canvas px-4 text-[13px] font-medium text-fg-secondary shadow-[0_1px_1px_rgba(0,0,0,0.02)] transition hover:border-edge-hover hover:bg-fill-faint hover:text-ink active:scale-[0.98] disabled:pointer-events-none disabled:opacity-35";
