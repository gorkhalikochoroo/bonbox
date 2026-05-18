export function exportToCsv(filename, rows, columns) {
  // columns = [{key: "date", label: "Date"}, {key: "amount", label: "Amount"}]
  const header = columns.map(c => c.label).join(",");
  const csv = rows.map(row =>
    columns.map(c => {
      let val = row[c.key] ?? "";
      if (typeof val === "string" && (val.includes(",") || val.includes('"'))) {
        val = '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }).join(",")
  );
  // UTF-8 BOM ("﻿") is critical for Danish accountants: Windows Excel
  // defaults to Windows-1252 when no BOM is present, mangling Æ Ø Å in
  // column headers + supplier names. Mac Numbers / LibreOffice autodetect
  // UTF-8 fine either way. Without this, every Dinero / e-conomic / Billy
  // import from BonBox shows garbled Danish characters.
  const blob = new Blob(
    ["﻿" + header + "\n" + csv.join("\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Firefox needs the anchor in the DOM to honor .click(); Chrome/Safari
  // don't but it doesn't hurt them. Cleanup happens immediately.
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
