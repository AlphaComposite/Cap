"""Idle pooled MySQL connections dropped by the server (wait_timeout) must not fail requests."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publication import ConnectionPool  # noqa: E402


class StaleConn:
    """Mimics a pymysql connection the server closed while it sat idle."""

    def __init__(self):
        self.alive = False
        self.pings = 0

    def ping(self, reconnect=True):
        self.pings += 1
        if reconnect:
            self.alive = True

    def close(self):
        pass


class PoolStaleTest(unittest.TestCase):
    def test_idle_connection_is_revalidated_before_reuse(self):
        pool = ConnectionPool("mysql://u:p@db/x", size=4)
        stale = [StaleConn() for _ in range(4)]
        for c in stale:
            pool._idle.put_nowait(c)
        pool._created = 4
        for _ in range(4):
            conn = pool.acquire()
            self.assertTrue(conn.alive, "acquire handed out a server-closed connection")
            pool.release(conn)


if __name__ == "__main__":
    unittest.main()
