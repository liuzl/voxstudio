import { useEffect, useState, type ReactNode } from "react";
import { useAccount } from "./account";
import { AuthError, resendVerification, signIn, signUp, socialSignInUrl } from "./lib/auth";
import { useT } from "./i18n";

/**
 * The hosted door (docs/auth.md phase 3). Under `--accounts` an unauthenticated visitor
 * gets this card instead of the studio; a self-hosted deployment renders its children
 * immediately and never mounts anything below.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const t = useT();
  const status = useAccount(state => state.status);
  const refresh = useAccount(state => state.refresh);

  useEffect(() => { void refresh(); }, [refresh]);

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-500">{t("探测中…")}</div>
    );
  }
  if (status === "self" || status === "signed-in") return <>{children}</>;
  return <SignInCard />;
}

/** A provider's name as a person recognises it; unknown ones fall back to their id. */
const providerLabels: Record<string, string> = { github: "GitHub", google: "Google" };

function SignInCard() {
  const t = useT();
  const refresh = useAccount(state => state.refresh);
  const doors = useAccount(state => state.doors);
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    const action = mode === "in" ? signIn(email, password) : signUp(email, password);
    void action
      .then(async () => {
        if (mode === "up") setNotice(t("注册成功。如果这个部署开启了邮箱验证，请查收验证邮件。"));
        await refresh();
      })
      .catch((failure: unknown) => {
        // The server's own wording, with one translated hint for the case a user can act on.
        if (failure instanceof AuthError && failure.code === "EMAIL_NOT_VERIFIED") {
          setError(t("邮箱尚未验证。请点击验证邮件中的链接后再登录。"));
        } else {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold tracking-wide">VoxStudio</div>
          <div className="text-xs text-ink-300">{t("自托管语音工作台")}</div>
        </div>
        <div className="space-y-3 rounded-xl border border-ink-700 bg-ink-900 p-5">
          {doors.providers.length > 0 && (
            <div className="space-y-2">
              {doors.providers.map(provider => (
                <button
                  key={provider}
                  type="button"
                  onClick={() => {
                    setError("");
                    void socialSignInUrl(provider)
                      .then(url => { window.location.href = url; })
                      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
                  }}
                  className="w-full rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm hover:border-accent-500"
                >
                  {t("用 {provider} 登录", { provider: providerLabels[provider] ?? provider })}
                </button>
              ))}
              {doors.password && (
                <div className="flex items-center gap-2 pt-1 text-[11px] text-ink-500">
                  <span className="h-px flex-1 bg-ink-700" />
                  {t("或")}
                  <span className="h-px flex-1 bg-ink-700" />
                </div>
              )}
            </div>
          )}
          {!doors.password && doors.providers.length === 0 && (
            <p className="text-xs text-ink-500">{t("该部署未开放任何登录方式。")}</p>
          )}
          {doors.password && (
          <form onSubmit={submit} className="space-y-3">
          <div className="flex gap-1 rounded-lg border border-ink-700 p-1 text-xs">
            {(["in", "up"] as const).map(option => (
              <button
                key={option}
                type="button"
                onClick={() => { setMode(option); setError(""); setNotice(""); }}
                aria-current={mode === option ? "true" : undefined}
                className={`flex-1 rounded-md px-3 py-1.5 ${mode === option ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:text-ink-100"}`}
              >
                {t(option === "in" ? "登录" : "注册账户")}
              </button>
            ))}
          </div>
          <label className="block text-xs text-ink-300">
            {t("邮箱")}
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-ink-100 outline-none focus:border-accent-500"
            />
          </label>
          <label className="block text-xs text-ink-300">
            {t("密码")}
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              value={password}
              onChange={event => setPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-ink-100 outline-none focus:border-accent-500"
            />
          </label>
          {error && <p className="text-xs text-red-300">{error}</p>}
          {notice && <p className="text-xs text-emerald-300">{notice}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-accent-500 px-3 py-2 text-sm font-medium text-ink-900 disabled:opacity-50"
          >
            {busy ? t("请稍候…") : t(mode === "in" ? "登录" : "注册账户")}
          </button>
          </form>
          )}
          {!doors.password && error && <p className="text-xs text-red-300">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * The nudge an unverified account sees above the studio: it does not block the app —
 * whether an unverified session may sign in at all is the gateway's decision (it depends
 * on a verification sender being configured), and this only helps once it did.
 */
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
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs text-amber-200">
      <span>{t("邮箱 {email} 尚未验证。", { email: user.email })}</span>
      <button
        onClick={resend}
        disabled={sent === "sending" || sent === "sent"}
        className="rounded-md border border-amber-400/40 px-2 py-0.5 disabled:opacity-60"
      >
        {sent === "sent" ? t("已发送") : sent === "sending" ? t("发送中…") : t("重新发送验证邮件")}
      </button>
      {sent === "failed" && <span className="text-amber-300/80">{t("该部署未配置发信服务。")}</span>}
    </div>
  );
}
