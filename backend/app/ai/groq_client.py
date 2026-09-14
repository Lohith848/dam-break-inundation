"""
groq_client.py
--------------
Groq API client for the AI Copilot.

Responsibilities:
  - Initialize Groq client from GROQ_API_KEY env var (loaded from project .env)
  - Retry on rate limits (exponential backoff)
  - Timeout handling
  - Structured logging
  - Streaming support (groq SDK and httpx fallback)
  - Error handling

Never exposes API keys — they are read from the environment only.

Note on imports: the optional dependencies (groq, httpx, python-dotenv) are
imported ONCE at module level inside guarded try/except blocks. This gives
editors/type checkers a single resolution point and keeps graceful runtime
fallbacks (no groq -> httpx; no dotenv -> built-in parser).
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Generator, Optional

logger = logging.getLogger("dam_sim.ai.groq")

# ---------------------------------------------------------------------------
# Optional dependencies — single guarded import site for each package.
# Each degrades to None so the code can fall back at runtime.
# ---------------------------------------------------------------------------
try:
    import httpx  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

try:
    from dotenv import load_dotenv as _dotenv_load  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    _dotenv_load = None  # type: ignore[assignment]

try:
    from groq import Groq  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    Groq = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Module-level client cache. Typed as Any because it holds either a groq SDK
# client or the httpx fallback client below.
# ---------------------------------------------------------------------------
_groq_client: Any = None

# ---------------------------------------------------------------------------
# HTTP Fallback Client (for environments where the groq package fails)
# ---------------------------------------------------------------------------


class _Delta:
    """Mimics groq SDK delta shape: chunk.choices[0].delta.content"""

    def __init__(self, content: Optional[str]) -> None:
        self.content = content


class _StreamChoice:
    """Mimics groq SDK stream chunk shape: chunk.choices[0].delta"""

    def __init__(self, choice: dict) -> None:
        delta_data = choice.get("delta") or {}
        self.delta = _Delta(delta_data.get("content"))
        self.choices = [self]


class _Message:
    """Mimics groq SDK message shape: choice.message.content"""

    def __init__(self, content: str) -> None:
        self.content = content


class _Choice:
    """Mimics groq SDK choice shape: choice.message"""

    def __init__(self, data: dict) -> None:
        msg = data.get("message") or {}
        self.message = _Message(msg.get("content", ""))


class _Response:
    """Mimics groq SDK response shape: response.choices[0].message.content"""

    def __init__(self, data: dict) -> None:
        self.choices = [_Choice(c) for c in data.get("choices", [])]


class _HttpxGroqClient:
    """Minimal Groq API client using httpx directly (OpenAI-compatible API)."""

    BASE_URL = "https://api.groq.com/openai/v1"

    def __init__(self, api_key: str, timeout: float = 30.0) -> None:
        if httpx is None:  # pragma: no cover — guarded by _get_client()
            raise ImportError("httpx is not installed")
        self._client = httpx.Client(
            base_url=self.BASE_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=timeout,
        )

    def chat_completions_create(self, **kwargs: Any) -> Any:
        """Send a chat completion request (streaming or not)."""
        payload = {
            "model": kwargs.get("model") or "openai/gpt-oss-120b",
            "messages": kwargs.get("messages", []),
            "temperature": kwargs.get("temperature", 0.3),
            "max_tokens": kwargs.get("max_tokens", 2048),
        }
        if kwargs.get("stream"):
            payload["stream"] = True
            # Use raw stream so we can parse SSE lines incrementally
            req = self._client.build_request("POST", "/chat/completions", json=payload)
            response = self._client.send(req, stream=True)
            response.raise_for_status()
            return self._iter_sse(response)
        resp = self._client.post("/chat/completions", json=payload)
        resp.raise_for_status()
        return _Response(resp.json())

    @staticmethod
    def _iter_sse(response: Any) -> Generator[_StreamChoice, None, None]:
        """Parse an OpenAI-compatible SSE stream into chunk objects."""
        with response:
            for line in response.iter_lines():
                if not line:
                    continue
                text = line.strip()
                if not text.startswith("data:"):
                    continue
                data = text[len("data:"):].strip()
                if data == "[DONE]":
                    return
                try:
                    chunk_data = json.loads(data)
                    choices = chunk_data.get("choices") or []
                    if choices:
                        yield _StreamChoice(choices[0])
                except (ValueError, KeyError):
                    continue


# ---------------------------------------------------------------------------
# Environment Loading (safe — never hardcode keys in source)
# ---------------------------------------------------------------------------

# Optional override only; the real key must live in .env / environment.
DEFAULT_GROQ_API_KEY = ""


def _load_dotenv() -> None:
    """Find and load .env file if GROQ_API_KEY is not already set.

    Search order: cwd, then directories upward from this file (up to the
    project root), so the backend works whether you run uvicorn from the
    project root or from backend/.
    """
    if os.environ.get("GROQ_API_KEY"):
        return
    if _dotenv_load is not None:
        try:
            _dotenv_load()
            if os.environ.get("GROQ_API_KEY"):
                return
        except Exception:
            pass

    # Built-in fallback parser (no python-dotenv dependency required)
    here = Path(__file__).resolve()
    search_dirs = [
        Path.cwd(),
        here.parent,                      # backend/app/ai
        here.parent.parent,               # backend/app
        here.parent.parent.parent,        # backend
        here.parent.parent.parent.parent, # project root
    ]
    for d in search_dirs:
        env_file = d / ".env"
        if env_file.is_file():
            try:
                with open(env_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip("'\"")
                            # Override only when unset OR set to an empty string.
                            # Some systems export empty placeholders like GROQ_API_KEY=
                            # which must not shadow the real value from .env.
                            if k and v and not os.environ.get(k):
                                os.environ[k] = v
                if os.environ.get("GROQ_API_KEY"):
                    logger.info("Loaded GROQ_API_KEY from %s", env_file)
                    return
            except Exception:
                pass


def _get_client() -> Any:
    """Lazy-initialize the Groq client (groq SDK first, httpx fallback)."""
    global _groq_client
    if _groq_client is not None:
        return _groq_client

    _load_dotenv()
    api_key = os.environ.get("GROQ_API_KEY", "") or DEFAULT_GROQ_API_KEY
    if not api_key:
        logger.warning("GROQ_API_KEY not set — AI features disabled. Add GROQ_API_KEY=<your key> to the project .env file.")
        return None

    # Preferred: groq SDK
    if Groq is not None:
        try:
            _groq_client = Groq(api_key=api_key)
            logger.info("Groq client initialized successfully (groq SDK)")
            return _groq_client
        except TypeError as e:
            # e.g. Python 3.14 incompatibility in some groq SDK versions
            logger.warning("groq SDK incompatible (%s), using httpx fallback", e)
        except Exception as e:
            logger.warning("groq init failed (%s), using httpx fallback", e)

    # Fallback: raw httpx (module-level import; no per-call import needed)
    if httpx is None:
        logger.error("Neither groq nor httpx available — pip install groq httpx")
        return None
    try:
        _groq_client = _HttpxGroqClient(api_key=api_key)
        logger.info("Groq httpx fallback client initialized")
        return _groq_client
    except Exception as e:
        logger.error("Failed to initialize httpx fallback: %s", e)
        return None


def is_available() -> bool:
    """Check if Groq client is available and configured."""
    return _get_client() is not None


# ---------------------------------------------------------------------------
# Model Resolution — Groq rotates model IDs; never hardcode one.
# ---------------------------------------------------------------------------

# Preferred chat models in order. The first one available to the API key wins.
# Override with GROQ_MODEL=<model_id> in .env to pin a specific model.
DEFAULT_MODEL = "openai/gpt-oss-120b"
_MODEL_PREFERENCE = [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "qwen/qwen3.6-27b",
    "groq/compound-mini",
    "groq/compound",
]
_resolved_model: Optional[str] = None


def _list_model_ids(client: Any) -> list[str]:
    """Return model IDs available to this API key (SDK or httpx fallback)."""
    try:
        return [m.id for m in client.models.list().data]
    except AttributeError:
        # httpx fallback: raw GET /models
        try:
            resp = client._client.get("/models")
            resp.raise_for_status()
            return [m["id"] for m in resp.json().get("data", [])]
        except Exception as e:
            logger.warning("Could not list Groq models: %s", e)
            return []
    except Exception as e:
        logger.warning("Could not list Groq models: %s", e)
        return []


def resolve_model() -> str:
    """Resolve the best available Groq chat model for this API key."""
    global _resolved_model
    if _resolved_model:
        return _resolved_model

    # Explicit override always wins
    override = os.environ.get("GROQ_MODEL", "")
    if override:
        _resolved_model = override
        logger.info("Using GROQ_MODEL override: %s", override)
        return _resolved_model

    client = _get_client()
    if not client:
        return DEFAULT_MODEL

    available = set(_list_model_ids(client))
    for candidate in _MODEL_PREFERENCE:
        if candidate in available:
            _resolved_model = candidate
            logger.info("Resolved Groq chat model: %s", candidate)
            return _resolved_model

    if available:
        # Last resort: first non-guard, non-audio model we can find
        skip = ("guard", "whisper", "orpheus", "safeguard")
        chat_models = sorted(m for m in available if not any(s in m for s in skip))
        if chat_models:
            _resolved_model = chat_models[0]
            logger.info("Resolved Groq chat model (fallback): %s", _resolved_model)
            return _resolved_model

    _resolved_model = DEFAULT_MODEL
    logger.warning("No Groq chat models detected — defaulting to %s", DEFAULT_MODEL)
    return _resolved_model


# ---------------------------------------------------------------------------
# Chat Completion with Retry
# ---------------------------------------------------------------------------

def chat_completion(
    messages: list[dict],
    model: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    max_retries: int = 3,
    timeout: int = 30,
) -> Optional[str]:
    """
    Send a chat completion request to Groq with retry logic.

    Parameters
    ----------
    messages : list of {"role": "system"|"user"|"assistant", "content": "..."}
    model : Groq model identifier
    temperature : response randomness (0.0-1.0)
    max_tokens : maximum response length
    max_retries : number of retries on rate limit / transient errors
    timeout : request timeout in seconds

    Returns
    -------
    Response text string, or None on failure.
    """
    client = _get_client()
    if not client:
        logger.error("Groq client not available")
        return None

    if not model:
        model = resolve_model()

    last_error: Optional[Exception] = None
    for attempt in range(1, max_retries + 1):
        t0 = time.time()
        try:
            if isinstance(client, _HttpxGroqClient):
                response = client.chat_completions_create(
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            else:
                response = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    timeout=timeout,
                )
            latency_ms = (time.time() - t0) * 1000
            content = response.choices[0].message.content
            if not content:
                # Reasoning models (e.g. gpt-oss) can consume the entire budget
                # with hidden reasoning — retry with a larger allowance.
                logger.warning(
                    "Groq returned empty content (attempt %d) — "
                    "retrying with doubled max_tokens", attempt)
                max_tokens = min(max_tokens * 2, 8192)
                continue
            logger.info("Groq response: %d words in %.0f ms (attempt %d)",
                        len(content.split()), latency_ms, attempt)
            return content

        except Exception as e:
            last_error = e
            latency_ms = (time.time() - t0) * 1000
            error_str = str(e).lower()

            if "rate_limit" in error_str or "429" in error_str:
                wait = min(2 ** attempt, 10)
                logger.warning("Rate limited (attempt %d/%d), waiting %ds",
                               attempt, max_retries, wait)
                time.sleep(wait)
                continue
            elif "timeout" in error_str:
                logger.warning("Request timeout (attempt %d/%d)", attempt, max_retries)
                continue
            elif "401" in error_str or "invalid_api_key" in error_str or "unauthorized" in error_str:
                logger.error("Groq authentication failed — check GROQ_API_KEY in .env")
                return None
            elif "model_not_found" in error_str or "does not exist" in error_str:
                logger.error("Groq model %r not available — set GROQ_MODEL in .env", model)
                return None
            else:
                logger.error("Groq API error (attempt %d): %s (%.0fms)",
                             attempt, e, latency_ms)
                if attempt == max_retries:
                    return None
                time.sleep(1)

    logger.error("All %d retries exhausted (last error: %s)", max_retries, last_error)
    return None


# ---------------------------------------------------------------------------
# Streaming Chat Completion
# ---------------------------------------------------------------------------

def chat_completion_stream(
    messages: list[dict],
    model: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 2048,
) -> Generator[str, None, None]:
    """
    Stream a chat completion response from Groq.

    Yields text chunks as they arrive. Works with both the groq SDK and
    the httpx fallback client.
    """
    client = _get_client()
    if not client:
        yield "Error: Groq client not available. Please set GROQ_API_KEY in the .env file."
        return

    if not model:
        model = resolve_model()

    try:
        if isinstance(client, _HttpxGroqClient):
            stream = client.chat_completions_create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
            )
        else:
            stream = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
            )
        for chunk in stream:
            choices = getattr(chunk, "choices", None)
            if choices:
                delta = getattr(choices[0], "delta", None)
                content = getattr(delta, "content", None) if delta else None
                if content:
                    yield content

    except Exception as e:
        logger.error("Groq streaming error: %s", e)
        yield f"\n\nError: {e}"


# ---------------------------------------------------------------------------
# Convenience wrappers
# ---------------------------------------------------------------------------

def analyze_simulation(sim_data: dict, system_prompt: str, user_prompt: str) -> Optional[str]:
    """Build messages and call Groq for simulation analysis."""
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    return chat_completion(messages, temperature=0.2, max_tokens=3000)


def chat_with_context(
    conversation_history: list[dict],
    system_prompt: str,
) -> Optional[str]:
    """Continue a conversation with the AI copilot."""
    messages = [{"role": "system", "content": system_prompt}] + conversation_history
    return chat_completion(messages, temperature=0.3, max_tokens=2048)


def generate_report(sim_data: dict, system_prompt: str, user_prompt: str) -> Optional[str]:
    """Generate a detailed report from simulation results."""
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    return chat_completion(messages, temperature=0.1, max_tokens=4000)
