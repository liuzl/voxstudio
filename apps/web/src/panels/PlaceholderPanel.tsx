export function PlaceholderPanel(props: { title: string; phase: string; description: string }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:px-8 md:py-16">
      <h1 className="text-2xl font-semibold">{props.title}</h1>
      <div className="mt-2 inline-block rounded-full border border-ink-700 px-3 py-1 text-xs text-ink-300">
        {props.phase}
      </div>
      <p className="mt-6 leading-relaxed text-ink-300">{props.description}</p>
      <p className="mt-4 text-sm text-ink-500">
        分期与验收门见 <code>docs/web-studio.md</code>。
      </p>
    </div>
  );
}
