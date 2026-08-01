"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = id => document.getElementById(id);
const fileInput = $("fileInput");
const processButton = $("processButton");
const csvButton = $("csvButton");
const clearButton = $("clearButton");
const fileList = $("fileList");
const resultBody = $("resultBody");
const selectedCount = $("selectedCount");
const completedCount = $("completedCount");
const failedCount = $("failedCount");
const progressArea = $("progressArea");
const progressBar = $("progressBar");
const statusText = $("statusText");

let selectedFiles = [];
let finalResults = [];

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []);
  if (files.length > 100) {
    alert("एक बार में अधिकतम 100 Files Select करें।");
    fileInput.value = "";
    return;
  }

  selectedFiles = files;
  finalResults = [];
  selectedCount.textContent = String(files.length);
  completedCount.textContent = "0";
  failedCount.textContent = "0";
  processButton.disabled = files.length === 0;
  clearButton.disabled = files.length === 0;
  csvButton.disabled = true;
  renderFileList();

  resultBody.innerHTML = files.length
    ? `<tr><td colspan="11">${files.length} Files Select हो गई हैं। अब Start Reading दबाएँ।</td></tr>`
    : `<tr><td colspan="11">पहले PDF या Image Select करें</td></tr>`;
});

clearButton.addEventListener("click", resetAll);

function resetAll() {
  selectedFiles = [];
  finalResults = [];
  fileInput.value = "";
  selectedCount.textContent = "0";
  completedCount.textContent = "0";
  failedCount.textContent = "0";
  processButton.disabled = true;
  csvButton.disabled = true;
  clearButton.disabled = true;
  progressArea.style.display = "none";
  progressBar.style.width = "0%";
  renderFileList();
  resultBody.innerHTML =
    `<tr><td colspan="11">पहले PDF या Image Select करें</td></tr>`;
}

function renderFileList() {
  if (!selectedFiles.length) {
    fileList.style.display = "none";
    fileList.innerHTML = "";
    return;
  }
  fileList.style.display = "block";
  fileList.innerHTML = selectedFiles.map((file, i) =>
    `<div class="file-item">${i + 1}. ${escapeHtml(file.name)}</div>`
  ).join("");
}


processButton.addEventListener("click", async () => {
  if (!selectedFiles.length) return;

  processButton.disabled = true;
  csvButton.disabled = true;
  finalResults = [];
  resultBody.innerHTML = "";
  progressArea.style.display = "block";

  const workItems = buildWorkItems(selectedFiles);
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < workItems.length; i++) {
    const item = workItems[i];

    setProgress(i, workItems.length,
      `Reading ${i + 1}/${workItems.length}: ${item.displayName}`);

    let record;

    try {
      record = await readWorkItem(item);
      record.fileName = item.displayName;

      if (record.registryNumber || record.tokenNumber) {
        record.status = record.warning ? "Check" : "Completed";
        completed++;
      } else {
        record.status = "Data Not Found";
        failed++;
      }
    } catch (error) {
      console.error(item.displayName, error);
      record = emptyRecord();
      record.fileName = item.displayName;
      record.status = "Error";
      failed++;
    }

    finalResults.push(record);
    addTableRow(record, i + 1);

    completedCount.textContent = String(completed);
    failedCount.textContent = String(failed);
  }

  setProgress(workItems.length, workItems.length,
    `Completed: ${completed} | Failed: ${failed}`);

  processButton.disabled = false;
  csvButton.disabled = finalResults.length === 0;
});

async function readAndExtract(file) {
  const name = file.name.toLowerCase();

  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return extractPdfRecord(await readPdfStructured(file));
  }

  if (file.type.startsWith("image/") ||
      name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png")) {
    statusText.textContent = "Image OCR चल रहा है...";
    return extractOcrRecord(await runOcr(file));
  }

  throw new Error("Unsupported file type");
}

async function readPdfStructured(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
  const pagesToRead = Math.min(pdf.numPages, 2);
  const pages = [];
  let fullText = "";

  for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
    statusText.textContent = `PDF Page ${pageNumber}/${pagesToRead} पढ़ रहा है...`;

    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items
      .filter(item => String(item.str || "").trim())
      .map(item => ({
        text: normalizeText(item.str),
        x: Number(item.transform?.[4] || 0),
        y: Number(item.transform?.[5] || 0)
      }));

    const rows = groupIntoRows(items, pageNumber);
    pages.push({pageNumber, rows});
    fullText += " " + rows.map(row => row.text).join(" ");
  }

  if (normalizeText(fullText).length < 60) {
    fullText = "";
    pages.length = 0;

    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
      statusText.textContent =
        `Scanned PDF Page ${pageNumber} OCR चल रहा है...`;

      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({scale: 1.7});
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      await page.render({canvasContext: context, viewport}).promise;
      const text = normalizeText(await runOcr(canvas));
      pages.push({
        pageNumber,
        rows: text.split(/\n+/).map((line, index) => ({
          page: pageNumber,
          y: 10000 - index,
          text: normalizeText(line)
        })).filter(row => row.text)
      });
      fullText += " " + text;
    }
  }

  return {
    text: normalizeText(fullText),
    rows: pages.flatMap(page => page.rows)
  };
}

function groupIntoRows(items, pageNumber) {
  const tolerance = 3.8;
  const groups = [];
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x));

  for (const item of sorted) {
    let group = groups.find(row => Math.abs(row.y - item.y) <= tolerance);
    if (!group) {
      group = {page: pageNumber, y: item.y, items: []};
      groups.push(group);
    }
    group.items.push(item);
    group.y = group.items.reduce((sum, value) => sum + value.y, 0) /
      group.items.length;
  }

  return groups.map(group => ({
    page: group.page,
    y: group.y,
    text: group.items
      .sort((a, b) => a.x - b.x)
      .map(value => value.text)
      .join(" ")
  })).sort((a, b) => (a.page - b.page) || (b.y - a.y));
}

async function runOcr(source) {
  const result = await Tesseract.recognize(source, "eng", {
    logger(message) {
      if (message.status === "recognizing text" &&
          typeof message.progress === "number") {
        statusText.textContent = `OCR ${Math.round(message.progress * 100)}%`;
      }
    }
  });
  return result.data.text || "";
}

function extractPdfRecord(data) {
  const record = emptyRecord();
  const allText = data.text;
  const rows = data.rows;

  record.deedType = extractDeedType(allText);

  record.registryNumber = cleanInteger(firstMatch(allText, [
    /Registration\s*No\.?\s*[:\-]?\s*(\d+)/i,
    /Registration\s*Number\s*[:\-]?\s*(\d+)/i,
    /प्रलेख\s*क्र\.?\s*[:\-]?\s*(\d+)/i
  ]));

  record.registrationDate = cleanDate(firstMatch(allText, [
    /Registration\s*No\.?\s*[:\-]?\s*\d+\s*Date\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
    /Registration\s*Number\s*[:\-]?\s*\d+\s*Date\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
    /पंजी\s*करण\s*दि\s*नां\s*क\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
    /\bDate\s*[:\-]\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i
  ]));

  record.tokenNumber = firstMatch(allText, [
    /Token\s*No\.?\s*[:\-]?\s*([A-Z0-9_]+)/i,
    /\(Token\s*:\s*([A-Z0-9_]+)\)/i,
    /\b(PAN_[A-Z0-9_]+)\b/i
  ]);

  const finance = extractFinancialFields(rows, allText);
  record.deedAmount = finance.deedAmount;
  record.landValue = finance.landValue;
  record.stampDuty = finance.stampDuty;
  record.registrationFees = finance.registrationFees;
  record.warning = finance.warning;

  return record;
}

function extractFinancialFields(rows, allText) {
  const aliases = {
    deedAmount: [
      "लेनदेनराशि", "लेनदेनमूल्य", "प्रतिफलराशि", "विक्रयराशि",
      "transactionamount", "considerationamount", "considerationvalue",
      "deedamount"
    ],
    landValue: [
      "कलेक्टरदर", "कलैक्टरदर", "भूमिमूल्य", "जमीनमूल्य",
      "landvalue", "collectorvalue", "collectorrate",
      "guidelinevalue", "circlevalue", "circlevalueofproperty"
    ],
    stampDuty: [
      "कुलस्टाम्पशुल्क", "कुलस्टांपशुल्क", "कुलस्टााम्पशुल्क",
      "stampdutypaid", "stampduty"
    ],
    registrationFees: [
      "पंजीकरणफीस", "पंजीकरणशुल्क", "रजिस्ट्रेशनफीस",
      "registrationfees", "registrationfee"
    ]
  };

  const result = {
    deedAmount: "",
    landValue: "",
    stampDuty: "",
    registrationFees: "",
    warning: false
  };

  for (const row of rows) {
    const compact = compactText(row.text);
    if (!result.deedAmount) {
      result.deedAmount = amountAfterAnyAlias(compact, aliases.deedAmount);
    }
    if (!result.landValue) {
      result.landValue = amountAfterAnyAlias(compact, aliases.landValue);
    }
    if (!result.stampDuty) {
      result.stampDuty = amountAfterAnyAlias(compact, aliases.stampDuty);
    }
    if (!result.registrationFees) {
      result.registrationFees =
        amountAfterAnyAlias(compact, aliases.registrationFees);
    }
  }

  const fullCompact = compactText(allText);
  if (!result.deedAmount) {
    result.deedAmount = amountAfterAnyAlias(fullCompact, aliases.deedAmount);
  }
  if (!result.landValue) {
    result.landValue = amountAfterAnyAlias(fullCompact, aliases.landValue);
  }
  if (!result.stampDuty) {
    result.stampDuty = amountAfterAnyAlias(fullCompact, aliases.stampDuty);
  }
  if (!result.registrationFees) {
    result.registrationFees =
      amountAfterAnyAlias(fullCompact, aliases.registrationFees);
  }

  const financialRows = rows.filter(row => {
    const compact = compactText(row.text);
    return compact.includes("धनसंबंधीविवरण") ||
      aliases.deedAmount.some(alias => compact.includes(alias)) ||
      aliases.landValue.some(alias => compact.includes(alias)) ||
      aliases.stampDuty.some(alias => compact.includes(alias)) ||
      aliases.registrationFees.some(alias => compact.includes(alias));
  });

  const firstMoneyRow = financialRows.find(row => {
    const nums = decimalAmounts(row.text);
    return nums.length >= 2 &&
      !/Stamp\s*Duty\s*Paid|Registration\s*Fees/i.test(row.text);
  });

  if (firstMoneyRow) {
    const nums = decimalAmounts(firstMoneyRow.text);

    if (!result.deedAmount && nums.length >= 1) {
      result.deedAmount = nums[0];
    }

    if (!result.landValue) {
      if (nums.length >= 3) {
        result.landValue = nums[1];
      } else if (nums.length === 2 &&
                 result.stampDuty &&
                 amountsEqual(nums[1], result.stampDuty)) {
        result.landValue = "0.00";
      }
    }

    if (!result.stampDuty) {
      if (nums.length >= 3) {
        result.stampDuty = nums[2];
      } else if (nums.length === 2) {
        result.stampDuty = nums[1];
      }
    }

    if (!result.registrationFees) {
      const firstIndex = rows.indexOf(firstMoneyRow);
      const nextRows = rows.slice(firstIndex + 1, firstIndex + 5);
      for (const row of nextRows) {
        const nums2 = decimalAmounts(row.text);
        if (nums2.length >= 2 &&
            result.stampDuty &&
            amountsEqual(nums2[0], result.stampDuty)) {
          result.registrationFees = nums2[1];
          break;
        }
      }
    }
  }

  result.deedAmount = cleanAmount(result.deedAmount);
  result.landValue = cleanAmount(result.landValue);
  result.stampDuty = cleanAmount(result.stampDuty);
  result.registrationFees = cleanAmount(result.registrationFees);

  return result;
}

function amountAfterAnyAlias(compact, aliases) {
  for (const alias of aliases) {
    const index = compact.indexOf(alias);
    if (index === -1) continue;

    const after = compact.slice(index + alias.length, index + alias.length + 80);

    // अगले label से पहले मौजूद number ही लिया जाएगा।
    const boundary = after.search(
      /(?:लेनदेन|कलेक्टर|कलैक्टर|भूमिमूल्य|जमीनमूल्य|कुलस्टा|पंजीकरण|registration|stampduty|landvalue|collector|transaction|consideration)/
    );
    const segment = boundary > 0 ? after.slice(0, boundary) : after;
    const match = segment.match(/(\d[\d,]{0,14}(?:\.\d{1,2})?)/);
    return match ? cleanAmount(match[1]) : "";
  }
  return "";
}

function extractOcrRecord(text) {
  const record = emptyRecord();
  const clean = normalizeText(text);
  record.deedType = extractDeedType(clean);
  record.registryNumber = cleanInteger(firstMatch(clean, [
    /Registration\s*No\.?\s*[:\-]?\s*(\d+)/i
  ]));
  record.registrationDate = cleanDate(firstMatch(clean, [
    /Date\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i
  ]));
  record.tokenNumber = firstMatch(clean, [
    /Token\s*(?:No\.?)?\s*[:\-]?\s*([A-Z0-9_]+)/i,
    /\b(PAN_[A-Z0-9_]+)\b/i
  ]);
  record.stampDuty = cleanAmount(firstMatch(clean, [
    /Stamp\s*Duty\s*Paid\s*[:\-]?\s*(?:₹\s*)?([\d,]+(?:\.\d{1,2})?)/i
  ]));
  record.registrationFees = cleanAmount(firstMatch(clean, [
    /Registration\s*Fees?\s*[:\-]?\s*(?:₹\s*)?([\d,]+(?:\.\d{1,2})?)/i
  ]));
  record.warning = true;
  return record;
}

function extractDeedType(text) {
  const patterns = [
    [/\bTRANSFER\s+OF\s+IMMOVABLE\s+PROPERTY\s+DEED\b/i,
      "TRANSFER OF IMMOVABLE PROPERTY"],
    [/\bPOWER\s+OF\s+ATTORNEY\s+DEED\b/i, "POWER OF ATTORNEY"],
    [/\bCONVEYANCE\s+DEED\b/i, "CONVEYANCE"],
    [/\bAGREEMENT\s+DEED\b/i, "AGREEMENT"],
    [/\bTARTIMA\s+DEED\b/i, "TARTIMA"],
    [/\bTRUST\s+DEED\b/i, "TRUST"],
    [/\bADOPTION\s+DEED\b/i, "ADOPTION"],
    [/\bCANCELLATION\s+DEED\b/i, "CANCELLATION"],
    [/\bRECTIFICATION\s+DEED\b/i, "RECTIFICATION"],
    [/\bPARTITION\s+DEED\b/i, "PARTITION"],
    [/\bRELEASE\s+DEED\b/i, "RELEASE"],
    [/\bSURRENDER\s+OF\s+LEASE\b/i, "SURRENDER OF LEASE"],
    [/\bLEASE\s+DEED\b/i, "LEASE"],
    [/\bGIFT\s+DEED\b/i, "GIFT"],
    [/\bSALE\s+DEED\b/i, "SALE"],
    [/\bWILL\s+DEED\b/i, "WILL"],
    [/\bWILL\b/i, "WILL"],
    [/\bGPA\b/i, "GPA"],
    [/\bSPA\b/i, "SPA"]
  ];

  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) return label;
  }

  const purpose = firstMatch(text, [
    /Purpose\s*[:\-]\s*([A-Z][A-Z ]{1,50})/i
  ]);
  return purpose ? purpose.trim() : "";
}

function decimalAmounts(text) {
  const matches = String(text || "")
    .match(/(?<![\d/])\d[\d,]{0,14}\.\d{1,2}(?!\d)/g) || [];
  return matches.map(cleanAmount);
}

function compactText(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[₹:;|()[\]{}–—\-_]/g, "")
    .replace(/\s+/g, "");
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

function cleanInteger(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function cleanAmount(value) {
  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^\d.]/g, "");

  if (!cleaned) return "0.00";
  const number = Number(cleaned);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function cleanDate(value) {
  return value ? String(value).replace(/-/g, "/") : "";
}

function amountsEqual(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;
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
    warning: false,
    status: ""
  };
}

function addTableRow(record, serial) {
  const statusClass =
    record.status === "Completed" ? "success" :
    record.status === "Check" ? "warning" : "error";

  resultBody.insertAdjacentHTML("beforeend", `
    <tr>
      <td>${serial}</td>
      <td class="file-name">${escapeHtml(record.fileName)}</td>
      <td>${escapeHtml(record.deedType || "Not Found")}</td>
      <td>${escapeHtml(record.registryNumber || "Not Found")}</td>
      <td>${escapeHtml(record.registrationDate || "Not Found")}</td>
      <td>${escapeHtml(record.tokenNumber || "Not Found")}</td>
      <td>${escapeHtml(record.deedAmount)}</td>
      <td>${escapeHtml(record.landValue)}</td>
      <td>${escapeHtml(record.stampDuty)}</td>
      <td>${escapeHtml(record.registrationFees)}</td>
      <td class="${statusClass}">${escapeHtml(record.status)}</td>
    </tr>
  `);
}

function setProgress(done, total, message) {
  const percentage = total ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = percentage + "%";
  statusText.textContent = message;
}

csvButton.addEventListener("click", () => {
  if (!finalResults.length) return;

  const rows = [
    [
      "Deed Type", "Registry Number", "Registration Date", "Token Number",
      "Deed Amount", "Land Value", "Stamp Duty", "Registration Fee"
    ],
    ...finalResults.map(record => [
      record.deedType,
      record.registryNumber,
      record.registrationDate,
      record.tokenNumber,
      record.deedAmount,
      record.landValue,
      record.stampDuty,
      record.registrationFees
    ])
  ];

  const csv = "\uFEFF" +
    rows.map(row => row.map(csvCell).join(",")).join("\n");

  const blob = new Blob([csv], {type: "text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "panipat-registry-data.csv";
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
