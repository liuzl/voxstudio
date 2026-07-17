import { useT } from "../i18n";

export function PlaceholderPanel(props: { title: string; phase: string; description: string }) {
  const t = useT();
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8 md:py-16">
      <h1 className="text-2xl font-semibold">{props.title}</h1>
      <div className="mt-2 inline-block rounded-full border border-ink-700 px-3 py-1 text-xs text-ink-300">
        {props.phase}
      </div>
      <p className="mt-6 leading-relaxed text-ink-300">{props.description}</p>
      <p className="mt-4 text-sm text-ink-500">
        {t("分期与验收门见 docs/web-studio.md。")}
      </p>
    </div>
  );
}
