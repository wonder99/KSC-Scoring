"""Filter the formula analysis report to exclude errors with dissenting cells in specified sheets."""

import re

INPUT = r"C:\Users\Paul\Projects\The-701-Club\formula_analysis_report.txt"
OUTPUT = r"C:\Users\Paul\Projects\The-701-Club\formula_analysis_report_filtered.txt"

EXCLUDED_SHEETS = frozenset([
    "Mens Overall", "Mens Outs", "Mens Avg", "Mens 95",
    "Lady Overall", "Lady Outs", "Lady Avg", "Lady 95",
])

with open(INPUT, encoding="utf-8") as f:
    content = f.read()

# Split the report into header (before first error) and footer (OFF-BY-ONE onwards)
header_end = content.index("--- Error #1 ---")
footer_start = content.index("OFF-BY-ONE RANGE ERRORS")
header_text = content[:header_end]
footer_text = content[footer_start:]

# Parse individual error blocks
error_section = content[header_end:footer_start]
error_blocks = [b for b in re.split(r'(?=--- Error #)', error_section) if b.strip().startswith("--- Error")]

kept_blocks = []
rejected_blocks = []
rejected_info = []

for block in error_blocks:
    # Extract dissenting cell lines
    # Format is "    SheetName:  'formula'" where SheetName can have spaces or digits
    dissent_sheets = re.findall(r'^\s{4}([^:\n]+?):\s', block, re.MULTILINE)
    
    if not dissent_sheets:
        kept_blocks.append(block)
        continue
    
    sheet_names = [s.strip() for s in dissent_sheets]
    found_excluded = [s for s in sheet_names if s in EXCLUDED_SHEETS]
    
    if found_excluded:
        rejected_blocks.append(block)
        unique_excluded = ", ".join(sorted(set(found_excluded)))
        err_num = re.search(r"Error #(\d+)", block)
        pos_match = re.search(r"Position:\s+(\S+)", block)
        en = err_num.group(1) if err_num else "?"
        po = pos_match.group(1) if pos_match else "?"
        print(f"  REJECT Error#{en} Pos={po}: {unique_excluded}")
        rejected_info.append((en, po))
    else:
        kept_blocks.append(block)

print(f"\nKept {len(kept_blocks)} errors, rejected {len(rejected_blocks)}")

# Build the filtered report
lines = []
lines.append(header_text)
if rejected_info:
    lines.append("NOTE: Errors with dissenting cells in Mens/Lady Overall/Outs/Avg/95 sheets have been EXCLUDED.\n\n")
    lines.append("=" * 120 + "\n")
    lines.append("EXCLUDED ERRORS (dissenting cells reference Mens/Lady Overall/Outs/Avg/95 sheets)\n")
    lines.append("=" * 120 + "\n\n")
    for en, po in rejected_info:
        lines.append(f"  [Error #{en}] Position {po}\n")

for block in kept_blocks:
    lines.append(block)

lines.append("\n")
lines.append(footer_text)

output_content = "".join(lines)
with open(OUTPUT, "w", encoding="utf-8") as f:
    f.write(output_content)

print(f"\nFiltered report written to: {OUTPUT}")
print(f"Report size: {len(output_content)} chars, {output_content.count(chr(10))} lines")
