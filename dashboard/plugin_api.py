"""hermes-translate backend — dual-speed EN→zh translation.

Fast tier:  Google Translate / Microsoft Edge translator / MyMemory —
            seconds, good enough to read NOW (POST /fast-translate).
LLM tier:   the agent's own LLM, ordered-array protocol — higher quality,
            runs in the background to refine the fast results (POST /translate).

Config (data/config.json): {"fast_provider": "google" | "bing" | "mymemory"}
Caches:  data/fast.json, data/translations.json  (en -> zh, never overwritten)

Mounted at /api/plugins/hermes-translate/ inside the gateway process.
"""

import json
import logging
import os
import re
import threading
import time
import urllib.parse
import urllib.request

from fastapi import APIRouter

logger = logging.getLogger("hermes_cli.plugins.hermes_translate")

router = APIRouter()

_LOCK = threading.Lock()
_WORK_SEM = threading.Semaphore(3)  # never hog the gateway threadpool
_LLM_CACHE: dict[str, str] | None = None
_FAST_CACHE: dict[str, str] | None = None
_CONFIG: dict | None = None
_HITS = 0
_MISSES = 0
_FAST_OK = 0
_LAST_ERROR: str | None = None

_BATCH_LIMIT = 12
_BATCH_CHAR_BUDGET = 1800
_FAST_BATCH = 30

_SYSTEM_PROMPT = (
    "你是资深软件 UI 本地化翻译，把英文界面文本翻译成简体中文。"
    "要求：专业、简洁、符合中文软件界面习惯；保留原文的大小写专有名词（如 LAS、Python、GitHub）；"
    "固定术语表：Skill=技能，Tool=工具，Toolset=工具集，Gateway=网关，Session=会话，"
    "Provider=提供商，Profile=配置档案，Plugin=插件，Cron=定时任务，Memory=记忆，"
    "Command=命令，Workspace=工作区，Pane=面板，Artifact=产物，Theme=主题，"
    "Credential=凭据，Hook=钩子，Slash command=斜杠命令。"
    "输入是一个 JSON 数组。按顺序翻译每一条，输出格式严格如下（序号从 1 连续编号）：\n"
    "<<<1>>>\n第一条译文\n<<<2>>>\n第二条译文\n……\n"
    "译文可以包含任意字符（引号、逗号、反斜杠都无需转义）；"
    "不要输出原文，不要输出解释，不要输出序号以外的标记。"
)

_CODEISH = re.compile(r"[{}[\]<>|;=`_$\\]|https?://")
_CJK = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff]")

FAST_PROVIDERS = ("google", "bing", "mymemory")


# ── storage ──────────────────────────────────────────────────────────────────

def _data_dir():
    from hermes_constants import get_hermes_home

    p = get_hermes_home() / "plugins" / "hermes-translate" / "data"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _load_json(path, default):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else default
    except Exception:
        return default


def _save_json(path, data) -> None:
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass


def _llm_cache() -> dict[str, str]:
    global _LLM_CACHE
    with _LOCK:
        if _LLM_CACHE is None:
            _LLM_CACHE = {str(k): str(v) for k, v in
                          _load_json(_data_dir() / "translations.json", {}).items()}
        return _LLM_CACHE


def _fast_cache() -> dict[str, str]:
    global _FAST_CACHE
    with _LOCK:
        if _FAST_CACHE is None:
            _FAST_CACHE = {str(k): str(v) for k, v in
                           _load_json(_data_dir() / "fast.json", {}).items()}
        return _FAST_CACHE


def _config() -> dict:
    global _CONFIG
    with _LOCK:
        if _CONFIG is None:
            _CONFIG = _load_json(_data_dir() / "config.json", {})
            if _CONFIG.get("fast_provider") not in FAST_PROVIDERS:
                _CONFIG["fast_provider"] = "google"
        return _CONFIG


def is_translatable(text: str) -> bool:
    if not isinstance(text, str):
        return False
    s = text.strip()
    if len(s) < 2 or len(s) > 3000:
        return False
    cjk = len(_CJK.findall(s))
    if cjk / len(s) > 0.6:  # mostly Chinese already; mixed EN/CJK still goes
        return False
    if not any(ch.isspace() for ch in s):
        return False  # single token = identifier
    if sum(c.isalpha() for c in s) < 2:
        return False
    code = len(re.findall(r"[{}[\]<>|;=`_$\\~^]", s))
    if code / len(s) > 0.06:  # density rule: real code dies, prose survives
        return False
    return True


def _batches(strings: list[str], limit: int, char_budget: int) -> list[list[str]]:
    out: list[list[str]] = []
    cur: list[str] = []
    cur_len = 0
    for s in strings:
        if cur and (len(cur) >= limit or cur_len + len(s) > char_budget):
            out.append(cur)
            cur, cur_len = [], 0
        cur.append(s)
        cur_len += len(s)
    if cur:
        out.append(cur)
    return out


# ── fast machine-translation providers ───────────────────────────────────────

def _http_json(url: str, *, data: bytes | None = None, headers: dict | None = None, timeout: float = 15):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fast_google(strings: list[str]) -> dict[str, str]:
    """Keyless translate.googleapis.com — one call per batch via newline joining."""
    joined = "\n".join(strings)
    url = ("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto"
           "&tl=zh-CN&dt=t&q=" + urllib.parse.quote(joined))
    data = _http_json(url, timeout=20)
    translated = "".join(seg[0] for seg in data[0] if seg and seg[0])
    parts = translated.split("\n")
    if len(parts) == len(strings):
        return dict(zip(strings, parts))
    # newline preservation failed — per-string calls in parallel
    from concurrent.futures import ThreadPoolExecutor

    def one(s: str):
        d = _http_json("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto"
                       "&tl=zh-CN&dt=t&q=" + urllib.parse.quote(s), timeout=20)
        return (s, "".join(seg[0] for seg in d[0] if seg and seg[0]))

    out: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for s, t in pool.map(one, strings):
            if t:
                out[s] = t
    return out


def _fast_mymemory(strings: list[str]) -> dict[str, str]:
    """Per-string API — parallelized so one slow call can't stall the batch."""
    from concurrent.futures import ThreadPoolExecutor

    def one(s: str):
        url = ("https://api.mymemory.translated.net/get?langpair=en|zh-CN&q="
               + urllib.parse.quote(s[:480]))
        d = _http_json(url, timeout=20)
        t = ((d.get("responseData") or {}).get("translatedText") or "").strip()
        return (s, t) if t and "MYMEMORY WARNING" not in t.upper() else (s, "")

    out: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for s, t in pool.map(one, strings):
            if t:
                out[s] = t
    return out


# NOTE: the Microsoft Edge free-JWT endpoint (edge.microsoft.com/translate/auth)
# was removed upstream (404 as of 2026) — the "bing" engine is retired.
FAST_PROVIDERS = ("google", "mymemory")
_FAST_FUNCS = {"google": _fast_google, "mymemory": _fast_mymemory}


def _fast_translate(strings: list[str]) -> tuple[dict[str, str], str]:
    with _WORK_SEM:
        return _fast_translate_inner(strings)


def _fast_translate_inner(strings: list[str]) -> tuple[dict[str, str], str]:
    """Try the configured provider first, then FILL THE HOLES with the others —
    one engine's omissions/quota must not strand strings that another engine
    can translate."""
    order = [_config().get("fast_provider", "google")]
    order += [p for p in FAST_PROVIDERS if p not in order]
    out: dict[str, str] = {}
    used: list[str] = []
    remaining = list(strings)
    last_err: Exception | None = None
    for name in order:
        if not remaining:
            break
        try:
            got = _FAST_FUNCS[name](remaining)
            for en, zh in got.items():
                if zh:
                    out[en] = zh
            if got:
                used.append(name)
            remaining = [s for s in remaining if s not in out]
        except Exception as e:
            last_err = e
    if not out:
        raise RuntimeError(f"all fast providers failed ({last_err})")
    return out, "+".join(used)


# ── LLM tier (ordered-array protocol) ────────────────────────────────────────

def _marked_zh_list(content: str, n: int) -> list[str | None]:
    """Parse the <<<N>>> marker protocol — immune to quotes/backslashes in
    translations (the old JSON protocol died on unescaped quotes)."""
    content = (content or "").strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\n?", "", content)
        content = re.sub(r"\n?```$", "", content.strip())
    out: dict[int, str] = {}
    for m in re.finditer(r"<<<(\d+)>>>\s*\n?(.*?)(?=\n?\s*<<<\d+>>>|\n\s*\n|\Z)", content, re.S):
        zh = m.group(2).strip()
        if zh:
            out[int(m.group(1))] = zh
    return [out.get(i) for i in range(1, n + 1)]


def _ordered_zh_list(content: str, n: int) -> list[str]:
    content = (content or "").strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\n?", "", content)
        content = re.sub(r"\n?```$", "", content.strip())
    data = json.loads(content)
    if isinstance(data, dict):
        data = list(data.values())
    out: list[str] = []
    for item in data:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif isinstance(item, dict):
            zh = item.get("zh") or item.get("translation") or item.get("target") or item.get("译文")
            if isinstance(zh, str) and zh.strip():
                out.append(zh.strip())
    return out[:n]


def _direct_env_call(messages: list[dict]) -> str:
    """OpenAI-compatible call straight against the env-configured MiMo endpoint."""
    api_key = os.environ.get("XIAOMI_TP_API_KEY") or os.environ.get("XIAOMI_API_KEY")
    base_url = os.environ.get("XIAOMI_TP_BASE_URL") or os.environ.get("XIAOMI_BASE_URL")
    if not api_key or not base_url:
        raise RuntimeError("no env-based endpoint (XIAOMI_TP_* / XIAOMI_*) configured")
    model = os.environ.get("HERMES_TRANSLATE_MODEL") or "mimo-v2.6-pro"
    payload = json.dumps(
        {"model": model, "messages": messages, "temperature": 0, "max_tokens": 8000}
    ).encode("utf-8")
    data = _http_json(base_url.rstrip("/") + "/chat/completions", data=payload,
                      headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                      timeout=300)
    return data["choices"][0]["message"]["content"] or ""


def _llm_translate(strings: list[str]) -> dict[str, str]:
    with _WORK_SEM:
        return _llm_translate_inner(strings)


def _llm_translate_inner(strings: list[str]) -> dict[str, str]:
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(strings, ensure_ascii=False)},
    ]
    content = None
    direct_err: Exception | None = None
    if os.environ.get("XIAOMI_TP_API_KEY") or os.environ.get("XIAOMI_API_KEY"):
        try:
            content = _direct_env_call(messages)
        except Exception as e:
            direct_err = e
    if content is None:
        try:
            from agent.auxiliary_client import call_llm

            response = call_llm(task=None, temperature=0, max_tokens=4000, timeout=300, messages=messages)
            content = response.choices[0].message.content or ""
        except Exception as e:
            raise RuntimeError(f"direct call failed ({direct_err}); call_llm failed ({e})")
    zhs = _marked_zh_list(content, len(strings))
    if sum(1 for z in zhs if z) < len(strings):
        try:  # model may still answer in JSON — keep it as a lenient fallback
            jzhs = _ordered_zh_list(content, len(strings))
            zhs = [z or j for z, j in zip(zhs, list(jzhs) + [None] * len(strings))]
        except Exception:
            pass
    return {s: z for s, z in zip(strings, zhs) if z}


# ── routes ───────────────────────────────────────────────────────────────────

@router.get("/config")
def get_config():
    return {"fast_provider": _config().get("fast_provider", "google"), "providers": list(FAST_PROVIDERS)}


@router.post("/config")
def set_config(body: dict):
    with _LOCK:
        cfg = _config()
        name = body.get("fast_provider")
        if name in FAST_PROVIDERS:
            cfg["fast_provider"] = name
            _save_json(_data_dir() / "config.json", cfg)
    return {"fast_provider": _config().get("fast_provider")}


@router.post("/fast-translate")
def fast_translate(body: dict):
    global _FAST_OK, _LAST_ERROR
    strings = [s for s in (body.get("strings") or []) if isinstance(s, str)]
    cache = _fast_cache()
    result: dict[str, str] = {}
    todo: list[str] = []
    with _LOCK:
        for s in strings:
            if s in cache:
                result[s] = cache[s]
            elif is_translatable(s) and len(s) <= 600 and s not in todo:
                # long strings exceed GET-URL limits on keyless MT engines —
                # the LLM tier covers them via its fast-miss fallback
                todo.append(s)
    used = ""
    for batch in _batches(todo, _FAST_BATCH, 4000):
        try:
            got, used = _fast_translate(batch)
            with _LOCK:
                for en, zh in got.items():
                    cache[en] = zh
                    result[en] = zh
                    _FAST_OK += 1
        except Exception as e:
            _LAST_ERROR = f"{type(e).__name__}: {e}"
            logger.warning("hermes-translate: fast batch failed (%s)", _LAST_ERROR)
            break
    if todo:
        _save_json(_data_dir() / "fast.json", cache)
    logger.info("hermes-translate: FAST %d in, %d out, engine=%s, err=%s",
                len(strings), len(result), used or _config().get("fast_provider"), _LAST_ERROR)
    return {"translations": result, "count": len(result), "engine": used, "last_error": _LAST_ERROR}


@router.post("/translate")
def translate(body: dict):
    global _HITS, _MISSES, _LAST_ERROR
    cache = _llm_cache()
    strings = body.get("strings") or []
    strings = [s for s in strings if isinstance(s, str)]
    result: dict[str, str] = {}
    todo: list[str] = []
    with _LOCK:
        for s in strings:
            if s in cache:
                result[s] = cache[s]
                _HITS += 1
            elif is_translatable(s) and s not in todo:
                todo.append(s)
    for batch in _batches(todo, _BATCH_LIMIT, _BATCH_CHAR_BUDGET):
        try:
            translated = _llm_translate(batch)
            with _LOCK:
                for en, zh in translated.items():
                    cache[en] = zh
                    result[en] = zh
                    _MISSES += 1
        except Exception as e:
            _LAST_ERROR = f"{type(e).__name__}: {e}"
            logger.warning("hermes-translate: LLM batch failed (%s)", _LAST_ERROR)
            break
    if todo:
        _save_json(_data_dir() / "translations.json", cache)
    logger.info("hermes-translate: LLM %d in, %d hits, %d translated, err=%s",
                len(strings), _HITS, len(result), _LAST_ERROR)
    return {"translations": result, "count": len(result), "last_error": _LAST_ERROR}


@router.get("/dict")
def full_dict():
    return {"translations": dict(_llm_cache()), "fast": dict(_fast_cache())}


@router.get("/stats")
def stats():
    return {"llm_count": len(_llm_cache()), "fast_count": len(_fast_cache()),
            "hits": _HITS, "misses": _MISSES, "fast_ok": _FAST_OK,
            "fast_provider": _config().get("fast_provider"),
            "last_error": _LAST_ERROR, "ts": time.time()}
