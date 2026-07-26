import { useEffect, useState } from "react";
import { useAccount } from "../account";
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeySummary } from "../lib/auth";
import { useStudio } from "../store";
import { useT } from "../i18n";

/**
 * Account and API keys in 设置 (docs/auth.md phase 3). Renders only under hosted
 * accounts: a self-hosted studio has no account to show and keeps its settings page
 * exactly as it was.
 */
export function AccountSection() {
  const t = useT();
  const status = useAccount(state => state.status);
  const user = useAccount(state => state.user);
  const signOut = useAccount(state => state.signOut);
  if (status !== "signed-in" || !user) return null;

  return (
    <>
      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h2 className="text-sm font-medium text-ink-300">{t("账户")}</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <dt className="text-ink-300">{t("邮箱")}</dt>
            <dd className="font-medium">{user.email}</dd>
            <dd className={user.emailVerified ? "text-xs text-emerald-300" : "text-xs text-amber-300"}>
              {t(user.emailVerified ? "已验证" : "未验证")}
            </dd>
          </div>
        </dl>
        <button
          onClick={() => { void signOut(); }}
          className="mt-4 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100"
        >
          {t("登出")}
        </button>
      </section>
      <ApiKeysSection />
    </>
  );
}

function ApiKeysSection() {
  const t = useT();
  const toast = useStudio(state => state.toast);
  const [keys, setKeys] = useState<ApiKeySummary[] | "error" | undefined>(undefined);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  /** Shown once, never stored: after this render the full key exists only where the user put it. */
  const [minted, setMinted] = useState<{ name: string; key: string } | undefined>(undefined);

  const load = (): void => {
    setKeys(undefined);
    listApiKeys()
      .then(setKeys)
      .catch(() => setKeys("error"));
  };

  useEffect(load, []);

  const create = (): void => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setBusy(true);
    createApiKey(trimmed)
      .then(key => {
        setMinted({ name: trimmed, key });
        setName("");
        load();
      })
      .catch((error: unknown) => toast("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const revoke = (entry: ApiKeySummary): void => {
    revokeApiKey(entry.id)
      .then(() => {
        toast("info", t("已撤销 {name}", { name: entry.name || entry.start }));
        load();
      })
      .catch((error: unknown) => toast("error", error instanceof Error ? error.message : String(error)));
  };

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-ink-300">{t("API 密钥")}</h2>
        <div className="flex-1" />
        <button
          onClick={load}
          className="rounded-lg border border-ink-700 px-3 py-1 text-xs text-ink-300 hover:text-ink-100"
        >
          {t("刷新")}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        {t("给 Agent、CLI 和自动化用的凭证：与你本人权限相同，看到的是同一套音色与素材库。请求带 Authorization: Bearer <key> 即可。")}
      </p>

      {minted && (
        <div className="mt-3 rounded-lg border border-emerald-400/40 bg-emerald-400/5 p-3">
          <div className="text-xs text-emerald-300">{t("这是 {name} 的密钥，只显示这一次：", { name: minted.name })}</div>
          <code className="mt-2 block break-all rounded-md bg-ink-800 px-2 py-1.5 text-xs">{minted.key}</code>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => { void navigator.clipboard?.writeText(minted.key).then(() => toast("info", t("已复制"))); }}
              className="rounded-md border border-ink-700 px-2 py-0.5 text-xs text-ink-300 hover:text-ink-100"
            >
              {t("复制")}
            </button>
            <button
              onClick={() => setMinted(undefined)}
              className="rounded-md border border-ink-700 px-2 py-0.5 text-xs text-ink-300 hover:text-ink-100"
            >
              {t("我已保存")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder={t("名称，例如 my-agent")}
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-sm outline-none focus:border-accent-500"
        />
        <button
          onClick={create}
          disabled={busy || name.trim() === ""}
          className="rounded-lg bg-accent-500 px-3 py-1.5 text-xs font-medium text-ink-900 disabled:opacity-50"
        >
          {t("创建密钥")}
        </button>
      </div>

      {keys === undefined && <p className="mt-3 text-sm text-ink-500">{t("探测中…")}</p>}
      {keys === "error" && <p className="mt-3 text-sm text-red-300">{t("无法获取密钥列表")}</p>}
      {Array.isArray(keys) && keys.length === 0 && (
        <p className="mt-3 text-sm text-ink-500">{t("还没有密钥。")}</p>
      )}
      {Array.isArray(keys) && keys.length > 0 && (
        <ul className="mt-3 space-y-2">
          {keys.map(entry => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-700/60 bg-ink-800/40 px-3 py-2 text-sm"
            >
              <span className="font-medium">{entry.name || t("未命名")}</span>
              <code className="rounded bg-ink-800 px-1.5 py-0.5 text-xs text-ink-300">{entry.start}…</code>
              <span className="text-xs text-ink-500">
                {entry.lastRequest ? t("最近使用 {when}", { when: entry.lastRequest.slice(0, 10) }) : t("尚未使用")}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => revoke(entry)}
                className="rounded-md border border-red-400/40 px-2 py-0.5 text-xs text-red-300 hover:text-red-200"
              >
                {t("撤销")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
