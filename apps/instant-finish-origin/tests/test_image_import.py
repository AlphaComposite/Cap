"""Import server.py inside the built origin image. Skips unless ORIGIN_IMAGE is set."""
from __future__ import annotations

import os
import subprocess
import unittest


@unittest.skipUnless(os.environ.get("ORIGIN_IMAGE"), "ORIGIN_IMAGE not set")
class ImageImportTests(unittest.TestCase):
    def test_server_imports_in_built_image(self) -> None:
        image = os.environ["ORIGIN_IMAGE"]
        result = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--entrypoint",
                "python3",
                image,
                "-c",
                "import server, service_auth, limits, grant, publication; print('import-ok')",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode()[-500:])
        self.assertIn(b"import-ok", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
