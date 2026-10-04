from __future__ import annotations

import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import app


class FakeResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self.body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class MemoryPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute(
            "CREATE TABLE memories(id INTEGER PRIMARY KEY, content TEXT UNIQUE, created_at TEXT)"
        )

    def tearDown(self) -> None:
        self.db.close()

    def test_auto_save_respects_preference_and_transience(self) -> None:
        saved = app.apply_memory_policy(self.db, "I prefer tea", True)
        self.assertEqual(saved["content"], "I prefer tea")
        self.assertEqual(app.apply_memory_policy(self.db, "I prefer tea", True)["added"], False)
        self.assertIsNone(app.apply_memory_policy(self.db, "okay good", True))
        self.assertEqual(
            app.apply_memory_policy(self.db, "I prefer tea tomorrow", True)["reason"],
            "transient",
        )

    def test_explicit_save_and_sensitive_refusal(self) -> None:
        saved = app.apply_memory_policy(self.db, "Remember that I enjoy quiet mornings", True)
        self.assertEqual(saved["content"], "I enjoy quiet mornings")
        skipped = app.apply_memory_policy(self.db, "Remember my password is example", True)
        self.assertEqual(skipped["reason"], "sensitive")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM memories").fetchone()[0], 1)

    def test_do_not_save_and_forget_commands(self) -> None:
        self.db.execute("INSERT INTO memories(content, created_at) VALUES (?, ?)", ("I prefer tea", "now"))
        self.assertEqual(app.apply_memory_policy(self.db, "Don't remember that", True)["reason"], "user")
        self.assertEqual(app.apply_memory_policy(self.db, "Forget that", True)["count"], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM memories").fetchone()[0], 0)

    def test_memory_retrieval_uses_saved_details(self) -> None:
        self.db.execute(
            "INSERT INTO memories(content, created_at) VALUES (?, ?)",
            ("The user chose the name Luna for themselves.", "now"),
        )
        self.assertTrue(
            any("Luna" in memory for memory in app.memory_matches(self.db, "what name did you give me?"))
        )


class ChatServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.db_path_patcher = patch.object(
            app, "DB_PATH", Path(self.temporary_directory.name) / "test.sqlite3"
        )
        self.db_path_patcher.start()
        app.initialize_db()
        self.conversation_id = str(uuid.uuid4())
        with app.connect_db() as db:
            db.execute(
                "INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (self.conversation_id, "New conversation", "now", "now"),
            )
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.StonyHandler)
        self.server.daemon_threads = True
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2)
        self.db_path_patcher.stop()
        self.temporary_directory.cleanup()

    def post_stream(self, message: str) -> str:
        request = urllib.request.Request(
            f"{self.base_url}/api/chat/stream",
            data=json.dumps(
                {
                    "conversation_id": self.conversation_id,
                    "message": message,
                    "model": "test-model",
                    "context_size": 4096,
                    "auto_save_memory": True,
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.read().decode("utf-8")

    def test_deep_link_restores_app_and_transcript(self) -> None:
        with urllib.request.urlopen(f"{self.base_url}/chat/{self.conversation_id}") as response:
            self.assertIn("Stony | Local companion", response.read().decode("utf-8"))
        with app.connect_db() as db:
            db.execute(
                "INSERT INTO messages(conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
                (self.conversation_id, "user", "hello", "now"),
            )
        with urllib.request.urlopen(f"{self.base_url}/api/chats/{self.conversation_id}") as response:
            self.assertEqual(json.loads(response.read())[0]["content"], "hello")
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(f"{self.base_url}/chat/not-a-uuid")
        self.assertEqual(error.exception.code, 404)

    def test_sse_orders_memory_receipt_before_reply_and_persists(self) -> None:
        with patch.object(app, "stream_ollama_chat", return_value=iter(["Tea", " noted."])):
            with patch.object(app, "generate_conversation_title", return_value="Tea Preference"):
                stream = self.post_stream("I prefer tea")
        self.assertLess(stream.index("event: memory"), stream.index('"type": "token"'))
        self.assertIn('"content": "I prefer tea"', stream)
        self.assertIn('event: title\ndata: {"title": "Tea Preference"}', stream)
        with app.connect_db() as db:
            self.assertEqual(db.execute("SELECT title FROM conversations").fetchone()[0], "Tea Preference")
            self.assertEqual(
                db.execute("SELECT content FROM messages WHERE role='assistant'").fetchone()[0],
                "Tea noted.",
            )

    def test_sse_announces_duplicate_memory_too(self) -> None:
        with patch.object(app, "stream_ollama_chat", return_value=iter(["Okay."])):
            with patch.object(app, "generate_conversation_title", return_value="Tea Preference"):
                self.post_stream("I prefer tea")
                duplicate_stream = self.post_stream("I prefer tea")
        self.assertIn('"action": "saved", "added": false', duplicate_stream)
        self.assertIn('"content": "I prefer tea"', duplicate_stream)

    def test_sse_reports_sensitive_memory_skip(self) -> None:
        with patch.object(app, "stream_ollama_chat", return_value=iter(["I won't store that."])):
            stream = self.post_stream("Remember my password is example")
        self.assertIn('"action": "skipped", "reason": "sensitive"', stream)
        with app.connect_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM memories").fetchone()[0], 0)

    def test_malformed_json_is_a_client_error(self) -> None:
        request = urllib.request.Request(
            f"{self.base_url}/api/chats",
            data=b"{bad json",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 400)


class TitleGenerationTests(unittest.TestCase):
    def test_title_generation_uses_small_local_context_and_cleans_output(self) -> None:
        response = FakeResponse({"message": {"content": "**Planning a Quiet Weekend**\n"}})
        with patch("app.urllib.request.urlopen", return_value=response) as open_url:
            title = app.generate_conversation_title("test-model", "Help me plan", "Here is a plan.")
        self.assertEqual(title, "Planning a Quiet Weekend")
        request = open_url.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["options"]["num_ctx"], 1024)
        self.assertEqual(payload["options"]["num_predict"], 18)
        self.assertFalse(payload["stream"])


if __name__ == "__main__":
    unittest.main()
