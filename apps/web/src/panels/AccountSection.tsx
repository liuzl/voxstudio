import { Check, Copy, KeyRound, LogOut, RefreshCw, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccount } from "../account";
import { SectionCard, StatusBadge, primaryButton, secondaryButton } from "../components/StudioPage";
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeySummary } from "../lib/auth";
import { useStudio } from "../store";
import { useT } from "../i18n";

/** Hosted-only account identity and credentials, visually aligned with the Studio shell. */
export function AccountSection() {
  const t = useT();
  const status = useAccount(state => state.status);
  const user = useAccount(state => state.user);
  const signOut = useAccount(state => state.signOut);
  if (status !== "signed-in" || !user) return null;

  const displayName = user.name.trim() || user.email.split("@")[0];

  return (
    <div className="space-y-6">
      <SectionCard className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-fill-active text-fg-secondary">
            <UserRound className="size-5" strokeWidth={1.7} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[10px] font-medium text-fg-faint">{t("账户")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg">{displayName}</h2>
              <StatusBadge tone={user.emailVerified ? "success" : "warning"}>
                {user.emailVerified && <ShieldCheck className="size-3" />}
                {t(user.emailVerified ? "已验证" : "未验证")}
              </StatusBadge>
            </div>
            <p className="mt-1 truncate text-[12px] text-fg-muted">{user.email}</p>
          </div>
          <button onClick={() => { void signOut(); }} className={secondaryButton}>
            <LogOut className="size-3.5" />
            {t("登出")}
          </button>
        </div>
      </SectionCard>
      <ApiKeysSection />
    </div>
  );
}

function ApiKeysSection() {
  const t = useT();
  const toast = useStudio(state => state.toast);
  const [keys, setKeys] = useState<ApiKeySummary[] | "error" | undefined>(undefined);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<ApiKeySummary | undefined>(undefined);
  /** Shown once, never stored: after dismissal the full value exists only where the user put it. */
  const [minted, setMinted] = useState<{ name: string; key: string } | undefined>(undefined);

  const load = (): void => {
    setKeys(undefined);
    listApiKeys()
      .then(setKeys)
      .catch(() => setKeys("error"));
  };

  useEffect(load, []);

  useEffect(() => {
    if (!pendingRevoke) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) setPendingRevoke(undefined);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [busy, pendingRevoke]);

  const create = (): void => {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setCopied(false);
    createApiKey(trimmed)
      .then(key => {
        setMinted({ name: trimmed, key });
        setName("");
        load();
      })
      .catch((error: unknown) => toast("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const revoke = (): void => {
    if (!pendingRevoke || busy) return;
    const entry = pendingRevoke;
    setBusy(true);
    revokeApiKey(entry.id)
      .then(() => {
        toast("info", t("已撤销 {name}", { name: entry.name || entry.start }));
        setPendingRevoke(undefined);
        load();
      })
      .catch((error: unknown) => toast("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <SectionCard>
        <div className="flex items-start gap-3 border-b border-edge-faint p-5 sm:p-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fill-active text-fg-secondary">
            <KeyRound className="size-[18px]" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold tracking-[-0.02em] text-fg">{t("API 密钥")}</h2>
            <p className="mt-1 max-w-2xl text-[12px] leading-5 text-fg-muted">
              {t("给 Agent、CLI 和自动化用的凭证：与你本人权限相同，看到的是同一套音色与素材库。请求带 Authorization: Bearer <key> 即可。")}
            </p>
          </div>
          <button onClick={load} className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-edge-strong text-fg-tertiary hover:bg-fill-hover hover:text-fg" title={t("刷新")} aria-label={t("刷新")}>
            <RefreshCw className="size-3.5" />
          </button>
        </div>

        <div className="p-5 sm:p-6">
          {minted && (
            <div className="mb-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <div className="flex items-center gap-2 text-[12px] font-medium text-emerald-800 dark:text-emerald-200">
                <ShieldCheck className="size-4" />
                {t("这是 {name} 的密钥，只显示这一次：", { name: minted.name })}
              </div>
              <code className="mt-3 block break-all rounded-xl border border-emerald-200/80 bg-canvas px-3 py-2.5 text-[12px] text-fg dark:border-emerald-500/20">{minted.key}</code>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(minted.key).then(() => {
                      setCopied(true);
                      toast("info", t("已复制"));
                    });
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-300 bg-canvas px-3 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/30 dark:text-emerald-200 dark:hover:bg-emerald-500/10"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? t("已复制") : t("复制")}
                </button>
                <button onClick={() => { setMinted(undefined); setCopied(false); }} className="h-8 rounded-lg px-3 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-500/10">
                  {t("我已保存")}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2.5 sm:flex-row">
            <input
              value={name}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") create(); }}
              placeholder={t("名称，例如 my-agent")}
              className="h-10 min-w-0 flex-1 rounded-xl border border-edge-strong bg-surface px-3.5 text-[13px] text-fg placeholder:text-fg-faint focus:bg-canvas"
            />
            <button onClick={create} disabled={busy || name.trim() === ""} className={`${primaryButton} sm:min-w-28`}>
              <KeyRound className="size-3.5" />
              {t("创建密钥")}
            </button>
          </div>

          <div className="mt-6 border-t border-edge-faint pt-2">
            {keys === undefined && <p className="py-6 text-center text-[12px] text-fg-muted">{t("探测中…")}</p>}
            {keys === "error" && <p className="py-6 text-center text-[12px] text-danger">{t("无法获取密钥列表")}</p>}
            {Array.isArray(keys) && keys.length === 0 && <p className="py-6 text-center text-[12px] text-fg-muted">{t("还没有密钥。")}</p>}
            {Array.isArray(keys) && keys.length > 0 && (
              <ul className="divide-y divide-edge-faint">
                {keys.map(entry => (
                  <li key={entry.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-fill-active text-fg-tertiary">
                      <KeyRound className="size-4" strokeWidth={1.7} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-fg">{entry.name || t("未命名")}</span>
                        <code className="rounded-md bg-fill-active px-2 py-0.5 text-[10px] text-fg-tertiary">{entry.start}…</code>
                      </div>
                      <p className="mt-1 text-[11px] text-fg-faint">
                        {entry.lastRequest ? t("最近使用 {when}", { when: entry.lastRequest.slice(0, 10) }) : t("尚未使用")}
                      </p>
                    </div>
                    <button onClick={() => setPendingRevoke(entry)} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 text-[11px] font-medium text-red-700 hover:bg-red-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10">
                      <Trash2 className="size-3.5" />
                      {t("撤销")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SectionCard>

      {pendingRevoke && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4 backdrop-blur-[1px]" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setPendingRevoke(undefined); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="revoke-key-title" aria-describedby="revoke-key-description" className="w-full max-w-[420px] rounded-2xl border border-edge bg-canvas p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)] sm:p-6">
            <span className="flex size-10 items-center justify-center rounded-xl bg-danger-surface text-danger"><Trash2 className="size-[18px]" /></span>
            <h2 id="revoke-key-title" className="mt-4 text-[17px] font-semibold tracking-[-0.025em] text-fg">{t("撤销 API 密钥？")}</h2>
            <p id="revoke-key-description" className="mt-2 text-[12px] leading-5 text-fg-muted">{t("撤销后，使用此密钥的应用会立即失去访问权限。")}</p>
            <code className="mt-4 block rounded-lg bg-fill-active px-3 py-2 text-[11px] text-fg-secondary">{pendingRevoke.name || pendingRevoke.start}</code>
            <div className="mt-6 flex justify-end gap-2">
              <button autoFocus onClick={() => setPendingRevoke(undefined)} disabled={busy} className={secondaryButton}>{t("取消")}</button>
              <button onClick={revoke} disabled={busy} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-danger px-5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40">
                <Trash2 className="size-3.5" />
                {t("撤销")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
