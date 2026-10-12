"""Only single-run, moof-relative tfhd-default fragments are supported."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_origin


def box(kind, payload):
    return (8 + len(payload)).to_bytes(4, 'big') + kind + payload


def fullbox(kind, flags, payload):
    return box(kind, flags.to_bytes(4, 'big') + payload)


def fragment(default: int | None = 4, extra_flags=0, explicit=False, truncated=False,
             payload=b'abcd', offset=None, runs=1, trafs=1, count=1,
             data_offset=True, extended_mdat=False, gap=b''):
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

    def moof(at):
        run = count.to_bytes(4, 'big')
        if data_offset:
            run += at.to_bytes(4, 'big', signed=True)
        run += (0x02000000).to_bytes(4, 'big')
        if explicit:
            run += (len(payload) // count).to_bytes(4, 'big') * count
        trun = fullbox(b'trun', 0x4 | int(data_offset) | (0x200 if explicit else 0), run)
        return box(b'moof', fullbox(b'mfhd', 0, (1).to_bytes(4, 'big')) + box(b'traf', tfhd + trun * runs) * trafs)

    header = 16 if extended_mdat else 8
    at = len(moof(0)) + len(gap) + header if offset is None else offset
    mdat = ((1).to_bytes(4, 'big') + b'mdat' + (16 + len(payload)).to_bytes(8, 'big') + payload
            if extended_mdat else box(b'mdat', payload))
    init = box(b'ftyp', b'isom') + box(b'moov', box(b'avcC', b'config'))
    return init + moof(at) + gap + mdat


class DefaultSampleSizeTest(unittest.TestCase):
    def assert_default_payload(self, media, payload):
        moof, mdat = list(lib_origin._iter_boxes(media, 0, len(media)))
        moof_at, moof_size, moof_header, moof_name = moof
        mdat_at, mdat_size, mdat_header, mdat_name = mdat
        self.assertEqual((moof_name, mdat_name), (b'moof', b'mdat'))
        runs = []
        for off, size, header, name in lib_origin._iter_boxes(media, moof_at + moof_header, moof_at + moof_size):
            if name == b'traf':
                runs.extend(box for box in lib_origin._iter_boxes(media, off + header, off + size) if box[3] == b'trun')
        self.assertEqual(len(runs), 1)
        run_at = runs[0][0]
        self.assertTrue(int.from_bytes(media[run_at + 9:run_at + 12], 'big') & 1)
        data_offset = int.from_bytes(media[run_at + 16:run_at + 20], 'big', signed=True)
        self.assertEqual(moof_at + data_offset, mdat_at + mdat_header)
        self.assertEqual(media[moof_at + data_offset:mdat_at + mdat_size], payload)

    def test_default_size_with_optional_tfhd_fields(self):
        for flags in (0, 2, 8, 10):
            with self.subTest(flags=flags):
                _init, _avcc, media = lib_origin.rewrite_fragment(fragment(extra_flags=flags), [30046], 17, 3)
                self.assert_default_payload(media, b'abcd')
                off = media.index(b'trun') - 4
                self.assertEqual(lib_origin._parse_trun(media, off, int.from_bytes(media[off:off + 4], 'big'))['sizes'], [4])

    def test_multiple_samples_with_padding(self):
        data = fragment(count=2, payload=b'abcdabcd', gap=box(b'free', b'padding'))
        media = lib_origin.rewrite_fragment(data, [512, 512], 0, 1)[2]
        self.assert_default_payload(media, b'abcdabcd')

    def test_extended_mdat_default_size_rejected(self):
        for gap in (b'', box(b'free', b'padding')):
            with self.subTest(gap=gap), self.assertRaises(RuntimeError, msg='accepted'):
                data = fragment(count=2, payload=b'abcdabcd', extended_mdat=True, gap=gap)
                lib_origin.rewrite_fragment(data, [512, 512], 0, 1)

    def test_explicit_sizes_override_default(self):
        _init, _avcc, media = lib_origin.rewrite_fragment(fragment(default=99, explicit=True), [30046], 0, 1)
        self.assertTrue(media.endswith(b'abcd'))

    def test_bad_offset(self):
        for offset in (0, -1, 1, 100000):
            with self.subTest(offset=offset), self.assertRaises(RuntimeError):
                lib_origin.rewrite_fragment(fragment(offset=offset), [30046], 0, 1)

    def test_extra_trun(self):
        with self.assertRaises(RuntimeError):
            lib_origin.rewrite_fragment(fragment(runs=2), [30046], 0, 1)

    def test_extra_traf(self):
        with self.assertRaises(RuntimeError):
            lib_origin.rewrite_fragment(fragment(trafs=2), [30046], 0, 1)

    def test_base_data_offset(self):
        with self.assertRaises(RuntimeError):
            lib_origin.rewrite_fragment(fragment(extra_flags=1), [30046], 0, 1)

    def test_missing_data_offset(self):
        with self.assertRaises(RuntimeError):
            lib_origin.rewrite_fragment(fragment(data_offset=False), [30046], 0, 1)

    def test_truncated_or_empty_run(self):
        with self.assertRaises(RuntimeError):
            lib_origin.rewrite_fragment(fragment(count=0), [], 0, 1)
        data = fragment()
        off = data.index(b'trun') - 4
        tfhd_at = data.index(b'tfhd') - 4
        tfhd_size = int.from_bytes(data[tfhd_at:tfhd_at + 4], 'big')
        with self.assertRaises(RuntimeError):
            lib_origin._parse_trun(data, off, 20, data[tfhd_at:tfhd_at + tfhd_size])

    def test_payload_mismatch(self):
        with self.assertRaisesRegex(RuntimeError, 'trun sizes do not match mdat'):
            lib_origin.rewrite_fragment(fragment(default=5), [30046], 0, 1)

    def test_invalid_or_missing_defaults_still_fail(self):
        for data in (fragment(default=None), fragment(default=0), fragment(truncated=True)):
            with self.subTest(data=data), self.assertRaisesRegex(RuntimeError, 'trun lacks per-sample sizes'):
                lib_origin.rewrite_fragment(data, [30046], 0, 1)
        with self.assertRaisesRegex(RuntimeError, 'default-base-is-moof'):
            lib_origin.rewrite_fragment(fragment().replace(bytes.fromhex('00020010'), bytes.fromhex('00000010')), [30046], 0, 1)


if __name__ == '__main__':
    unittest.main()
