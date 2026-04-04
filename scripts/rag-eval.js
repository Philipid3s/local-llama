const {
  retrieveRagRowsForQuery,
  DEFAULT_VECTOR_INSTANCE_ID,
  getRowSourceKind
} = require("../server");
const { EVAL_CASES } = require("./rag-eval-cases");

function summarizeRow(row) {
  return {
    ticketNumber: row.metadata?.ticketNumber || null,
    filename: row.metadata?.filename || null,
    title: row.metadata?.title || null,
    createdDate: row.metadata?.createdDate || null,
    chunkIndex: row.metadata?.chunkIndex || null,
    sourceKind: getRowSourceKind(row),
    excerpt: String(row.document || "").replace(/\s+/g, " ").slice(0, 180)
  };
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function includesAny(value, patterns = []) {
  return patterns.some((pattern) => pattern.test(value));
}

function assertCase(testCase, result) {
  ensure(result.ok, `expected retrieval to succeed, got ${result.reason}`);
  ensure(result.sourceFilter === testCase.expectedSource, `expected sourceFilter=${testCase.expectedSource}, got ${result.sourceFilter}`);
  ensure(result.queryMode === testCase.expectedMode, `expected queryMode=${testCase.expectedMode}, got ${result.queryMode}`);
  ensure(result.rows.length > 0, "expected at least one row");

  const top = summarizeRow(result.rows[0]);
  const renderedTop = `${top.filename}\n${top.title}\n${top.excerpt}`;
  const fullHaystack = result.rows.map((row) => `${row.metadata?.title || ""}\n${row.document || ""}`).join("\n");

  if (testCase.expectedSource === "reference_doc") {
    ensure(top.sourceKind === "reference_doc", `expected top sourceKind=reference_doc, got ${top.sourceKind}`);
    if (testCase.allowedDocPatterns?.length) {
      ensure(
        includesAny(renderedTop, testCase.allowedDocPatterns),
        `expected top doc to match one of ${testCase.allowedDocPatterns.map((item) => item.toString()).join(", ")}, got ${JSON.stringify(top)}`
      );
    }
  }

  if (testCase.expectedSource === "ticket_json") {
    ensure(top.sourceKind === "ticket_json", `expected top sourceKind=ticket_json, got ${top.sourceKind}`);
  }

  if (testCase.requiredContentPatterns?.length) {
    ensure(
      includesAny(fullHaystack, testCase.requiredContentPatterns),
      `expected retrieved content to match one of ${testCase.requiredContentPatterns.map((item) => item.toString()).join(", ")}`
    );
  }

  if (testCase.allowedTopTickets?.length) {
    ensure(
      testCase.allowedTopTickets.includes(String(top.ticketNumber)),
      `expected top ticketNumber in [${testCase.allowedTopTickets.join(", ")}], got ${JSON.stringify(top)}`
    );
  }

  if (testCase.forbiddenTopTickets?.length) {
    ensure(
      !testCase.forbiddenTopTickets.includes(String(top.ticketNumber)),
      `top ticketNumber ${top.ticketNumber} is explicitly forbidden for this case`
    );
  }

  if (testCase.explicitTicketNumber) {
    ensure(
      result.explicitTicketNumber === testCase.explicitTicketNumber,
      `expected explicitTicketNumber=${testCase.explicitTicketNumber}, got ${result.explicitTicketNumber}`
    );
  }

  if (testCase.preferredTopTicket) {
    ensure(
      String(top.ticketNumber) === String(testCase.preferredTopTicket),
      `expected top ticketNumber=${testCase.preferredTopTicket}, got ${JSON.stringify(top)}`
    );
  }
}

async function evaluateCase(testCase, instanceId) {
  const result = await retrieveRagRowsForQuery(testCase.prompt, instanceId, "all");
  assertCase(testCase, result);
  return {
    name: testCase.name,
    family: testCase.family,
    topic: testCase.topic,
    description: testCase.description,
    status: "PASS",
    query: testCase.prompt,
    queryMode: result.queryMode,
    sourceFilter: result.sourceFilter,
    topRows: result.rows.slice(0, 3).map(summarizeRow)
  };
}

async function main() {
  const instanceId = process.argv[2] || DEFAULT_VECTOR_INSTANCE_ID;
  const failures = [];
  const results = [];

  for (const testCase of EVAL_CASES) {
    try {
      results.push(await evaluateCase(testCase, instanceId));
    } catch (error) {
      let retrieval;
      try {
        retrieval = await retrieveRagRowsForQuery(testCase.prompt, instanceId, "all");
      } catch (innerError) {
        retrieval = { ok: false, reason: innerError.message, rows: [] };
      }
      failures.push({
        name: testCase.name,
        family: testCase.family,
        topic: testCase.topic,
        description: testCase.description,
        query: testCase.prompt,
        error: error.message,
        queryMode: retrieval.queryMode || null,
        sourceFilter: retrieval.sourceFilter || null,
        topRows: (retrieval.rows || []).slice(0, 5).map(summarizeRow)
      });
    }
  }

  console.log("RAG evaluation results");
  console.log(JSON.stringify({ passed: results.length, failed: failures.length, results, failures }, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("RAG evaluation crashed:", error);
  process.exit(1);
});
