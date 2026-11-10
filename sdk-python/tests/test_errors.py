import os
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from platform_sdk import PlatformClient


class ErrorCaptureTests(unittest.TestCase):
    def test_error_contract_and_frame_order(self):
        client = PlatformClient()
        client.options = {"version": "1.2.3", "environment_name": "test"}
        client._request = Mock()
        def inner():
            raise ValueError("cart failed")
        try:
            inner()
        except ValueError as error:
            client.capture_exception(error, sessionId="opaque-session", projectId="ignored")
        method, route, event = client._request.call_args.args
        self.assertEqual((method, route), ("POST", "/api/sdk/errors"))
        self.assertEqual(event["type"], "ValueError")
        self.assertEqual(event["release"], "1.2.3")
        self.assertEqual(event["frames"][0]["function"], "inner")
        self.assertEqual(event["frames"][0]["column"], 0)
        self.assertEqual(event["sessionId"], "opaque-session")
        self.assertNotIn("projectId", event)


if __name__ == '__main__':
    unittest.main()
