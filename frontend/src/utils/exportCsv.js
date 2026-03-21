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
  const blob = new Blob([header + "\n" + csv.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
