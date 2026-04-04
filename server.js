const http = require("node:http");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { ChromaClient } = require("chromadb");
const mammoth = require("mammoth");
const { PDFParse } = require("pdf-parse");
const { createWorker } = require("tesseract.js");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const PUBLIC_DIR = path.join(__dirname, "public");
const NODE_MODULES_DIR = path.join(__dirname, "node_modules");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "server.log");
const MAX_JSON_BYTES = 1_000_000;
const MAX_DOCUMENT_JSON_BYTES = 15_000_000;
const MAX_DOCUMENT_BYTES = 10_000_000;
const OLLAMA_EMBED_MODEL =
  process.env.OLLAMA_EMBEDDING_MODEL ||
  process.env.OLLAMA_EMBED_MODEL ||
  "nomic-embed-text";
const RAG_CHUNK_SIZE = readIntEnv("RAG_CHUNK_SIZE", 1200, 200);
const RAG_CHUNK_OVERLAP = readIntEnv("RAG_CHUNK_OVERLAP", 180, 0);
const RAG_RETRIEVAL_LIMIT = readIntEnv("RAG_RETRIEVAL_LIMIT", 4, 1);
const RAG_QUERY_CANDIDATE_LIMIT = readIntEnv("RAG_QUERY_CANDIDATE_LIMIT", Math.max(12, RAG_RETRIEVAL_LIMIT * 3), RAG_RETRIEVAL_LIMIT);
const RAG_MAX_CONTEXT_CHARS_PER_EXCERPT = readIntEnv("RAG_MAX_CONTEXT_CHARS_PER_EXCERPT", 1600, 200);
const RAG_BROAD_TOPIC_CANDIDATE_LIMIT = readIntEnv("RAG_BROAD_TOPIC_CANDIDATE_LIMIT", 40, RAG_QUERY_CANDIDATE_LIMIT);
const RAG_BROAD_TOPIC_TICKET_LIMIT = readIntEnv("RAG_BROAD_TOPIC_TICKET_LIMIT", 10, RAG_RETRIEVAL_LIMIT);
const RAG_BROAD_TOPIC_EXCERPT_CHARS = readIntEnv("RAG_BROAD_TOPIC_EXCERPT_CHARS", 550, 200);
const RAG_RECENT_SUMMARY_TICKET_LIMIT = readIntEnv("RAG_RECENT_SUMMARY_TICKET_LIMIT", 6, 2);
const EMBED_BATCH_SIZE = readIntEnv("EMBED_BATCH_SIZE", 16, 1);
const RAG_UPSERT_BATCH_SIZE = readIntEnv("RAG_UPSERT_BATCH_SIZE", 5000, 1);
const DEVOPS_TICKET_MAX_RECORD_CHARS = readIntEnv("DEVOPS_TICKET_MAX_RECORD_CHARS", 5000, 500);
const DEFAULT_VECTOR_INSTANCE_ID = process.env.DEFAULT_VECTOR_INSTANCE_ID || "default";
const vectorClients = new Map();
const vectorCollectionPromises = new Map();

function readBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function readIntEnv(name, defaultValue, minValue = 1) {
  const raw = Number.parseInt(process.env[name] || "", 10);
  if (Number.isNaN(raw)) return defaultValue;
  return Math.max(minValue, raw);
}

const OCR_ENABLED = readBoolEnv("OCR_ENABLED", true);
const OCR_LANG = process.env.OCR_LANG || "eng";
const OCR_MAX_PAGES = readIntEnv("OCR_MAX_PAGES", 3, 1);
const OCR_MIN_TEXT_CHARS = readIntEnv("OCR_MIN_TEXT_CHARS", 80, 0);
const OCR_IMAGE_SCALE = Number.parseFloat(process.env.OCR_IMAGE_SCALE || "2");
const SAFE_OCR_IMAGE_SCALE = Number.isFinite(OCR_IMAGE_SCALE) && OCR_IMAGE_SCALE > 0 ? OCR_IMAGE_SCALE : 2;
const BRAVE_SEARCH_ENABLED = readBoolEnv("BRAVE_SEARCH_ENABLED", false);
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY || "";
const BRAVE_SEARCH_MAX_RESULTS = readIntEnv("BRAVE_SEARCH_MAX_RESULTS", 5, 1);
const BRAVE_SEARCH_COUNTRY = (process.env.BRAVE_SEARCH_COUNTRY || "US").toUpperCase();
let ocrWorkerPromise = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const SUPPORTED_DOCUMENT_TYPES = {
  pdf: {
    extensions: [".pdf"],
    mimeTypes: ["application/pdf"],
    fallbackMimeType: "application/pdf",
    defaultFilename: "document.pdf"
  },
  docx: {
    extensions: [".docx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ],
    fallbackMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    defaultFilename: "document.docx"
  },
  json: {
    extensions: [".json"],
    mimeTypes: ["application/json", "text/json"],
    fallbackMimeType: "application/json",
    defaultFilename: "document.json"
  }
};

const SOURCE_FILTERS = new Set(["all", "reference_doc", "ticket_json"]);

function setupFileLogging() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const appendLogLine = (level, values) => {
    const rendered = values
      .map((value) => {
        if (value instanceof Error) {
          return value.stack || value.message;
        }
        if (typeof value === "string") {
          return value;
        }
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" ");

    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${level}] ${rendered}\n`);
  };

  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      appendLogLine(level.toUpperCase(), values);
      original(...values);
    };
  }

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function describeUpstreamFetchError(error, serviceName) {
  const rawMessage = String(error?.message || "").trim();
  const normalized = rawMessage.toLowerCase();

  if (normalized === "terminated") {
    return `${serviceName} closed the streaming connection unexpectedly.`;
  }
  if (normalized === "fetch failed") {
    return `Could not reach ${serviceName}. Check that it is running and reachable.`;
  }
  if (normalized.includes("abort")) {
    return `${serviceName} request was aborted before completion.`;
  }
  return rawMessage || `${serviceName} request failed.`;
}

function describeOllamaModelError(errorLike) {
  const rawMessage = String(
    typeof errorLike === "string"
      ? errorLike
      : errorLike?.error || errorLike?.message || errorLike?.raw || ""
  ).trim();
  const normalized = rawMessage.toLowerCase();

  if (!rawMessage) {
    return {
      userMessage: "Ollama failed while generating the response.",
      rawMessage: ""
    };
  }

  if (normalized.includes("cuda error") || normalized.includes("0xc0000005")) {
    return {
      userMessage:
        "Ollama failed while running the model on the GPU. This usually means the model process crashed or hit GPU memory or context pressure. Try retrying, reducing retrieved context, or restarting Ollama.",
      rawMessage
    };
  }

  if (normalized.includes("out of memory") || normalized.includes("cuda out of memory")) {
    return {
      userMessage:
        "Ollama ran out of GPU memory while generating the response. Reduce the prompt load or restart Ollama before retrying.",
      rawMessage
    };
  }

  return {
    userMessage: rawMessage,
    rawMessage
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(new Error("timeout")), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: abortController.signal
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker(OCR_LANG);
  }
  return ocrWorkerPromise;
}

async function runPdfOcr(parser, totalPages) {
  const screenshot = await parser.getScreenshot({
    first: Math.min(OCR_MAX_PAGES, totalPages || OCR_MAX_PAGES),
    scale: SAFE_OCR_IMAGE_SCALE,
    imageDataUrl: false,
    imageBuffer: true
  });

  const worker = await getOcrWorker();
  const parts = [];
  for (const page of screenshot.pages || []) {
    const imageBuffer = Buffer.from(page.data || []);
    if (imageBuffer.length === 0) continue;
    const result = await worker.recognize(imageBuffer);
    const pageText = (result.data?.text || "").trim();
    if (pageText) {
      parts.push(pageText);
    }
  }
  return parts.join("\n\n").trim();
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeSourceFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SOURCE_FILTERS.has(normalized) ? normalized : "all";
}

function inferSourceKindFromFilename(filename) {
  const name = String(filename || "").trim().toLowerCase();
  if (name.endsWith(".pdf") || name.endsWith(".docx")) return "reference_doc";
  if (/^tickets-\d+-\d+\.json$/.test(name)) return "ticket_json";
  return "reference_doc";
}

function getRowSourceKind(row) {
  const metadataKind = String(row?.metadata?.sourceKind || "").trim();
  if (metadataKind === "reference_doc" || metadataKind === "ticket_json") {
    return metadataKind;
  }
  if (row?.metadata?.documentKind === "devops-ticket") {
    return "ticket_json";
  }
  return inferSourceKindFromFilename(row?.metadata?.filename);
}

function filterRowsBySource(rows, sourceFilter) {
  const normalizedFilter = normalizeSourceFilter(sourceFilter);
  if (normalizedFilter === "all") return rows;
  return rows.filter((row) => getRowSourceKind(row) === normalizedFilter);
}

function isDocLogicQuery(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    /\blogic\b|\bcalculation\b|\bcalculate\b|\bmethodology\b|\bformula\b|\bdeal formulas?\b|\bcustom pricing formula\b|\bcustom deal formula\b|\blinked components?\b|\bhow does\b|\bhow is\b/.test(normalized) ||
    /\bgreek\b|\bpnl\b/.test(normalized)
  );
}

function isDocReferenceQuery(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return false;
  return /\binstall\b|\binstallation\b|\bsetup\b|\bset up\b|\benvironment\b|\bconfigure\b|\bconfiguration\b|\biis\b|\bupgrade\b|\brollback\b|\brefresh\b|\bpre prod\b|\bpre-prod\b|\badmin manual\b|\bweb services?\b/.test(normalized);
}

function isTicketAnalysisQuery(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return false;
  if (extractExplicitTicketNumber(normalized)) return true;
  if (/\broot cause\b|\broot causes\b|\bcommon issues\b|\bmost common issues\b/.test(normalized)) return true;
  if (/\blatest\b|\bmost recent\b|\bnewest\b|\bsummar(?:y|ize|ise)\b/.test(normalized)) return true;
  if (/\bwhat tickets?\b|\bwhich tickets?\b|\btickets? say about\b/.test(normalized)) return true;
  if (/\bbilling statement\b|\bdeal corruption\b|\bctp\b|\bctpr\b|\bdsr\b|\bmonthend\b|\bmonth end\b/.test(normalized)) return true;
  if (/\bwhat do you know about\b/.test(normalized) && /\breport\b|\bbilling statement\b|\bdeal corruption\b|\bctp\b|\bdsr\b/.test(normalized)) {
    return true;
  }
  return false;
}

function resolveEffectiveSourceFilter(query, sourceFilter) {
  const normalizedFilter = normalizeSourceFilter(sourceFilter);
  if (normalizedFilter !== "all") {
    return normalizedFilter;
  }
  if ((isDocLogicQuery(query) || isDocReferenceQuery(query)) && !isTicketAnalysisQuery(query)) {
    return "reference_doc";
  }
  if (isTicketAnalysisQuery(query)) {
    return "ticket_json";
  }
  return "all";
}

function getDocumentType({ filename, mimeType }) {
  const normalizedFilename = String(filename || "").trim().toLowerCase();
  const extension = path.extname(normalizedFilename);
  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();

  for (const [documentType, config] of Object.entries(SUPPORTED_DOCUMENT_TYPES)) {
    if (config.extensions.includes(extension) || (normalizedMimeType && config.mimeTypes.includes(normalizedMimeType))) {
      return documentType;
    }
  }

  return null;
}

function parseVectorInstancesFromEnv() {
  const raw = process.env.VECTOR_DB_INSTANCES;
  if (!raw || !raw.trim()) {
    return [{
      id: DEFAULT_VECTOR_INSTANCE_ID,
      name: "Vector:Chroma:1",
      host: process.env.CHROMA_HOST || "127.0.0.1",
      port: readIntEnv("CHROMA_PORT", 8000, 1),
      ssl: readBoolEnv("CHROMA_SSL", false),
      tenant: process.env.CHROMA_TENANT || undefined,
      database: process.env.CHROMA_DATABASE || undefined,
      collection: process.env.CHROMA_COLLECTION || "bonsai_documents"
    }];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid VECTOR_DB_INSTANCES JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("VECTOR_DB_INSTANCES must be a non-empty JSON array.");
  }

  return parsed.map((item, index) => {
    const id = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `vector-${index + 1}`;
    const host = typeof item?.host === "string" && item.host.trim() ? item.host.trim() : "127.0.0.1";
    const collection = typeof item?.collection === "string" && item.collection.trim()
      ? item.collection.trim()
      : "bonsai_documents";
    const defaultName = `Vector:Chroma:${index + 1}`;
    return {
      id,
      name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : defaultName,
      host,
      port: Number.isFinite(Number(item?.port)) ? Math.max(1, Number(item.port)) : 8000,
      ssl: typeof item?.ssl === "boolean" ? item.ssl : false,
      tenant: typeof item?.tenant === "string" && item.tenant.trim() ? item.tenant.trim() : undefined,
      database: typeof item?.database === "string" && item.database.trim() ? item.database.trim() : undefined,
      collection
    };
  });
}

const VECTOR_INSTANCES = parseVectorInstancesFromEnv();
const VECTOR_INSTANCES_BY_ID = new Map(VECTOR_INSTANCES.map((item) => [item.id, item]));
const DEFAULT_VECTOR_INSTANCE = VECTOR_INSTANCES_BY_ID.get(DEFAULT_VECTOR_INSTANCE_ID) || VECTOR_INSTANCES[0];

function listVectorInstances() {
  return VECTOR_INSTANCES.map((item) => ({
    id: item.id,
    name: item.name,
    host: item.host,
    port: item.port,
    ssl: item.ssl,
    collection: item.collection,
    isDefault: item.id === DEFAULT_VECTOR_INSTANCE.id
  }));
}

function getVectorInstanceConfig(instanceId) {
  if (typeof instanceId === "string" && VECTOR_INSTANCES_BY_ID.has(instanceId)) {
    return VECTOR_INSTANCES_BY_ID.get(instanceId);
  }
  return DEFAULT_VECTOR_INSTANCE;
}

function getChromaClient(instanceId) {
  const config = getVectorInstanceConfig(instanceId);
  if (!vectorClients.has(config.id)) {
    vectorClients.set(config.id, new ChromaClient({
      host: config.host,
      port: config.port,
      ssl: config.ssl,
      tenant: config.tenant,
      database: config.database
    }));
  }
  return vectorClients.get(config.id);
}

async function getOrCreateRagCollection(instanceId) {
  const config = getVectorInstanceConfig(instanceId);
  if (!vectorCollectionPromises.has(config.id)) {
    const promise = getChromaClient(config.id).getOrCreateCollection({
      name: config.collection,
      embeddingFunction: null
    }).catch((error) => {
      vectorCollectionPromises.delete(config.id);
      throw error;
    });
    vectorCollectionPromises.set(config.id, promise);
  }
  return vectorCollectionPromises.get(config.id);
}

async function getExistingRagCollection(instanceId) {
  const config = getVectorInstanceConfig(instanceId);
  try {
    return await getChromaClient(config.id).getCollection({
      name: config.collection,
      embeddingFunction: null
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (/not found|does not exist|404/i.test(message)) {
      return null;
    }
    throw error;
  }
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function splitTextIntoChunks(text, chunkSize = RAG_CHUNK_SIZE, overlap = RAG_CHUNK_OVERLAP) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const safeOverlap = Math.max(0, Math.min(overlap, chunkSize - 1));
  const step = Math.max(1, chunkSize - safeOverlap);
  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + chunkSize);
    if (end < normalized.length) {
      const lastParagraphBreak = normalized.lastIndexOf("\n\n", end);
      const lastSentenceBreak = Math.max(
        normalized.lastIndexOf(". ", end),
        normalized.lastIndexOf("? ", end),
        normalized.lastIndexOf("! ", end)
      );
      const lastSpace = normalized.lastIndexOf(" ", end);
      const candidateBreak = Math.max(lastParagraphBreak, lastSentenceBreak, lastSpace);
      if (candidateBreak > start + Math.floor(chunkSize * 0.6)) {
        end = candidateBreak;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }
    start = Math.max(start + 1, end - safeOverlap);
  }

  return chunks;
}

function slugifyIdentifierPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function normalizeTicketNumber(value, fallbackIndex) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return `record-${fallbackIndex + 1}`;
}

function buildDevOpsCommentText(comment) {
  if (!comment || typeof comment !== "object") return "";
  const author = normalizeWhitespace(comment.createdBy || comment.author || "");
  const createdDate = formatDisplayDate(normalizeWhitespace(comment.createdDate || comment.date || ""));
  const body = normalizeWhitespace(comment.text || comment.comment || comment.body || "");
  if (!body) return "";

  const headerParts = [];
  if (author) headerParts.push(author);
  if (createdDate) headerParts.push(createdDate);
  const header = headerParts.length ? `Comment (${headerParts.join(" | ")}):` : "Comment:";
  return `${header}\n${body}`;
}

function buildDevOpsTicketText(ticket) {
  const searchText = normalizeWhitespace(ticket?.searchText || "");
  if (searchText) return searchText;

  const parts = [];
  const title = normalizeWhitespace(ticket?.title || "");
  const description = normalizeWhitespace(ticket?.description || "");
  const createdDate = normalizeWhitespace(ticket?.createdDate || "");

  if (title) parts.push(`Title: ${title}`);
  if (createdDate) parts.push(`Created: ${createdDate}`);
  if (description) parts.push(`Description:\n${description}`);

  const comments = Array.isArray(ticket?.relatedComments)
    ? ticket.relatedComments.map(buildDevOpsCommentText).filter(Boolean)
    : [];
  if (comments.length) {
    parts.push(comments.join("\n\n"));
  }

  return normalizeWhitespace(parts.join("\n\n"));
}

function buildDevOpsTicketChunks(ticket, ticketText) {
  const searchChunkTexts = Array.isArray(ticket?.searchChunks)
    ? ticket.searchChunks
        .map((chunk) => normalizeWhitespace(chunk?.text || ""))
        .filter(Boolean)
    : [];

  if (ticketText.length <= DEVOPS_TICKET_MAX_RECORD_CHARS) {
    return ticketText ? [ticketText] : [];
  }
  if (searchChunkTexts.length > 0) {
    return searchChunkTexts;
  }
  return splitTextIntoChunks(ticketText, DEVOPS_TICKET_MAX_RECORD_CHARS, Math.min(400, Math.floor(DEVOPS_TICKET_MAX_RECORD_CHARS / 5)));
}

function isDevOpsTicketJson(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  const sample = parsed.find((item) => item && typeof item === "object");
  if (!sample) return false;
  return (
    Object.prototype.hasOwnProperty.call(sample, "ticketNumber") &&
    Object.prototype.hasOwnProperty.call(sample, "searchText") &&
    Object.prototype.hasOwnProperty.call(sample, "searchChunks")
  );
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { response, payload };
}

async function embedTextsWithOllama(texts) {
  const cleanTexts = texts.map((value) => normalizeWhitespace(value)).filter(Boolean);
  if (cleanTexts.length === 0) return [];

  const { response, payload } = await fetchJson(`${OLLAMA_BASE_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_EMBED_MODEL,
      input: cleanTexts
    })
  });

  if (response.ok && Array.isArray(payload.embeddings)) {
    return payload.embeddings;
  }

  const fallbackEmbeddings = [];
  for (const input of cleanTexts) {
    const fallback = await fetchJson(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_EMBED_MODEL,
        prompt: input
      })
    });

    if (!fallback.response.ok || !Array.isArray(fallback.payload.embedding)) {
      const details =
        fallback.payload?.error ||
        payload?.error ||
        payload?.raw ||
        "Failed to generate embeddings with Ollama.";
      throw createHttpError(502, String(details));
    }

    fallbackEmbeddings.push(fallback.payload.embedding);
  }

  return fallbackEmbeddings;
}

async function embedTexts(texts) {
  const vectors = [];
  for (let index = 0; index < texts.length; index += EMBED_BATCH_SIZE) {
    const batch = texts.slice(index, index + EMBED_BATCH_SIZE);
    const batchVectors = await embedTextsWithOllama(batch);
    vectors.push(...batchVectors);
  }
  return vectors;
}

async function upsertRagBatches(collection, { ids, documents, embeddings, metadatas }) {
  for (let index = 0; index < ids.length; index += RAG_UPSERT_BATCH_SIZE) {
    await collection.upsert({
      ids: ids.slice(index, index + RAG_UPSERT_BATCH_SIZE),
      documents: documents.slice(index, index + RAG_UPSERT_BATCH_SIZE),
      embeddings: embeddings.slice(index, index + RAG_UPSERT_BATCH_SIZE),
      metadatas: metadatas.slice(index, index + RAG_UPSERT_BATCH_SIZE)
    });
  }
}

async function upsertRagRecords(collection, records) {
  if (!Array.isArray(records) || records.length === 0) {
    return 0;
  }

  const ids = records.map((record) => record.id);
  const documents = records.map((record) => record.document);
  const metadatas = records.map((record) => record.metadata);
  const embeddings = await embedTexts(documents);

  await upsertRagBatches(collection, {
    ids,
    documents,
    embeddings,
    metadatas
  });

  return records.length;
}

async function ingestDocumentIntoRag({ instanceId, documentId, filename, pages, text, sourceKind = "reference_doc", sourceType = "" }) {
  const cleanText = normalizeWhitespace(text);
  const finalDocumentId = typeof documentId === "string" && documentId.trim() ? documentId.trim() : randomUUID();
  if (!filename || !cleanText) {
    throw createHttpError(400, "filename and text are required.");
  }

  const chunks = splitTextIntoChunks(cleanText);
  if (chunks.length === 0) {
    throw createHttpError(422, "No usable text chunks were produced for ingestion.");
  }

  const collection = await getOrCreateRagCollection(instanceId);
  const embeddings = await embedTexts(chunks);
  const chunkCount = chunks.length;
  const ids = chunks.map((_, index) => `${finalDocumentId}:${index + 1}`);
  const metadatas = chunks.map((chunk, index) => ({
    libraryDocumentId: finalDocumentId,
    filename,
    sourceKind,
    sourceType,
    pages: typeof pages === "number" ? pages : -1,
    chunkIndex: index + 1,
    chunkCount,
    charCount: chunk.length
  }));

  try {
    await collection.delete({
      where: { libraryDocumentId: finalDocumentId }
    });
  } catch {
    // Ignore delete misses on first ingest.
  }

  await upsertRagBatches(collection, {
    ids,
    documents: chunks,
    embeddings,
    metadatas
  });

  return { chunkCount, documentId: finalDocumentId };
}

async function ingestDevOpsTicketsIntoRag({ instanceId, documentId, filename, tickets }) {
  const finalDocumentId = typeof documentId === "string" && documentId.trim() ? documentId.trim() : randomUUID();
  if (!filename || !Array.isArray(tickets) || tickets.length === 0) {
    throw createHttpError(400, "filename and tickets[] are required.");
  }

  const collection = await getOrCreateRagCollection(instanceId);
  const records = [];

  tickets.forEach((ticket, ticketIndex) => {
    const ticketNumber = normalizeTicketNumber(ticket?.ticketNumber, ticketIndex);
    const ticketText = buildDevOpsTicketText(ticket);
    const ticketChunks = buildDevOpsTicketChunks(ticket, ticketText);
    if (ticketChunks.length === 0) {
      return;
    }

    const title = normalizeWhitespace(ticket?.title || "");
    const createdDate = normalizeWhitespace(ticket?.createdDate || "");
    const baseRecordId = `${finalDocumentId}:ticket:${slugifyIdentifierPart(ticketNumber)}`;
    const commentCount = Array.isArray(ticket?.relatedComments) ? ticket.relatedComments.length : 0;
    const totalChunks = ticketChunks.length;

    ticketChunks.forEach((chunkText, chunkIndex) => {
      records.push({
        id: totalChunks === 1 ? baseRecordId : `${baseRecordId}:chunk-${chunkIndex + 1}`,
        document: chunkText,
        metadata: {
          libraryDocumentId: finalDocumentId,
          filename,
          sourceKind: "ticket_json",
          sourceType: "json",
          documentKind: "devops-ticket",
          ticketNumber,
          title,
          createdDate,
          commentCount,
          chunkIndex: chunkIndex + 1,
          chunkCount: totalChunks,
          charCount: chunkText.length
        }
      });
    });
  });

  if (records.length === 0) {
    throw createHttpError(422, "No usable DevOps ticket records were produced for ingestion.");
  }

  try {
    await collection.delete({
      where: { libraryDocumentId: finalDocumentId }
    });
  } catch {
    // Ignore delete misses on first ingest.
  }

  const chunkCount = await upsertRagRecords(collection, records);
  return { chunkCount, documentId: finalDocumentId, ticketCount: tickets.length };
}

async function deleteDocumentFromRag(instanceId, documentId) {
  if (!documentId || typeof documentId !== "string") {
    throw createHttpError(400, "documentId is required.");
  }

  const collection = await getExistingRagCollection(instanceId);
  if (!collection) {
    return { deleted: 0 };
  }

  const result = await collection.delete({
    where: { libraryDocumentId: documentId }
  });
  return { deleted: Number(result?.deleted || 0) };
}

function buildRagContextMessage(query, rows, instanceName) {
  const resolvedTicketSummary = buildResolvedTicketSummary(query, rows);
  const lines = [
    `Knowledge base: ${instanceName}`,
    "Answer using the retrieved knowledge-base excerpts below when they are relevant.",
    "If the excerpts do not support the answer, say that the indexed knowledge base does not contain it.",
    "When you use an excerpt, cite it inline using the source label exactly as provided, including any ticket number inside the label.",
    "Do not mention any ticket number, filename, source, issue, root cause, date, or conclusion unless it appears in the retrieved excerpts below.",
    "Do not generalize from one ticket into a broader pattern unless multiple retrieved excerpts support that pattern.",
    "If only one relevant excerpt is retrieved, say that the knowledge base evidence is limited to that excerpt.",
    "Do not speculate or infer business meaning, report purpose, or system behavior beyond the retrieved excerpts.",
    "For DevOps ticket JSON records: ticket createdDate is the ticket creation timestamp. Comment createdBy values identify commenters only, not the ticket creator.",
    "Do not infer that a person created a ticket just because they commented on it. If the ticket creator is not explicitly present in the excerpt or metadata, say that the indexed data does not provide the ticket creator.",
    "For DevOps ticket JSON records: the ticket ID is metadata.ticketNumber only. Do not use comment IDs, statement IDs, deal IDs, batch IDs, or other numbers inside the excerpt as the ticket ID.",
    "When the user asks for the latest or most recent ticket, compare DevOps tickets by metadata.createdDate only. Do not use comment dates as the ticket creation date.",
    `User query: ${query}`,
    "",
    ...(resolvedTicketSummary ? [resolvedTicketSummary, ""] : []),
    "Retrieved excerpts:"
  ];

  rows.forEach((row, index) => {
    const filename = row.metadata?.filename || "document";
    const chunkIndex = row.metadata?.chunkIndex || index + 1;
    const distance = typeof row.distance === "number" ? row.distance.toFixed(4) : "n/a";
    const ticketNumber = row.metadata?.ticketNumber ? ` ticket ${row.metadata.ticketNumber}` : "";
    const sourceLabel = `[source: ${filename}${ticketNumber} chunk ${chunkIndex}]`;
    const excerpt = buildRagPromptExcerpt(row.document || "");
    lines.push(`${index + 1}. ${sourceLabel} similarity=${distance}`);
    if (row.metadata?.ticketNumber) {
      lines.push(`Ticket ID: ${row.metadata.ticketNumber}`);
    }
    if (row.metadata?.title) {
      lines.push(`Ticket Title: ${row.metadata.title}`);
    }
    if (row.metadata?.createdDate) {
      lines.push(`Ticket Created: ${formatDisplayDate(row.metadata.createdDate)}`);
    }
    lines.push(excerpt);
    lines.push("");
  });

  return lines.join("\n").trim();
}

function buildBroadTopicExcerpt(text) {
  const documentText = normalizeWhitespace(text);
  if (documentText.length <= RAG_BROAD_TOPIC_EXCERPT_CHARS) {
    return documentText;
  }

  return `${documentText.slice(0, RAG_BROAD_TOPIC_EXCERPT_CHARS).trim()}\n[excerpt truncated]`;
}

function buildBroadTopicContextMessage(query, rows, instanceName) {
  const lines = [
    `Knowledge base: ${instanceName}`,
    "The user is asking for a broad topic summary.",
    "Synthesize across the ticket evidence below.",
    "Prefer patterns that are supported by multiple tickets.",
    "If the evidence is mixed or partial, say so clearly.",
    "Do not claim completeness.",
    `User query: ${query}`,
    "",
    "Relevant ticket evidence:"
  ];

  rows.forEach((row, index) => {
    const filename = row.metadata?.filename || "document";
    const ticketNumber = row.metadata?.ticketNumber || "n/a";
    const title = row.metadata?.title || "";
    const createdDate = formatDisplayDate(row.metadata?.createdDate) || "unknown";
    const chunkIndex = row.metadata?.chunkIndex || index + 1;
    const excerpt = buildBroadTopicExcerpt(row.document || "");
    lines.push(`${index + 1}. Ticket ${ticketNumber} | ${title} | Created: ${createdDate}`);
    lines.push(`Source: [source: ${filename} ticket ${ticketNumber} chunk ${chunkIndex}]`);
    lines.push(excerpt);
    lines.push("");
  });

  return lines.join("\n").trim();
}

function buildRecentSummaryContextMessage(query, rows, instanceName) {
  const lines = [
    `Knowledge base: ${instanceName}`,
    "The user is asking for a summary of the latest relevant tickets.",
    "Focus on recent relevant tickets first and synthesize the evidence across them.",
    "Do not answer with only one ticket if multiple relevant tickets are provided below.",
    "Do not say 'the latest ticket is ...' unless the user explicitly asked for a single latest ticket.",
    "Prefer concrete changes, fixes, issues, and trends supported by the recent tickets below.",
    "If the recent evidence is partial or mixed, say so clearly.",
    `User query: ${query}`,
    "",
    "Recent relevant ticket evidence:"
  ];

  rows.forEach((row, index) => {
    const filename = row.metadata?.filename || "document";
    const ticketNumber = row.metadata?.ticketNumber || "n/a";
    const title = row.metadata?.title || "";
    const createdDate = formatDisplayDate(row.metadata?.createdDate) || "unknown";
    const chunkIndex = row.metadata?.chunkIndex || index + 1;
    const excerpt = buildBroadTopicExcerpt(row.document || "");
    lines.push(`${index + 1}. Ticket ${ticketNumber} | ${title} | Created: ${createdDate}`);
    lines.push(`Source: [source: ${filename} ticket ${ticketNumber} chunk ${chunkIndex}]`);
    lines.push(excerpt);
    lines.push("");
  });

  return lines.join("\n").trim();
}

function logRetrievedRagRows(query, instanceName, mode, rows) {
  const summary = rows.map((row, index) => ({
    rank: index + 1,
    ticketNumber: row.metadata?.ticketNumber || null,
    filename: row.metadata?.filename || null,
    title: row.metadata?.title || null,
    chunkIndex: row.metadata?.chunkIndex || null,
    distance: typeof row.distance === "number" ? Number(row.distance.toFixed(4)) : null,
    excerpt: String(row.document || "").replace(/\s+/g, " ").slice(0, 180)
  }));
  console.log("RAG retrieval", { query, instanceName, mode, rows: summary });
}

function buildRagPromptExcerpt(text) {
  const documentText = normalizeWhitespace(text);
  if (documentText.length <= RAG_MAX_CONTEXT_CHARS_PER_EXCERPT) {
    return documentText;
  }

  const omissionMarker = "\n[excerpt middle omitted]\n";
  const availableChars = Math.max(0, RAG_MAX_CONTEXT_CHARS_PER_EXCERPT - omissionMarker.length);
  const headChars = Math.ceil(availableChars * 0.58);
  const tailChars = Math.max(0, availableChars - headChars);
  const head = documentText.slice(0, headChars).trim();
  const tail = documentText.slice(Math.max(headChars, documentText.length - tailChars)).trim();

  if (!head || !tail || head === tail) {
    return `${documentText.slice(0, RAG_MAX_CONTEXT_CHARS_PER_EXCERPT).trim()}\n[excerpt truncated]`;
  }

  return `${head}${omissionMarker}${tail}`;
}

function formatDisplayDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }

  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const year = String(parsed.getUTCFullYear());
  return `${day}/${month}/${year}`;
}

const RAG_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "know",
  "me",
  "of",
  "on",
  "please",
  "tell",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "you"
]);

function tokenizeForRagSearch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !RAG_STOPWORDS.has(token));
}

function extractQueryPhrases(value) {
  const tokens = tokenizeForRagSearch(value);
  const phrases = [];

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (!left || !right) continue;
    phrases.push(`${left} ${right}`);
  }

  return [...new Set(phrases)];
}

const LATEST_TICKET_QUERY_NOISE_TERMS = new Set([
  "all",
  "any",
  "around",
  "common",
  "concerning",
  "could",
  "created",
  "creator",
  "describe",
  "details",
  "explain",
  "give",
  "history",
  "last",
  "latest",
  "main",
  "most",
  "newest",
  "person",
  "problem",
  "problems",
  "recent",
  "regarding",
  "show",
  "summaries",
  "summarize",
  "summary",
  "tell",
  "ticket",
  "tickets",
  "issue",
  "issues",
  "related",
  "relation",
  "with",
  "reporting",
  "report",
  "reports"
]);

function normalizeTopicSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\bmonth\s+end\b/g, "monthend")
    .replace(/\bcommodity\s+trading\s+position\b/g, "ctp")
    .replace(/\bcredit\s+trading\s+position\b/g, "ctp")
    .replace(/\bday\s+sales\s+report\b/g, "dsr");
}

function extractLatestTicketTopicQuery(query) {
  const tokens = tokenizeForRagSearch(normalizeTopicSearchText(query))
    .filter((token) => !LATEST_TICKET_QUERY_NOISE_TERMS.has(token));
  return tokens.join(" ").trim();
}

function detectReportFamilies(text) {
  const normalized = normalizeTopicSearchText(text);
  const families = new Set();

  if (/\bmonthend\b/.test(normalized)) families.add("monthend");
  if (/\bctp\b/.test(normalized)) families.add("ctp");
  if (/\bdsr\b/.test(normalized)) families.add("dsr");
  if (/\bbilling\b|\bstatement\b/.test(normalized)) families.add("billing_statement");
  if (/\bcredit\b/.test(normalized)) families.add("credit");
  if ((/\bfx\b/.test(normalized) && /\brisk\b/.test(normalized)) || /\bfx\s*risk\b/.test(normalized)) families.add("fx_risk");

  return families;
}

const PRIMARY_REPORT_FAMILIES = new Set(["monthend", "ctp", "dsr", "billing_statement", "fx_risk"]);

function extractTicketDescriptionText(document) {
  const text = normalizeWhitespace(document);
  if (!text) return "";
  const descriptionMatch = text.match(/Description:\s*([\s\S]*?)(?:\bComment\s*\(|$)/i);
  if (descriptionMatch?.[1]) {
    return normalizeWhitespace(descriptionMatch[1]);
  }
  return text;
}

function splitTicketDescriptionSections(document) {
  const description = extractTicketDescriptionText(document);
  if (!description) {
    return {
      mainDescription: "",
      referencedTicketList: ""
    };
  }

  const listMarkerMatch = description.match(/\bTicket\s+Priority\s+Title\b/i);
  if (!listMarkerMatch || listMarkerMatch.index === undefined) {
    return {
      mainDescription: description,
      referencedTicketList: ""
    };
  }

  const markerIndex = listMarkerMatch.index;
  return {
    mainDescription: normalizeWhitespace(description.slice(0, markerIndex)),
    referencedTicketList: normalizeWhitespace(description.slice(markerIndex))
  };
}

function scoreLatestTicketTopicMatch(query, row) {
  const topicQuery = extractLatestTicketTopicQuery(query);
  if (!topicQuery) {
    return {
      score: 0,
      directScore: 0,
      mixedFamilyPenalty: 0,
      titleMatches: 0,
      descriptionMatches: 0,
      phraseMatches: 0,
      referenceListMatches: 0,
      exactTitleMatch: false,
      exactDescriptionMatch: false
    };
  }

  const topicTerms = [...new Set(tokenizeForRagSearch(topicQuery))];
  const topicPhrases = extractQueryPhrases(topicQuery);
  const queryFamilies = detectReportFamilies(topicQuery);
  const title = normalizeTopicSearchText(row.metadata?.title || "");
  const descriptionSections = splitTicketDescriptionSections(row.document || "");
  const mainDescription = normalizeTopicSearchText(descriptionSections.mainDescription);
  const referencedTicketList = normalizeTopicSearchText(descriptionSections.referencedTicketList);
  const exactTitleMatch = topicQuery.length >= 4 && title.includes(topicQuery);
  const exactDescriptionMatch = topicQuery.length >= 4 && mainDescription.includes(topicQuery);
  const exactReferenceListMatch = topicQuery.length >= 4 && referencedTicketList.includes(topicQuery);
  const titleMatches = topicTerms.filter((term) => title.includes(term)).length;
  const descriptionMatches = topicTerms.filter((term) => mainDescription.includes(term)).length;
  const referenceListMatches = topicTerms.filter((term) => referencedTicketList.includes(term)).length;
  const phraseMatches = topicPhrases.filter((phrase) => title.includes(phrase) || mainDescription.includes(phrase)).length;
  const referenceListPhraseMatches = topicPhrases.filter((phrase) => referencedTicketList.includes(phrase)).length;
  const rowFamilies = detectReportFamilies(`${title}\n${mainDescription}`);
  const primaryQueryFamilies = new Set([...queryFamilies].filter((family) => PRIMARY_REPORT_FAMILIES.has(family)));
  const primaryRowFamilies = new Set([...rowFamilies].filter((family) => PRIMARY_REPORT_FAMILIES.has(family)));
  const mixedFamilyPenalty =
    primaryQueryFamilies.size === 1 &&
    [...primaryQueryFamilies].every((family) => primaryRowFamilies.has(family)) &&
    primaryRowFamilies.size > 1
      ? Math.min(4, (primaryRowFamilies.size - primaryQueryFamilies.size) * 2)
      : 0;
  const directScore =
    (exactTitleMatch ? 10 : 0) +
    (exactDescriptionMatch ? 6 : 0) +
    (titleMatches * 5) +
    (descriptionMatches * 3) +
    (phraseMatches * 6) -
    mixedFamilyPenalty;

  return {
    score:
      directScore +
      (exactReferenceListMatch ? 1 : 0) +
      referenceListMatches +
      referenceListPhraseMatches,
    directScore,
    mixedFamilyPenalty,
    titleMatches,
    descriptionMatches,
    phraseMatches,
    referenceListMatches,
    exactTitleMatch,
    exactDescriptionMatch
  };
}

function hasSummaryLanguage(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return false;

  const summaryPatterns = [
    /^what do you know about\b/,
    /^what do tickets say about\b/,
    /^what tickets are about\b/,
    /^which tickets are about\b/,
    /^tell me about\b/,
    /^summari[sz]e\b/,
    /\boverview\b/,
    /\bcommon issues\b/,
    /\broot causes\b/,
    /\bmain issues\b/,
    /\bknown issues\b/,
    /\bwhat are the issues\b/,
    /\bwhat are the common issues\b/,
    /\bhistory of\b/
  ];

  return summaryPatterns.some((pattern) => pattern.test(normalized));
}

function hasRecentPluralLanguage(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return false;

  const pluralPatterns = [
    /\blatest tickets\b/,
    /\brecent tickets\b/,
    /\blatest issues\b/,
    /\brecent issues\b/,
    /\blatest changes\b/,
    /\brecent changes\b/,
    /\blatest updates\b/,
    /\brecent updates\b/
  ];

  return pluralPatterns.some((pattern) => pattern.test(normalized));
}

function isRecentSummaryQuery(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return false;
  return isLatestTicketQuery(normalized) && (hasSummaryLanguage(normalized) || hasRecentPluralLanguage(normalized));
}

function isBroadTopicQuery(query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return false;
  if (isRecentSummaryQuery(normalized)) return false;
  if (isLatestTicketQuery(normalized)) return false;
  return hasSummaryLanguage(normalized);
}

function resolveRagQueryMode(query) {
  if (extractExplicitTicketNumber(query)) return "precise";
  if (isRecentSummaryQuery(query)) return "summary_recent";
  if (isBroadTopicQuery(query)) return "summary";
  return "precise";
}

function isTicketFocusedQuery(query) {
  return /\bticket\b|\bwork item\b|\bcr\b|#\d+/i.test(String(query || ""));
}

function isLatestTicketQuery(query) {
  return /\blatest\b|\bmost recent\b|\bnewest\b|\blast ticket\b|\blast issue\b|\brecent ticket\b|\brecent issue\b|\blast person\b.*\bcreated\b.*\bticket\b|\bwho\s+created\s+(?:the\s+)?(?:latest|last|most recent|newest)\b/i.test(String(query || ""));
}

function extractExplicitTicketNumber(query) {
  const text = String(query || "").trim();
  if (!text) return null;

  const explicitMatch = text.match(/\b(?:ticket|work item|workitem|issue|cr)\s*#?\s*(\d{1,8})\b/i);
  if (explicitMatch?.[1]) {
    return explicitMatch[1];
  }

  const hashMatch = text.match(/(^|\s)#(\d{1,8})\b/);
  if (hashMatch?.[2]) {
    return hashMatch[2];
  }

  return null;
}

function scoreRagRow(queryText, queryTerms, row, index) {
  const documentText = String(row.document || "").toLowerCase();
  const filename = String(row.metadata?.filename || "").toLowerCase();
  const ticketNumber = String(row.metadata?.ticketNumber || "").toLowerCase();
  const title = String(row.metadata?.title || "").toLowerCase();
  const combinedText = `${title}\n${documentText}`;
  const isTicketRecord = row.metadata?.documentKind === "devops-ticket";
  let lexicalMatches = 0;
  let titleMatches = 0;
  let phraseMatches = 0;

  for (const term of queryTerms) {
    if (documentText.includes(term) || filename.includes(term) || ticketNumber === term.replace(/^#/, "")) {
      lexicalMatches += 1;
    }
    if (title.includes(term)) {
      titleMatches += 1;
    }
  }

  const exactPhraseBoost =
    queryText.length >= 8 && documentText.includes(queryText)
      ? 4
      : 0;
  const exactTitleBoost =
    queryText.length >= 6 && title.includes(queryText)
      ? 8
      : 0;
  for (const phrase of extractQueryPhrases(queryText)) {
    if (combinedText.includes(phrase)) {
      phraseMatches += 1;
    }
  }
  const acronymBoost = /\b[a-z]{2,6}\b/.test(queryText) && combinedText.includes(queryText) ? 6 : 0;
  const charCount = Number(row.metadata?.charCount) || documentText.length;
  const richnessBoost = Math.min(4, Math.floor(charCount / 250));
  const thinContentPenalty = charCount > 0 && charCount < 80 ? 3 : 0;
  const distancePenalty = typeof row.distance === "number" ? row.distance : 0;
  const score =
    (lexicalMatches * 3) +
    (titleMatches * 5) +
    (phraseMatches * 6) +
    exactPhraseBoost +
    exactTitleBoost +
    richnessBoost +
    acronymBoost -
    thinContentPenalty -
    distancePenalty;
  const createdTimestamp = row.metadata?.createdDate ? Date.parse(row.metadata.createdDate) : Number.NaN;

  return {
    row,
    index,
    score,
    isTicketRecord,
    lexicalMatches,
    titleMatches,
    phraseMatches,
    createdTimestamp
  };
}

function dedupeRowsById(rows) {
  const seen = new Set();
  const deduped = [];

  for (const row of rows) {
    const ticketNumber = row.metadata?.ticketNumber || "";
    const chunkIndex = row.metadata?.chunkIndex || "";
    const filename = row.metadata?.filename || "";
    const document = row.document || "";
    const key = `${filename}|${ticketNumber}|${chunkIndex}|${document.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

function getRowGroupingKey(row) {
  if (row.metadata?.ticketNumber) {
    return `ticket:${row.metadata.ticketNumber}`;
  }
  return `doc:${row.metadata?.libraryDocumentId || row.metadata?.filename || "document"}`;
}

async function findLexicalRagMatches(collection, query, sourceFilter = "all") {
  const queryText = String(query || "").trim().toLowerCase();
  const queryTerms = [...new Set(tokenizeForRagSearch(queryText))];
  const queryPhrases = extractQueryPhrases(queryText);
  const latestFocused = isLatestTicketQuery(queryText);

  if (!queryTerms.length && !queryPhrases.length) {
    return [];
  }

  const collectionCount = await collection.count();
  if (!collectionCount) {
    return [];
  }

  const result = await collection.get({
    limit: collectionCount,
    include: ["documents", "metadatas"]
  });

  const rows = filterRowsBySource(result.rows(), sourceFilter);
  const matches = [];

  for (const row of rows) {
    const documentText = String(row.document || "").toLowerCase();
    const title = String(row.metadata?.title || "").toLowerCase();
    const haystack = `${title}\n${documentText}`;
    const termMatches = queryTerms.filter((term) => haystack.includes(term)).length;
    const phraseMatches = queryPhrases.filter((phrase) => haystack.includes(phrase)).length;
    const exactQueryMatch = queryText.length >= 3 && haystack.includes(queryText);
    const createdTimestamp = row.metadata?.createdDate ? Date.parse(row.metadata.createdDate) : Number.NaN;
    const titleBoost = title.includes("dsr") && title.includes("report") ? 3 : 0;
    const score =
      (exactQueryMatch ? 10 : 0) +
      (phraseMatches * 6) +
      (termMatches * 3) +
      titleBoost;

    if (exactQueryMatch || phraseMatches > 0 || termMatches >= Math.min(2, queryTerms.length)) {
      matches.push({
        ...row,
        distance: typeof row.distance === "number" ? row.distance : 0.35,
        _lexicalScore: score,
        _createdTimestamp: createdTimestamp
      });
    }
  }

  return matches
    .sort((left, right) => {
      if ((right._lexicalScore || 0) !== (left._lexicalScore || 0)) {
        return (right._lexicalScore || 0) - (left._lexicalScore || 0);
      }
      if (latestFocused) {
        const leftTs = Number.isFinite(left._createdTimestamp) ? left._createdTimestamp : Number.NEGATIVE_INFINITY;
        const rightTs = Number.isFinite(right._createdTimestamp) ? right._createdTimestamp : Number.NEGATIVE_INFINITY;
        if (rightTs !== leftTs) return rightTs - leftTs;
      }
      const leftDistance = typeof left.distance === "number" ? left.distance : Number.POSITIVE_INFINITY;
      const rightDistance = typeof right.distance === "number" ? right.distance : Number.POSITIVE_INFINITY;
      return leftDistance - rightDistance;
    })
    .slice(0, 250)
    .map((row) => {
      delete row._lexicalScore;
      delete row._createdTimestamp;
      return row;
    });
}

async function findExactTicketNumberMatches(collection, ticketNumber, sourceFilter = "all") {
  const normalizedTicketNumber = String(ticketNumber || "").trim();
  if (!normalizedTicketNumber) {
    return [];
  }

  const result = await collection.get({
    where: { ticketNumber: normalizedTicketNumber },
    include: ["documents", "metadatas"]
  });

  return filterRowsBySource(result.rows(), sourceFilter)
    .filter((row) => String(row.metadata?.ticketNumber || "") === normalizedTicketNumber)
    .sort((left, right) => {
      const leftChunk = Number(left.metadata?.chunkIndex) || 1;
      const rightChunk = Number(right.metadata?.chunkIndex) || 1;
      return leftChunk - rightChunk;
    });
}

async function findLatestTicketTopicRows(collection, query, sourceFilter = "all", mode = "single") {
  const collectionCount = await collection.count();
  if (!collectionCount) {
    return [];
  }

  const result = await collection.get({
    limit: collectionCount,
    include: ["documents", "metadatas"]
  });

  const ticketRows = filterRowsBySource(result.rows(), sourceFilter)
    .filter((row) => row.metadata?.ticketNumber && row.metadata?.documentKind === "devops-ticket");

  if (!ticketRows.length) {
    return [];
  }

  const groups = new Map();
  for (const row of ticketRows) {
    const ticketNumber = String(row.metadata.ticketNumber);
    const topic = scoreLatestTicketTopicMatch(query, row);
    if (!groups.has(ticketNumber)) {
      groups.set(ticketNumber, {
        ticketNumber,
        rows: [],
        createdTimestamp: row.metadata?.createdDate ? Date.parse(row.metadata.createdDate) : Number.NaN,
        bestTopicScore: Number.NEGATIVE_INFINITY,
        bestDirectTopicScore: Number.NEGATIVE_INFINITY,
        bestRow: row,
        bestRowChunkIndex: Number(row.metadata?.chunkIndex) || 1
      });
    }

    const group = groups.get(ticketNumber);
    const chunkIndex = Number(row.metadata?.chunkIndex) || 1;
    group.rows.push(row);
    if (Number.isFinite(row.metadata?.createdDate ? Date.parse(row.metadata.createdDate) : Number.NaN)) {
      group.createdTimestamp = row.metadata?.createdDate ? Date.parse(row.metadata.createdDate) : group.createdTimestamp;
    }
    if (
      topic.directScore > group.bestDirectTopicScore ||
      (topic.directScore === group.bestDirectTopicScore && topic.score > group.bestTopicScore) ||
      (topic.directScore === group.bestDirectTopicScore && topic.score === group.bestTopicScore && chunkIndex < group.bestRowChunkIndex)
    ) {
      group.bestDirectTopicScore = topic.directScore;
      group.bestTopicScore = topic.score;
      group.bestRow = row;
      group.bestRowChunkIndex = chunkIndex;
    }
  }

  const rankedGroups = [...groups.values()];
  const bestDirectTopicScore = Math.max(...rankedGroups.map((group) => group.bestDirectTopicScore || 0));
  const bestTopicScore = Math.max(...rankedGroups.map((group) => group.bestTopicScore || 0));
  const directTopicFloor = bestDirectTopicScore > 0 ? Math.max(3, bestDirectTopicScore * 0.45) : 0;
  const topicFloor = bestTopicScore > 0 ? Math.max(3, bestTopicScore * 0.45) : 0;

  const directGroups = rankedGroups.filter((group) => (group.bestDirectTopicScore || 0) >= directTopicFloor);
  const topicalGroups = rankedGroups.filter((group) => (group.bestTopicScore || 0) >= topicFloor);
  const candidateGroups = directGroups.length ? directGroups : topicalGroups;

  if (!candidateGroups.length) {
    return [];
  }

  const sortedGroups = candidateGroups.sort((left, right) => {
    const leftTs = Number.isFinite(left.createdTimestamp) ? left.createdTimestamp : Number.NEGATIVE_INFINITY;
    const rightTs = Number.isFinite(right.createdTimestamp) ? right.createdTimestamp : Number.NEGATIVE_INFINITY;
    if (rightTs !== leftTs) return rightTs - leftTs;
    if ((right.bestDirectTopicScore || 0) !== (left.bestDirectTopicScore || 0)) {
      return (right.bestDirectTopicScore || 0) - (left.bestDirectTopicScore || 0);
    }
    if ((right.bestTopicScore || 0) !== (left.bestTopicScore || 0)) {
      return (right.bestTopicScore || 0) - (left.bestTopicScore || 0);
    }
    return left.ticketNumber.localeCompare(right.ticketNumber);
  });

  if (mode === "recent_summary") {
    return sortedGroups
      .slice(0, RAG_RECENT_SUMMARY_TICKET_LIMIT)
      .map((group) => group.bestRow);
  }

  const winner = sortedGroups[0];
  return winner.rows
    .sort((left, right) => (Number(left.metadata?.chunkIndex) || 1) - (Number(right.metadata?.chunkIndex) || 1))
    .slice(0, RAG_RETRIEVAL_LIMIT);
}

function selectBroadTopicRows(query, rows) {
  const queryText = String(query || "").trim().toLowerCase();
  const queryTerms = [...new Set(tokenizeForRagSearch(queryText))];
  const grouped = new Map();

  for (const [index, row] of rows.entries()) {
    const scored = scoreRagRow(queryText, queryTerms, row, index);
    const key = getRowGroupingKey(row);
    const current = grouped.get(key);
    if (!current || scored.score > current.score) {
      grouped.set(key, scored);
    }
  }

  const rankedRows = [...grouped.values()]
    .map((item) => {
      const topic = scoreLatestTicketTopicMatch(queryText, item.row);
      return {
        ...item,
        directTopicScore: topic.directScore || 0,
        topicScore: topic.score || 0
      };
    })
    .sort((left, right) => {
      if ((right.directTopicScore || 0) !== (left.directTopicScore || 0)) {
        return (right.directTopicScore || 0) - (left.directTopicScore || 0);
      }
      if ((right.topicScore || 0) !== (left.topicScore || 0)) {
        return (right.topicScore || 0) - (left.topicScore || 0);
      }
      const leftTs = Number.isFinite(left.createdTimestamp) ? left.createdTimestamp : Number.NEGATIVE_INFINITY;
      const rightTs = Number.isFinite(right.createdTimestamp) ? right.createdTimestamp : Number.NEGATIVE_INFINITY;
      if (rightTs !== leftTs) return rightTs - leftTs;
      if (right.score !== left.score) return right.score - left.score;
      const leftDistance = typeof left.row.distance === "number" ? left.row.distance : Number.POSITIVE_INFINITY;
      const rightDistance = typeof right.row.distance === "number" ? right.row.distance : Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.index - right.index;
    });

  const strongestDirectTopic = Math.max(...rankedRows.map((item) => item.directTopicScore || 0), 0);
  const topicalRows = rankedRows.filter((item) => (item.directTopicScore || 0) > 0 || (item.topicScore || 0) > 0);
  const directRows = rankedRows.filter((item) =>
    strongestDirectTopic > 0 &&
    (item.directTopicScore || 0) >= Math.max(3, strongestDirectTopic * 0.45)
  );

  return (directRows.length ? directRows : (topicalRows.length ? topicalRows : rankedRows))
    .slice(0, RAG_BROAD_TOPIC_TICKET_LIMIT)
    .map((item) => item.row);
}

function selectRecentSummaryRows(query, rows) {
  const queryText = String(query || "").trim().toLowerCase();
  const queryTerms = [...new Set(tokenizeForRagSearch(queryText))];
  const latestFocused = isLatestTicketQuery(queryText);
  const grouped = new Map();

  for (const [index, row] of rows.entries()) {
    const scored = scoreRagRow(queryText, queryTerms, row, index);
    const key = getRowGroupingKey(row);
    const current = grouped.get(key);
    if (!current || scored.score > current.score) {
      grouped.set(key, scored);
    }
  }

  const groupedRows = [...grouped.values()]
    .filter((item) => item.row.metadata?.ticketNumber)
    .map((item) => {
      const topicScore = scoreLatestTicketTopicMatch(queryText, item.row);
      return {
        ...item,
        topicScore: topicScore.score,
        directTopicScore: topicScore.directScore,
        topicTitleMatches: topicScore.titleMatches,
        topicDescriptionMatches: topicScore.descriptionMatches,
        topicPhraseMatches: topicScore.phraseMatches
      };
    })
    .sort((left, right) => {
      if (latestFocused && (right.directTopicScore || 0) !== (left.directTopicScore || 0)) {
        return (right.directTopicScore || 0) - (left.directTopicScore || 0);
      }
      if (latestFocused && (right.topicScore || 0) !== (left.topicScore || 0)) {
        return (right.topicScore || 0) - (left.topicScore || 0);
      }
      if (right.score !== left.score) return right.score - left.score;
      const leftTs = Number.isFinite(left.createdTimestamp) ? left.createdTimestamp : Number.NEGATIVE_INFINITY;
      const rightTs = Number.isFinite(right.createdTimestamp) ? right.createdTimestamp : Number.NEGATIVE_INFINITY;
      if (rightTs !== leftTs) return rightTs - leftTs;
      const leftDistance = typeof left.row.distance === "number" ? left.row.distance : Number.POSITIVE_INFINITY;
      const rightDistance = typeof right.row.distance === "number" ? right.row.distance : Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.index - right.index;
    });

  if (!groupedRows.length) {
    return [];
  }

  const bestScore = groupedRows[0].score;
  const relevanceFloor = Math.max(6, bestScore * 0.55);
  const bestDirectTopicScore = Math.max(...groupedRows.map((item) => item.directTopicScore || 0));
  const directTopicFloor = bestDirectTopicScore > 0 ? Math.max(3, bestDirectTopicScore * 0.45) : 0;
  const topicalRows = groupedRows.filter((item) => (item.directTopicScore || 0) > 0 || (item.topicScore || 0) > 0);
  const directTopicRows = groupedRows.filter((item) =>
    bestDirectTopicScore > 0 &&
    (item.directTopicScore || 0) >= directTopicFloor &&
    ((item.topicTitleMatches || 0) > 0 || (item.topicDescriptionMatches || 0) > 0 || (item.topicPhraseMatches || 0) > 0)
  );
  const relevantRows = directTopicRows.length
    ? directTopicRows
    : (topicalRows.length
      ? topicalRows
      : groupedRows.filter((item) =>
        item.score >= relevanceFloor &&
        (item.lexicalMatches > 0 || item.titleMatches > 0 || item.phraseMatches > 0)
      ));

  const bestRecentTimestamp = relevantRows.find((item) => Number.isFinite(item.createdTimestamp))?.createdTimestamp ?? Number.NaN;
  const recentFloor = Number.isFinite(bestRecentTimestamp)
    ? bestRecentTimestamp - (365 * 24 * 60 * 60 * 1000 * 2)
    : Number.NaN;

  const filteredRows = relevantRows.filter((item) => {
    if (!Number.isFinite(recentFloor)) return true;
    if (!Number.isFinite(item.createdTimestamp)) return false;
    return item.createdTimestamp >= recentFloor;
  });

  return (filteredRows.length ? filteredRows : relevantRows)
    .sort((left, right) => {
      const leftTs = Number.isFinite(left.createdTimestamp) ? left.createdTimestamp : Number.NEGATIVE_INFINITY;
      const rightTs = Number.isFinite(right.createdTimestamp) ? right.createdTimestamp : Number.NEGATIVE_INFINITY;
      if (rightTs !== leftTs) return rightTs - leftTs;
      if ((right.directTopicScore || 0) !== (left.directTopicScore || 0)) {
        return (right.directTopicScore || 0) - (left.directTopicScore || 0);
      }
      if ((right.topicScore || 0) !== (left.topicScore || 0)) {
        return (right.topicScore || 0) - (left.topicScore || 0);
      }
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .slice(0, RAG_RECENT_SUMMARY_TICKET_LIMIT)
    .map((item) => item.row);
}

function resolveTicketRows(query, scoredRows) {
  const latestFocused = isLatestTicketQuery(query);
  const ticketRows = scoredRows.filter((item) => item.isTicketRecord && item.row.metadata?.ticketNumber);
  if (ticketRows.length === 0) {
    return [];
  }

  const groups = new Map();
  for (const item of ticketRows) {
    const ticketNumber = String(item.row.metadata.ticketNumber);
    if (!groups.has(ticketNumber)) {
      groups.set(ticketNumber, {
        ticketNumber,
        rows: [],
        bestScore: Number.NEGATIVE_INFINITY,
        aggregateScore: 0,
        maxLexicalMatches: 0,
        maxTitleMatches: 0,
        createdTimestamp: item.createdTimestamp
      });
    }

    const group = groups.get(ticketNumber);
    group.rows.push(item);
    group.bestScore = Math.max(group.bestScore, item.score);
    group.aggregateScore += Math.max(0, item.score);
    group.maxLexicalMatches = Math.max(group.maxLexicalMatches, item.lexicalMatches);
    group.maxTitleMatches = Math.max(group.maxTitleMatches, item.titleMatches);
    if (Number.isFinite(item.createdTimestamp)) {
      group.createdTimestamp = item.createdTimestamp;
    }
  }

  const rankedGroups = [...groups.values()]
    .map((group) => {
      const sortedRows = group.rows.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        const leftDistance = typeof left.row.distance === "number" ? left.row.distance : Number.POSITIVE_INFINITY;
        const rightDistance = typeof right.row.distance === "number" ? right.row.distance : Number.POSITIVE_INFINITY;
        if (leftDistance !== rightDistance) return leftDistance - rightDistance;
        return left.index - right.index;
      });
      const topicScores = sortedRows.map((item) => scoreLatestTicketTopicMatch(query, item.row));
      return {
        ...group,
        rows: sortedRows,
        relevance: group.bestScore + (group.aggregateScore * 0.15) + (group.maxLexicalMatches * 2) + (group.maxTitleMatches * 3),
        topicScore: Math.max(...topicScores.map((score) => score.score)),
        directTopicScore: Math.max(...topicScores.map((score) => score.directScore || 0)),
        topicTitleMatches: Math.max(...topicScores.map((score) => score.titleMatches)),
        topicDescriptionMatches: Math.max(...topicScores.map((score) => score.descriptionMatches)),
        topicPhraseMatches: Math.max(...topicScores.map((score) => score.phraseMatches))
      };
    })
    .sort((left, right) => {
      if (right.relevance !== left.relevance) return right.relevance - left.relevance;
      const leftTs = Number.isFinite(left.createdTimestamp) ? left.createdTimestamp : Number.NEGATIVE_INFINITY;
      const rightTs = Number.isFinite(right.createdTimestamp) ? right.createdTimestamp : Number.NEGATIVE_INFINITY;
      if (rightTs !== leftTs) return rightTs - leftTs;
      return left.ticketNumber.localeCompare(right.ticketNumber);
    });

  if (latestFocused) {
    const bestDirectTopicScore = Math.max(...rankedGroups.map((group) => group.directTopicScore || 0));
    const directTopicFloor = bestDirectTopicScore > 0 ? Math.max(3, bestDirectTopicScore * 0.45) : 0;
    const directTopicalGroups = rankedGroups.filter((group) =>
      bestDirectTopicScore > 0 &&
      (group.directTopicScore || 0) >= directTopicFloor &&
      (group.topicTitleMatches > 0 || group.topicDescriptionMatches > 0 || group.topicPhraseMatches > 0)
    );
    const bestTopicScore = Math.max(...rankedGroups.map((group) => group.topicScore || 0));
    const topicFloor = bestTopicScore > 0 ? Math.max(3, bestTopicScore * 0.45) : 0;
    const topicalGroups = rankedGroups.filter((group) =>
      bestTopicScore > 0 &&
      group.topicScore >= topicFloor &&
      (group.topicTitleMatches > 0 || group.topicDescriptionMatches > 0 || group.topicPhraseMatches > 0)
    );
    const relevanceFloor = Math.max(4, rankedGroups[0].relevance * 0.45);
    const fallbackGroups = rankedGroups.filter((group) =>
      group.relevance >= relevanceFloor &&
      (group.maxLexicalMatches > 0 || group.maxTitleMatches > 0)
    );
    const candidateGroups = directTopicalGroups.length
      ? directTopicalGroups
      : (topicalGroups.length ? topicalGroups : (fallbackGroups.length ? fallbackGroups : [rankedGroups[0]]));
    const winner = candidateGroups
      .sort((left, right) => {
        const leftTs = Number.isFinite(left.createdTimestamp) ? left.createdTimestamp : Number.NEGATIVE_INFINITY;
        const rightTs = Number.isFinite(right.createdTimestamp) ? right.createdTimestamp : Number.NEGATIVE_INFINITY;
        if (rightTs !== leftTs) return rightTs - leftTs;
        if ((right.directTopicScore || 0) !== (left.directTopicScore || 0)) {
          return (right.directTopicScore || 0) - (left.directTopicScore || 0);
        }
        if ((right.topicScore || 0) !== (left.topicScore || 0)) {
          return (right.topicScore || 0) - (left.topicScore || 0);
        }
        if (right.relevance !== left.relevance) return right.relevance - left.relevance;
        return left.ticketNumber.localeCompare(right.ticketNumber);
      })[0];
    return winner.rows.slice(0, RAG_RETRIEVAL_LIMIT).map((item) => item.row);
  }

  const selectedRows = [];
  for (const group of rankedGroups) {
    for (const item of group.rows) {
      if (selectedRows.length >= RAG_RETRIEVAL_LIMIT) {
        return selectedRows;
      }
      selectedRows.push(item.row);
    }
  }
  return selectedRows;
}

function buildResolvedTicketSummary(query, rows) {
  if (!isTicketFocusedQuery(query) || rows.length === 0) {
    return "";
  }

  const explicitTicketNumber = extractExplicitTicketNumber(query);
  const firstTicketRow = explicitTicketNumber
    ? rows.find((row) => String(row.metadata?.ticketNumber || "") === explicitTicketNumber)
    : rows.find((row) => row.metadata?.documentKind === "devops-ticket" && row.metadata?.ticketNumber);
  if (!firstTicketRow) {
    return "";
  }

  const metadata = firstTicketRow.metadata || {};
  const lines = explicitTicketNumber
    ? [
        "Resolved exact ticket match:",
        `- requestedTicketNumber: ${explicitTicketNumber}`,
        `- matchedTicketNumber: ${metadata.ticketNumber}`,
        `- title: ${metadata.title || ""}`,
        `- createdDate: ${formatDisplayDate(metadata.createdDate) || ""}`,
        `- sourceLabel: [source: ${metadata.filename || "document"} ticket ${metadata.ticketNumber} chunk ${metadata.chunkIndex || 1}]`,
        "- answerRule: answer about this ticket using the retrieved excerpts for this ticket only",
        "- answerRule: do not say the ticket is missing",
        "- answerRule: do not substitute other ticket numbers"
      ]
    : [
        "Resolved ticket facts:",
        `- ticketNumber: ${metadata.ticketNumber}`,
        `- title: ${metadata.title || ""}`,
        `- createdDate: ${formatDisplayDate(metadata.createdDate) || ""}`,
        `- sourceLabel: [source: ${metadata.filename || "document"} ticket ${metadata.ticketNumber} chunk ${metadata.chunkIndex || 1}]`
      ];
  if (!explicitTicketNumber && isLatestTicketQuery(query)) {
    lines.push("- resolutionRule: selected from topic-relevant DevOps tickets by newest ticket createdDate first, then topic relevance as tie-breaker");
  }
  return lines.join("\n");
}

function rerankRagRows(query, rows) {
  const queryText = String(query || "").trim().toLowerCase();
  const queryTerms = [...new Set(tokenizeForRagSearch(queryText))];
  const ticketFocused = isTicketFocusedQuery(queryText);
  const latestFocused = isLatestTicketQuery(queryText);

  const scoredRows = rows.map((row, index) => {
    const scored = scoreRagRow(queryText, queryTerms, row, index);
    return {
      ...scored,
      score: scored.score + (ticketFocused && scored.isTicketRecord ? 6 : 0)
    };
  });

  if (ticketFocused) {
    const resolvedTicketRows = resolveTicketRows(queryText, scoredRows);
    if (resolvedTicketRows.length > 0) {
      return resolvedTicketRows;
    }
  }

  return scoredRows
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (latestFocused) {
        const leftTs = Number.isFinite(left.createdTimestamp) ? left.createdTimestamp : Number.NEGATIVE_INFINITY;
        const rightTs = Number.isFinite(right.createdTimestamp) ? right.createdTimestamp : Number.NEGATIVE_INFINITY;
        if (rightTs !== leftTs) return rightTs - leftTs;
      }
      const leftDistance = typeof left.row.distance === "number" ? left.row.distance : Number.POSITIVE_INFINITY;
      const rightDistance = typeof right.row.distance === "number" ? right.row.distance : Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.index - right.index;
    })
    .slice(0, RAG_RETRIEVAL_LIMIT)
    .map((item) => item.row);
}

function summarizeLibraryRows(rows) {
  const docs = new Map();
  let totalChars = 0;

  for (const row of rows) {
    const metadata = row.metadata || {};
    const documentId = metadata.libraryDocumentId;
    if (!documentId) continue;

    const charCount = Number(metadata.charCount) || 0;
    totalChars += charCount;

    if (!docs.has(documentId)) {
      docs.set(documentId, {
        documentId,
        filename: metadata.filename || "document",
        pages: Number(metadata.pages) >= 0 ? Number(metadata.pages) : null,
        chunkCount: 0,
        totalChars: 0
      });
    }

    const doc = docs.get(documentId);
    doc.chunkCount += 1;
    doc.totalChars += charCount;
  }

  const documents = [...docs.values()].sort((a, b) => a.filename.localeCompare(b.filename));
  return {
    documents,
    stats: {
      documentCount: documents.length,
      chunkCount: rows.length,
      totalChars
    }
  };
}

async function getVectorLibraryOverview(instanceId) {
  const instance = getVectorInstanceConfig(instanceId);
  const collection = await getExistingRagCollection(instance.id);
  if (!collection) {
    return {
      instance: {
        id: instance.id,
        name: instance.name,
        host: instance.host,
        port: instance.port,
        ssl: instance.ssl,
        collection: instance.collection,
        type: "Chroma"
      },
      stats: {
        documentCount: 0,
        chunkCount: 0,
        totalChars: 0
      },
      documents: []
    };
  }
  const collectionCount = await collection.count();

  if (collectionCount === 0) {
    return {
      instance: {
        id: instance.id,
        name: instance.name,
        host: instance.host,
        port: instance.port,
        ssl: instance.ssl,
        collection: instance.collection,
        type: "Chroma"
      },
      stats: {
        documentCount: 0,
        chunkCount: 0,
        totalChars: 0
      },
      documents: []
    };
  }

  const result = await collection.get({
    limit: collectionCount,
    include: ["metadatas"]
  });
  const rows = result.rows().filter((row) => row.metadata?.libraryDocumentId);
  const summary = summarizeLibraryRows(rows);

  return {
    instance: {
      id: instance.id,
      name: instance.name,
      host: instance.host,
      port: instance.port,
      ssl: instance.ssl,
      collection: instance.collection,
      type: "Chroma"
    },
    stats: summary.stats,
    documents: summary.documents
  };
}

async function testVectorInstance(instanceId) {
  const instance = getVectorInstanceConfig(instanceId);
  const client = getChromaClient(instance.id);

  const summary = {
    ok: false,
    instance: {
      id: instance.id,
      name: instance.name,
      type: "Chroma",
      host: instance.host,
      port: instance.port,
      ssl: instance.ssl,
      collection: instance.collection
    },
    checks: {
      heartbeat: { ok: false, detail: "" },
      collection: { ok: false, detail: "" }
    }
  };

  try {
    const heartbeat = await client.heartbeat();
    summary.checks.heartbeat = {
      ok: true,
      detail: `Heartbeat OK (${heartbeat})`
    };
  } catch (error) {
    summary.checks.heartbeat = {
      ok: false,
      detail: error.message || "Heartbeat failed."
    };
    return summary;
  }

  try {
    const collection = await getExistingRagCollection(instance.id);
    if (!collection) {
      summary.checks.collection = {
        ok: true,
        detail: `Collection "${instance.collection}" does not exist yet (will be created on first ingest)`
      };
      summary.ok = true;
      return summary;
    }
    const count = await collection.count();
    summary.checks.collection = {
      ok: true,
      detail: `Collection "${instance.collection}" reachable (${count} chunk records)`
    };
    summary.ok = true;
  } catch (error) {
    summary.checks.collection = {
      ok: false,
      detail: error.message || "Collection access failed."
    };
  }

  return summary;
}

async function retrieveRagRowsForQuery(query, vectorInstanceId, sourceFilter = "all") {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return {
      ok: false,
      reason: "missing_query",
      rows: []
    };
  }
  const normalizedSourceFilter = resolveEffectiveSourceFilter(query, sourceFilter);
  const queryMode = resolveRagQueryMode(query);
  const broadTopicQuery = queryMode === "summary";
  const recentSummaryQuery = queryMode === "summary_recent";
  const explicitTicketNumber = extractExplicitTicketNumber(query);

  const instance = getVectorInstanceConfig(vectorInstanceId);
  const collection = await getExistingRagCollection(instance.id);
  if (!collection) {
    return {
      ok: false,
      reason: "empty_collection",
      instance,
      queryMode,
      sourceFilter: normalizedSourceFilter,
      rows: []
    };
  }

  if (explicitTicketNumber && queryMode === "precise") {
    const rows = (await findExactTicketNumberMatches(collection, explicitTicketNumber, normalizedSourceFilter))
      .slice(0, RAG_RETRIEVAL_LIMIT);

    if (rows.length === 0) {
      return {
        ok: false,
        reason: "exact_ticket_not_found",
        instance,
        queryMode,
        sourceFilter: normalizedSourceFilter,
        explicitTicketNumber,
        rows: []
      };
    }

    return {
      ok: true,
      instance,
      queryMode,
      sourceFilter: normalizedSourceFilter,
      explicitTicketNumber,
      rows
    };
  }

  if (normalizedSourceFilter === "ticket_json" && isLatestTicketQuery(query) && !explicitTicketNumber) {
    const rows = await findLatestTicketTopicRows(
      collection,
      query,
      normalizedSourceFilter,
      recentSummaryQuery ? "recent_summary" : "single"
    );
    if (rows.length > 0) {
      return {
        ok: true,
        instance,
        queryMode,
        sourceFilter: normalizedSourceFilter,
        explicitTicketNumber,
        rows
      };
    }
  }

  const queryEmbeddings = await embedTexts([query]);
  const result = await collection.query({
    queryEmbeddings,
    nResults: broadTopicQuery || recentSummaryQuery ? RAG_BROAD_TOPIC_CANDIDATE_LIMIT : RAG_QUERY_CANDIDATE_LIMIT,
    include: ["documents", "metadatas", "distances"]
  });

  const vectorRows = filterRowsBySource(result.rows()[0]?.filter((row) => row.document) || [], normalizedSourceFilter);
  const lexicalRows = await findLexicalRagMatches(collection, query, normalizedSourceFilter);
  const candidateRows = dedupeRowsById([...vectorRows, ...lexicalRows]);
  let rows = [];

  if (rows.length === 0) {
    rows = recentSummaryQuery
      ? selectRecentSummaryRows(query, candidateRows)
      : broadTopicQuery
        ? selectBroadTopicRows(query, candidateRows)
        : rerankRagRows(query, candidateRows);
  }
  if (rows.length === 0) {
    return {
      ok: false,
      reason: "no_matches",
      instance,
      queryMode,
      sourceFilter: normalizedSourceFilter,
      rows: []
    };
  }

  return {
    ok: true,
    instance,
    queryMode,
    sourceFilter: normalizedSourceFilter,
    explicitTicketNumber,
    rows
  };
}

async function maybeAugmentMessagesWithDocumentContext(messages, vectorSearchEnabled, vectorInstanceId, sourceFilter = "all") {
  if (!vectorSearchEnabled) {
    return messages;
  }

  const query = getLatestUserMessage(messages);
  if (!query) {
    return messages;
  }
  const retrieval = await retrieveRagRowsForQuery(query, vectorInstanceId, sourceFilter);
  if (!retrieval.ok) {
    if (retrieval.reason === "empty_collection") {
      return [
        {
          role: "system",
          content: `Knowledge base "${retrieval.instance.name}" is empty. Say clearly that no indexed documents are available yet.`
        },
        ...messages
      ];
    }
    if (retrieval.reason === "exact_ticket_not_found") {
      return [
        {
          role: "system",
          content:
            `Knowledge base "${retrieval.instance.name}" does not contain ticket ${retrieval.explicitTicketNumber} in the indexed material. Say clearly that ticket ${retrieval.explicitTicketNumber} was not found in the knowledge base.`
        },
        ...messages
      ];
    }
    return [
      {
        role: "system",
        content:
          `Knowledge base "${retrieval.instance?.name || "selected"}" returned no matching excerpts for the current question. Say clearly if the answer is not in the indexed material.`
      },
      ...messages
    ];
  }

  const { instance, queryMode, rows } = retrieval;
  const broadTopicQuery = queryMode === "summary";
  const recentSummaryQuery = queryMode === "summary_recent";
  logRetrievedRagRows(query, instance.name, queryMode, rows);

  return [
    {
      role: "system",
      content: recentSummaryQuery
        ? buildRecentSummaryContextMessage(query, rows, instance.name)
        : broadTopicQuery
          ? buildBroadTopicContextMessage(query, rows, instance.name)
          : buildRagContextMessage(query, rows, instance.name)
    },
    ...messages
  ];
}

function normalizeQueryForIntent(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldRunWebSearch(query) {
  const normalized = normalizeQueryForIntent(query);
  if (!normalized) return false;

  const smallTalkPatterns = [
    /^(hi|hello|hey|yo)\b/,
    /^how are you\b/,
    /^what s up\b/,
    /^(thanks|thank you)\b/,
    /^(good morning|good afternoon|good evening|good night)\b/,
    /^who are you\b/,
    /^what can you do\b/
  ];
  if (smallTalkPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const explicitWebPatterns = [
    /\b(search the web|web search|look up|find online|browse)\b/,
    /\b(source|sources|reference|references|citation|cite)\b/
  ];
  if (explicitWebPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const freshDataPatterns = [
    /\b(latest|current|today|yesterday|this week|recent)\b/,
    /\b(news|headline|breaking)\b/,
    /\b(weather|forecast|temperature)\b/,
    /\b(price|stock|market cap|exchange rate|score|standings|schedule)\b/,
    /\b(version|release date|release notes|changelog|updated)\b/,
    /\b(president|prime minister|ceo)\b/
  ];
  return freshDataPatterns.some((pattern) => pattern.test(normalized));
}

function getLatestUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return "";
}

async function fetchBraveWebResults(query) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(BRAVE_SEARCH_MAX_RESULTS));
  url.searchParams.set("country", BRAVE_SEARCH_COUNTRY);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": BRAVE_SEARCH_API_KEY
    }
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const details = payload.error || payload.message || payload.raw || "Brave Search request failed.";
    throw createHttpError(response.status, String(details));
  }

  const results = Array.isArray(payload.web?.results) ? payload.web.results : [];
  return results
    .slice(0, BRAVE_SEARCH_MAX_RESULTS)
    .map((item) => ({
      title: item?.title || "Untitled",
      url: item?.url || "",
      description: item?.description || ""
    }))
    .filter((item) => item.url);
}

function buildWebSearchContextMessage(query, results) {
  if (results.length === 0) {
    return [
      `Web search query: ${query}`,
      "No web results were returned. Do not invent sources.",
      "If answer confidence is low, say that web results were unavailable."
    ].join("\n");
  }

  const lines = [
    `Web search query: ${query}`,
    "Use these web search snippets as supporting evidence and cite URLs you used:"
  ];

  for (const [index, item] of results.entries()) {
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`URL: ${item.url}`);
    lines.push(`Snippet: ${item.description || "(no snippet)"}`);
  }

  lines.push("If the answer is not covered by these results, say so clearly.");
  return lines.join("\n");
}

function prependConversationGuard(messages) {
  return [
    {
      role: "system",
      content: [
        "Answer the user's latest question as the primary task.",
        "If the latest question changes topic, do not carry forward facts, tickets, root causes, or assumptions from earlier turns unless the user explicitly asks to continue or compare with the earlier topic.",
        "Treat prior turns as conversational background only, not as evidence for the current answer.",
        "When grounded knowledge-base excerpts are provided, use only those excerpts as evidence."
      ].join("\n")
    },
    ...messages
  ];
}

async function maybeAugmentMessagesWithWebSearch(messages, webSearchEnabled, webSearchQuery) {
  if (!webSearchEnabled) return messages;

  const query = typeof webSearchQuery === "string" && webSearchQuery.trim()
    ? webSearchQuery.trim()
    : getLatestUserMessage(messages);

  if (!query) {
    throw createHttpError(400, "Web search enabled but no query text was found.");
  }

  if (!shouldRunWebSearch(query)) {
    return messages;
  }

  if (!BRAVE_SEARCH_ENABLED) {
    throw createHttpError(400, "Web search is disabled. Set BRAVE_SEARCH_ENABLED=true in .env.");
  }
  if (!BRAVE_SEARCH_API_KEY) {
    throw createHttpError(400, "Missing BRAVE_SEARCH_API_KEY for Brave web search.");
  }

  const results = await fetchBraveWebResults(query);
  const contextMessage = buildWebSearchContextMessage(query, results);
  return [{ role: "system", content: contextMessage }, ...messages];
}

function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function extractPdfDocument(fileBuffer) {
  const parser = new PDFParse({ data: fileBuffer });
  let extracted;
  let text = "";
  let extractionMethod = "text";

  try {
    extracted = await parser.getText();
    text = (extracted.text || "").replace(/\r\n/g, "\n").trim();

    const shouldTryOcr = OCR_ENABLED && text.length < OCR_MIN_TEXT_CHARS;
    if (shouldTryOcr) {
      try {
        const ocrText = await runPdfOcr(parser, extracted.total || null);
        if (ocrText) {
          if (text) {
            text = `${text}\n\n${ocrText}`.trim();
            extractionMethod = "mixed";
          } else {
            text = ocrText;
            extractionMethod = "ocr";
          }
        }
      } catch (ocrError) {
        if (!text) {
          throw new Error(`OCR fallback failed: ${ocrError.message || "unknown OCR error"}`);
        }
      }
    }
  } finally {
    await parser.destroy();
  }

  return {
    text,
    pages: extracted?.total || null,
    extractionMethod
  };
}

async function extractDocxDocument(fileBuffer) {
  const extracted = await mammoth.extractRawText({ buffer: fileBuffer });
  return {
    text: normalizeWhitespace(extracted.value || ""),
    pages: null,
    extractionMethod: "text"
  };
}

async function extractJsonDocument(fileBuffer) {
  let parsed;
  try {
    parsed = JSON.parse(fileBuffer.toString("utf8"));
  } catch (error) {
    throw createHttpError(422, `Invalid JSON file: ${error.message}`);
  }

  return {
    text: JSON.stringify(parsed, null, 2),
    pages: null,
    extractionMethod: "text",
    parsedJson: parsed,
    jsonFormat: isDevOpsTicketJson(parsed) ? "devops-tickets" : "generic"
  };
}

async function extractUploadedDocument({ filename, mimeType, dataBase64 }) {
  if (!dataBase64 || typeof dataBase64 !== "string") {
    throw createHttpError(400, "dataBase64 is required.");
  }

  const documentType = getDocumentType({ filename, mimeType });
  if (!documentType) {
    throw createHttpError(400, "Only .pdf, .docx, and .json files are supported.");
  }

  const fileBuffer = Buffer.from(dataBase64, "base64");
  if (fileBuffer.length > MAX_DOCUMENT_BYTES) {
    throw createHttpError(413, `Document is too large. Max supported size is ${Math.floor(MAX_DOCUMENT_BYTES / 1_000_000)}MB.`);
  }

  const extracted =
    documentType === "pdf"
      ? await extractPdfDocument(fileBuffer)
      : documentType === "docx"
        ? await extractDocxDocument(fileBuffer)
        : await extractJsonDocument(fileBuffer);

  const resolvedFilename = filename || SUPPORTED_DOCUMENT_TYPES[documentType].defaultFilename;
  return {
    ...extracted,
    documentType,
    filename: resolvedFilename,
    mimeType: SUPPORTED_DOCUMENT_TYPES[documentType].fallbackMimeType
  };
}

async function handleDocumentExtract(req, res) {
  try {
    const body = await readJsonBody(req, MAX_DOCUMENT_JSON_BYTES);
    const extracted = await extractUploadedDocument(body);
    const text = normalizeWhitespace(extracted.text || "");

    if (!text) {
      sendJson(res, 422, { error: `No extractable text found in this ${extracted.documentType.toUpperCase()} file.` });
      return;
    }

    sendJson(res, 200, {
      filename: extracted.filename,
      pages: extracted.pages,
      extractionMethod: extracted.extractionMethod,
      documentType: extracted.documentType,
      mimeType: extracted.mimeType,
      jsonFormat: extracted.jsonFormat,
      text
    });
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Failed to process document." });
  }
}

async function handleVectorInstances(_req, res) {
  try {
    sendJson(res, 200, {
      defaultInstanceId: DEFAULT_VECTOR_INSTANCE.id,
      instances: listVectorInstances()
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Failed to load vector instances." });
  }
}

async function handleVectorLibrary(req, res, parsedUrl) {
  try {
    const instanceId = parsedUrl.searchParams.get("instanceId");
    const payload = await getVectorLibraryOverview(instanceId);
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Failed to load knowledge base overview." });
  }
}

async function handleVectorTest(req, res, parsedUrl) {
  try {
    const instanceId = parsedUrl.searchParams.get("instanceId");
    const payload = await testVectorInstance(instanceId);
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Failed to test knowledge base connection." });
  }
}

async function handleRagIngest(req, res) {
  try {
    const body = await readJsonBody(req, MAX_DOCUMENT_JSON_BYTES);
    const { vectorInstanceId, documentId, filename, pages, text } = body;
    const instance = getVectorInstanceConfig(vectorInstanceId);
    let result;
    let extractionMethod = null;
    let documentType = null;
    let jsonFormat = null;
    let resolvedFilename = filename;
    let resolvedPages = typeof pages === "number" ? pages : null;

    if (typeof body.dataBase64 === "string") {
      const extracted = await extractUploadedDocument(body);
      extractionMethod = extracted.extractionMethod;
      documentType = extracted.documentType;
      jsonFormat = extracted.jsonFormat || null;
      resolvedFilename = extracted.filename;
      resolvedPages = typeof extracted.pages === "number" ? extracted.pages : null;

      if (documentType === "json" && jsonFormat === "devops-tickets" && Array.isArray(extracted.parsedJson)) {
        result = await ingestDevOpsTicketsIntoRag({
          instanceId: instance.id,
          documentId,
          filename: extracted.filename,
          tickets: extracted.parsedJson
        });
      } else {
        result = await ingestDocumentIntoRag({
          instanceId: instance.id,
          documentId,
          filename: extracted.filename,
          pages: extracted.pages,
          text: extracted.text,
          sourceKind: documentType === "json" ? "ticket_json" : "reference_doc",
          sourceType: documentType || ""
        });
      }
    } else {
      result = await ingestDocumentIntoRag({
        instanceId: instance.id,
        documentId,
        filename,
        pages,
        text,
        sourceKind: inferSourceKindFromFilename(filename),
        sourceType: getDocumentType({ filename, mimeType: "" }) || ""
      });
    }

    sendJson(res, 200, {
      documentId: result.documentId,
      filename: resolvedFilename,
      pages: resolvedPages,
      chunkCount: result.chunkCount,
      ticketCount: result.ticketCount || null,
      embeddingModel: OLLAMA_EMBED_MODEL,
      vectorInstanceId: instance.id,
      vectorInstanceName: instance.name,
      collection: instance.collection,
      extractionMethod,
      documentType,
      jsonFormat
    });
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Failed to ingest document." });
  }
}

async function handleVectorDelete(req, res) {
  try {
    const body = await readJsonBody(req);
    const instance = getVectorInstanceConfig(body.vectorInstanceId);
    const result = await deleteDocumentFromRag(instance.id, body.documentId);
    sendJson(res, 200, {
      ok: true,
      deleted: result.deleted,
      vectorInstanceId: instance.id,
      vectorInstanceName: instance.name
    });
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Failed to delete document from knowledge base." });
  }
}

async function handleChatStream(req, res) {
  let clientDisconnected = false;
  try {
    const body = await readJsonBody(req);
    const { model, messages, webSearchEnabled, webSearchQuery, vectorSearchEnabled, vectorInstanceId, sourceFilter } = body;

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      sendJson(res, 400, { error: "model and messages[] are required." });
      return;
    }

    let finalMessages = prependConversationGuard(messages);
    finalMessages = await maybeAugmentMessagesWithDocumentContext(
      finalMessages,
      Boolean(vectorSearchEnabled),
      vectorInstanceId,
      sourceFilter
    );
    finalMessages = await maybeAugmentMessagesWithWebSearch(
      finalMessages,
      Boolean(webSearchEnabled),
      webSearchQuery
    );

    const abortController = new AbortController();
    const abortUpstream = () => {
      clientDisconnected = true;
      abortController.abort();
    };
    req.on("aborted", abortUpstream);
    res.on("close", () => {
      if (!res.writableEnded) {
        abortUpstream();
      }
    });

    let ollamaRes;
    try {
      ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: finalMessages,
          stream: true
        }),
        signal: abortController.signal
      });
    } catch (error) {
      if (clientDisconnected) {
        return;
      }
      throw createHttpError(502, describeUpstreamFetchError(error, "Ollama"));
    }

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
      const modelError = describeOllamaModelError(payload);
      console.error("Ollama request failed:", {
        status: ollamaRes.status,
        rawError: modelError.rawMessage || payload.error || payload.raw || text
      });
      sendJson(res, ollamaRes.status, {
        error: modelError.userMessage || "Ollama stream request failed",
        details: {
          ...payload,
          rawError: modelError.rawMessage || payload.error || payload.raw || text
        }
      });
      return;
    }

    if (!ollamaRes.body) {
      sendJson(res, 500, { error: "Ollama stream did not return a response body." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(": stream-open\n\n");

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (parsed.error) {
          const modelError = describeOllamaModelError(parsed.error);
          console.error("Ollama stream error:", modelError.rawMessage || parsed.error);
          sendSse(res, {
            type: "error",
            error: modelError.userMessage,
            details: modelError.rawMessage || parsed.error
          });
          res.end();
          return;
        }

        if (parsed.message?.content) {
          sendSse(res, { type: "token", content: parsed.message.content });
        }

        if (parsed.done) {
          sendSse(res, {
            type: "done",
            done_reason: parsed.done_reason || null
          });
        }
      }
    }

    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.message?.content) {
          sendSse(res, { type: "token", content: parsed.message.content });
        }
        if (parsed.done) {
          sendSse(res, {
            type: "done",
            done_reason: parsed.done_reason || null
          });
        }
      } catch {
        // Ignore partial trailing chunk.
      }
    }

    res.end();
  } catch (error) {
    if (res.headersSent) {
      if (clientDisconnected) {
        res.end();
        return;
      }
      try {
        sendSse(res, {
          type: "error",
          error: describeUpstreamFetchError(error, "Ollama")
        });
      } catch {
        // Ignore write errors if connection already closed.
      }
      res.end();
      return;
    }
    sendJson(res, Number(error.status) || 500, { error: error.message || "Internal server error" });
  }
}

async function handleChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const { model, messages, webSearchEnabled, webSearchQuery, vectorSearchEnabled, vectorInstanceId, sourceFilter } = body;

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      sendJson(res, 400, { error: "model and messages[] are required." });
      return;
    }

    let finalMessages = prependConversationGuard(messages);
    finalMessages = await maybeAugmentMessagesWithDocumentContext(
      finalMessages,
      Boolean(vectorSearchEnabled),
      vectorInstanceId,
      sourceFilter
    );
    finalMessages = await maybeAugmentMessagesWithWebSearch(
      finalMessages,
      Boolean(webSearchEnabled),
      webSearchQuery
    );

    let ollamaRes;
    try {
      ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: finalMessages,
          stream: false
        })
      });
    } catch (error) {
      throw createHttpError(502, describeUpstreamFetchError(error, "Ollama"));
    }

    const text = await ollamaRes.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    if (!ollamaRes.ok) {
      sendJson(res, ollamaRes.status, {
        error: payload.error || "Ollama request failed",
        details: payload
      });
      return;
    }

    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, Number(error.status) || 500, { error: error.message || "Internal server error" });
  }
}

async function handleModels(_req, res) {
  try {
    let ollamaRes;
    try {
      ollamaRes = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, {}, 4_000);
    } catch (error) {
      throw createHttpError(502, describeUpstreamFetchError(error, "Ollama"));
    }
    const text = await ollamaRes.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    if (!ollamaRes.ok) {
      sendJson(res, ollamaRes.status, {
        error: payload.error || "Could not load models",
        details: payload
      });
      return;
    }

    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
}

function serveStatic(req, res, parsedUrl) {
  const requestedPath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && parsedUrl.pathname === "/api/models") {
      await handleModels(req, res);
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/vector/instances") {
      await handleVectorInstances(req, res);
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/vector/library") {
      await handleVectorLibrary(req, res, parsedUrl);
      return;
    }

    if (req.method === "GET" && parsedUrl.pathname === "/api/vector/test") {
      await handleVectorTest(req, res, parsedUrl);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/chat") {
      await handleChat(req, res);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/chat/stream") {
      await handleChatStream(req, res);
      return;
    }

    if (req.method === "POST" && (parsedUrl.pathname === "/api/document/extract" || parsedUrl.pathname === "/api/pdf/extract")) {
      await handleDocumentExtract(req, res);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/rag/ingest") {
      await handleRagIngest(req, res);
      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/api/vector/delete") {
      await handleVectorDelete(req, res);
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res, parsedUrl);
      return;
    }

    res.writeHead(405);
    res.end("Method Not Allowed");
  });
}

function startServer() {
  setupFileLogging();
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`Proxying Ollama to ${OLLAMA_BASE_URL}`);
    console.log(
      `OCR fallback: ${OCR_ENABLED ? `enabled (lang=${OCR_LANG}, maxPages=${OCR_MAX_PAGES})` : "disabled"}`
    );
    console.log(
      `Brave web search: ${
        BRAVE_SEARCH_ENABLED
          ? `enabled (country=${BRAVE_SEARCH_COUNTRY}, maxResults=${BRAVE_SEARCH_MAX_RESULTS})`
          : "disabled"
      }`
    );
    console.log(`RAG embeddings: model=${OLLAMA_EMBED_MODEL}`);
    console.log(`Vector instances: ${VECTOR_INSTANCES.map((item) => `${item.name}(${item.id})`).join(", ")}`);
  });
  return server;
}

module.exports = {
  retrieveRagRowsForQuery,
  resolveEffectiveSourceFilter,
  resolveRagQueryMode,
  getRowSourceKind,
  startServer,
  createServer,
  DEFAULT_VECTOR_INSTANCE_ID
};

if (require.main === module) {
  startServer();
}
