"""MP4 fragments may put sample sizes in tfhd rather than trun."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_origin


def box(kind, payload):
    return (8 + len(payload)).to_bytes(4, 'big') + kind + payload


def fullbox(kind, flags, payload):
    return box(kind, flags.to_bytes(4, 'big') + payload)


def fragment(default: int | None = 4, extra_flags=0, explicit=False, truncated=False, payload=b'abcd'):
    fields = (1).to_bytes(4, 'big')
    if extra_flags & 1:
        fields += (0).to_bytes(8, 'big')
    if extra_flags & 2:
        fields += (1).to_bytes(4, 'big')
    if extra_flags & 8:
        fields += (512).to_bytes(4, 'big')
    if default is not None:
        fields += default.to_bytes(4, 'big')[:2 if truncated else 4]
    tfhd = fullbox(b'tfhd', 0x20000 | extra_flags | (0x10 if default is not None else 0), fields)
    run = (1).to_bytes(4, 'big') + (0).to_bytes(4, 'big') + (0x02000000).to_bytes(4, 'big')
    if explicit:
        run += len(payload).to_bytes(4, 'big')
    trun = fullbox(b'trun', 0x205 if explicit else 0x5, run)
    init = box(b'ftyp', b'isom') + box(b'moov', box(b'avcC', b'config'))
    return init + box(b'moof', fullbox(b'mfhd', 0, (1).to_bytes(4, 'big')) + box(b'traf', tfhd + trun)) + box(b'mdat', payload)


class DefaultSampleSizeTest(unittest.TestCase):
    def test_default_size_with_optional_tfhd_fields(self):
        for flags in (0, 2, 8, 10):
            with self.subTest(flags=flags):
                _init, _avcc, media = lib_origin.rewrite_fragment(fragment(extra_flags=flags), [30046], 17, 3)
                self.assertTrue(media.endswith(b'abcd'))
                off = media.index(b'trun') - 4
                self.assertEqual(lib_origin._parse_trun(media, off, int.from_bytes(media[off:off + 4], 'big'))['sizes'], [4])

    def test_explicit_sizes_override_default(self):
        _init, _avcc, media = lib_origin.rewrite_fragment(fragment(default=99, explicit=True), [30046], 0, 1)
        self.assertTrue(media.endswith(b'abcd'))

    def test_invalid_or_missing_defaults_still_fail(self):
        for data in (fragment(default=None), fragment(default=0), fragment(truncated=True)):
            with self.subTest(data=data), self.assertRaisesRegex(RuntimeError, 'trun lacks per-sample sizes'):
                lib_origin.rewrite_fragment(data, [30046], 0, 1)
        with self.assertRaisesRegex(RuntimeError, 'trun sizes do not match mdat'):
            lib_origin.rewrite_fragment(fragment(default=5), [30046], 0, 1)
        with self.assertRaisesRegex(RuntimeError, 'default-base-is-moof'):
            lib_origin.rewrite_fragment(fragment(extra_flags=1).replace(bytes.fromhex('00020011'), bytes.fromhex('00000011')), [30046], 0, 1)


if __name__ == '__main__':
    unittest.main()
