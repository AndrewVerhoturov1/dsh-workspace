"""The canonical ZIP reader and bounded Leader metadata/archive operations."""
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
import archive_operations as archive
import safe_zip

class ArchiveTests(unittest.TestCase):
    def test_selected_pack_list_unpack_and_never_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); source=root/'note.txt'; source.write_bytes(b'private data')
            zipped=root/'input.zip'
            result=archive.pack([str(source)],str(zipped))
            self.assertEqual(result['inventory'][0]['path'],'note.txt')
            output=root/'unpacked'; safe_zip.unpack(zipped,output)
            self.assertEqual((output/'note.txt').read_bytes(),b'private data')
            with self.assertRaises(ValueError): safe_zip.unpack(zipped,output)
            with self.assertRaises(ValueError): archive.pack([str(source)],str(zipped))
            self.assertEqual(source.read_bytes(),b'private data')

    def test_zip_paths_links_collision_crc_and_limits_share_one_reader(self):
        for name in ['../escape','/absolute','C:/drive','//server/share','safe:ads','CON.txt','bad.','foo/../bar']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root=Path(temp); source=root/'input.zip'
                with zipfile.ZipFile(source,'w') as z:z.writestr(name,b'data')
                with self.assertRaises(safe_zip.SafeZipError):safe_zip.unpack(source,root/'result')
                self.assertFalse((root/'result').exists())
        with tempfile.TemporaryDirectory() as temp:
            source=Path(temp)/'input.zip'
            info=zipfile.ZipInfo('link');info.external_attr=(0o120777<<16)
            with zipfile.ZipFile(source,'w') as z:z.writestr(info,b'target')
            with self.assertRaisesRegex(ValueError,'symlink'):safe_zip.read_archive(source)
            with zipfile.ZipFile(source,'w') as z:z.writestr('A.txt',b'a');z.writestr('a.txt',b'b')
            with self.assertRaisesRegex(ValueError,'case_collision'):safe_zip.read_archive(source)
            with zipfile.ZipFile(source,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('data',b'A'*20000)
            self.assertEqual(safe_zip.read_archive(source)['inventory'][0]['uncompressedSize'],20000)
            with self.assertRaises(ValueError):safe_zip.read_archive(source,limits={'maxTotalUncompressedBytes':100})

    def test_locate_is_metadata_only_bounded_and_requires_ambiguous_selection(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'a').mkdir();(root/'b').mkdir();(root/'secrets').mkdir()
            for directory in ['a','b','secrets']:(root/directory/'note.txt').write_bytes(b'not read')
            result=archive.locate('note.txt',[str(root)])
            self.assertEqual(result['status'],'POSTMAN_INPUT_SELECTION_REQUIRED')
            self.assertEqual(len(result['candidates']),2)
            self.assertNotIn('content',str(result))
            with self.assertRaises(ValueError):archive.locate('../note.txt',[str(root)])
            with self.assertRaises(ValueError):archive.safe_selected('relative.txt')
            with self.assertRaises(ValueError):archive.pack([str(root/'secrets'/'note.txt')],str(root/'s.zip'))
            for i in range(2001):(root/f'empty-{i}').touch()
            result=archive.locate('absent.txt',[str(root)])
            self.assertTrue(result['capped'])
            self.assertLessEqual(result['examined'],2000)

if __name__=='__main__':unittest.main()
