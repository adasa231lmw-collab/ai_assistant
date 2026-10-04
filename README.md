# Stony: Status and Roadmap

Stony is a local-first chat companion: a browser UI, a Python standard-library server, SQLite storage, and Ollama for local inference. This document separates shipped behavior from future work and defines testable gates for improving it on the target PC. “Full-proof” is not a realistic guarantee for an AI; the goal is a system with explicit limits, repeatable checks, and recoverable local data.

## Target PC and Model

- CPU: Intel Core i5-6500, 4 cores / 4 threads
- RAM: 16 GB DDR4
- GPU: none
- Storage: 512 GB SSD

The recommended starting model is **`qwen3:4b`**, using Ollama's default quantization. It is not currently among the models installed on this PC, so install it with:

```powershell
ollama pull qwen3:4b
```

The current fallback, `qwen2.5-coder:3b`, is lightweight but code-focused and may be less natural for open-ended conversation. `qwen3:8b` is available for comparison but will be slower on CPU and competes with Windows for RAM. Avoid the installed 30B model on this machine. These are starting recommendations, not measured speed or quality guarantees. Model downloads and history use SSD space; check available disk space before adding more models.

Stony defaults to a 4K context and caps a response at 768 generated tokens. Larger contexts are configurable, but their speed and memory cost have not been benchmarked on this PC. Context assembly currently uses recent messages and a character-based approximation, not the selected model's tokenizer.

## Shipped

- Local chat through Ollama, streamed token-by-token over SSE.
- SQLite conversation history and user-editable long-term notes.
- `/chat/<id>` URLs that restore a transcript on reload and follow browser history.
- Short local-model-generated conversation titles, requested once after the first reply with a small context/output budget.
- Automatic memory decisions for a limited set of recognizable stable-fact phrases, plus explicit “remember” and “forget” commands. Sensitive terms are excluded; inline status above Stony's reply reports save, duplicate, skip, or forget actions.
- Local Markdown rendering with bundled parser/sanitizer/highlighter assets. Unsafe HTML and remote embeds are blocked.
- Light/dark theme, responsive viewport layout, right-aligned user messages, larger readable chat text, and reduced-motion support.
- Local awareness for clock, OS, processor count, RAM use, and uptime. Running process names are scanned only on request and shared with a message only after opt-in.
- Optional NPR RSS headlines, fetched only after the user clicks the news control.
- A standard-library regression suite: `python -m unittest discover -s tests -v`.

## Limits to Keep Visible

- Memory selection is currently rule/cue based, not semantic understanding. It will miss paraphrases, may save an overly broad stable statement, and cannot infer that a user accepted a model suggestion unless the user states that fact clearly. Review and deletion controls remain important.
- Saved memories are plain SQLite data, not encrypted. Anyone with access to this Windows account and data folder can read them.
- The current context does not summarize arbitrarily long chats; older messages eventually fall outside the prompt window.
- “Proactive” behavior is conversational prompting only. There are no background watchers, scheduled check-ins, reminders, or automatic screen/app capture.
- Process awareness is limited to manually scanned process names. It does not include window titles, screen contents, or file access.
- Stony binds to `127.0.0.1`, but Ollama's own listener may be broader depending on `OLLAMA_HOST`. For loopback-only Ollama, start it from PowerShell with `$env:OLLAMA_HOST = '127.0.0.1:11434'` before `ollama serve`.
- The only intentional internet feature is the manually requested NPR RSS fetch. Normal inference is sent to the local Ollama endpoint.

## Roadmap and Acceptance Gates

### 1. Establish a Hardware Baseline

Measure the recommended model and current fallback on this exact PC before changing model defaults. Record model/tag, quantization, context, time-to-first-token, generated tokens/second, peak RAM, and cold versus warm run. Include short conversation, long context, title generation, and an idle Windows baseline.

**Done when:** each model has repeatable measurements from at least five runs; a restart/reload test stays within available RAM; the recommended default is chosen from measured conversational quality and latency, not model size alone. Keep 4K as the default until 8K/16K passes the RAM and latency gate.

### 2. Make Memory Model-Assisted and Auditable

Replace phrase-cue-only selection with a small local-model decision that returns structured JSON: `save`, `update`, `forget`, `skip`, a concise candidate fact, confidence, and reason. Keep the current explicit commands as deterministic safety overrides. Deduplicate and update existing facts instead of accumulating contradictions. Distinguish stable user facts/preferences from temporary state and conversation-only context. Never auto-save credentials or sensitive personal data.

**Done when:** a labeled test set covers direct statements, paraphrases, accepted suggestions, contradictions, temporary details, secrets, ambiguous text, opt-out requests, and multilingual input; false-save and missed-save rates are published; every change has an inline receipt; every memory is inspectable/editable/deletable; restart preserves the expected state. Run the classifier locally and measure its additional CPU/RAM/latency cost.

### 3. Improve Long-Conversation Recall

Use bounded summaries plus searchable memory retrieval rather than sending the entire transcript. Start with SQLite full-text search; evaluate a small CPU-friendly embedding model only if lexical retrieval misses too many relevant facts. Keep provenance (conversation/message source) and timestamps so Stony can distinguish current facts from old ones.

**Done when:** a fixed recall benchmark answers questions from old turns, reports uncertainty when retrieval finds nothing, respects corrections/deletions, and remains within a measured memory/latency budget at 4K and 8K.

### 4. Evaluate Behavior, Not Just Syntax

Create a versioned local prompt suite for greetings, casual conversation, identity/ownership, emotional support, user preferences, “what did we discuss?”, uncertainty, safety, and tool/PC awareness. Compare model versions without storing real private conversations in test fixtures. Score repetition, factual consistency, unwanted follow-up questions, helpful initiative, and latency.

**Done when:** each model or prompt change passes the same regression suite; repeated greetings do not loop; the assistant never claims to inspect unavailable PC data; personal facts are consistent with retrieved memory; failures have saved reproduction cases.

### 5. Add Explicit Proactive Features

Represent goals, tasks, and reminders as user-approved local records. Offer opt-in check-ins at user-selected times; do not add background process monitoring or network access by default. Provide pause, edit, delete, and “why did you surface this?” controls.

**Done when:** every proactive event maps to a saved user goal or an enabled schedule, can be disabled/deleted, survives restart, and has tests for missed, repeated, and timezone-shifted reminders. No proactive action may execute commands or access files without a separate explicit permission design.

### 6. Harden Privacy, Recovery, and Packaging

Audit all API routes for bounds, origin/CSRF exposure, concurrency, and error leakage. Consider a per-run local token if the server ever binds beyond loopback. Add a documented SQLite backup/export and restore process. Keep generated databases, credentials, and local model files out of Git. Pin and review bundled browser libraries and licenses.

**Done when:** malformed/oversized inputs, interrupted streams, simultaneous chats, database lock/restart, backup/restore, and hostile Markdown tests pass; only loopback listeners are present in the local-only profile; repository scans find no personal chat data or credentials.

## Verification Commands

```powershell
python -m py_compile app.py
node --check app.js
python -m unittest discover -s tests -v
```

These checks cover syntax and the current local API/memory/SSE regressions. They do not prove model quality or hardware performance; use the roadmap benchmarks for those claims.

## Run and Data

Run `run.bat`, then open <http://127.0.0.1:8765>. Keep its terminal open while using Stony. Python 3.10+ is recommended. Chats and memories live in `stony_data/stony.sqlite3`; back up that folder for recovery. It is ignored by Git and is not included in the repository. Ollama stores model files separately.
