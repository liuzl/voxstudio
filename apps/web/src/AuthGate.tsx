import { ArrowRight, AudioLines, Eye, EyeOff, LoaderCircle, Mail, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useAccount, type AccountStatus } from "./account";
import {
  AuthError,
  authReturnPath,
  resendVerification,
  signIn,
  signUp,
  socialSignInUrl,
  type LoginDoors,
} from "./lib/auth";
import { useT } from "./i18n";

/**
 * The hosted door (docs/auth.md phase 3). Under `--accounts` an unauthenticated visitor
 * gets the product-owned entrance; a self-hosted deployment passes through unchanged.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAccount(state => state.status);
  const refresh = useAccount(state => state.refresh);
  const doors = useAccount(state => state.doors);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <AuthGateView
      status={status}
      doors={doors}
      onRetry={() => { void refresh(); }}
      onAuthenticated={refresh}
    >
      {children}
    </AuthGateView>
  );
}

/** Pure status switch: testable without teaching a renderer about Zustand snapshots. */
export function AuthGateView({
  status,
  doors,
  onRetry,
  onAuthenticated,
  children,
}: {
  status: AccountStatus;
  doors: LoginDoors;
  onRetry: () => void;
  onAuthenticated: () => Promise<void>;
  children: ReactNode;
}) {
  if (status === "loading") return <AuthLoading />;
  if (status === "unavailable") return <AuthUnavailable onRetry={onRetry} />;
  if (status === "self" || status === "signed-in") return <>{children}</>;
  return <AuthEntrance doors={doors} onAuthenticated={onAuthenticated} />;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`${compact ? "size-9 rounded-[11px]" : "size-10 rounded-xl"} flex items-center justify-center bg-ink text-on-ink shadow-sm`}>
        <AudioLines className={compact ? "size-[18px]" : "size-5"} strokeWidth={2.2} />
      </span>
      <span className={`${compact ? "text-[16px]" : "text-[17px]"} font-semibold tracking-[-0.03em] text-ink`}>VoxStudio</span>
    </div>
  );
}

function AuthLoading() {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center bg-canvas text-fg-muted">
      <div className="flex items-center gap-3 text-[13px]">
        <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
        {t("探测中…")}
      </div>
    </div>
  );
}

function AuthUnavailable({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center bg-canvas px-5">
      <div className="w-full max-w-[420px] text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-fill-active text-fg-secondary">
          <RefreshCw className="size-5" strokeWidth={1.8} />
        </div>
        <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.035em] text-ink">{t("网关离线")}</h1>
        <p className="mt-2 text-[13px] leading-5 text-fg-muted">{t("无法连接网关（/healthz）")}</p>
        <button onClick={onRetry} className="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-full bg-ink px-5 text-[13px] font-medium text-on-ink hover:bg-ink-hover">
          <RefreshCw className="size-3.5" />
          {t("刷新")}
        </button>
      </div>
    </div>
  );
}

/** A provider's name as a person recognises it; unknown ones fall back to their id. */
const providerLabels: Record<string, string> = { github: "GitHub", google: "Google" };

function ProviderMark({ provider }: { provider: string }) {
  if (provider === "github") return <span className="text-[11px] font-bold tracking-[-0.04em]">GH</span>;
  return <span className="text-[13px] font-semibold">{(providerLabels[provider] ?? provider).slice(0, 1).toUpperCase()}</span>;
}

function AuthEntrance({ doors, onAuthenticated }: { doors: LoginDoors; onAuthenticated: () => Promise<void> }) {
  const t = useT();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unverifiedEmail, setUnverifiedEmail] = useState("");
  const [resending, setResending] = useState(false);

  const changeMode = (next: "in" | "up"): void => {
    setMode(next);
    setError("");
    setNotice("");
    setUnverifiedEmail("");
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setError("");
    setNotice("");
    setUnverifiedEmail("");
    setBusy(true);
    const action = mode === "in" ? signIn(email, password) : signUp(email, password);
    void action
      .then(async () => {
        setPassword("");
        if (mode === "up") setNotice(t("注册成功。如果这个部署开启了邮箱验证，请查收验证邮件。"));
        await onAuthenticated();
      })
      .catch((failure: unknown) => {
        if (failure instanceof AuthError && failure.code === "EMAIL_NOT_VERIFIED") {
          setUnverifiedEmail(email);
          setError(t("邮箱尚未验证。请点击验证邮件中的链接后再登录。"));
        } else {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      })
      .finally(() => setBusy(false));
  };

  const resend = (): void => {
    if (!unverifiedEmail || resending) return;
    setResending(true);
    setNotice("");
    void resendVerification(unverifiedEmail)
      .then(() => {
        setNotice(t("已发送"));
        setError("");
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setResending(false));
  };

  const fieldClass = "mt-2 h-11 w-full rounded-xl border border-edge-strong bg-surface px-3.5 text-[14px] text-fg placeholder:text-fg-faint focus:border-edge-hover focus:bg-canvas";

  return (
    <div className="grid h-full min-h-[620px] bg-canvas lg:grid-cols-[minmax(360px,44%)_1fr]">
      <aside className="relative hidden overflow-hidden bg-[#11110f] p-10 text-white lg:flex lg:flex-col xl:p-14">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white text-[#11110f]">
            <AudioLines className="size-5" strokeWidth={2.25} />
          </span>
          <span className="text-[17px] font-semibold tracking-[-0.03em]">VoxStudio</span>
        </div>
        <div className="relative z-10 my-auto max-w-[440px] py-16">
          <div className="mb-6 flex h-20 items-end gap-1.5" aria-hidden="true">
            {[28, 46, 68, 38, 74, 54, 82, 44, 64, 32, 52, 24].map((height, index) => (
              <span key={index} className="w-1.5 rounded-full bg-white/70" style={{ height: `${height}%` }} />
            ))}
          </div>
          <h1 className="text-[34px] font-semibold tracking-[-0.045em]">{t("语音助手")}</h1>
          <p className="mt-3 max-w-sm text-[15px] leading-6 text-white/55">{t("创建、配置和测试实时语音助手。")}</p>
        </div>
        <p className="text-[11px] text-white/35">VoxStudio</p>
      </aside>

      <main className="relative flex min-w-0 items-center justify-center overflow-y-auto px-5 py-10 sm:px-10">
        <div className="absolute left-5 top-5 sm:left-8 sm:top-7 lg:hidden"><Brand compact /></div>
        <div className="w-full max-w-[410px] pt-14 lg:pt-0">
          <div className="mt-10 lg:mt-0">
            <h2 className="text-[27px] font-semibold tracking-[-0.04em] text-ink">{t(mode === "in" ? "登录" : "注册账户")}</h2>
            <p className="mt-2 text-[14px] leading-5 text-fg-muted">{t("创建、配置和测试实时语音助手。")}</p>
          </div>

          {doors.providers.length > 0 && (
            <div className="mt-8 space-y-2.5">
              {doors.providers.map(provider => (
                <button
                  key={provider}
                  type="button"
                  onClick={() => {
                    setError("");
                    void socialSignInUrl(provider, authReturnPath())
                      .then(url => { window.location.href = url; })
                      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
                  }}
                  className="flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-edge-strong bg-canvas text-[13px] font-medium text-fg shadow-[0_1px_1px_rgba(0,0,0,0.02)] hover:border-edge-hover hover:bg-fill-faint"
                >
                  <ProviderMark provider={provider} />
                  {t("用 {provider} 登录", { provider: providerLabels[provider] ?? provider })}
                </button>
              ))}
            </div>
          )}

          {doors.providers.length > 0 && doors.password && (
            <div className="my-6 flex items-center gap-3 text-[11px] text-fg-faint">
              <span className="h-px flex-1 bg-edge-faint" />{t("或")}<span className="h-px flex-1 bg-edge-faint" />
            </div>
          )}

          {!doors.password && doors.providers.length === 0 && (
            <p className="mt-8 rounded-xl border border-edge bg-surface p-4 text-[13px] text-fg-muted">{t("该部署未开放任何登录方式。")}</p>
          )}

          {doors.password && (
            <form onSubmit={submit} className={doors.providers.length > 0 ? "" : "mt-8"}>
              <div className="mb-6 grid grid-cols-2 rounded-xl bg-fill-active p-1 text-[12px] font-medium">
                {(["in", "up"] as const).map(option => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => changeMode(option)}
                    aria-current={mode === option ? "true" : undefined}
                    className={`h-9 rounded-lg transition ${mode === option ? "bg-canvas text-ink shadow-sm" : "text-fg-tertiary hover:text-fg"}`}
                  >
                    {t(option === "in" ? "登录" : "注册账户")}
                  </button>
                ))}
              </div>

              <label className="block text-[12px] font-medium text-fg-secondary">
                {t("邮箱")}
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 mt-1 size-4 -translate-y-1/2 text-fg-faint" strokeWidth={1.7} />
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    className={`${fieldClass} pl-10`}
                  />
                </div>
              </label>

              <label className="mt-5 block text-[12px] font-medium text-fg-secondary">
                {t("密码")}
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={8}
                    autoComplete={mode === "in" ? "current-password" : "new-password"}
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    className={`${fieldClass} pr-11`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(value => !value)}
                    aria-label={t(showPassword ? "隐藏密码" : "显示密码")}
                    className="absolute right-2.5 top-1/2 mt-1 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-fg-faint hover:bg-fill-hover hover:text-fg"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </label>

              {error && (
                <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                  {error}
                  {unverifiedEmail && (
                    <button type="button" onClick={resend} disabled={resending} className="ml-2 font-medium underline underline-offset-2 disabled:opacity-50">
                      {resending ? t("发送中…") : t("重新发送验证邮件")}
                    </button>
                  )}
                </div>
              )}
              {notice && <p role="status" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-[12px] leading-5 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">{notice}</p>}

              <button
                type="submit"
                disabled={busy}
                className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-ink px-5 text-[13px] font-medium text-on-ink shadow-sm transition hover:bg-ink-hover active:scale-[0.99] disabled:opacity-40"
              >
                {busy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <ArrowRight className="size-4" />}
                {busy ? t("请稍候…") : t(mode === "in" ? "登录" : "注册账户")}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}

/** A signed-in but unverified account gets one consistent, actionable notice. */
export function VerifyBanner() {
  const t = useT();
  const user = useAccount(state => state.user);
  const [sent, setSent] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  if (!user || user.emailVerified) return null;

  const resend = (): void => {
    setSent("sending");
    void resendVerification(user.email)
      .then(() => setSent("sent"))
      .catch(() => setSent("failed"));
  };

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 sm:px-6">
      <Mail className="size-3.5 shrink-0" />
      <span>{t("邮箱 {email} 尚未验证。", { email: user.email })}</span>
      <button onClick={resend} disabled={sent === "sending" || sent === "sent"} className="font-medium underline underline-offset-2 disabled:opacity-60">
        {sent === "sent" ? t("已发送") : sent === "sending" ? t("发送中…") : t("重新发送验证邮件")}
      </button>
      {sent === "failed" && <span className="text-amber-700/80 dark:text-amber-300/80">{t("该部署未配置发信服务。")}</span>}
    </div>
  );
}
