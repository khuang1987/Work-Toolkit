from pathlib import Path
import hashlib
import json
import shutil
import zipfile
import pefile

BASE = Path(__file__).resolve().parents[1]
OUTPUT = BASE.parents[1] / 'outputs'
VERSION = '1.8.1'
folder = OUTPUT / f'caleb-desktop-{VERSION}'
archive = OUTPUT / f'Caleb-Desktop-Pet-{VERSION}-win-x64.zip'
assert not folder.exists() and not archive.exists(), 'Do not overwrite an existing release'
qa = BASE / f'qa-release-{VERSION}'
source_tests = json.loads((qa / 'source-tests.json').read_text(encoding='utf-8'))
assert all(test['passed'] for test in source_tests)
smoke = json.loads((qa / 'frozen-smoke.json').read_text(encoding='utf-8'))
assert smoke['ok'] and smoke['tray_visible'] and not smoke['user_profile_touched']
exe = BASE / 'dist' / 'CalebDesktopPet.exe'
pe = pefile.PE(str(exe))
assert pe.FILE_HEADER.Machine == 0x8664 and pe.OPTIONAL_HEADER.Subsystem == 2
resources = {entry.id for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries}
assert {3, 14}.issubset(resources), 'EXE character icon missing'
pe.close()
folder.mkdir(parents=True)
shutil.copy2(exe, folder / exe.name)
for source, destination in [(f'README-{VERSION}.txt', 'README.txt'), ('version.json', 'version.json'), ('THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt')]:
    shutil.copy2(BASE / 'package' / source, folder / destination)
shutil.copytree(BASE / 'package' / 'LICENSES', folder / 'LICENSES')
files = sorted(path for path in folder.rglob('*') if path.is_file())
assert not any(path.name in ('profile.json', 'spritesheet.png', 'climb.png') for path in files)
checksums = [(hashlib.sha256(path.read_bytes()).hexdigest(), path.relative_to(folder).as_posix()) for path in files]
(folder / 'SHA256SUMS.txt').write_text('\n'.join(f'{checksum}  {name}' for checksum, name in checksums) + '\n', encoding='utf-8')
with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for path in sorted(folder.rglob('*')):
        if path.is_file():
            output.write(path, path.relative_to(OUTPUT))
with zipfile.ZipFile(archive) as check:
    assert check.testzip() is None
    embedded = check.read(f'caleb-desktop-{VERSION}/CalebDesktopPet.exe')
    assert hashlib.sha256(embedded).digest() == hashlib.sha256(exe.read_bytes()).digest()
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
report = {'archive': str(archive), 'version': VERSION, 'bytes': archive.stat().st_size, 'sha256': digest, 'windows_x64': True,
          'exe_icon': True, 'archive_integrity': True, 'no_user_profile': True, 'source_tests': len(source_tests), 'frozen_smoke': smoke}
(qa / 'release.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
