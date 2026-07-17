import { useEffect, useMemo } from "react";
import { listEngines, listVoices } from "../lib/api";
import { useStudio } from "../store";
import { useT } from "../i18n";

/**
 * The one voice select: engine-grouped, 默认 falls to the role default, and picking a
 * voice carries its owning engine so the request routes to the right instance.
 */
export function VoicePicker({ value, engine, onChange, className }: {
  value: string;
  engine: string;
  onChange: (voice: string, engine?: string) => void;
  className?: string;
}) {
  const t = useT();
  const voicesList = useStudio(state => state.voicesList);
  const setVoicesList = useStudio(state => state.setVoicesList);
  const enginesList = useStudio(state => state.enginesList);
  const setEnginesList = useStudio(state => state.setEnginesList);

  useEffect(() => {
    if (voicesList.length === 0) listVoices().then(setVoicesList).catch(() => {});
    if (enginesList.length === 0) listEngines().then(setEnginesList).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byEngine = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const entry of voicesList) {
      groups.set(entry.engine, [...(groups.get(entry.engine) ?? []), entry.id]);
    }
    // The user's own voices lead: an engine whose bank holds anything beyond the fixed
    // preset naming (the bank's 我的音色 heuristic) sorts ahead of preset-only engines.
    const preset = /^(zf|zm|af|am|bf|bm)_/;
    const rank = (ids: string[]): number => (ids.some(id => !preset.test(id)) ? 0 : 1);
    return [...groups.entries()].sort((a, b) => rank(a[1]) - rank(b[1]));
  }, [voicesList]);

  // The empty option routes to the tts role default — a fact from the registry, not
  // whichever group happens to be listed first.
  const roleDefault = enginesList.find(entry => entry.roles.includes("tts"))?.name;

  return (
    <label className="flex items-center gap-2 text-xs text-ink-300">
      {t("音色")}
      <select
        value={value ? `${engine}::${value}` : ""}
        onChange={event => {
          const [nextEngine, id] = event.target.value.split("::");
          onChange(id ?? "", nextEngine || undefined);
        }}
        className={`rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-xs text-ink-100 ${className ?? "max-w-48"}`}
      >
        <option value="">{t("默认（{engine}）", { engine: roleDefault || t("引擎默认") })}</option>
        {byEngine.map(([groupEngine, ids]) => (
          <optgroup key={groupEngine} label={groupEngine}>
            {ids.map(id => (
              <option key={`${groupEngine}::${id}`} value={`${groupEngine}::${id}`}>
                {id}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
