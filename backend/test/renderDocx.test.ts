import { describe, it, expect } from "vitest";
import { Table, TableRow, TableCell, Paragraph, TextRun } from "docx";
import { assertDocxParserSafe, DocxParserSafetyError, renderDocx } from "../src/render/renderDocx.js";
import { structuralFallback } from "../src/llm/tailorResume.js";
import { lintParserSafe } from "../src/llm/renderResume.js";

const master = `SUMMARY
Senior backend engineer.

EXPERIENCE
- Built APIs in Node.js at Acme.`;

describe("renderDocx", () => {
  it("assertDocxParserSafe throws on Table element", () => {
    const bad = [
      new Table({
        rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("x")] })] })],
      }),
    ];
    expect(() => assertDocxParserSafe(bad)).toThrow(DocxParserSafetyError);
  });

  it("renderDocx produces buffer and plain-text equivalent passes lintParserSafe", async () => {
    const tailored = structuralFallback(master, "Node.js backend role");
    const buf = await renderDocx(tailored);
    expect(buf.length).toBeGreaterThan(1000);
    const plain = tailored.sections
      .flatMap((s) => [s.heading.toUpperCase(), ...s.items.map((i) => `- ${i}`)])
      .join("\n");
    expect(() => lintParserSafe(plain + "\n")).not.toThrow();
  });

  it("safe paragraphs pass assertDocxParserSafe", () => {
    const ok = [new Paragraph({ children: [new TextRun("Hello")] })];
    expect(() => assertDocxParserSafe(ok)).not.toThrow();
  });
});
