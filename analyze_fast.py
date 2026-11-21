import zipfile
import re
from collections import defaultdict, Counter
import xml.etree.ElementTree as ET

# XLSX is a ZIP of XML files - read formulas directly from sheet XML
xlsx_path = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'

ns = {
    'xl': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
}

with zipfile.ZipFile(xlsx_path, 'r') as zf:
    sheet_names_file = '[Content_Types].xml'
    # Get sheet names from content types
    content = zf.read('[Content_Types].xml').decode()
    parts = re.findall(r'Target="([^"]*\.xml)"', content)
    
    sheet_xml_files = [p for p in parts if re.match(r'^xl/worksheets/sheet\d+\.xml$', p)]
    
print(f"Found {len(sheet_xml_files)} sheet XML files")

# Map sheets to their formulas
all_formulas = {}  # {sheet_index: [(col, row, formula), ...]}

for idx, xml_file in enumerate(sheet_xml_files):
    content = zf.read(xml_file).decode()
    
    # Find all formula cells
    # Formula elements look like: <f>...formula text...</f>
    formulas_in_cell = re.findall(r'<[^>]*c\s+r="([^"]*)"[^>]*/?>\s*<f>(.*?)</f>', content, re.DOTALL)
    
    if not formulas_in_cell:
        continue
    
    sheet_formulas = []
    for cell_ref, formula in formulas_in_cell:
        # Parse column letter(s) from AIZ-style ref
        col_match = re.match(r'([A-Z]+)', cell_ref)
        row_match = re.search(r'(\d+)$', cell_ref)
        
        if col_match and row_match:
            col_str = col_match.group(1)
            row_num = int(row_match.group(1))
            
            # Convert column letter to number for display
            col_num = 0
            for c in col_str:
                col_num = col_num * 26 + (ord(c) - ord('A') + 1)
            
            sheet_formulas.append((col_str, row_num, formula.strip()))
    
    all_formulas[idx] = sheet_formulas

print(f"\nSheets with formulas:")
for idx, formulas in sorted(all_formulas.items()):
    print(f"  Sheet {idx}: {len(formulas)} formulas")
