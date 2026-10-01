// ATS-friendly single-column DOCX renderer for the gen-*-resume-pdf.mjs data shape.
// Usage: import { writeDocx } from "./resume-docx.mjs"; await writeDocx(resumeData, outPath)
// Requires the `docx` package (npm i docx).
import fs from "node:fs";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  TabStopType,
  BorderStyle,
} from "docx";

const FONT = "Calibri";
const ACCENT = "1F3A5F";
const MUTED = "5A6472";
const PAGE_W = 12240; // Letter width in twips
const MARGIN = 720; // 0.5in
const RIGHT_TAB = PAGE_W - 2 * MARGIN;

function h2(text) {
  return new Paragraph({
    spacing: { before: 160, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D7DCE3", space: 1 } },
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, size: 20, color: ACCENT, font: FONT, characterSpacing: 20 }),
    ],
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text, size: 20, font: FONT })],
  });
}

function labelLink(url) {
  const v = url.replace(/\/+$/, "");
  if (/linkedin\.com/i.test(url)) return `LinkedIn: ${v}`;
  if (/github\.com/i.test(url)) return `GitHub: ${v}`;
  return `Website: ${v}`;
}

export function buildDocx(data) {
  const { contact, summary, education, skills, experience, projects = [] } = data;
  const children = [];

  children.push(
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 40 },
      children: [new TextRun({ text: contact.name.toUpperCase(), bold: true, size: 44, color: ACCENT, font: FONT, characterSpacing: 30 })],
    })
  );
  const contactBits = [
    contact.email && `Email: ${contact.email}`,
    contact.phone && `Phone: ${contact.phone}`,
    contact.location && `Location: ${contact.location}`,
    ...(contact.links ?? []).map(labelLink),
  ].filter(Boolean);
  children.push(
    new Paragraph({
      spacing: { after: 120 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 4 } },
      children: [new TextRun({ text: contactBits.join("  |  "), size: 18, color: MUTED, font: FONT })],
    })
  );

  children.push(h2("Summary"));
  children.push(
    new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 60 },
      children: [new TextRun({ text: summary, size: 20, font: FONT })],
    })
  );

  children.push(h2("Experience"));
  for (const e of experience) {
    const meta = [e.dates, e.location].filter(Boolean).join(" · ");
    children.push(
      new Paragraph({
        spacing: { before: 100, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [
          new TextRun({ text: e.company, bold: true, size: 22, font: FONT }),
          new TextRun({ text: `\t${meta}`, size: 18, color: MUTED, font: FONT }),
        ],
      })
    );
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({ text: e.title, italics: true, size: 20, color: ACCENT, font: FONT })],
      })
    );
    for (const b of e.bullets) children.push(bullet(b));
  }

  if (projects.length) {
    children.push(h2("Projects"));
    for (const p of projects) {
      children.push(
        new Paragraph({
          spacing: { before: 80, after: 0 },
          tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
          children: [
            new TextRun({ text: p.name, bold: true, size: 22, font: FONT }),
            new TextRun({ text: `\t${p.context ?? ""}`, size: 18, color: MUTED, font: FONT }),
          ],
        })
      );
      if (p.stack)
        children.push(
          new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: p.stack, italics: true, size: 20, color: ACCENT, font: FONT })] })
        );
      for (const b of p.bullets) children.push(bullet(b));
    }
  }

  children.push(h2("Skills"));
  for (const s of skills) {
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [
          new TextRun({ text: `${s.label}: `, bold: true, size: 20, font: FONT }),
          new TextRun({ text: s.value, size: 20, font: FONT }),
        ],
      })
    );
  }

  children.push(h2("Education"));
  for (const e of education) {
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
        children: [
          new TextRun({ text: e.degree, bold: true, size: 20, font: FONT }),
          new TextRun({ text: ` — ${e.school}`, size: 20, font: FONT }),
          new TextRun({ text: `\t${e.year ?? ""}`, size: 18, color: MUTED, font: FONT }),
        ],
      })
    );
  }

  return new Document({
    creator: contact.name,
    title: `${contact.name} — Résumé`,
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: "bullet",
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 220 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: { size: { width: PAGE_W, height: 15840 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } },
        },
        children,
      },
    ],
  });
}

export async function writeDocx(data, outPath) {
  const buf = await Packer.toBuffer(buildDocx(data));
  fs.writeFileSync(outPath, buf);
  return outPath;
}
