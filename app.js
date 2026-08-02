
"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = id => document.getElementById(id);
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzrKQrXyFjLEiYC26Z9DhXGiXu1ujDTEOjRZ-4BojkxXMmwiPPCbjkQu5AYmL6-nYX1/exec";

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
      const text = await extractFirstTwoPages(file);
      const record = parseRegistryText(text);
      record.fileName = file.name;

      const identityOkay = Boolean(
        record.deedType &&
        record.registryNumber &&
        record.registrationDate &&
        record.tokenNumber
      );

      record.status = identityOkay ? "Completed" : "Check";
      if (identityOkay) completed++;
      else checks++;

      results.push(record);
      await saveToGoogleSheet(record);
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
    statusText.textContent = `PDF Page ${pageNumber}/${pageCount} पढ़ रहा है...`;
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
  const clean = normalizeText(text);
  const compact = compactText(clean);
  const record = emptyRecord();

  record.deedType = extractDeedType(clean);

  record.registryNumber =
    extractByCompactLabel(compact, [
      "प्रलेखक्र", "registrationno", "registrationnumber", "regno"
    ], "integer") ||
    firstMatch(clean, [
      /Registration\s*No\.?\s*[:\-]?\s*(\d+)/i,
      /Registration\s*Number\s*[:\-]?\s*(\d+)/i,
      /Reg(?:istration)?\s*No\.?\s*[:\-]?\s*(\d+)/i
    ]);

  record.registrationDate = normalizeDate(
    extractByCompactLabel(compact, [
      "पंजीकरणदिनांक", "registrationdate"
    ], "date") ||
    firstMatch(clean, [
      /Registration\s*No\.?\s*[:\-]?\s*\d+[\s\S]{0,50}?Date\s*[:\-]?\s*(\d{1,2}\s*[\/\-]\s*\d{1,2}\s*[\/\-]\s*\d{4})/i,
      /\bDate\s*[:\-]?\s*(\d{1,2}\s*[\/\-]\s*\d{1,2}\s*[\/\-]\s*\d{4})/i,
      /(\d{1,2}\s*[\/\-]\s*\d{1,2}\s*[\/\-]\s*\d{4})/
    ])
  );

  record.tokenNumber =
    extractToken(clean) ||
    firstMatch(clean, [/\b(PAN_[A-Z0-9_]+)\b/i]);

  record.deedAmount = extractMoney(compact, [
    "लेनदेनराशि", "लेनदेनराश", "transactionamount", "considerationamount", "deedamount"
  ]);

  record.landValue = extractMoney(compact, [
    "कलेक्टरदर", "कलैक्टरदर", "landvalue", "collectorvalue", "collectorrate"
  ]);

  record.stampDuty =
    extractMoney(compact, [
      "कुलस्टाम्पशुल्क", "कुलस्टााम्पशुल्क", "कुलस्टांपशुल्क", "स्टाम्पशुल्क", "stampdutypaid", "stampduty"
    ]) || "0.00";

  record.registrationFees =
    extractMoney(compact, [
      "पंजीकरणफीस", "पंजीकरणशुल्क", "registrationfees", "registrationfee"
    ]) || "0.00";


  return record;
}

function inferDeedAmountFromKnownValues(text, landValue, stampDuty, registrationFee) {
  const land = Number(landValue || 0);
  const stamp = Number(stampDuty || 0);
  const fee = Number(registrationFee || 0);

  const values = decimalAmountsFlexible(text).map(formatAmount);
  const nums = values.map(Number);
  let best = null;

  // Main case: [Deal Amount, Land Value, Stamp Duty].
  for (let i = 0; i + 2 < nums.length; i++) {
    const deal = nums[i];
    const landCandidate = nums[i + 1];
    const stampCandidate = nums[i + 2];
    let score = 0;

    if (nearlyEqual(landCandidate, land)) score += 100;
    if (nearlyEqual(stampCandidate, stamp)) score += 100;

    // Reject common stamp-certificate values being mistaken for deal amount.
    if (nearlyEqual(deal, fee)) score -= 50;
    if (deal === 101) score -= 30;

    if (deal >= landCandidate || deal === 0) score += 10;

    if (!best || score > best.score) {
      best = {score, value: values[i]};
    }
  }

  if (best && best.score >= 180) return best.value;

  // Blank collector value case: [Deal Amount, Stamp Duty].
  if (land === 0) {
    let bestPair = null;
    for (let i = 0; i + 1 < nums.length; i++) {
      const deal = nums[i];
      const stampCandidate = nums[i + 1];
      let score = 0;

      if (nearlyEqual(stampCandidate, stamp)) score += 100;
      if (nearlyEqual(deal, fee)) score -= 50;
      if (deal === 101) score -= 30;
      if (deal >= stampCandidate || deal === 0) score += 10;

      if (!bestPair || score > bestPair.score) {
        bestPair = {score, value: values[i]};
      }
    }
    if (bestPair && bestPair.score >= 90) return bestPair.value;
  }

  return "0.00";
}

function decimalAmountsFlexible(text) {
  const matches = String(text || "").match(
    /(?<![\d/])\d[\d,]{0,14}(?:\s*\.\s*\d{1,2})(?!\d)/g
  ) || [];

  return matches.map(value =>
    value.replace(/\s+/g, "").replace(/,/g, "")
  );
}

function nearlyEqual(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;
}

function extractDeedType(text) {
  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);

  const exact = [
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

  for (const [label, pattern] of exact) {
    if (pattern.test(text)) return label;
  }

  for (const line of lines) {
    const m = line.match(/^([A-Z][A-Z /&()'-]{1,80})\s+DEED$/i);
    if (m) return m[1].replace(/\s+/g, " ").trim().toUpperCase();
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
    .replace(/स्टााम्प/g, "स्टाम्प")
    .replace(/स्टांम्प/g, "स्टाम्प")
    .replace(/स्टांप/g, "स्टाम्प")
    .replace(/कलैक्टर/g, "कलेक्टर")
    .replace(/रपये/g, "रुपये")
    .replace(/[₹:;|()[\]{}–—\-_,/]/g, "")
    .replace(/\s+/g, "");
}

function extractByCompactLabel(compact, labels, kind) {
  for (const label of labels) {
    const index = compact.indexOf(label);
    if (index === -1) continue;
    const after = compact.slice(index + label.length, index + label.length + 80);

    if (kind === "integer") {
      const m = after.match(/(\d{1,10})/);
      if (m) return m[1];
    }

    if (kind === "date") {
      const m = after.match(/(\d{1,2})(\d{1,2})(\d{4})/);
      if (m) return `${m[1]}/${m[2]}/${m[3]}`;
    }
  }
  return "";
}

function extractToken(text) {
  const m = String(text || "").match(/\b(PAN_[A-Z0-9_]+)\b/i);
  return m ? m[1] : "";
}

function extractMoney(compact, labels) {
  const normalized = compactText(compact);
  const boundaries = [
    "लेनदेनराशि", "transactionamount", "considerationamount", "deedamount",
    "कलेक्टरदर", "landvalue", "collectorvalue", "collectorrate",
    "कुलस्टाम्पशुल्क", "स्टाम्पशुल्क", "stampdutypaid", "stampduty",
    "पंजीकरणफीस", "पंजीकरणशुल्क", "registrationfees", "registrationfee",
    "कुलक्रेता", "कुलदावेदार", "कुलन्यासी", "कुलप्राधिकत",
    "स्टाम्पकामूल्य", "पेस्टिंगशुल्क", "ईचालान", "echallan",
    "grnno", "grn", "stampno", "tokenno", "propertyid",
    "rtgs", "neft", "cheque"
  ].map(compactText);

  for (const rawLabel of labels) {
    const label = compactText(rawLabel);
    const start = normalized.indexOf(label);
    if (start === -1) continue;

    const valueStart = start + label.length;
    let valueEnd = Math.min(normalized.length, valueStart + 70);

    for (const boundary of boundaries) {
      if (!boundary || boundary === label) continue;
      const next = normalized.indexOf(boundary, valueStart);
      if (next !== -1 && next < valueEnd) valueEnd = next;
    }

    const segment = normalized.slice(valueStart, valueEnd);

    // Example: "कलेक्टर दर- रुपये" means zero. Never borrow a later identifier.
    if (/^(?:रुपये|rs|inr)/i.test(segment)) return "0.00";

    const match = segment.match(/(\d[\d,]{0,14}(?:\.\d{1,2})?)/);
    return match ? formatAmount(match[1]) : "0.00";
  }

  return "0.00";
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
  const s = String(value).replace(/-/g, "/");
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[1].padStart(2,"0")}/${m[2].padStart(2,"0")}/${m[3]}` : s;
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
    "Deed Amount", "Land Value", "Stamp Duty", "Registration Fee"
  ], ...results.map(r => [
    r.deedType, r.registryNumber, r.registrationDate, r.tokenNumber,
    r.deedAmount, r.landValue, r.stampDuty, r.registrationFees
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

