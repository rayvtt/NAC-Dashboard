---
description: Turn a client meeting transcript into structured Client Gateway updates (writes the NAC Lead CRM + Partners in Notion; the gateway reflects it on refresh).
argument-hint: paste the meeting transcript (or paste it in the message)
---

# /consult — transcript → Client Gateway

You are updating NAC's **Client Gateway** from a client meeting. The gateway
(`client-gateway.html`) is a **live window into Notion** — it reads the Lead CRM
+ Partners DBs on every login (no cache), so "update the gateway" = **write to
Notion**, and the change shows on the next refresh.

**The transcript** is in `$ARGUMENTS`. If that's empty, use the meeting
transcript / notes pasted in this conversation. If there is no transcript at all,
ask the user to paste one and stop.

**Golden example:** the `Thao Ha` record is the quality bar — a clear bilingual
consult summary, programs shortlisted, budget, next step, access code granted, and
the two touchpoints (consult + access). Reproduce that standard every time.

Auto-apply the changes (don't stage for approval — the user has opted into this),
then report what changed. Only pause to ask if the client's identity is genuinely
ambiguous (two plausible existing rows) or the transcript is too thin to act on.

---

## Notion targets

Use the Notion MCP tools: `notion-search`, `notion-fetch`, `notion-query-data-sources`,
`notion-update-page`, `notion-create-pages`. **Always `notion-fetch` a data source
first** to confirm the current schema/option names before writing (options change).

| DB | Data source id | Role |
|---|---|---|
| **NAC Lead CRM** | `2fe48ec2-5e86-8038-8bad-000b8cf5fd9a` | one row per client — the spine of the gateway |
| **🤝 NAC - Partners** | `0ee45b96-eb49-4a57-9f3f-947a42817ca2` | access code + tools granted (only if you shared materials/Property Hub) |

### How Notion fields surface in the gateway (write for these)

The worker (`worker.js::mapLeadToClient`) derives the gateway view from the Lead
CRM, joined to Partners by client name:

| Gateway element | Comes from |
|---|---|
| Stage / progress (§1–§12) | Lead CRM **Status** → Mới=§1 · Đã liên hệ=§2 · Tiềm năng=§4 · Chốt được=§7 |
| Status + Appetite pills | Lead CRM **Status** |
| Programs in play | Lead CRM **Chương trình quan tâm** → flag chips |
| Budget | Lead CRM **Ngân sách (USD)** |
| Consultation summary | Lead CRM **Ghi chú** |
| Next action | Lead CRM **Timeline** |
| Access code + "Property Hub granted" tool + Access touchpoint | Partners **Access Code** (+ opens/last-access) |
| Consult touchpoint | Lead CRM **Ngày liên hệ** |

So: to advance the journey, set **Status**; to show the shortlist, set **Chương
trình quan tâm**; to show "what's next", set **Timeline**; to show tools + the
second touchpoint, put a code on the Partners row.

---

## Procedure

1. **Identify the client.** `notion-search` the Lead CRM for the person's name (and
   email if spoken). If a row exists → update it. If not → create one. Never
   duplicate; if two plausible rows exist, ask which.

2. **Extract the touchpoint** from the transcript (only what's actually said —
   never invent):
   - Programs discussed / shortlisted; which are front-runners.
   - Budget / ticket size; investment route (real estate vs fund, etc.).
   - Goals + concerns (in their words).
   - Contact details if revealed (email / phone) — capture them; a missing
     contact is a real gap the gateway flags in red.
   - What was agreed as the **next step**, and who owns it.
   - Any **materials or access granted** (Property Hub, brochures, comparison, a
     consult link).
   - Meeting date (default: today, Vietnam time) and format (video / in-person / call).

3. **Update the Lead CRM row** (`notion-update-page`, or `notion-create-pages` under
   the data source above). Set:
   - `Tên khách hàng` (title), `Email` / `Số điện thoại` **if** revealed.
   - `Status` — pick from the outcome: just met / info only → `📞 Đã liên hệ`;
     engaged with a real shortlist + next steps → `🔥 Tiềm năng`; committed → `✅ Chốt được`;
     not a fit → `❌ Không quan tâm`.
   - `Chương trình quan tâm` (multi-select, e.g. `RBI · Malta`, `RBI · Đảo Síp`,
     `RBI · Hy Lạp`) — match existing options exactly.
   - `Ngân sách (USD)` (number), `Region` (e.g. `Châu Âu`), `Nguồn lead` if new.
   - `Ngày liên hệ` = meeting date.
   - `Timeline` = the concrete **next step** (short, imperative — this is the
     gateway's "Next action").
   - `Ghi chú` = the consult summary. **Non-destructive & bilingual (VI primary):**
     prepend a dated block, keep older entries below, and keep the whole field
     **under ~1,800 chars** (the gateway shows the first block, so newest on top).
     Match the Thao Ha voice: what changed for them, the shortlist + why, the
     route, budget, concerns, and `ĐÃ CẤP:` any access granted.

4. **Grant access (only if materials were shared).** Find-or-create the Partners row
   by the same name (data source above):
   - `Partner` (title) + `Contact Name` = client name.
   - `Access Code` — **generate `XXXX-XXXX`** from the alphabet
     `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (excludes 0/O/1/I/L). Reuse the existing
     code if the row already has one — never regenerate.
   - `Call Status` = `✅ Held`, `Call Date` = meeting date, `Stage` = `🔥 Positive`,
     `Appetite` from engagement (`🔥 High` / `🌤 Warm`), `Next Step`, `Next Note`.
   - `Material Sent` (multi): `🏠 Listing PDP`, `📘 Country Brochure`, `📊 Pitch Deck`, …
   - `Wrap Up` = one-line summary. Optionally draft the follow-up email into `Draft`.
   - Link both sides: Lead CRM `Outreach Prospect` ↔ Partners `CRM Lead`.

5. **Idempotency.** Re-running for the same meeting must not duplicate rows or
   re-log the same touchpoint. Update in place; only append a Ghi chú block for a
   genuinely new interaction (new date/content).

---

## Report back

End with a tight summary the user will see when they open the gateway:

- **Client** — name · (new row / updated) · current Status → gateway stage.
- **Logged** — the shortlist, budget, and access code (if any).
- **Next action** — the one thing that's next, and who owns it.
- **Gaps** — anything missing that blocks progress (e.g. "no email/phone on file").

Keep it to a few lines. The gateway is the record; your reply is the receipt.
