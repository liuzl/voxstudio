#!/usr/bin/env python
"""Fit `voxcore.text._CPS` -- the per-script speech rate table -- against a live engine.

Run this when you change the default reference voice. Speaking rate is a property of the
voice as much as of the script, and every chunk-duration estimate is downstream of it.

    uv run python tools/measure_speech_rates.py                    # all scripts
    uv run python tools/measure_speech_rates.py --repeats 5        # tighter, slower
    uv run python tools/measure_speech_rates.py Han Latin          # just these

Method, and why it is this and not something simpler (see docs/chunking.md):

- **Every paragraph is synthesized `--repeats` times.** The engine is not reproducible:
  the same text, voice and sampler settings give durations that spread 13-25% run to run,
  and occasionally far more. A single generation per paragraph measures that noise, not
  the speech rate. This is the one thing you must not economise on -- an early revision
  sampled once and its rates were wrong in the second significant figure.
- **The repeats are reduced by their median, not their mean.** The engine's outliers are
  one-sided: `retry_badcase` silently re-synthesizes a generation it judges bad, so a run
  can come back twice as long as its siblings, never half as long. One such run in four
  drags a mean by 20% and a median by nothing.
- **Paragraphs, not sentences.** A short utterance carries no inter-sentence pause and
  runs measurably faster. The regime we budget in is a ~30s chunk, so the samples have to
  be long enough to contain pauses. An early revision fitted sentences and produced rates
  10-20% too fast.
- **Duration is measured after `trim_edge_silence`**, with the same speech-relative gate
  the joiner uses. The model pads its output; that padding is not speech.
- **Rates are pooled, not averaged.** `total_chars / total_seconds` over the paragraphs'
  medians, because the budget asks how long *N characters* take, so a long paragraph
  should carry more weight than a short one.
- **Requests go out serially.** The engine's peak VRAM grows with generation length and
  torch does not hand it back.
- **One paragraph per script is held out** and never fits anything. The error printed
  against it is the only honest statement this script can make about accuracy -- and even
  that error is floored by the run-to-run spread, which is printed beside it.

`--raw out.json` writes every individual duration. A fit is fifteen minutes of GPU; never
throw the samples away just because you want to try a different estimator.

Japanese is the one script that cannot be pooled: its text interleaves kanji with kana,
and `est_seconds` charges the kanji at the Han rate. So the kana rate is solved for under
that same assumption rather than read off the paragraph.
"""

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

from voxcore import load_config, read_wav, trim_edge_silence
from voxcore.clients.tts import TTSClient
from voxcore.text import _script_of  # the table this script fits is keyed on it

# Three paragraphs per script; the third is held out for validation. Ordinary prose, of
# roughly a full chunk's length. Replace these if you have text closer to your own domain
# -- the rate depends on register, and a news bulletin is not read like a bedtime story.
PARAGRAPHS: dict[str, list[str]] = {
    "Han": [
        "人工智能正在改变我们与机器交流的方式，语音合成是其中最直观的一环。过去要让机器说出自然的句子，需要录制大量语料，如今只要几秒钟的参考音就够了。这项变化来得比很多人预想的都快。",
        "今天的天气很好，我们约在下午三点，在图书馆门口见面吧。如果你临时有事，提前给我发个消息就行，我可以改到晚上。图书馆六点关门，所以最好不要太晚。",
        "语音技术的下一步是双向对话。机器不仅要说得自然，还要听得准确，并且在合适的时机开口。这三件事任何一件做不好，整段对话都会显得别扭。",
    ],
    "Kana": [
        "音声合成の技術はここ数年で大きく進歩しました。以前は自然な発話を作るために膨大な録音が必要でしたが、今では数秒の参考音声があれば十分です。この変化は多くの人の予想よりも早く訪れました。",
        "明日の午後、駅の近くの喫茶店で打ち合わせをしましょう。もし急な用事が入ったら、前もって連絡をください。夕方に変更しても構いません。",
        "次の課題は双方向の対話です。機械は自然に話すだけでなく、正確に聞き取り、適切な間合いで口を開く必要があります。",
    ],
    "Hangul": [
        "음성 합성 기술은 최근 몇 년 사이에 크게 발전했습니다. 예전에는 자연스러운 발화를 만들기 위해 방대한 녹음이 필요했지만, 이제는 몇 초의 참조 음성이면 충분합니다. 이 변화는 많은 사람의 예상보다 빠르게 찾아왔습니다.",
        "내일 오후에 도서관 앞에서 만나기로 해요. 갑자기 일이 생기면 미리 연락을 주세요. 저녁으로 옮겨도 괜찮습니다. 도서관은 여섯 시에 문을 닫습니다.",
        "다음 과제는 양방향 대화입니다. 기계는 자연스럽게 말할 뿐만 아니라 정확하게 듣고 적절한 순간에 입을 열어야 합니다.",
    ],
    # Latin is deliberately three different languages. It is the widest bucket in the
    # table -- English, German, Vietnamese, Indonesian, Turkish, Swahili all land here --
    # and if they disagreed, keying the table on script would not be defensible.
    "Latin": [
        "Speech synthesis has improved dramatically over the past few years, and natural sounding voices are now within reach of anyone. Producing a convincing voice once required hours of studio recording; a few seconds of reference audio is now enough. The shift arrived faster than most people expected.",
        "Die Sprachsynthese hat sich in den vergangenen Jahren erheblich verbessert, und natürlich klingende Stimmen sind heute für jeden erreichbar. Früher brauchte man stundenlange Aufnahmen, heute genügen wenige Sekunden Referenzton.",
        "Công nghệ tổng hợp giọng nói đã tiến bộ vượt bậc trong vài năm trở lại đây. Trước kia muốn có một giọng đọc tự nhiên thì phải thu âm rất nhiều, còn bây giờ chỉ cần vài giây âm thanh tham chiếu là đủ.",
    ],
    "Cyrillic": [
        "Технологии синтеза речи за последние несколько лет заметно продвинулись вперёд. Раньше для естественного звучания требовались часы студийной записи, теперь достаточно нескольких секунд эталонного звука. Эти перемены наступили быстрее, чем многие ожидали.",
        "Давайте встретимся завтра днём возле библиотеки. Если у вас появятся срочные дела, предупредите меня заранее. Можно перенести встречу на вечер, но библиотека закрывается в шесть часов.",
        "Следующая задача — это двусторонний диалог. Машина должна не только говорить естественно, но и точно слышать собеседника.",
    ],
    "Greek": [
        "Η τεχνολογία σύνθεσης ομιλίας έχει προοδεύσει σημαντικά τα τελευταία χρόνια. Παλαιότερα χρειάζονταν ώρες ηχογράφησης σε στούντιο, ενώ σήμερα αρκούν λίγα δευτερόλεπτα ήχου αναφοράς. Η αλλαγή ήρθε πιο γρήγορα από όσο περίμεναν οι περισσότεροι.",
        "Ας συναντηθούμε αύριο το απόγευμα μπροστά από τη βιβλιοθήκη. Αν προκύψει κάτι επείγον, ενημερώστε με νωρίτερα. Μπορούμε να το μεταθέσουμε για το βράδυ.",
        "Το επόμενο ζητούμενο είναι ο αμφίδρομος διάλογος. Η μηχανή πρέπει να μιλάει φυσικά και ταυτόχρονα να ακούει με ακρίβεια.",
    ],
    "Arabic": [
        "لقد تطورت تقنيات تركيب الكلام بشكل كبير خلال السنوات القليلة الماضية. كان الأمر يتطلب ساعات من التسجيل في الاستوديو، أما اليوم فتكفي بضع ثوان من الصوت المرجعي. جاء هذا التحول أسرع مما توقع كثيرون.",
        "لنلتق غدا بعد الظهر أمام المكتبة. إذا طرأ عليك أمر عاجل فأخبرني مسبقا. يمكننا تأجيل الموعد إلى المساء، لكن المكتبة تغلق في السادسة.",
        "المهمة التالية هي الحوار المتبادل. لا يكفي أن تتحدث الآلة بطبيعية، بل عليها أن تسمع بدقة وأن تتكلم في اللحظة المناسبة.",
    ],
    "Hebrew": [
        "טכנולוגיית סינתזת הדיבור התקדמה מאוד בשנים האחרונות. בעבר נדרשו שעות של הקלטה באולפן, וכיום מספיקות כמה שניות של שמע ייחוס. השינוי הגיע מהר יותר משציפו רבים.",
        "בוא ניפגש מחר אחר הצהריים מול הספרייה. אם יתעורר משהו דחוף, הודע לי מראש. אפשר לדחות את הפגישה לערב, אבל הספרייה נסגרת בשש.",
        "המשימה הבאה היא שיחה דו כיוונית. המכונה צריכה לא רק לדבר בטבעיות אלא גם לשמוע במדויק.",
    ],
    "Devanagari": [
        "पिछले कुछ वर्षों में वाक् संश्लेषण की तकनीक बहुत आगे बढ़ी है। पहले स्वाभाविक आवाज़ बनाने के लिए घंटों की रिकॉर्डिंग चाहिए होती थी, अब कुछ सेकंड का संदर्भ ध्वनि ही पर्याप्त है। यह बदलाव अधिकांश लोगों की अपेक्षा से जल्दी आया।",
        "चलो कल दोपहर पुस्तकालय के सामने मिलते हैं। अगर तुम्हें कोई ज़रूरी काम आ जाए तो पहले से बता देना। हम शाम को भी मिल सकते हैं, लेकिन पुस्तकालय छह बजे बंद हो जाता है।",
        "अगला काम दोतरफ़ा संवाद का है। मशीन को केवल स्वाभाविक बोलना नहीं, ठीक से सुनना भी आना चाहिए।",
    ],
    "Thai": [
        "เทคโนโลยีการสังเคราะห์เสียงพูดก้าวหน้าไปมากในช่วงไม่กี่ปีที่ผ่านมา เมื่อก่อนการสร้างเสียงที่เป็นธรรมชาติต้องใช้การบันทึกเสียงหลายชั่วโมง แต่ตอนนี้ใช้เสียงอ้างอิงเพียงไม่กี่วินาทีก็เพียงพอแล้ว การเปลี่ยนแปลงนี้มาเร็วกว่าที่หลายคนคาดไว้",
        "พรุ่งนี้บ่ายเรามาเจอกันหน้าห้องสมุดนะ ถ้ามีธุระด่วนช่วยบอกล่วงหน้าด้วย เราเลื่อนไปตอนเย็นก็ได้ แต่ห้องสมุดปิดหกโมง",
        "โจทย์ถัดไปคือการสนทนาสองทาง เครื่องต้องไม่เพียงพูดได้เป็นธรรมชาติ แต่ต้องฟังได้แม่นยำด้วย",
    ],
    "Lao": [
        "ເຕັກໂນໂລຊີການສັງເຄາະສຽງເວົ້າໄດ້ກ້າວໜ້າຢ່າງຫຼວງຫຼາຍໃນຊຸມປີຜ່ານມາ ແຕ່ກ່ອນການສ້າງສຽງທີ່ເປັນທຳມະຊາດຕ້ອງໃຊ້ການບັນທຶກສຽງຫຼາຍຊົ່ວໂມງ ແຕ່ດຽວນີ້ໃຊ້ສຽງອ້າງອີງພຽງແຕ່ບໍ່ເທົ່າໃດວິນາທີກໍພຽງພໍແລ້ວ",
        "ມື້ອື່ນຕອນບ່າຍພວກເຮົາພົບກັນຢູ່ໜ້າຫ້ອງສະໝຸດເດີ ຖ້າມີວຽກດ່ວນຊ່ວຍບອກລ່ວງໜ້າແດ່ ພວກເຮົາເລື່ອນໄປຕອນແລງກໍໄດ້ ແຕ່ຫ້ອງສະໝຸດປິດຫົກໂມງ",
        "ວຽກຕໍ່ໄປແມ່ນການສົນທະນາສອງທາງ ເຄື່ອງຈັກຕ້ອງບໍ່ພຽງແຕ່ເວົ້າໄດ້ຢ່າງທຳມະຊາດ ແຕ່ຕ້ອງຟັງໄດ້ຢ່າງແມ່ນຍຳອີກ",
    ],
    "Khmer": [
        "បច្ចេកវិទ្យាសំយោគសំឡេងបានរីកចម្រើនយ៉ាងខ្លាំងក្នុងប៉ុន្មានឆ្នាំចុងក្រោយនេះ។ កាលពីមុនការបង្កើតសំឡេងធម្មជាតិត្រូវការការថតជាច្រើនម៉ោង ប៉ុន្តែឥឡូវនេះសំឡេងយោងត្រឹមតែប៉ុន្មានវិនាទីគឺគ្រប់គ្រាន់ហើយ។",
        "ថ្ងៃស្អែករសៀលយើងជួបគ្នានៅមុខបណ្ណាល័យ។ បើមានការងារបន្ទាន់សូមប្រាប់ជាមុន។ យើងអាចពន្យារពេលទៅល្ងាចក៏បាន ប៉ុន្តែបណ្ណាល័យបិទនៅម៉ោងប្រាំមួយ។",
        "កិច្ចការបន្ទាប់គឺការសន្ទនាទ្វេទិស។ ម៉ាស៊ីនមិនត្រឹមតែត្រូវនិយាយដោយធម្មជាតិទេ ថែមទាំងត្រូវស្តាប់ឱ្យបានត្រឹមត្រូវផង។",
    ],
    "Myanmar": [
        "စကားသံပေါင်းစပ်ဖန်တီးမှုနည်းပညာသည် လွန်ခဲ့သောနှစ်အနည်းငယ်အတွင်း များစွာတိုးတက်လာသည်။ အရင်က သဘာဝကျသောအသံတစ်ခုရရှိရန် နာရီပေါင်းများစွာ အသံသွင်းရသည်။ ယခုအခါ စက္ကန့်အနည်းငယ်မျှသော ကိုးကားအသံဖြင့် လုံလောက်ပြီဖြစ်သည်။",
        "မနက်ဖြန်နေ့လယ်ပိုင်းတွင် စာကြည့်တိုက်ရှေ့၌ တွေ့ကြမယ်။ အရေးကြီးကိစ္စရှိလျှင် ကြိုတင်အကြောင်းကြားပါ။ ညနေပိုင်းသို့ ရွှေ့လိုက်လည်း ရပါသည်။",
        "နောက်တစ်ဆင့်မှာ နှစ်လမ်းသွားစကားပြောဆိုမှုဖြစ်သည်။ စက်သည် သဘာဝကျစွာ ပြောနိုင်ရုံမျှမက တိကျစွာ နားထောင်နိုင်ရမည်။",
    ],
}


def spoken_seconds(tts: TTSClient, text: str, attempts: int = 3) -> float:
    """Synthesize once and return the duration of the speech, edge silence removed.

    A full fit is over a hundred generations and a quarter of an hour. The engine will
    occasionally hang one of them past the client timeout -- retry rather than throw away
    everything measured so far.
    """
    for attempt in range(1, attempts + 1):
        try:
            samples, rate = read_wav(tts.speech(" ".join(text.split())))
            return len(trim_edge_silence(samples, rate)) / rate
        except Exception as exc:
            if attempt == attempts:
                raise
            print(f"  retry {attempt}/{attempts - 1} after {type(exc).__name__}",
                  file=sys.stderr, flush=True)
            time.sleep(2 * attempt)
    raise AssertionError("unreachable")


def script_counts(text: str) -> dict[str, int]:
    """Per-script character counts, script-less characters inheriting the running script.

    Mirrors how `_char_seconds` charges them, which is what makes the kana solve below
    consistent with what `est_seconds` will actually do.
    """
    counts: dict[str, int] = {}
    current: str | None = None
    leading = 0
    for ch in " ".join(text.split()):
        script = _script_of(ch)
        if script is None:
            if current is None:
                leading += 1
            else:
                counts[current] = counts.get(current, 0) + 1
            continue
        counts[script] = counts.get(script, 0) + 1 + (leading if current is None else 0)
        leading = 0
        current = script
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("scripts", nargs="*", default=[], help="scripts to fit (default: all)")
    parser.add_argument("--repeats", type=int, default=5, metavar="N",
                        help="generations per paragraph; the engine is not reproducible. "
                             "An odd count gives the median something to sit on "
                             "(default: 5)")
    parser.add_argument("--raw", metavar="PATH",
                        help="write every individual duration here as JSON")
    args = parser.parse_args()

    wanted = args.scripts or list(PARAGRAPHS)
    unknown = [s for s in wanted if s not in PARAGRAPHS]
    if unknown:
        raise SystemExit(f"unknown script(s): {', '.join(unknown)}")
    if args.repeats < 1:
        raise SystemExit("--repeats must be at least 1")
    if args.repeats < 3:
        print("warning: fewer than 3 repeats cannot see past the engine's own spread\n",
              file=sys.stderr)

    cfg = load_config()
    runs: dict[str, list[dict]] = {}

    with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts:
        for script in wanted:
            runs[script] = []
            for i, para in enumerate(PARAGRAPHS[script]):
                kind = "val" if i == len(PARAGRAPHS[script]) - 1 else "fit"
                seconds = [spoken_seconds(tts, para) for _ in range(args.repeats)]
                chars = len(" ".join(para.split()))
                runs[script].append({"kind": kind, "chars": chars, "seconds": seconds})
                middle = statistics.median(seconds)
                print(f"{script:11} {kind}  {chars:>4}ch  median {middle:6.2f}s  "
                      f"spread {_spread(seconds):5.1%}  cps {chars / middle:5.2f}  "
                      f"[{' '.join(f'{s:.1f}' for s in sorted(seconds))}]", flush=True)

    if args.raw:
        Path(args.raw).write_text(json.dumps(runs, ensure_ascii=False, indent=1),
                                  encoding="utf-8")
        print(f"\nraw durations -> {args.raw}")

    rates = _fit(wanted, runs)

    print("\n=== held-out validation ===")
    print(f"{'script':11} {'chars':>5} {'actual':>8} {'est':>8} {'error':>8} {'spread':>8}")
    worst = 0.0
    for script in wanted:
        held_out = runs[script][-1]
        actual = statistics.median(held_out["seconds"])
        estimate = _est_with(rates, PARAGRAPHS[script][-1])
        error = (estimate - actual) / actual
        worst = max(worst, abs(error))
        print(f"{script:11} {held_out['chars']:>5} {actual:>7.2f}s {estimate:>7.2f}s "
              f"{error:>+7.1%} {_spread(held_out['seconds']):>7.1%}")
    print(f"\nworst absolute error: {worst:.1%}  "
          f"(positive = over-estimated = shorter chunks = the safe direction)")
    print("The `spread` column is the engine's own run-to-run variation on that very "
          "paragraph.\nAn error inside it says nothing about the rate table.")

    print("\nPaste into core/voxcore/text.py:\n")
    print("_CPS = {")
    for script, cps in sorted(rates.items(), key=lambda kv: -kv[1]):
        print(f'    "{script}": {cps:.1f},')
    print("}")


def _fit(wanted: list[str], runs: dict[str, list[dict]]) -> dict[str, float]:
    """Pooled chars/sec per script, over the paragraphs' median durations."""
    rates: dict[str, float] = {}
    for script in wanted:
        if script == "Kana":
            continue
        fit = [r for r in runs[script] if r["kind"] == "fit"]
        rates[script] = (sum(r["chars"] for r in fit)
                         / sum(statistics.median(r["seconds"]) for r in fit))

    if "Kana" in wanted:
        if "Han" not in rates:
            raise SystemExit("fitting Kana needs Han in the same run: it charges kanji at "
                             "the Han rate, exactly as est_seconds does")
        kana_chars = kana_seconds = 0.0
        for para, row in zip(PARAGRAPHS["Kana"], runs["Kana"]):
            if row["kind"] != "fit":
                continue
            counts = script_counts(para)
            kana_chars += counts.get("Kana", 0)
            kana_seconds += statistics.median(row["seconds"]) - counts.get("Han", 0) / rates["Han"]
        rates["Kana"] = kana_chars / kana_seconds
    return rates


def _spread(samples: list[float]) -> float:
    """Peak-to-peak, relative to the median. Zero for a single sample, and honestly so."""
    middle = statistics.median(samples)
    return (max(samples) - min(samples)) / middle if middle else 0.0


def _est_with(rates: dict[str, float], text: str) -> float:
    """`est_seconds` under a candidate table, by running the real one over it.

    Swapping the module's table rather than reimplementing the estimate means the
    validation exercises the code that production will run, inheritance rules and all.
    """
    from voxcore import text as textmod

    saved_cps, saved_default = textmod._CPS, textmod._DEFAULT_CPS
    textmod._CPS, textmod._DEFAULT_CPS = rates, min(rates.values())
    try:
        return textmod.est_seconds(text)
    finally:
        textmod._CPS, textmod._DEFAULT_CPS = saved_cps, saved_default


if __name__ == "__main__":
    main()
