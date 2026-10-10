"""Prepared immutable bytes must not wait for an unrelated segment encode."""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_origin
from server import OriginApp
from publication import MemoryPublication
from storage import ObjectIdentity, ShaIdentityCache

class StartupCacheTests(unittest.TestCase):
    def test_prepared_bytes_do_not_wait_for_encode_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            o = object.__new__(lib_origin.Origin)
            o._lock = threading.Lock()
            o._segment_bytes = {0: b'prepared-segment'}
            o._init_bytes = b'prepared-init'
            o.init_path = Path(tmp) / 'init.mp4'
            seg = Path(tmp) / '0.m4s'
            o.segment_path = lambda _: seg
            o._record = lambda *a, **k: None
            o.segments = [None]
            for p in [o.init_path, seg]:
                p.write_bytes(b'bound')
                lib_origin.sidecar_path(p).write_bytes(b'bound')
            result = []
            o._lock.acquire()
            t = threading.Thread(target=lambda: result.extend([o._ensure_init(), o._ensure(0)]))
            t.start()
            try:
                t.join(.2)
                self.assertFalse(t.is_alive(), 'prepared hits blocked behind cold encode')
                self.assertEqual(result, [b'prepared-init', b'prepared-segment'])
            finally:
                o._lock.release()
                t.join(2)

    def test_prepare_head_seeds_existing_identity_cache_and_keeps_ttl(self):
        app = object.__new__(OriginApp)
        app._lock = threading.Lock()
        app._sha_ident = {}
        app._sha_cache = ShaIdentityCache()
        calls = []
        ident = ObjectIdentity('private/source/vid/original', 'etag', 'v1', 4)
        app.objects = SimpleNamespace(head=lambda key: (calls.append(key), ident)[1])
        app._remember_sha(ident.key, 'a'*64)
        self.assertEqual(app._identity(ident.key), ident)
        self.assertEqual(len(calls), 1)
        self.assertEqual(app._sha_cache.get(ident), 'a'*64)
        app._sha_ident[ident.key] = (ident, time.monotonic()-1000)
        app._identity(ident.key)
        self.assertEqual(len(calls), 2, 'expired identity must still refresh')

if __name__ == '__main__':
    unittest.main()
