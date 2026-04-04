# bonsAI - local ollama client

A lightweight, private, and powerful web interface for your local Ollama models. Chat with your favorite AI models, analyze PDF and DOCX documents with OCR support for PDFs, and ground responses with real-time web search from a clean, responsive UI.

---

## Features

### Core Chat Experience
- **Full Model Support**: Seamlessly switch between any models pulled to your local Ollama instance.
- **Real-time Streaming**: Experience token-by-token response generation for a fluid chat experience.
- **Markdown Rendering**: Beautifully rendered responses including code blocks (with syntax highlighting), lists, tables, and links.
- **Thread Management**: Organize conversations into multiple threads with the ability to rename and delete.
- **Local Persistence**: All chat history and document context are stored in your browser's `localStorage` for privacy and speed.

### Document Intelligence
- **Session Documents**: Attach a PDF, DOCX, or JSON file to the active chat and use it as temporary thread-only context.
- **Knowledge Library**: Add a PDF, DOCX, or JSON file permanently to the selected Chroma-backed knowledge base, then query it from any future chat.
- **OCR Fallback**: Built-in OCR support using `Tesseract.js`. If a PDF is scanned or image-heavy, the system automatically falls back to OCR so the AI can read the content.
- **Knowledge-Base Retrieval**: Toggle `KB` to force retrieval from the selected vector instance during chat.

### Web-Search Grounding
- **Brave Search Integration**: Toggle "Web Search" to provide the model with up-to-date information from the internet.
- **Intent Detection**: The system intelligently decides when to search based on your prompt, such as requests for the latest news or current weather.
- **Source Citation**: Encourages the model to cite sources and URLs from the retrieved search results.

---

## Tech Stack

- **Backend**: Node.js (Standard Library)
- **Frontend**: Vanilla JavaScript, CSS3, HTML5
- **AI Core**: [Ollama](https://ollama.com/)
- **Vector Store**: [Chroma](https://www.trychroma.com/)
- **Document Processing**: `mammoth`, `pdf-parse`, `tesseract.js`
- **Web Search**: Brave Search API

---

## Prerequisites

1. **Node.js**: Version 18.x or higher (tested on Node 22+).
2. **Ollama**: Installed and running locally.
3. **Models**: At least one chat model and one embedding model pulled.
   ```bash
   ollama pull qwen2.5
   ollama pull nomic-embed-text
   ```
4. **Chroma**: A local Chroma server running. On Windows x64, Docker is the most reliable option:
   ```bash
   docker run --name bonsai-chroma -p 8000:8000 -v ./chroma-data:/data chromadb/chroma
   ```

---

## Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd bonsai-local-ollama-client
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment**:
   Copy `.env.example` to `.env` and adjust settings:
   ```powershell
   Copy-Item .env.example .env
   ```

   ```bash
   cp .env.example .env
   ```

4. **Start the application**:
   ```bash
   npm start
   ```
   For Windows, you can also use `start.bat`, which checks Chroma first and will try Python or Docker launchers automatically.

5. **Access the UI**:
   Open `http://localhost:<PORT>` in your browser. If you keep the sample `.env`, that will be `http://localhost:3000`.

---

## Deployment Steps

### Local Ollama Setup

Pull one chat model and one embedding model:

```powershell
ollama pull qwen2.5
ollama pull nomic-embed-text
```

Verify the models are available:

```powershell
ollama list
```

### Local Chroma Setup With Docker

The most reliable Windows x64 path is Docker. Start Chroma with:

```powershell
docker run --name bonsai-chroma -p 8000:8000 -v "${PWD}\chroma-data:/data" chromadb/chroma
```

Test that Chroma is reachable:

```powershell
Invoke-WebRequest http://127.0.0.1:8000/api/v2/heartbeat
```

If you want to stop and restart the same container later:

```powershell
docker stop bonsai-chroma
docker start bonsai-chroma
```

If you need to remove and recreate it:

```powershell
docker rm -f bonsai-chroma
docker run --name bonsai-chroma -p 8000:8000 -v "${PWD}\chroma-data:/data" chromadb/chroma
```

### Windows Shortcut

On Windows, [start.bat](D:\Projects\ollama-client\start.bat) will:

- check whether Chroma responds on the configured host/port
- try to start Chroma via Python or Docker when needed
- start the Node app
- open the browser

Typical usage:

```powershell
.\start.bat
```

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | The port the web server listens on. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | The URL where your Ollama instance is running. |
| `OCR_ENABLED` | `true` | Enable or disable OCR fallback for PDF documents. DOCX extraction is text-only. |
| `OCR_LANG` | `eng` | Language code for OCR downloads on first run. |
| `OCR_MAX_PAGES` | `3` | Maximum number of pages to process via OCR per document. |
| `OCR_MIN_TEXT_CHARS` | `80` | Minimum text length before OCR fallback is triggered. |
| `OCR_IMAGE_SCALE` | `2` | Image scaling factor for OCR; higher is better quality and slower. |
| `BRAVE_SEARCH_ENABLED` | `false` | Enable or disable web search capabilities. |
| `BRAVE_SEARCH_API_KEY` | `(none)` | Brave Search API key required for web search. |
| `BRAVE_SEARCH_MAX_RESULTS` | `5` | Number of search results to retrieve. |
| `BRAVE_SEARCH_COUNTRY` | `US` | Country code for search results. |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model used to generate document and query vectors for the knowledge base. |
| `OLLAMA_EMBED_MODEL` | `(fallback alias)` | Backward-compatible alias for `OLLAMA_EMBEDDING_MODEL`. |
| `DEFAULT_VECTOR_INSTANCE_ID` | `default` | Default knowledge-base instance shown in the selector. |
| `CHROMA_HOST` | `127.0.0.1` | Hostname for the local Chroma server. |
| `CHROMA_PORT` | `8000` | Port for the local Chroma server. |
| `CHROMA_SSL` | `false` | Whether to connect to Chroma over HTTPS. |
| `CHROMA_COLLECTION` | `bonsai_documents` | Collection name used for indexed documents. |
| `VECTOR_DB_INSTANCES` | `(empty)` | Optional JSON array of named vector instances for the header selector. If omitted, the single `CHROMA_*` config becomes the default instance. |
| `RAG_CHUNK_SIZE` | `1200` | Approximate chunk size, in characters, for extracted document text splitting. |
| `RAG_CHUNK_OVERLAP` | `180` | Character overlap between adjacent chunks. |
| `RAG_RETRIEVAL_LIMIT` | `4` | Number of retrieved chunks added to each chat request. |
| `RAG_QUERY_CANDIDATE_LIMIT` | `12` | Number of nearest-neighbor candidates fetched before local reranking prefers stronger lexical and ticket-focused matches. |
| `RAG_MAX_CONTEXT_CHARS_PER_EXCERPT` | `1600` | Maximum characters from each retrieved excerpt inserted into the model prompt; long excerpts are compressed to keep both the start and the latest tail content while reducing Ollama/CUDA failures from oversized context. |
| `EMBED_BATCH_SIZE` | `16` | Number of chunks embedded per Ollama batch request. |
| `RAG_UPSERT_BATCH_SIZE` | `5000` | Maximum number of chunk records sent to Chroma in each upsert request during ingestion. |
| `DEVOPS_TICKET_MAX_RECORD_CHARS` | `5000` | For DevOps ticket JSON imports, keep each ticket as one record unless it exceeds this size; larger tickets are split only within that ticket. |

---

## Usage Tips

- **Session Document**: Click `PDF` to attach a PDF, DOCX, or JSON document only to the current chat thread.
- **Permanent Knowledge Base**: Click `Library` to ingest a PDF, DOCX, or JSON document into the selected knowledge base. That data stays in Chroma until you remove/reset it outside the app.
- **DevOps Ticket JSON**: JSON exports with `ticketNumber`, `searchText`, and `searchChunks` are ingested per ticket instead of as one raw JSON blob, so comments stay with the correct ticket.
- **Delete from KB**: Open `Browse` next to the knowledge base selector to inspect indexed files, run a connection test, or delete a document from the selected knowledge base.
- **KB Search**: Toggle `KB` on when you want the model to retrieve from the selected knowledge base for the current prompt.

### Ticket Query Behavior

- **Exact ticket lookup**: Prompts that contain an explicit ticket number such as `summarize ticket 5000` bypass embedding search and use a direct metadata lookup on `ticketNumber` first. This is both faster and more reliable than broad vector retrieval for exact-ID requests.
- **Exact ticket answer constraints**: When an explicit ticket number is found, the system prompt tells the model that the requested ticket was resolved exactly and that it must answer from that ticket's retrieved excerpts only.
- **Latest related ticket lookup**: Prompts such as `what is the latest ticket related to monthend report?` first prefer title and ticket-description relevance to the topic, then choose the newest ticket by `createdDate` among those relevant matches.
- **No-topic safeguard for latest queries**: If a latest-ticket query does not have enough topical evidence for any DevOps ticket, the retrieval layer returns no match instead of substituting the newest unrelated ticket in the knowledge base.
- **Created date rule**: For DevOps ticket JSON, `createdDate` is the ticket creation timestamp. Comment dates are not used to decide the latest ticket.
- **Automatic source preference when `Source=All`**: Logic and methodology prompts such as Greek or PNL calculation questions prefer reference documents first, while ticket-history prompts such as root causes, common issues, latest tickets, report issue summaries, and explicit ticket-number requests prefer ticket JSON first.

### RAG Regression Testing

The repository includes an offline RAG non-regression suite for retrieval and ranking behavior:

```powershell
node --env-file-if-exists=.env scripts/rag-eval.js
```

Equivalent npm command:

```powershell
npm run test:rag
```

What it covers:

- docs-vs-tickets source routing
- exact ticket-number retrieval
- latest related ticket selection
- broad ticket-summary ranking
- representative report topics such as DSR, monthend, CTP, billing, and deal-corruption prompts

Important scope notes:

- `scripts/rag-eval.js` and `scripts/rag-eval-cases.js` are offline evaluation tools only. They are not used by the live chat runtime.
- The case set is representative, not exhaustive. It is a regression gate, not a proof that every possible prompt is correct.

When to run it:

- after every major modification to RAG-related logic
- especially after changes to source routing, query-mode classification, exact ticket lookup, latest-ticket selection, reranking, ticket-topic scoring, prompt context construction, ingestion/chunking, or retrieval candidate logic

Recommended verification flow after major RAG changes:

1. Run `npm test`
2. Run `npm run test:rag`
3. Review and explain any failures before handoff

If a change intentionally alters expected retrieval behavior, update both the relevant eval case and this README so the documented behavior stays aligned with the code.

### Multiple Vector Instances

You can expose multiple Chroma-backed knowledge bases in the header selector with `VECTOR_DB_INSTANCES`:

```json
[
  {
    "id": "contracts",
    "name": "Contracts KB",
    "host": "127.0.0.1",
    "port": 8000,
    "ssl": false,
    "collection": "contracts_docs"
  },
  {
    "id": "hr",
    "name": "HR KB",
    "host": "127.0.0.1",
    "port": 8000,
    "ssl": false,
    "collection": "hr_docs"
  }
]
```
- **Web Search**: Useful for current events or technical documentation released after your model's training cutoff.
- **Storage**: If you hit a storage warning, try deleting older threads or removing large document attachments.

---

## Privacy & Security

- **Data Ownership**: Your chat history stays in your browser.
- **Local AI**: All AI processing happens on your machine via Ollama.
- **Search Privacy**: When web search is enabled, only specific queries are sent to Brave Search; your full conversation history is never shared.

---

## License

This project is open source. Check the license terms if a `LICENSE` file is present.
