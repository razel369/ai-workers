# Agent Capabilities — AI Workers Platform

AI Workers are **autonomous agents**, not chatbots. Each worker runs a **plan → act → observe → respond** loop (max 5 steps, 45s timeout) with structured tools that produce measurable business outcomes.

## Agent loop

1. **Plan** — LLM reads persona, tasks, knowledge, customer profile, and enabled tools.
2. **Act** — Calls one or more tools (OpenAI-compatible function calling or Anthropic tools).
3. **Observe** — Tool results are fed back into the conversation context.
4. **Respond** — Final Hebrew/English reply to the customer.

Without `LLM_API_KEY`, workers use **mock agent mode**: pattern-based tool execution with a visible tool trace (good for demos and tests).

## Worker modes

| Mode | `agentMode` | Behavior |
|------|-------------|----------|
| Agent | `agent` (default) | Tools enabled, multi-step loop |
| Chat only | `chat` | Text replies only, no tool calls |

Set via Builder UI or `PATCH /api/workers/:id` with `{ "agentMode": "agent" | "chat" }`.

## Built-in tools

| Tool | What it does |
|------|----------------|
| `save_lead` | Saves lead with BANT notes + score 1–10, webhook on `WEBHOOK_NOTIFY_URL` |
| `escalate_to_human` | Creates escalation with priority; notifies Slack/webhook |
| `schedule_callback` | Stores callback in DB + outbox |
| `search_knowledge` | Chunked KB search with confidence score + citations |
| `send_email` | Records to outbox (delivered when email webhook connected) |
| `create_crm_note` | JSON CRM note export |
| `book_meeting_link` | Returns meeting URL from knowledge / `MEETING_BOOKING_URL` |
| `flag_needs_followup` | Proactive follow-up trigger for the business |
| `get_appointment_slots` | Suggests clinic appointment slots (Israel TZ) |
| `export_leads_csv` | CSV export of captured leads |
| `notify_webhook` | Generic JSON webhook event |

List all tools: `GET /api/workers/tools` (authenticated).

## Customer memory

- **Per-customer facts** — `remember_fact` / `recall_facts` (key-value in `customer_memories`)
- **Customer profile** — name, phone, preferences, last intent (`customer_profiles` table)
- Pass `customerId` in chat requests to persist across sessions

## Proactive triggers

After agent sessions with tools, workers can flag `needs_followup` in `followup_triggers`. List via:

`GET /api/workers/:id/followups`

## API endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/workers/:id/chat` | Live chat (`customerId`, optional `testMode`) |
| `POST /api/workers/:id/test-agent` | Simulate customer message without saving history |
| `GET /api/workers/:id/leads` | Captured leads |
| `GET /api/workers/:id/escalations` | Open escalations |
| `GET /api/workers/:id/followups` | Follow-up queue |
| `GET /api/workers/:id/crm-notes` | CRM notes JSON |

Chat response fields: `reply`, `runtime`, `agentMode`, `toolCalls[]`, `agentSteps[]`, `stepsUsed`.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `LLM_API_KEY` | **Yes** for real AI agent loop | Platform LLM key |
| `LLM_PROVIDER` | No | `openai_compatible` (default) or `anthropic` |
| `LLM_MODEL` | No | e.g. `gpt-4o`, `claude-opus-4.8` |
| `LLM_BASE_URL` | No | Custom OpenAI-compatible endpoint |
| `WEBHOOK_NOTIFY_URL` | No | Lead/escalation/follow-up JSON webhooks |
| `SLACK_WEBHOOK_URL` | No | Alias for escalation/lead notifications |
| `MEETING_BOOKING_URL` | No | Default booking link for `book_meeting_link` |
| `EMAIL_WEBHOOK_URL` | No | Outbound email delivery hook |
| `BUSINESS_HOURS` | No | Fallback hours for `check_business_hours` |
| `ADMIN_TOKEN` | Yes (admin) | Mark workers paid, issue keys |

## Israeli vertical templates (upgraded)

### `sales-leads-il`
BANT qualification, lead scoring, `book_meeting_link`, CSV export, webhook on hot leads.

### `support-he`
Chunked KB search, confidence score, auto-escalate below 55%, citations in replies.

### `clinic-receptionist-he`
Appointment slots, urgency triage, medical-safe disclaimers, no medical advice.

## Demo flow (sales-leads-il)

1. Buy template → admin mark paid.
2. Builder: Agent mode ON, tools include `save_lead`, `book_meeting_link`.
3. Test panel: *"שלום, אני דני מחברת Acme, 50 עובדים, מעוניין בפגישה השבוע, טלפון 050-1234567"*
4. Observe tool trace: `save_lead` (score), `book_meeting_link`.
5. Check `GET /api/workers/:id/leads` for persisted lead.

## MCP extensions

Workers can attach MCP servers for additional tools. Local tools above always work without MCP.
