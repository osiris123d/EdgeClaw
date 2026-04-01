# Cloudflare Agent Prototype — API Reference

## Overview

The agent system exposes a single REST endpoint for request processing. All requests are authenticated at the Cloudflare edge (add authentication via Wrangler routes + API tokens as your deployment scales).

## Request Endpoint

```
POST /
Content-Type: application/json
```

## Request Schema

```json
{
  "id": "req-12345",
  "type": "analyze|draft|audit|generic",
  "userId": "user-abc",
  "timestamp": 1709251200000,
  "data": "string or object",
  "context": {
    "analysis": "...",
    "format": "markdown",
    "content": "...",
    "contentType": "text|json|html"
  },
  "metadata": {
    "source": "api|web|mobile",
    "correlationId": "corr-xyz",
    "priority": "low|normal|high",
    "timeout": 30000
  }
}
```

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique request identifier |
| `type` | enum | No | Request type hint for dispatcher (default: `generic`) |
| `userId` | string | Yes | User making the request |
| `timestamp` | number | No | Request timestamp (epoch ms) |
| `data` | string\|object | No | Primary input data for processing |
| `context` | object | No | Additional context (varies by agent type) |
| `metadata` | object | No | Request metadata (source, priority, etc.) |

## Response Schema

### Success Response (200)

```json
{
  "success": true,
  "requestId": "req-12345",
  "agentChain": ["dispatcher", "analyst", "audit"],
  "result": { ... },
  "audit": {
    "approved": true,
    "score": 0.95,
    "feedback": "APPROVED ✓ (No issues detected)"
  },
  "artifactKey": "artifacts/req-12345/1709251234567.json"
}
```

### Error Response

#### Audit Rejection (200)

```json
{
  "success": false,
  "approved": false,
  "auditFeedback": "REJECTED ✗ (2 risk(s) found)",
  "risks": [
    {
      "level": "high",
      "category": "safety",
      "description": "Content contains destructive operations",
      "recommendation": "Review content for unintended side effects"
    }
  ]
}
```

#### Execution Error (500)

```json
{
  "success": false,
  "error": {
    "code": "ANALYSIS_FAILED",
    "message": "AI Gateway request timed out"
  }
}
```

## Example Request/Response

### Request: Analyze Data

```json
POST /
{
  "id": "analyze-001",
  "type": "analyze",
  "userId": "user-001",
  "data": "Sales increased 25% QoQ. Customer satisfaction up 10%. Churn rate stable at 2%.",
  "metadata": {
    "source": "api",
    "priority": "normal"
  }
}
```

### Response

```json
{
  "success": true,
  "requestId": "analyze-001",
  "agentChain": ["dispatcher", "analyst", "audit"],
  "result": {
    "findings": [
      "Strong revenue growth with positive customer sentiment",
      "Stable churn suggests retention strategies are working"
    ],
    "patterns": ["Alignment between satisfaction and revenue"],
    "recommendations": [
      "Continue current customer engagement approach",
      "Investigate satisfaction drivers for scale"
    ],
    "risks": []
  },
  "audit": {
    "approved": true,
    "score": 0.98,
    "feedback": "APPROVED ✓ (No issues detected)"
  },
  "artifactKey": "artifacts/analyze-001/1709251234567.json"
}
```

---

### Request: Draft Summary

```json
POST /
{
  "id": "draft-001",
  "type": "draft",
  "userId": "user-001",
  "context": {
    "analysis": {
      "findings": ["Key finding 1", "Key finding 2"],
      "recommendations": ["Recommendation 1"]
    },
    "format": "markdown"
  }
}
```

### Response

```json
{
  "success": true,
  "requestId": "draft-001",
  "agentChain": ["dispatcher", "drafting", "audit"],
  "result": "# Analysis Report\n\n**Generated:** 2025-03-31T...",
  "audit": {
    "approved": true,
    "score": 0.92,
    "feedback": "APPROVED ✓ (1 low-risk issue, suitable for release)"
  },
  "artifactKey": "artifacts/draft-001/1709251234567.json"
}
```

---

## Agent Types & Behavior

### Dispatcher

**Auto-triggered for all requests.**

- Classifies incoming request intent
- Routes to appropriate specialized agent
- Uses keyword analysis (Phase 1) or LLM classification (Phase 3+)

**Output:**
```json
{
  "targetAgent": "analyst|drafting|audit",
  "confidence": 0.85,
  "reason": "Classified as analyst with 85% confidence"
}
```

### Analyst

**Route:** Automatically triggered when request intent suggests data analysis.

- Reads and parses input data
- Calls AI Gateway for LLM-powered analysis
- Returns structured findings, patterns, recommendations

**Inputs:**
- `data` (string or object): Data to analyze

**Outputs:**
```json
{
  "findings": [...],
  "patterns": [...],
  "recommendations": [...],
  "risks": [...]
}
```

### Drafting

**Route:** Triggered when request suggests document/report generation.

- Formats analysis results into human-readable output
- Supports formats: `markdown`, `html`, `plaintext`, `json`

**Inputs:**
- `analysis` (object): Analysis results from Analyst
- `format` (string): Output format (default: `markdown`)

**Outputs:** Formatted string (or object if format is `json`)

### Audit

**Auto-triggered after every agent execution.**

- Validates outputs for accuracy, safety, compliance
- Flags risks and issues
- Approves or rejects execution result

**Inputs:**
- `content` (string or object): Content to audit
- `contentType` (string): Type of content being audited

**Outputs:**
```json
{
  "approved": true,
  "risks": [],
  "score": 0.98,
  "feedback": "APPROVED ✓ (No issues detected)"
}
```

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Request processed (check `success` field in response) |
| 400 | Invalid request format |
| 405 | Method not allowed (only POST) |
| 500 | Server error during agent execution |

## Rate Limiting

Currently no built-in rate limiting (Phase 3 will add per-user limits via Durable Objects).

## Authentication

Authentication layer to be added at Cloudflare edge via:
- Wrangler route patterns
- Custom middleware
- Cloudflare Access (recommended for production)

---

## Usage Examples

### cURL

```bash
# Analyze data
curl -X POST https://your-agent.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-001",
    "userId": "user-001",
    "type": "analyze",
    "data": "Monthly revenue: $100k. Growth: 15% YoY."
  }'

# Draft summary (requires prior analysis output)
curl -X POST https://your-agent.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-002",
    "userId": "user-001",
    "type": "draft",
    "context": {
      "analysis": {"findings": ["Strong growth"], "recommendations": []},
      "format": "markdown"
    }
  }'
```

### JavaScript/Fetch

```javascript
const response = await fetch('https://your-agent.workers.dev/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: 'req-' + Date.now(),
    userId: 'user-001',
    type: 'analyze',
    data: 'Insert data here...'
  })
});

const result = await response.json();
console.log(result);
```

---

## Future API Expansions

- **Batch processing:** Submit multiple requests atomically
- **Webhook callbacks:** Long-running tasks notify client when complete
- **Streaming responses:** Real-time agent progress updates
- **Custom agent composition:** User-defined agent chains
- **Context persistence:** Load/save conversation state across requests

