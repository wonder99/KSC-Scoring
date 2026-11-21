#!/usr/bin/env python3
"""Quick diagnostic to map sheet positions to names."""
import zipfile, re

XLSX = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'

with zipfile.ZipFile(XLSX, 'r') as z:
    wb = z.read('xl/workbook.xml').decode('utf-8')
    
    # Find all sheet entries with rId references
    pattern = re.compile(r'<sheet\s+name="([^"]+)"[^>]*r:id="(rId\d+)"', re.IGNORECASE)
    matches = list(pattern.finditer(wb))
    print(f'Sheets in workbook.xml: {len(matches)}')
    print()
    
    # Print them in order
    for i, m in enumerate(matches):
        sheet_name = m.group(1)
        rid = m.group(2)
        r_id_num = int(rid.replace('rId', ''))
        
        # Also try to find the sheet file for this rId
        print(f'  [{i+1}] name="{sheet_name}" {rid} (rId #{r_id_num})')
    
    print()
    print('Worksheet files in archive:')
    sheet_files = sorted([n for n in z.namelist() if 'worksheets/sheet' in n and n.endswith('.xml')])
    for i, sf in enumerate(sheet_files):
        print(f'  [{i+1}] {sf}')
