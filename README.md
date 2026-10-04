# Stony, local AI companion

Stony runs in your browser, with a small Python server and Ollama doing inference on this PC. The app server binds only to `127.0.0.1`; it has no account, cloud chat API, remote JavaScript, or telemetry. The only online feature is optional NPR headlines, fetched only when you click the headlines button.

## Recommended model for this PC

For an i5-6500, 16 GB RAM, and no GPU, start with **`qwen3:4b`**. It is a more practical quality/speed balance for conversation than an 8B model on a four-core CPU. The standard Ollama tag uses its default quantization; expect a few GB of disk space. Actual speed depends on the PC and context length, so treat this as a sensible starting point rather than a benchmark guarantee.

Open a terminal and run:

```powershell
ollama pull qwen3:4b
```

Ollama must be running in the background. On Windows, open the Ollama app from the Start menu if the Stony status says Ollama is offline. Stony also shows installed Ollama models in the model picker. Your existing `qwen2.5-coder:3b` is selected as a temporary fallback when available; it is quick, but it is code-focused. Your `qwen3:8b` can be tried for stronger answers, with noticeably slower CPU responses. Avoid the 30B model on this machine.

## Start Stony

Double-click `run.bat`, then open <http://127.0.0.1:8765> if it does not open automatically. Keep the terminal window open while using Stony. Python 3.10 or newer is recommended; the server uses only the Python standard library.

Stony binds only to `127.0.0.1`. This Windows account currently has `OLLAMA_HOST=0.0.0.0:11434`, so the existing Ollama tray service also accepts connections on a wildcard interface. Stony sends requests only to `127.0.0.1`; to make Ollama itself loopback-only, quit its tray app and start it from PowerShell with:

```powershell
$env:OLLAMA_HOST = '127.0.0.1:11434'
ollama serve
```

Keep that PowerShell window open, then start Stony. This override applies to that Ollama process; changing the Windows user environment variable is needed to make the setting persist across logins.

## Memory and awareness

- **Short-term memory:** recent messages in the active conversation are included up to the context limit. Full chat history stays local in SQLite.
- **Conversation links:** each thread has a `/chat/<id>` URL. Opening or refreshing that URL restores the same local transcript; browser Back/Forward follows the selected thread.
- **Automatic long-term memory:** enabled by default. Clear stable preferences, identity details, and ongoing goals may be saved; transient details are skipped. Say “remember …” or “forget …” in chat, switch automatic saving off, or inspect/delete notes. Passwords, keys, and sensitive details are not auto-saved.
- **Context length:** 4K is the default to leave RAM for Windows and CPU inference. Choose 8K–16K for longer context if performance remains comfortable.
- **Streaming:** replies arrive token-by-token using local SSE; no cloud relay is involved.
- **Rich replies:** Markdown headings, lists, tables, quotes, links, and fenced code render locally. The app sanitizes model-generated HTML and blocks remote images/embeds; code blocks include syntax highlighting and copy controls.
- **Theme and motion:** use the sun/moon control in the header to switch between light and dark themes. The choice is saved in this browser; entrance and streaming animations respect reduced-motion settings.
- **PC awareness:** Stony gets the local clock, OS, logical processor count, system RAM usage, and uptime when answering. The running-app scan is manual, names-only, and stays out of chat unless you check “Share this list in my next message.” Stony never reads screen contents, window titles, or files.
- **News:** click the arrow next to Headlines to fetch NPR's public RSS feed. Turn on “Include fetched headlines in chat” to share those fetched headlines with Stony. This is the only feature that makes a network request.
- **Answer transparency:** leave **Brief rationale** checked to ask for a concise, user-facing explanation and key assumptions. This is a summary, not hidden chain-of-thought.

## Local data

Chats and memories are stored in `stony_data/stony.sqlite3` beside the app. Back up or remove that folder to manage all saved data. Ollama stores model files separately in its own local model directory.
