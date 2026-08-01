"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = id => document.getElementById(id);
const fileInput = $("fileInput");
const readButton = $("readButton");
const csvButton = $("csvButton");
const clearButton = $("clearButton");
const fileList = $("fileList");
const resultBody = $("resultBody");
const progressArea = $("progressArea");
const progressBar = $("progressBar");
const statusText = $("statusText");
const selectedCount = $("selectedCount");
const completedCount = $("completedCount");
const failedCount = $("failedCount");

let selectedFiles = [];
let results = [];



fileInput.addEventListener("change", () => {
  selectedFiles = Array.from(fileInput.files || []);
  if (selectedFiles.length > 100) {
    alert("एक बार में अधिकतम 100 Files Select करें।");
    selectedFiles = [];
    fileInput.value = "";
  }

  results = [];
  selectedCount.textContent = selectedFiles.length;
  completedCount.textContent = "0";
  failedCount.textContent = "0";

  readButton.disabled = selectedFiles.length === 0;
  csvButton.disabled = true;
  clearButton.disabled = selectedFiles.length === 0;

  renderFileList();
  resultBody.innerHTML = selectedFiles.length
    ? `<tr><td colspan="11">${selectedFiles.length} Files Select हो गई हैं। Read Data दबाएँ।</td></tr>`
    : `<tr><td colspan="11">पहले PDF या Images Select करें</td></tr>`;
});

clearButton.addEventListener("click", clearEverything);

function clearEverything() {
  selectedFiles = [];
  results = [];
  fileInput.value = "";
  selectedCount.textContent = "0";
  completedCount.textContent = "0";
  failedCount.textContent = "0";
  readButton.disabled = true;
  csvButton.disabled = true;
  clearButton.disabled = true;
  progressArea.classList.add("hidden");
  progressBar.style.width = "0%";
  fileList.classList.add("hidden");
  fileList.innerHTML = "";
  resultBody.innerHTML =
    `<tr><td colspan="11">पहले PDF या Images Select करें</td></tr>`;
}

function renderFileList() {
  if (!selectedFiles.length) {
    fileList.classList.add("hidden");
    return;
  }
  fileList.classList.remove("hidden");
  fileList.innerHTML = selectedFiles.map((file, i) =>
    `<div class="file-item">${i + 1}. ${escapeHtml(file.name)}</div>`
  ).join("");
}

function isPdf(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isImage(file) {
  const name = file.name.toLowerCase();
  return file.type.startsWith("image/") ||
    name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png");
}

function buildJobs(files) {
  const jobs = [];
  let i = 0;

  while (i < files.length) {
    if (isPdf(files[i])) {
      jobs.push({type: "pdf", files: [files[i]], name: files[i].name});
      i++;
      continue;
    }

    if (isImage(files[i])) {
      if (files[i + 1] && isImage(files[i + 1])) {
        jobs.push({
          type: "images",
          files: [files[i], files[i + 1]],
          name: files[i].name + " + " + files[i + 1].name
        });
        i += 2;
      } else {
        jobs.push({type: "image", files: [files[i]], name: files[i].name});
        i++;
      }
      continue;
    }

    jobs.push({type: "unsupported", files: [files[i]], name: files[i].name});
    i++;
  }

  return jobs;
}

readButton.addEventListener("click", async () => {
  const jobs = buildJobs(selectedFiles);
  if (!jobs.length) return;

  results = [];
  resultBody.innerHTML = "";
  progressArea.classList.remove("hidden");
  readButton.disabled = true;

  let completed = 0;
  let failed = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    setProgress(i, jobs.length, `Reading ${i + 1}/${jobs.length}: ${job.name}`);

    try {
      const record = await readJob(job);
      record.fileName = job.name;
      record.status = (record.registryNumber || record.tokenNumber)
        ? "Completed" : "Check";
      if (record.status === "Completed") completed++;
      else failed++;
      results.push(record);
      addRow(record, results.length);
    } catch (error) {
      console.error(error);
      const record = emptyRecord();
      record.fileName = job.name;
      record.status = "Error";
      results.push(record);
      failed++;
      addRow(record, results.length);
    }

    completedCount.textContent = completed;
    failedCount.textContent = failed;
  }

  setProgress(jobs.length, jobs.length,
    `Completed: ${completed} | Failed: ${failed}`);

  readButton.disabled = false;
  csvButton.disabled = results.length === 0;
});

async function readJob(job) {
  if (job.type === "pdf") {
    return extractPdfRecord(await readPdf(job.files[0]));
  }

  if (job.type === "images") {
    const first = extractImageRecord(await ocrImage(job.files[0], "Page 1"));
    const second = extractImageRecord(await ocrImage(job.files[1], "Page 2"));
    return mergeRecords(first, second);
  }

  if (job.type === "image") {
    const record = extractImageRecord(await ocrImage(job.files[0], "Image"));
    record.status = "Check";
    return record;
  }

  throw new Error("Unsupported file");
}

async function readPdf(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: buffer}).promise;
  const pagesToRead = Math.min(2, pdf.numPages);
  let text = "";

  for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
    statusText.textContent = `PDF Page ${pageNumber}/${pagesToRead} पढ़ रहा है...`;
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    text += " " + content.items.map(item => String(item.str || "")).join(" ");
  }

  return normalize(text);
}

async function ocrImage(file, label) {
  statusText.textContent = `${label} OCR चल रहा है...`;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(2, 1900 / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d", {willReadFrequently: true});
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(.299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2]);
    const value = gray < 155 ? Math.max(0, gray - 25) : Math.min(255, gray + 15);
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
  ctx.putImageData(imageData, 0, 0);

  const result = await Tesseract.recognize(canvas, "eng", {
    logger(message) {
      if (message.status === "recognizing text" && typeof message.progress === "number") {
        statusText.textContent = `${label} OCR ${Math.round(message.progress * 100)}%`;
      }
    }
  });

  return normalize(result.data.text || "");
}

function extractPdfRecord(text) {
  const record = emptyRecord();
  record.deedType = extractDeedType(text);
  record.registryNumber = digits(firstMatch(text, [
    /Registration\s*No\.?\s*[:\-]?\s*(\d+)/i,
    /प्रलेख\s*क्र\.?\s*[:\-]?\s*(\d+)/i
  ]));
  record.registrationDate = dateValue(firstMatch(text, [
    /Registration\s*No\.?\s*[:\-]?\s*\d+\s*Date\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
    /पंजी\s*करण\s*दि\s*नां\s*क\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i
  ]));
  record.tokenNumber = firstMatch(text, [
    /Token\s*No\.?\s*[:\-]?\s*([A-Z0-9_]+)/i,
    /\(Token\s*:\s*([A-Z0-9_]+)\)/i,
    /\b(PAN_[A-Z0-9_]+)\b/i
  ]);

  const compact = compactText(text);
  record.deedAmount = labeledAmount(compact, ["लेनदेनराशि","विक्रयराशि","transactionamount","considerationamount"]);
  record.landValue = labeledAmount(compact, ["कलेक्टरदर","कलैक्टरदर","landvalue","collectorrate","collectorvalue"]);
  record.stampDuty = labeledAmount(compact, ["कुलस्टाम्पशुल्क","कुलस्टांपशुल्क","stampdutypaid","stampduty"]);
  record.registrationFees = labeledAmount(compact, ["पंजीकरणफीस","पंजीकरणशुल्क","registrationfees","registrationfee"]);

  return record;
}

function extractImageRecord(text) {
  const record = extractPdfRecord(text);
  const compact = compactText(text);

  if (!record.registryNumber) {
    record.registryNumber = digits(firstMatch(text, [
      /Registration\s*(?:No\.?|Number)\s*[:\-]?\s*(\d+)/i,
      /(\d{3,6})\s+(?:Date|दिनांक)/i
    ]));
  }

  if (!record.registrationDate) {
    record.registrationDate = dateValue(firstMatch(text, [
      /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/
    ]));
  }

  if (!record.tokenNumber) {
    record.tokenNumber = firstMatch(text, [/\b(PAN_[A-Z0-9_]+)\b/i]);
  }

  return record;
}

function mergeRecords(a, b) {
  const out = emptyRecord();
  out.deedType = a.deedType || b.deedType;
  out.registryNumber = a.registryNumber || b.registryNumber;
  out.registrationDate = a.registrationDate || b.registrationDate;
  out.tokenNumber = a.tokenNumber || b.tokenNumber;
  out.deedAmount = a.deedAmount !== "0.00" ? a.deedAmount : b.deedAmount;
  out.landValue = a.landValue !== "0.00" ? a.landValue : b.landValue;
  out.stampDuty = a.stampDuty !== "0.00" ? a.stampDuty : b.stampDuty;
  out.registrationFees = a.registrationFees !== "0.00" ? a.registrationFees : b.registrationFees;
  return out;
}

function extractDeedType(text) {
  const types = [
    [/TRANSFER\s+OF\s+IMMOVABLE\s+PROPERTY/i, "TRANSFER OF IMMOVABLE PROPERTY"],
    [/POWER\s+OF\s+ATTORNEY/i, "POWER OF ATTORNEY"],
    [/CONVEYANCE/i, "CONVEYANCE"],
    [/AGREEMENT/i, "AGREEMENT"],
    [/TARTIMA/i, "TARTIMA"],
    [/TRUST/i, "TRUST"],
    [/ADOPTION/i, "ADOPTION"],
    [/CANCELLATION/i, "CANCELLATION"],
    [/RECTIFICATION/i, "RECTIFICATION"],
    [/PARTITION/i, "PARTITION"],
    [/RELEASE/i, "RELEASE"],
    [/SURRENDER\s+OF\s+LEASE/i, "SURRENDER OF LEASE"],
    [/LEASE/i, "LEASE"],
    [/GIFT/i, "GIFT"],
    [/SALE/i, "SALE"],
    [/\bWILL\b/i, "WILL"],
    [/\bGPA\b/i, "GPA"],
    [/\bSPA\b/i, "SPA"]
  ];

  for (const [pattern, label] of types) {
    if (pattern.test(text)) return label;
  }
  return "";
}

function labeledAmount(compact, labels) {
  for (const label of labels) {
    const index = compact.indexOf(label);
    if (index === -1) continue;
    const after = compact.slice(index + label.length, index + label.length + 70);
    const match = after.match(/(\d[\d,]{0,14}(?:\.\d{1,2})?)/);
    if (match) return amount(match[1]);
  }
  return "0.00";
}

function compactText(value) {
  return normalize(value).toLowerCase()
    .replace(/[₹:;|()[\]{}–—\-_]/g, "")
    .replace(/\s+/g, "");
}

function normalize(value) {
  return String(value || "")
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

function amount(value) {
  const clean = String(value || "").replace(/,/g, "").replace(/[^\d.]/g, "");
  const number = Number(clean);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function digits(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function dateValue(value) {
  return value ? String(value).replace(/-/g, "/") : "";
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

function addRow(record, serial) {
  const cls = record.status === "Completed" ? "success" :
    record.status === "Check" ? "warning" : "error";

  resultBody.insertAdjacentHTML("beforeend", `
    <tr>
      <td>${serial}</td>
      <td class="file-name">${escapeHtml(record.fileName)}</td>
      <td>${escapeHtml(record.deedType || "Not Found")}</td>
      <td>${escapeHtml(record.registryNumber || "Not Found")}</td>
      <td>${escapeHtml(record.registrationDate || "Not Found")}</td>
      <td>${escapeHtml(record.tokenNumber || "Not Found")}</td>
      <td>${record.deedAmount}</td>
      <td>${record.landValue}</td>
      <td>${record.stampDuty}</td>
      <td>${record.registrationFees}</td>
      <td class="${cls}">${record.status}</td>
    </tr>
  `);
}

function setProgress(done, total, message) {
  progressBar.style.width = (total ? Math.round(done / total * 100) : 0) + "%";
  statusText.textContent = message;
}


csvButton.addEventListener("click", () => {
  if (!results.length) return;

  const rows = [[
    "Deed Type","Registry Number","Registration Date","Token Number",
    "Deed Amount","Land Value","Stamp Duty","Registration Fee"
  ], ...results.map(r => [
    r.deedType,r.registryNumber,r.registrationDate,r.tokenNumber,
    r.deedAmount,r.landValue,r.stampDuty,r.registrationFees
  ])];

  const csv = "\uFEFF" + rows.map(row =>
    row.map(value => `"${String(value || "").replace(/"/g, '""')}"`).join(",")
  ).join("\n");

  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "registry-data.csv";
  link.click();
  URL.revokeObjectURL(url);
});

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

