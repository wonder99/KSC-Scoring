import zipfile

xlsx_path = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'

with zipfile.ZipFile(xlsx_path, 'r') as zf:
    names = zf.namelist()
    xml_files = [n for n in names if 'worksheets/sheet' in n.lower() and n.endswith('.xml')]
    print(f"Sheet XML files ({len(xml_files)}):")
    for f in sorted(xml_files)[:5]:
        print(f"  {f}")

# Read first sheet XML to understand structure
with zipfile.ZipFile(xlsx_path, 'r') as zf:
    content = zf.read(xml_files[0]).decode('utf-8', errors='replace')

print(f"\nTotal file size: {len(content)} chars")

# Find any <f> tags (these indicate formulas)
import re
f_count = len(re.findall(r'<f>', content))
print(f"<f> tag count: {f_count}")

# Show some examples of f tags
f_tags = re.findall(r'<f[^>]*>(.*?)</f>', content, re.DOTALL)
if f_tags:
    print("\nSample formulas:")
    for i, tag in enumerate(f_tags[:10]):
        print(f"  {i+1}: {tag.strip()[:120]}")
else:
    # Maybe shared formula?
    si_tags = re.findall(r'<si[^>]*>(.*?)</si>', content, re.DOTALL)
    if si_tags:
        print(f"\nFound {len(si_tags)} <si> tags (shared formulas)")
        for i, tag in enumerate(si_tags[:10]):
            print(f"  {i+1}: {tag.strip()[:120]}")

# Show a sample of the raw XML around f elements
f_positions = [m.start() for m in re.finditer(r'<f', content)]
print(f"\nFirst 5 <f> positions: {f_positions[:5]}")
if f_positions:
    start_pos = max(0, f_positions[0] - 200)
    end_pos = min(len(content), f_positions[0] + 400)
    snippet = content[start_pos:end_pos].replace('\n', '\\n')
    print(f"\nSnippet around first <f>:")
    print(snippet)
