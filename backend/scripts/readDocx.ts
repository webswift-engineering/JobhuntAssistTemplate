/** Read plain text from a .docx file (requires python-docx). */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const py = `
from docx import Document
import sys
d = Document(sys.argv[1])
parts = [p.text.strip() for p in d.paragraphs if p.text.strip()]
for t in d.tables:
    for row in t.rows:
        line = " | ".join(c.text.strip() for c in row.cells if c.text.strip())
        if line:
            parts.append(line)
print("\\n".join(parts))
`.trim();

export function readDocxText(filePath: string): string {
  const tmp = filePath.replace(/\.docx$/i, "") + "._read_docx.py";
  fs.writeFileSync(tmp, py);
  try {
    return execFileSync("python", [tmp, filePath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}
