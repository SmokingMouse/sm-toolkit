# /// script
# requires-python = ">=3.10"
# dependencies = ["jsonschema==4.26.0"]
# ///
"""Regression tests against freshly generated official schemas."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("wire_schema", Path(__file__).with_name("codex-wire-schema.py"))
sys.dont_write_bytecode = True
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WireSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="as-wire-schema-test-")
        cls.schema = Path(cls.directory.name)
        subprocess.run(["codex", "app-server", "generate-json-schema", "--experimental", "--out", str(cls.schema)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def frames(self):
        return [
            {"connection": 1, "direction": "TUI>AS", "id": 1, "method": "thread/loaded/list"},
            {"connection": 2, "direction": "TUI>AS", "id": 1, "method": "thread/name/set"},
            {"connection": 1, "direction": "AS>TUI", "id": 1, "result": {"data": [], "nextCursor": None}},
            {"connection": 2, "direction": "AS>TUI", "id": 1, "result": {}},
            {"connection": 1, "direction": "AS>TUI", "method": "warning", "params": {"message": "该线程为 claude，已沿用 sonnet", "threadId": "thread"}},
            {"connection": 1, "direction": "AS>TUI", "id": "card", "method": "item/tool/requestUserInput", "params": {
                "threadId": "thread", "turnId": "turn", "itemId": "item", "isBlocking": True,
                "questions": [{"id": "permission", "header": "Read", "question": "Allow?", "isOther": False, "isSecret": False,
                               "options": [{"label": "allow", "description": "允许"}, {"label": "deny", "description": "拒绝"}]}]}},
        ]

    def test_all_three_kinds_and_connection_scoped_ids(self):
        result = module.validate_wire(self.schema, self.frames())
        self.assertTrue(result["clean"], result)
        self.assertEqual(result["by_kind"], {"response": 2, "notification": 1, "serverRequest": 1})

    def test_missing_blocking_and_other_required_card_fields_fail(self):
        for field in ["isBlocking", "threadId", "turnId", "itemId", "questions"]:
            with self.subTest(field=field):
                frames = self.frames()
                del frames[-1]["params"][field]
                self.assertFalse(module.validate_wire(self.schema, frames)["clean"])

    def test_invalid_response_and_notification_fail(self):
        for index, field, value in [(2, "result", {"data": 42}), (4, "params", {"message": 42})]:
            frames = self.frames()
            frames[index][field] = value
            self.assertFalse(module.validate_wire(self.schema, frames)["clean"])

    def test_orphan_unknown_and_empty_wire_fail_closed(self):
        frames = self.frames()
        self.assertFalse(module.validate_wire(self.schema, frames[2:])["clean"])
        frames[0]["method"] = "unknown/future"
        self.assertFalse(module.validate_wire(self.schema, frames)["clean"])
        self.assertFalse(module.validate_wire(self.schema, [])["clean"])

    def test_error_response_is_validated(self):
        frames = self.frames()
        frames[2].pop("result")
        frames[2]["error"] = {"code": -32601, "message": "as-ingress: unsupported"}
        self.assertTrue(module.validate_wire(self.schema, frames)["clean"])
        del frames[2]["error"]["code"]
        self.assertFalse(module.validate_wire(self.schema, frames)["clean"])


if __name__ == "__main__":
    unittest.main()
