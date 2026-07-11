"""VoxCPM2 TTS HTTP 服务. 端点:
  GET    /                     简单 Web UI(文本 + 参考音上传)
  GET    /health
  POST   /tts                  JSON {text, voice, ref_path?, cfg_value?, timesteps?} -> audio/wav
  POST   /tts_form             multipart {text, voice, cfg_value, timesteps, ref_file?} -> audio/wav
  POST   /v1/audio/speech      OpenAI 兼容 {input, voice?, response_format?} -> audio/wav
  POST   /v1/voices            具名音色注册 multipart {id, text, audio} -> 元数据(201)
  GET    /v1/voices            列出全部已注册音色
  GET    /v1/voices/{id}       查音色元数据
  DELETE /v1/voices/{id}       删音色
voice 取值: clone(默认音) / design(零样本,text 前加 (English 描述)) / <已注册 id>.
单 GPU 模型, threading.Lock 串行化生成.
"""
import io, os, re, json, threading, tempfile, subprocess, shutil
from datetime import datetime, timezone
import soundfile as sf
import torch
from fastapi import FastAPI, Response, Form, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from voxcpm import VoxCPM

# Runtime layout is configurable via env (no hard-coded absolute paths):
#   VOXCPM2_BASE    base dir holding the model + default reference voice (default: ~/tts-eval-voxcpm2)
#   VOXCPM2_MODEL   model dir              (default: $VOXCPM2_BASE/pretrained_models/VoxCPM2)
#   VOXCPM2_REF     default reference wav  (default: $VOXCPM2_BASE/voice.wav)
#   VOXCPM2_VOICES  named-voice registry   (default: $VOXCPM2_BASE/voices)
BASE = os.environ.get("VOXCPM2_BASE") or os.path.expanduser("~/tts-eval-voxcpm2")
MODEL_PATH = os.environ.get("VOXCPM2_MODEL") or os.path.join(BASE, "pretrained_models/VoxCPM2")
DEFAULT_REF = os.environ.get("VOXCPM2_REF") or os.path.join(BASE, "voice.wav")
VOICES_DIR = os.environ.get("VOXCPM2_VOICES") or os.path.join(BASE, "voices")
os.makedirs(VOICES_DIR, exist_ok=True)

print("Loading VoxCPM2 ...", flush=True)
model = VoxCPM.from_pretrained(MODEL_PATH, load_denoiser=False)
SR = model.tts_model.sample_rate
print(f"VoxCPM2 loaded, sample_rate={SR}", flush=True)
lock = threading.Lock()
app = FastAPI()

_CUDA = torch.cuda.is_available()


def _generate(text, ref, cfg, ts, prompt=None, seed=None):
    """prompt = (wav_path, transcript). Conditions on an aligned text/audio example, which
    the model follows for tempo; `ref` alone only carries timbre. Output excludes the prompt."""
    kw = {"prompt_wav_path": prompt[0], "prompt_text": prompt[1]} if prompt else {}
    with lock:
        wav = model.generate(text=text, reference_wav_path=ref, cfg_value=cfg,
                             inference_timesteps=ts, seed=seed, **kw)
        if _CUDA:
            # Peak VRAM grows with the length of one generation, and the caching allocator
            # keeps that peak forever -- a co-tenant model on the same card never gets it
            # back. Hand it over here, while we still hold the lock and nothing is in
            # flight. Pair with PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True (see the
            # systemd unit): this call returns what was cached *after* a generation, but
            # only expandable segments bound the peak *during* one.
            torch.cuda.empty_cache()
    buf = io.BytesIO(); sf.write(buf, wav, SR, format="WAV"); buf.seek(0)
    return buf.read()

def _ref_from_upload(up: UploadFile):
    """保存上传音频 -> ffmpeg 转 16k mono wav, 返回临时路径(调用方负责删)。"""
    suffix = os.path.splitext(up.filename or "")[1] or ".bin"
    raw = tempfile.NamedTemporaryFile(suffix=suffix, delete=False); raw.write(up.file.read()); raw.close()
    out = raw.name + ".16k.wav"
    r = subprocess.run(["ffmpeg", "-y", "-i", raw.name, "-ar", "16000", "-ac", "1", out], capture_output=True)
    os.unlink(raw.name)
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError("ffmpeg 转码失败: " + r.stderr.decode()[-200:])
    return out

# ---- named-voice registry (mirrors VoxCPM.cpp voxcpm-server /v1/voices) ----
_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

def _vdir(vid):  return os.path.join(VOICES_DIR, vid)
def _vref(vid):  return os.path.join(_vdir(vid), "ref.wav")
def _vmeta(vid): return os.path.join(_vdir(vid), "meta.json")

def _now(): return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

def _check_id(vid):
    if not _ID_RE.match(vid or ""):
        raise HTTPException(400, {"error": {"code": "invalid_voice_id",
            "message": "id must match [A-Za-z0-9._-]{1,64}", "type": "invalid_request_error"}})

def _read_meta(vid):
    with open(_vmeta(vid), encoding="utf-8") as f:
        return json.load(f)

def resolve_voice(voice):
    """voice -> reference wav path (or None for zero-shot 'design'); raises 404 for unknown id."""
    if voice == "design":
        return None
    if voice == "clone":
        return DEFAULT_REF
    if os.path.exists(_vref(voice)):
        return _vref(voice)
    raise HTTPException(400, {"error": {"code": "voice_not_found",
        "message": "Unknown voice id.", "type": "invalid_request_error"}})

def resolve_prompt(voice):
    """A registered voice also has a transcript of its reference audio. Passing both as a
    prompt (rather than the audio alone) gives the model an aligned tempo example."""
    if voice in ("clone", "design") or not os.path.exists(_vmeta(voice)):
        return None
    text = (_read_meta(voice) or {}).get("prompt_text") or ""
    return (_vref(voice), text) if text.strip() else None

@app.get("/health")
def health():
    return {"status": "ok", "sample_rate": SR}

@app.post("/v1/voices", status_code=201)
def create_voice(id: str = Form(...), text: str = Form(...), audio: UploadFile = File(...)):
    _check_id(id)
    ref16k = _ref_from_upload(audio)          # ffmpeg -> 16k mono temp wav
    try:
        os.makedirs(_vdir(id), exist_ok=True)
        shutil.move(ref16k, _vref(id))
        info = sf.info(_vref(id))
        existed = os.path.exists(_vmeta(id))
        created = _read_meta(id)["created_at"] if existed else _now()
        meta = {"id": id, "prompt_text": text,
                "prompt_audio_length": round(info.frames / info.samplerate, 3),
                "sample_rate": info.samplerate, "created_at": created, "updated_at": _now()}
        with open(_vmeta(id), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
        return meta
    finally:
        if os.path.exists(ref16k):
            os.unlink(ref16k)

@app.get("/v1/voices")
def list_voices():
    out = []
    for vid in sorted(os.listdir(VOICES_DIR)):
        if os.path.exists(_vmeta(vid)):
            out.append(_read_meta(vid))
    return {"voices": out}

@app.get("/v1/voices/{vid}")
def get_voice(vid: str):
    if not os.path.exists(_vmeta(vid)):
        raise HTTPException(404, {"error": {"code": "voice_not_found",
            "message": "Unknown voice id.", "type": "invalid_request_error"}})
    return _read_meta(vid)

@app.delete("/v1/voices/{vid}")
def delete_voice(vid: str):
    if not os.path.isdir(_vdir(vid)):
        raise HTTPException(404, {"error": {"code": "voice_not_found",
            "message": "Unknown voice id.", "type": "invalid_request_error"}})
    shutil.rmtree(_vdir(vid))
    return {"id": vid, "deleted": True}

class TTSReq(BaseModel):
    text: str
    voice: str = "clone"
    ref_path: str | None = None
    cfg_value: float = 2.0
    timesteps: int = 10
    seed: int | None = None

@app.post("/tts")
def tts(r: TTSReq):
    # explicit ref_path wins; otherwise resolve clone/design/<registered id>
    ref = r.ref_path if r.ref_path else resolve_voice(r.voice)
    return Response(_generate(r.text, ref, r.cfg_value, r.timesteps, seed=r.seed), media_type="audio/wav")

@app.post("/tts_form")
def tts_form(text: str = Form(...), voice: str = Form("clone"),
             cfg_value: float = Form(2.0), timesteps: int = Form(10),
             seed: int | None = Form(None),
             ref_file: UploadFile = File(None)):
    tmp = None
    try:
        if voice == "clone" and ref_file and ref_file.filename:
            ref = _ref_from_upload(ref_file); tmp = ref     # per-call upload overrides default
        else:
            ref = resolve_voice(voice)                       # clone/design/<registered id>
        return Response(_generate(text, ref, cfg_value, timesteps, seed=seed), media_type="audio/wav")
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)

class OAIReq(BaseModel):
    input: str
    voice: str = "clone"
    response_format: str = "wav"
    model: str | None = None
    cfg_value: float = 2.0
    timesteps: int = 10
    seed: int | None = None
    prosody_prompt: bool = False   # condition on the voice's reference transcript too

@app.post("/v1/audio/speech")
def oai_speech(r: OAIReq):
    ref = resolve_voice(r.voice)   # clone(默认音) / design(零样本) / <已注册 id>
    prompt = resolve_prompt(r.voice) if r.prosody_prompt else None
    return Response(_generate(r.input, ref, r.cfg_value, r.timesteps, prompt, seed=r.seed),
                    media_type="audio/wav")

@app.get("/", response_class=HTMLResponse)
def index():
    return HTML

HTML = """<!doctype html><html lang=zh><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>VoxCPM2 TTS</title><style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:20px}label{display:block;margin:12px 0 4px;font-weight:600;font-size:14px}
textarea{width:100%;height:120px;font-size:15px;padding:8px;box-sizing:border-box}
select,input[type=number],input[type=file]{font-size:14px;padding:6px}
.row{display:flex;gap:16px;flex-wrap:wrap;align-items:end}
button{margin-top:16px;font-size:15px;padding:10px 22px;background:#2563eb;color:#fff;border:0;border-radius:6px;cursor:pointer}
button:disabled{background:#9ca3af}#st{margin-left:12px;font-size:14px;color:#555}
#out{margin-top:18px}audio{width:100%}.hint{font-size:12px;color:#777;font-weight:400}
</style></head><body>
<h1>VoxCPM2 语音合成</h1>
<label>文本 <span class=hint>design 模式可在开头加 (描述) 前缀，如 (warm male voice)</span></label>
<textarea id=text placeholder="输入要合成的文本…">你好，这是 VoxCPM2 的网页测试。</textarea>
<div class=row>
<div><label>音色模式</label>
<select id=voice>
<option value=clone>克隆（默认音色或上传参考音）</option>
<option value=design>Voice Design（纯文字描述，无需参考音）</option>
</select></div>
<div><label>cfg_value</label><input id=cfg type=number value=2.0 step=0.1 style=width:80px></div>
<div><label>timesteps</label><input id=ts type=number value=10 step=1 style=width:80px></div>
</div>
<div id=refwrap><label>参考音（可选，clone 模式；mp3/wav/m4a 均可，留空用默认音色）</label>
<input id=ref type=file accept="audio/*"></div>
<button id=go onclick=gen()>合成</button><span id=st></span>
<div id=out></div>
<script>
const $=id=>document.getElementById(id);
$('voice').onchange=()=>{$('refwrap').style.display=$('voice').value=='clone'?'block':'none'};
async function gen(){
  $('go').disabled=true;$('st').textContent='合成中…（首次/长文本稍慢）';$('out').innerHTML='';
  const fd=new FormData();
  fd.append('text',$('text').value);fd.append('voice',$('voice').value);
  fd.append('cfg_value',$('cfg').value);fd.append('timesteps',$('ts').value);
  if($('voice').value=='clone'&&$('ref').files[0])fd.append('ref_file',$('ref').files[0]);
  try{
    const t0=Date.now();
    const r=await fetch('/tts_form',{method:'POST',body:fd});
    if(!r.ok){throw new Error('HTTP '+r.status+' '+(await r.text()).slice(0,200))}
    const blob=await r.blob();const url=URL.createObjectURL(blob);
    $('out').innerHTML='<audio controls autoplay src="'+url+'"></audio><br><a download="voxcpm2.wav" href="'+url+'">下载 WAV</a>';
    $('st').textContent='完成 '+((Date.now()-t0)/1000).toFixed(1)+'s';
  }catch(e){$('st').textContent='失败: '+e.message}
  $('go').disabled=false;
}
</script></body></html>"""
