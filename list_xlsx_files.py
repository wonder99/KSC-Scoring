import zipfile
import re

xlsx_path = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'

with zipfile.ZipFile(xlsx_path, 'r') as zf:
    names = zf.namelist()

# Find sheet files
sheet_files = [n for n in names if 'worksheets/sheet' in n.lower()]
print(f"Sheet XML files ({len(sheet_files)}):")
for f in sheet_files[:20]:
    print(f"  {f}")
if len(sheet_files) > 20:
    print(f"  ... and {len(sheet_files) - 20} more")

# Also list all files to understand structure
print(f"\nAll files in xlsx ({len(names)} total):")
for n in sorted(set(n.split('/')[0] for n in names)):
    sub = [m for m in names if m.startswith(n + '/')][:5]
    print(f"  {n}/ ({len([m for m in names if m.startswith(n + '/')])} files)")
    for s in sub:
        print(f"    {s}")
