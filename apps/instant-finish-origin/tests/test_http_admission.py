"""Completed HTTP requests must not keep an origin admission slot idle."""
import http.client
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import serve


class HttpAdmissionTest(unittest.TestCase):
    def test_idle_keepalive_does_not_hold_slot(self):
        app = SimpleNamespace(max_inflight=1, handle=lambda *args: (200, b"ok", "text/plain", {}))
        httpd = serve(app, "127.0.0.1", 0)
        first = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=2)
        second = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=2)
        try:
            first.request("GET", "/health")
            response = first.getresponse()
            self.assertEqual(response.read(), b"ok")
            # Give the completed handler time to release its semaphore, but leave
            # the client idle: old HTTP/1.1 code holds the slot indefinitely.
            time.sleep(0.05)
            second.request("GET", "/health")
            next_response = second.getresponse()
            next_response.read()
            self.assertEqual(next_response.status, 200)
            self.assertEqual(response.getheader("Connection"), "close")
        finally:
            first.close()
            second.close()
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
