"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzrKQrXyFjLEiYC26Z9DhXGiXu1ujDTEOjRZ-4BojkxXMmwiPPCbjkQu5AYmL6-nYX1/exec";
const $ = id => document.getElementById(id);

const fileInput = $("fileInput");
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

fileInput.addEventListener("change", () => {
  const chosen = Array.from(fileInput.files || []);
  const files = chosen.filter(file =>
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );

  if (chosen.length > 100) {
    alert("एक बार में अधिकतम 100 PDF चुनें।");
    fileInput.value = "";
    return;
  }

  if (chosen.length && files.length !== chosen.length) {
    alert("सिर्फ PDF files चुनें।");
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
    ? `<tr><td colspan="10">${files.length} PDF चुनी गई हैं। अब Read Data दबाएँ।</td></tr>`
    : `<tr><td colspan="10">पहले PDF चुनें</td></tr>`;
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
  resultBody.innerHTML = `<tr><td colspan="10">पहले PDF चुनें</td></tr>`;
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
      const pageData = await extractFirstTwoPages(file);
      const record = parseRegistryPages(pageData);
      record.fileName = file.name;

      const identityComplete = Boolean(
        record.deedType &&
        record.registryNumber &&
        record.registrationDate &&
        record.tokenNumber
      );

      record.status =
        identityComplete && record.financialFieldsFound === 4
          ? "Completed"
          : "Check";

      if (record.status === "Completed") {
        completed++;
        await saveToGoogleSheet(record);
      } else {
        checks++;
      }

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

async function saveToGoogleSheet(record) {
  try {
    await fetch(WEB_APP_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        deedType: record.deedType || "",
        registryNumber: record.registryNumber || "",
        registrationDate: record.registrationDate || "",
        tokenNumber: record.tokenNumber || "",
        deedAmount: record.deedAmount || "0.00",
        landValue: record.landValue || "0.00",
        stampDuty: record.stampDuty || "0.00",
        registrationFees: record.registrationFees || "0.00",
        status: record.status || "",
        fileName: record.fileName || ""
      })
    });
  } catch (error) {
    console.error("Google Sheet save error:", error);
  }
}

async function extractFirstTwoPages(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: buffer}).promise;
  const pageCount = Math.min(2, pdf.numPages);
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    statusText.textContent = `PDF Page ${pageNumber}/${pageCount} पढ़ रहा है...`;
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows = groupPdfItemsIntoRows(content.items);
    pages.push({
      pageNumber,
      rows,
      text: rows.map(row => row.text).join("\n")
    });
  }

  return pages;
}

function groupPdfItemsIntoRows(items) {
  const usable = items
    .filter(item => String(item.str || "").trim())
    .map(item => ({
      text: String(item.str || "").trim(),
      x: Number(item.transform?.[4] || 0),
      y: Number(item.transform?.[5] || 0)
    }))
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const rows = [];
  const tolerance = 4;

  for (const item of usable) {
    let row = rows.find(candidate => Math.abs(candidate.y - item.y) <= tolerance);
    if (!row) {
      row = {y: item.y, items: []};
      rows.push(row);
    }
    row.items.push(item);
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map(row => {
      const sorted = row.items.sort((a, b) => a.x - b.x);
      return {
        y: row.y,
        text: sorted.map(item => item.text).join(" ").replace(/\s+/g, " ").trim()
      };
    })
    .filter(row => row.text);
}

function parseRegistryPages(pages) {
  const fullText = normalizeText(pages.map(page => page.text).join("\n"));
  const compact = compactText(fullText);
  const record = emptyRecord();

  record.deedType = extractDeedType(fullText);

  record.registryNumber =
    extractByCompactLabel(compact, ["प्रलेखक्र", "प्रलेखक्रमांक"], "integer") ||
    firstMatch(fullText, [
      /Registration\s*No\.?\s*[:\-]?\s*(\d+)/i,
      /Registration\s*Number\s*[:\-]?\s*(\d+)/i
    ]);

  record.registrationDate = normalizeDate(
    extractByCompactLabel(compact, ["पंजीकरणदिनांक"], "date") ||
    firstMatch(fullText, [
      /Registration\s*No\.?\s*[:\-]?\s*\d+[\s\S]{0,50}?Date\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
      /\bDate\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i
    ])
  );

  record.tokenNumber = extractToken(fullText);

  const financial = extractFinancialFields(fullText);
  record.deedAmount = financial.deedAmount.value;
  record.landValue = financial.landValue.value;
  record.stampDuty = financial.stampDuty.value;
  record.registrationFees = financial.registrationFees.value;
  record.financialFieldsFound = [
    financial.deedAmount.found,
    financial.landValue.found,
    financial.stampDuty.found,
    financial.registrationFees.found
  ].filter(Boolean).length;

  return record;
}

/*
  Financial extraction is deliberately strict:
  - only first two pages are used;
  - only decimal money values are accepted;
  - values are read only after their Hindi word group;
  - GRN/e-challan/RTGS/cheque numbers are never used;
  - if a word group is not found, the field stays 0 and Status becomes Check.
*/
function extractFinancialFields(text) {
  const canonical = canonicalForFinance(text);

  return {
    deedAmount: extractCanonicalMoney(
      canonical,
      /लनदन(?:रश)?/,
      [/कलकटर/, /कलसटमप/, /पजकरणफस/]
    ),
    landValue: extractCanonicalMoney(
      canonical,
      /कलकटर(?:दर)?/,
      [/कलसटमप/, /पजकरणफस/, /लनदन/]
    ),
    stampDuty: extractCanonicalMoney(
      canonical,
      /कलसटमप/,
      [/पजकरणफस/, /लनदन/, /कलकटर/, /कलकरत|कलकरत|कलकरता|कलदवदर|कलनयस/]
    ),
    registrationFees: extractCanonicalMoney(
      canonical,
      /पजकरणफस/,
      [/लनदन/, /कलकटर/, /कलसटमप/, /ईचलन/]
    )
  };
}

function canonicalForFinance(value) {
  return String(value || "")
    .normalize("NFD")
    .toLowerCase()
    .replace(/[\u0900-\u0903]/g, "")
    .replace(/[\u093a-\u094f\u0951-\u0957\u0962-\u0963]/g, "")
    .replace(/[₹,:;|()[\]{}–—\-_/\\\s]/g, "")
    .replace(/[^\u0904-\u0939a-z0-9.]/g, "");
}

function extractCanonicalMoney(canonical, anchorPattern, stopPatterns) {
  const anchor = canonical.match(anchorPattern);
  if (!anchor || anchor.index === undefined) {
    return {found: false, value: "0.00"};
  }

  const valueStart = anchor.index + anchor[0].length;
  let valueEnd = Math.min(canonical.length, valueStart + 120);

  for (const stopPattern of stopPatterns) {
    const tail = canonical.slice(valueStart);
    const stop = tail.match(stopPattern);
    if (stop && stop.index !== undefined && valueStart + stop.index < valueEnd) {
      valueEnd = valueStart + stop.index;
    }
  }

  const segment = canonical.slice(valueStart, valueEnd);

  // Financial values in these PDFs are decimal amounts.
  // This rejects e-challan, GRN, token, cheque and account numbers.
  const amount = segment.match(/(\d{1,15}\.\d{1,2})/);

  return {
    found: true,
    value: amount ? formatAmount(amount[1]) : "0.00"
  };
}

function extractDeedType(text) {
  const patterns = [
    ["TRANSFER OF IMMOVABLE PROPERTY", /TRANSFER\s+OF\s+IMMOVABLE\s+PROPERTY\s+DEED/i],
    ["POWER OF ATTORNEY", /POWER\s+OF\s+ATTORNEY\s+DEED/i],
    ["CONVEYANCE", /CONVEYANCE\s+DEED/i],
    ["AGREEMENT", /AGREEMENT\s+DEED/i],
    ["TARTIMA", /TARTIMA\s+DEED/i],
    ["TRUST", /TRUST\s+DEED/i],
    ["SALE", /SALE\s+DEED/i],
    ["GIFT", /GIFT\s+DEED/i],
    ["WILL", /WILL\s+DEED/i],
    ["LEASE", /LEASE\s+DEED/i],
    ["ADOPTION", /ADOPTION\s+DEED/i],
    ["RECTIFICATION", /RECTIFICATION\s+DEED/i],
    ["CANCELLATION", /CANCELLATION\s+DEED/i],
    ["PARTITION", /PARTITION\s+DEED/i],
    ["RELEASE", /RELEASE\s+DEED/i]
  ];

  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) return label;
  }

  const purpose = firstMatch(text, [/Purpose\s*:\s*([A-Z][A-Z ]{1,60})/i]);
  return purpose ? purpose.toUpperCase().trim() : "";
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function compactText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[₹:;|()[\]{}–—\-_,/.]/g, "")
    .replace(/\s+/g, "");
}

function extractByCompactLabel(compact, labels, kind) {
  for (const label of labels) {
    const index = compact.indexOf(label);
    if (index === -1) continue;

    const after = compact.slice(index + label.length, index + label.length + 80);

    if (kind === "integer") {
      const match = after.match(/(\d{1,10})/);
      if (match) return match[1];
    }

    if (kind === "date") {
      const match = after.match(/(\d{1,2})(\d{1,2})(\d{4})/);
      if (match) return `${match[1]}/${match[2]}/${match[3]}`;
    }
  }
  return "";
}

function extractToken(text) {
  const match = String(text || "").match(/\b(PAN_[A-Z0-9_]+)\b/i);
  return match ? match[1] : "";
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

function normalizeDate(value) {
  if (!value) return "";
  const normalized = String(value).replace(/-/g, "/");
  const match = normalized.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return match
    ? `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}/${match[3]}`
    : normalized;
}

function formatAmount(value) {
  const cleaned = String(value || "")
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
    financialFieldsFound: 0,
    status: ""
  };
}

function appendRow(record, serial) {
  const statusClass = record.status === "Completed" ? "success" : "warning";
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
    "Deed Amount", "Land Value", "Stamp Duty", "Registration Fee", "Status"
  ], ...results.map(record => [
    record.deedType,
    record.registryNumber,
    record.registrationDate,
    record.tokenNumber,
    record.deedAmount,
    record.landValue,
    record.stampDuty,
    record.registrationFees,
    record.status
  ])];

  const csv = "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\n");
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

