from importlib.metadata import distribution
from pathlib import Path
import shutil
import sys
BASE = Path(__file__).resolve().parents[1]
target = BASE / 'package' / 'LICENSES'
for name in ('pillow', 'pystray', 'pycaw', 'comtypes', 'psutil', 'six', 'pyinstaller', 'pywin32-ctypes', 'setuptools'):
    dist = distribution(name)
    for file in dist.files or []:
        if file.name.lower().startswith(('license', 'copying', 'notice')):
            source = Path(dist.locate_file(file))
            if source.is_file():
                destination = target / name / Path(str(file))
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
python_license = Path(sys.base_prefix) / 'LICENSE.txt'
if python_license.exists():
    (target / 'python').mkdir(parents=True, exist_ok=True)
    shutil.copy2(python_license, target / 'python' / 'LICENSE.txt')
import tkinter
tcl_library = Path(tkinter.Tcl().eval('info library'))
for library in (tcl_library, tcl_library.parent / 'tk8.6'):
    for source in library.glob('license*'):
        (target / library.name).mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target / library.name / source.name)
print('Collected', len(list(target.rglob('*.*'))), 'upstream license files')
