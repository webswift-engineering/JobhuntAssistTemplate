import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  BorderStyle,
  HeadingLevel,
  type FileChild,
} from "docx";
import type { TailoredResume } from "../llm/tailorResume.js";
import { lintParserSafe } from "../llm/renderResume.js";
import { buildLayout } from "./layout.js";
import {
  toResumeDoc,
  contactHeaderLines,
  roleHeaderLine,
  educationLine,
  projectHeaderLine,
  type ResumeContact,
  type ResumeDoc,
} from "./resumeDoc.js";

const ACCENT = "2b579a";
const HEADING_PT = 12;
const BODY_PT = 10.5;

export class DocxParserSafetyError extends Error {
  constructor(msg: string) {
    super(`DOCX parser-safety failed: ${msg}`);
    this.name = "DocxParserSafetyError";
  }
}

/** Reject tables, multi-column sections, images (mirror lintParserSafe invariants). */
export function assertDocxParserSafe(children: FileChild[]): void {
  for (const child of children) {
    const ctor = (child as { constructor?: { name?: string } }).constructor?.name ?? "";
    if (ctor === "Table" || ctor === "TableRow" || ctor === "TableCell") {
      throw new DocxParserSafetyError("contains Table element");
    }
  }
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 80 },
    border: {
      bottom: { color: ACCENT, space: 1, style: BorderStyle.SINGLE, size: 6 },
    },
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, size: HEADING_PT * 2, color: ACCENT }),
    ],
  });
}

/** ATS-clean DOCX from a structured doc: contact in body, bold role headers, one EXPERIENCE section. */
function structuredChildren(contact: ResumeContact | undefined, doc: ResumeDoc): FileChild[] {
  const children: FileChild[] = [];
  const header = contactHeaderLines(contact);
  if (header[0]) {
    children.push(
      new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: header[0], bold: true, size: 18 * 2 })] })
    );
  }
  if (header[1]) {
    children.push(
      new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: header[1], size: 10 * 2, color: "333333" })] })
    );
  }

  if (doc.summary) {
    children.push(sectionHeading("Summary"));
    children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: doc.summary, size: BODY_PT * 2 })] }));
  }

  if (doc.skills?.length) {
    children.push(sectionHeading("Skills"));
    for (const s of doc.skills) {
      children.push(
        new Paragraph({
          spacing: { after: 40 },
          children: [
            new TextRun({ text: `${s.label}: `, bold: true, size: BODY_PT * 2 }),
            new TextRun({ text: s.value, size: BODY_PT * 2 }),
          ],
        })
      );
    }
  }

  if (doc.experience?.length) {
    children.push(sectionHeading("Experience"));
    for (const e of doc.experience) {
      children.push(
        new Paragraph({
          spacing: { before: 100, after: 30 },
          children: [new TextRun({ text: roleHeaderLine(e), bold: true, size: BODY_PT * 2 })],
        })
      );
      for (const b of e.bullets) {
        children.push(
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: "\u2022 ", size: BODY_PT * 2 }), new TextRun({ text: b, size: BODY_PT * 2 })],
          })
        );
      }
    }
  }

  if (doc.projects?.length) {
    children.push(sectionHeading("Projects"));
    for (const p of doc.projects) {
      children.push(
        new Paragraph({
          spacing: { before: 100, after: 20 },
          children: [new TextRun({ text: projectHeaderLine(p), bold: true, size: BODY_PT * 2 })],
        })
      );
      if (p.stack) {
        children.push(
          new Paragraph({
            spacing: { after: 30 },
            children: [new TextRun({ text: p.stack, italics: true, size: BODY_PT * 2, color: "5a6472" })],
          })
        );
      }
      for (const b of p.bullets) {
        children.push(
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: "\u2022 ", size: BODY_PT * 2 }), new TextRun({ text: b, size: BODY_PT * 2 })],
          })
        );
      }
    }
  }

  if (doc.education?.length) {
    children.push(sectionHeading("Education"));
    for (const ed of doc.education) {
      children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: educationLine(ed), size: BODY_PT * 2 })] }));
    }
  }

  return children;
}

export async function renderDocx(tailored: TailoredResume): Promise<Buffer> {
  const structured = toResumeDoc(tailored);
  if (structured) {
    const children = structuredChildren(structured.contact, structured.doc);
    assertDocxParserSafe(children);
    const doc = new Document({ sections: [{ properties: {}, children }] });
    const buf = await Packer.toBuffer(doc);
    const plain = [
      ...contactHeaderLines(structured.contact),
      structured.doc.summary ?? "",
      ...(structured.doc.skills ?? []).map((s) => `${s.label}: ${s.value}`),
      ...(structured.doc.experience ?? []).flatMap((e) => [roleHeaderLine(e), ...e.bullets.map((b) => `- ${b}`)]),
      ...(structured.doc.projects ?? []).flatMap((p) => [
        projectHeaderLine(p),
        ...(p.stack ? [p.stack] : []),
        ...p.bullets.map((b) => `- ${b}`),
      ]),
      ...(structured.doc.education ?? []).map((ed) => educationLine(ed)),
    ].join("\n");
    lintParserSafe(plain + "\n");
    return buf;
  }

  const layout = buildLayout(tailored);
  const children: FileChild[] = [];

  for (const section of layout.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 80 },
        border: {
          bottom: {
            color: layout.accentColor.replace("#", ""),
            space: 1,
            style: BorderStyle.SINGLE,
            size: 6,
          },
        },
        children: [
          new TextRun({
            text: section.heading.toUpperCase(),
            bold: true,
            size: layout.headingSizePt * 2,
            color: layout.accentColor.replace("#", ""),
          }),
        ],
      })
    );
    for (const item of section.items) {
      children.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: "• ", size: layout.bodySizePt * 2 }),
            new TextRun({ text: item, size: layout.bodySizePt * 2 }),
          ],
        })
      );
    }
  }

  assertDocxParserSafe(children);

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  const buf = await Packer.toBuffer(doc);

  const plain = layout.sections
    .flatMap((s) => [s.heading, ...s.items.map((i) => `- ${i}`)])
    .join("\n");
  lintParserSafe(plain + "\n");

  return buf;
}
