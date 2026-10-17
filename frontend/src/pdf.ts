// Loaded on first download so the PDF library stays out of the main bundle.
const loadPdfLib = () => Promise.all([import("jspdf"), import("jspdf-autotable")]);

/**
 * Renders the Markdown subset our report builders emit (headings, paragraphs, bullets, numbered items,
 * block quotes, tables, `**bold**` lines, `---` rules) into an A4 PDF and downloads it.
 * The built-in PDF fonts only cover Latin-1, so symbols outside it are swapped for plain-text equivalents.
 */
export async function downloadPdf(filename: string, markdown: string, footer = "FraudGraph AI"): Promise<void> {
  const [{ jsPDF }, tableLib] = await loadPdfLib();
  // jspdf-autotable ships CommonJS; depending on the bundler's interop the function sits one `default` deeper.
  const autoTable: typeof tableLib.default = (tableLib.default as any).default ?? tableLib.default;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 48;
  const width = pageW - margin * 2;
  let y = margin;

  const ensure = (h: number) => {
    if (y + h > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };
  const text = (s: string, size: number, style: "normal" | "bold" | "italic" = "normal", indent = 0, gap = 4) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    const lines: string[] = doc.splitTextToSize(s, width - indent);
    const lh = size * 1.35;
    lines.forEach((line) => {
      ensure(lh);
      doc.text(line, margin + indent, y + size);
      y += lh;
    });
    y += gap;
  };

  const rows = markdown.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const line = clean(raw.trimEnd());
    if (!line.trim()) continue;

    if (line.startsWith("|")) {
      // Collect the whole table: header, separator, body.
      const block: string[] = [];
      while (i < rows.length && rows[i].trim().startsWith("|")) block.push(clean(rows[i++].trim()));
      i--;
      const cells = (r: string) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const [head, , ...body] = block;
      autoTable(doc, {
        head: [cells(head)],
        body: body.map(cells),
        startY: y,
        margin: { left: margin, right: margin },
        styles: { font: "helvetica", fontSize: 8, cellPadding: 4, overflow: "linebreak" },
        headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: "bold" },
        alternateRowStyles: { fillColor: [245, 247, 250] },
      });
      y = (doc as any).lastAutoTable.finalY + 12;
      continue;
    }
    if (line.startsWith("# ")) {
      text(line.slice(2), 17, "bold", 0, 8);
      continue;
    }
    if (line.startsWith("## ")) {
      ensure(40);
      y += 6;
      text(line.slice(3), 13, "bold", 0, 2);
      doc.setDrawColor(203, 213, 225);
      doc.line(margin, y, pageW - margin, y);
      y += 8;
      continue;
    }
    if (line.startsWith("### ")) {
      y += 2;
      text(line.slice(4), 11, "bold", 0, 2);
      continue;
    }
    if (line === "---") {
      ensure(16);
      doc.setDrawColor(203, 213, 225);
      doc.line(margin, y + 4, pageW - margin, y + 4);
      y += 14;
      continue;
    }
    if (line.startsWith("> ")) {
      text(line.slice(2), 9, "italic", 10, 6);
      continue;
    }
    const bullet = line.match(/^(\s*)(- |\d+\. )(.*)$/);
    if (bullet) {
      const marker = bullet[2].trim() === "-" ? "•" : bullet[2].trim();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      ensure(13);
      doc.text(marker, margin + 6, y + 9.5);
      text(strip(bullet[3]), 9.5, "normal", 20, 2);
      continue;
    }
    const italic = line.match(/^_(.*)_$/);
    if (italic) {
      text(italic[1], 8.5, "italic", 0, 6);
      continue;
    }
    const bold = line.match(/^\*\*(.*)\*\*$/);
    if (bold) {
      text(bold[1], 10.5, "bold", 0, 4);
      continue;
    }
    text(strip(line), 9.5, "normal", 0, 6);
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(footer, margin, pageH - 24);
    doc.text(`Page ${p} of ${pages}`, pageW - margin, pageH - 24, { align: "right" });
    doc.setTextColor(0, 0, 0);
  }
  doc.save(filename);
}

/** Inline Markdown emphasis is dropped; the PDF styles whole lines instead. */
function strip(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1$2").replace(/\s{2,}$/, "");
}

/** Map characters the standard PDF fonts can't draw. */
function clean(s: string): string {
  return s
    .replace(/₹\s?/g, "INR ")
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/✓/g, "")
    .replace(/±/g, "+/-")
    .replace(/[^\x00-\xFF–—‘’“”•…]/g, "");
}
