"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = id => document.getElementById(id);
const fileInput = $("fileInput");
const selectButton = $("selectButton");
const readButton = $("readButton");
const csvButton = $("csvButton");
const clearButton = $("clearButton");
const fileList = $("fileList");
const progressArea = $("progressArea");
const progressBar = $("progressBar");
const statusText = $("statusText");
const resultBody = $("resultBody");
const selectedCount = $("selectedCount");
const completedCount = $("completedCount");
const checkCount = $("checkCount");

let selectedFiles = [];
let results = [];

selectButton.addEventListener("click", () => {
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const chosen = Array.from(fileInput.files || []);
  const files = chosen.filter(file =>
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );

  if (chosen.length && !files.length) {
    alert("सिर्फ PDF File Select करें।");
    fileInput.value = "";
  }

  if (files.length > 100) {
    alert("एक बार में अधिकतम 100 PDF Select करें।");
    fileInput.value = "";
    selectedFiles = [];
    return;
  }

  selectedFiles = files;
  results = [];
  selectedCount.textContent = String(files.length);
  completedCount.textContent = "0";
  checkCount.textContent = "0";
  readButton.disabled = files.length === 0;
  csvButton.disabled = true;
  clearButton.disabled = files.length === 0;
  renderFiles();

  resultBody.innerHTML = files.length
    ? `<tr><td colspan="10">${files.length} PDF Select हो गई हैं। Read Data दबाएँ।</td></tr>`
    : `<tr><td colspan="10">पहले PDF Select करें</td></tr>`;
});

clearButton.addEventListener("click", resetAll);

function resetAll() {
  selectedFiles = [];
  results = [];
  fileInput.value = "";
  selectedCount.textContent = "0";
  completedCount.textContent = "0";
  checkCount.textContent = "0";
  readButton.disabled = true;
  csvButton.disabled = true;
  clearButton.disabled = true;
  fileList.innerHTML = "";
  fileList.classList.add("hidden");
  progressArea.classList.add("hidden");
  progressBar.style.width = "0%";
  resultBody.innerHTML = `<tr><td colspan="10">पहले PDF Select करें</td></tr>`;
}

function renderFiles() {
  if (!selectedFiles.length) {
    fileList.classList.add("hidden");
    return;
  }
  fileList.classList.remove("hidden");
  fileList.innerHTML = selectedFiles.map((file, i) =>
    `<div class="file-item">${i + 1}. ${escapeHtml(file.name)}</div>`
  ).join("");
}

readButton.addEventListener("click", async () => {
  if (!selectedFiles.length) return;

  results = [];
  resultBody.innerHTML = "";
  progressArea.classList.remove("hidden");
  readButton.disabled = true;
  csvButton.disabled = true;

  let completed = 0;
  let checks = 0;

  for (let i = 0; i < selectedFiles.length; i++) {
    const file = selectedFiles[i];
    setProgress(i, selectedFiles.length,
      `Reading ${i + 1}/${selectedFiles.length}: ${file.name}`);

    try {
      const text = await extractFirstTwoPages(file);
      const record = parseRegistryText(text);
      record.fileName = file.name;

      const identityOkay =
        record.deedType && record.registryNumber &&
        record.registrationDate && record.tokenNumber;

      record.status = identityOkay ? "Completed" : "Check";
      if (identityOkay) completed++;
      else checks++;

      results.push(record);
      appendRow(record, i + 1);
    } catch (error) {
      console.error(file.name, error);
      const record = emptyRecord();
      record.fileName = file.name;
      record.status = "Check";
      results.push(record);
      checks++;
      appendRow(record, i + 1);
    }

    completedCount.textContent = String(completed);
    checkCount.textContent = String(checks);
  }

  setProgress(selectedFiles.length, selectedFiles.length,
    `Completed: ${completed} | Check: ${checks}`);

  readButton.disabled = false;
  csvButton.disabled = results.length === 0;
});

async function extractFirstTwoPages(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: buffer}).promise;
  const pageCount = Math.min(2, pdf.numPages);
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    statusText.textContent =
      `PDF Page ${pageNumber}/${pageCount} पढ़ रहा है...`;

    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = groupPdfItemsIntoLines(content.items);
    pageTexts.push(lines.join("\n"));
  }

  return normalizeText(pageTexts.join("\n"));
}

function groupPdfItemsIntoLines(items) {
  const usable = items
    .filter(item => String(item.str || "").trim())
    .map(item => ({
      text: String(item.str || "").trim(),
      x: Number(item.transform?.[4] || 0),
      y: Number(item.transform?.[5] || 0)
    }))
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const rows = [];
  const tolerance = 3.5;

  for (const item of usable) {
    let row = rows.find(candidate =>
      Math.abs(candidate.y - item.y) <= tolerance
    );

    if (!row) {
      row = {y: item.y, items: []};
      rows.push(row);
    }

    row.items.push(item);
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map(row => row.items
      .sort((a, b) => a.x - b.x)
      .map(item => item.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    )
    .filter(Boolean);
}

function parseRegistryText(text) {
  const record = emptyRecord();
  const clean = normalizeText(text);

  record.deedType = extractDeedType(clean);

  record.registryNumber = firstMatch(clean, [
    /Registration\s*No\.?\s*:\s*(\d+)/i,
    /प्रलेख\s*क्र\.?\s*:\s*(\d+)/i
  ]);

  record.registrationDate = normalizeDate(firstMatch(clean, [
    /Registration\s*No\.?\s*:\s*\d+\s*Date\s*:\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/i,
    /पंजीकरण\s*दिनांक\s*:\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/i
  ]));

  record.tokenNumber = firstMatch(clean, [
    /Token\s*No\.?\s*:\s*([A-Z0-9_]+)/i,
    /\(Token\s*:\s*([A-Z0-9_]+)\)/i,
    /\b(PAN_[A-Z0-9_]+)\b/i
  ]);

  const compact = compactFinancialText(clean);

  record.deedAmount = extractFinancialAmount(compact, [
    "लेनदेनराशि", "लेनदेनराशी",
    "transactionamount", "considerationamount", "deedamount"
  ]);

  record.landValue = extractFinancialAmount(compact, [
    "कलेक्टरदर", "कलैक्टरदर",
    "landvalue", "collectorrate", "collectorvalue"
  ]);

  record.stampDuty = extractEnglishOrFinancialAmount(clean, compact, [
    /Stamp\s*Duty\s*Paid\s*:\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/i
  ], [
    "कुलस्टाम्पशुल्क", "कुलस्टााम्पशुल्क", "कुलस्टांपशुल्क",
    "stampdutypaid", "stampduty"
  ]);

  record.registrationFees = extractEnglishOrFinancialAmount(clean, compact, [
    /Registration\s*Fees?\s*:\s*₹?\s*([\d,\s]+(?:\.\d{1,2})?)/i
  ], [
    "पंजीकरणफीस", "पंजीकरणशुल्क",
    "registrationfees", "registrationfee"
  ]);

  return record;
}

function extractDeedType(text) {
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);

  for (const line of lines) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (/^[A-Z][A-Z /&()'-]{1,80}\s+DEED$/i.test(normalized)) {
      return normalized
        .replace(/\s+DEED$/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
    }
  }

  const purpose = firstMatch(text, [
    /Purpose\s*:\s*([A-Z][A-Z ]{1,60})/i
  ]);

  return purpose ? purpose.toUpperCase().trim() : "";
}

function extractEnglishOrFinancialAmount(text, compact, englishPatterns, aliases) {
  const englishValue = firstMatch(text, englishPatterns);
  return englishValue
    ? formatAmount(englishValue)
    : extractFinancialAmount(compact, aliases);
}

function extractFinancialAmount(compact, aliases) {
  const allLabels = [
    "लेनदेनराशि", "लेनदेनराशी", "transactionamount",
    "considerationamount", "deedamount",
    "कलेक्टरदर", "कलैक्टरदर", "landvalue",
    "collectorrate", "collectorvalue",
    "कुलस्टाम्पशुल्क", "कुलस्टााम्पशुल्क", "कुलस्टांपशुल्क",
    "stampdutypaid", "stampduty",
    "पंजीकरणफीस", "पंजीकरणशुल्क",
    "registrationfees", "registrationfee"
  ];

  for (const alias of aliases) {
    const start = compact.indexOf(alias);
    if (start === -1) continue;

    const valueStart = start + alias.length;
    let valueEnd = compact.length;

    for (const nextLabel of allLabels) {
      const nextIndex = compact.indexOf(nextLabel, valueStart);
      if (nextIndex !== -1 && nextIndex < valueEnd) {
        valueEnd = nextIndex;
      }
    }

    const segment = compact.slice(valueStart, valueEnd);
    const match = segment.match(/(\d[\d,]{0,14}(?:\.\d{1,2})?)/);
    return match ? formatAmount(match[1]) : "0.00";
  }

  return "0.00";
}

function compactFinancialText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[₹:;|()[\]{}–—\-_]/g, "")
    .replace(/\s+/g, "");
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/[–—]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeDate(value) {
  return value ? String(value).replace(/-/g, "/") : "";
}

function formatAmount(value) {
  const cleaned = String(value || "")
    .replace(/\s+/g, "")
    .replace(/,/g, "")
    .replace(/[^\d.]/g, "");

  const number = Number(cleaned);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function emptyRecord() {
  return {
    fileName: "",
    deedType: "",
    registryNumber: "",
    registrationDate: "",
    tokenNumber: "",
    deedAmount: "0.00",
    landValue: "0.00",
    stampDuty: "0.00",
    registrationFees: "0.00",
    status: ""
  };
}

function appendRow(record, serial) {
  const statusClass =
    record.status === "Completed" ? "success" : "warning";

  resultBody.insertAdjacentHTML("beforeend", `
    <tr>
      <td>${serial}</td>
      <td>${escapeHtml(record.deedType || "Not Found")}</td>
      <td>${escapeHtml(record.registryNumber || "Not Found")}</td>
      <td>${escapeHtml(record.registrationDate || "Not Found")}</td>
      <td>${escapeHtml(record.tokenNumber || "Not Found")}</td>
      <td>${record.deedAmount}</td>
      <td>${record.landValue}</td>
      <td>${record.stampDuty}</td>
      <td>${record.registrationFees}</td>
      <td class="${statusClass}">${record.status}</td>
    </tr>
  `);
}

function setProgress(done, total, message) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = percent + "%";
  statusText.textContent = message;
}

csvButton.addEventListener("click", () => {
  if (!results.length) return;

  const rows = [[
    "Deed Type", "Registry Number", "Registration Date", "Token Number",
    "Deed Amount", "Land Value", "Stamp Duty", "Registration Fee"
  ], ...results.map(record => [
    record.deedType,
    record.registryNumber,
    record.registrationDate,
    record.tokenNumber,
    record.deedAmount,
    record.landValue,
    record.stampDuty,
    record.registrationFees
  ])];

  const csv = "\uFEFF" + rows
    .map(row => row.map(csvCell).join(","))
    .join("\n");

  const blob = new Blob([csv], {type: "text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "registry-pdf-data.csv";
  link.click();
  URL.revokeObjectURL(url);
});

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
