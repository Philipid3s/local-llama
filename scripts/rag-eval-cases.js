const DOC_TOPICS = {
  greek_pnl: {
    family: "docs_logic",
    topic: "greek_pnl",
    description: "Greek and PNL calculation logic should come from methodology docs rather than tickets.",
    prompts: [
      "what is the logic for the GREEK calculation in Entrade ?",
      "how is Greek PNL calculated in Entrade?",
      "explain the greek pnl methodology"
    ],
    expectedSource: "reference_doc",
    expectedMode: "precise",
    allowedDocPatterns: [
      /entrade pnl methodology\.docx/i,
      /greek/i,
      /pnl/i
    ]
  },
  pnl_methodology: {
    family: "docs_logic",
    topic: "pnl_methodology",
    description: "General PNL logic questions should prefer the Entrade PNL methodology document.",
    prompts: [
      "what is the PNL logic ?",
      "explain Entrade PNL methodology",
      "how does pnl attribution work in Entrade?"
    ],
    expectedSource: "reference_doc",
    expectedMode: "precise",
    allowedDocPatterns: [
      /entrade pnl methodology\.docx/i,
      /pnl/i,
      /attribution/i
    ]
  },
  custom_deal_formula: {
    family: "docs_logic",
    topic: "custom_deal_formula",
    description: "Custom pricing formula and deal formula prompts should prefer the formula guide.",
    prompts: [
      "how do custom deal formulas work in Entrade?",
      "what is the logic for a custom pricing formula?",
      "how are linked components used in deal modeling?"
    ],
    expectedSource: "reference_doc",
    expectedMode: "precise",
    allowedDocPatterns: [
      /creating a custom deal formula\.docx/i,
      /custom pricing formula/i,
      /linked component/i
    ]
  },
  environment_setup: {
    family: "docs_configuration",
    topic: "environment_setup",
    description: "Installation and setup prompts should route to environment/setup documentation.",
    prompts: [
      "how do I configure Entrade IIS setup?",
      "what are the steps to install Entrade web services?",
      "how do I set up the Entrade environment?"
    ],
    expectedSource: "reference_doc",
    expectedMode: "precise",
    allowedDocPatterns: [
      /entrade environment setup\.docx/i,
      /\biis\b/i,
      /web service/i
    ]
  },
  upgrade_process: {
    family: "docs_operations",
    topic: "upgrade_process",
    description: "Upgrade and rollback prompts should prefer the admin manual.",
    prompts: [
      "how do I upgrade Entrade?",
      "what is the rollback process for an Entrade upgrade?",
      "how do I refresh SIT from pre-prod?"
    ],
    expectedSource: "reference_doc",
    expectedMode: "precise",
    allowedDocPatterns: [
      /entrade admin manual\.pdf/i,
      /upgrade/i,
      /rollback/i,
      /refresh/i
    ]
  }
};

const TICKET_TOPICS = {
  deal_corruption: {
    family: "ticket_data_integrity",
    topic: "deal_corruption",
    description: "Root-cause and corruption prompts should prefer ticket evidence.",
    prompts: [
      "What could be the root causes of deal corruption?",
      "what are common root causes of data corruption in deals?",
      "what do tickets say about corrupted deals?"
    ],
    expectedSource: "ticket_json",
    expectedMode: "summary",
    requiredContentPatterns: [/corrupt/i, /data corruption/i, /deal modeling/i]
  },
  billing_statement: {
    family: "ticket_statements_and_billing",
    topic: "billing_statement",
    description: "Common billing statement issue prompts should summarize ticket patterns.",
    prompts: [
      "What are the most common issues when generating a billing statements ?",
      "summarize common billing statement issues",
      "what do tickets say about billing statement problems?"
    ],
    expectedSource: "ticket_json",
    expectedMode: "summary",
    requiredContentPatterns: [/billing statement/i, /statement/i]
  },
  dsr_report: {
    family: "ticket_reports",
    topic: "dsr_report",
    description: "Latest DSR-related ticket should prefer direct DSR report topics and newest creation date.",
    prompts: [
      "what is the latest ticket related to DSR report ?",
      "latest DSR report ticket",
      "most recent ticket about DSR report",
      "who is the last person who created a ticket about DSR report ?"
    ],
    expectedSource: "ticket_json",
    expectedMode: "precise",
    allowedTopTickets: ["5113", "5052", "4950", "4888"],
    preferredTopTicket: "5113"
  },
  monthend_report: {
    family: "ticket_reports",
    topic: "monthend_report",
    description: "Latest monthend report summaries should prefer direct monthend tickets and avoid parent/meta tickets.",
    prompts: [
      "can you summarize latest tickets about monthend report ?",
      "summarize latest monthend report tickets",
      "what are the latest tickets about month end report?"
    ],
    expectedSource: "ticket_json",
    expectedMode: "summary_recent",
    allowedTopTickets: ["4988", "4924", "4848", "4731", "4527"],
    forbiddenTopTickets: ["5082"],
    preferredTopTicket: "4988"
  },
  ctp_report: {
    family: "ticket_reports",
    topic: "ctp_report",
    description: "CTP report prompts should prefer ticket evidence over docs and surface direct report issues.",
    prompts: [
      "what do you know about CTP report ?",
      "summarize issues related to CTP report",
      "what tickets are about commodity trading position report?"
    ],
    expectedSource: "ticket_json",
    expectedMode: "summary",
    allowedTopTickets: ["5044", "5041", "4716", "4637", "4571", "4492", "4444"]
  },
  exact_ticket_lookup: {
    family: "exact_ticket",
    topic: "exact_ticket_lookup",
    description: "Explicit ticket-number prompts must resolve to the exact ticket only.",
    prompts: [
      "can you summarize ticket 5000 ?",
      "summarize issue 5000",
      "give me details for work item 5000"
    ],
    expectedSource: "ticket_json",
    expectedMode: "precise",
    explicitTicketNumber: "5000",
    preferredTopTicket: "5000"
  }
};

function buildCaseFromTopic(topicConfig) {
  return topicConfig.prompts.map((prompt, index) => ({
    name: `${topicConfig.family}:${topicConfig.topic}:${index + 1}`,
    prompt,
    ...topicConfig
  }));
}

const EVAL_CASES = [
  ...Object.values(DOC_TOPICS).flatMap(buildCaseFromTopic),
  ...Object.values(TICKET_TOPICS).flatMap(buildCaseFromTopic)
];

module.exports = {
  DOC_TOPICS,
  TICKET_TOPICS,
  EVAL_CASES
};
