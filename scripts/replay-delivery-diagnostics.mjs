// Read-only historical diagnosis: no Store/ControlPlane construction, no writes,
// no provider calls, no business file inspection, no historical reclassification.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { replayDeliveryDiagnosis } from "../server/delivery.mjs";

const [databasePath, ...ids] = process.argv.slice(2);
if (!databasePath || !ids.length || ids.length > 32) throw new Error("usage: node scripts/replay-delivery-diagnostics.mjs DATABASE TASK_ID [TASK_ID ...] (1-32 tasks)");
const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!row) throw new Error(`task not found: ${id}`);
    const rawEvents = db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id").all(id);
    const events = rawEvents.map(event => ({ id: event.id, stream: event.stream, eventType: event.event_type, payload: JSON.parse(event.payload_json) }));
    const task = { id, agent: row.agent, status: row.status, exitCode: row.exit_code, signal: row.signal, errorText: row.error_text, providerSessionId: row.provider_session_id, eventCursor: row.event_cursor, capabilities: JSON.parse(row.capability_snapshot_json || "{}"), permissionPolicy: JSON.parse(row.permission_policy_json || "{}"), metadata: JSON.parse(row.metadata_json || "{}") };
    const diagnosis = replayDeliveryDiagnosis(task, events, task.metadata.deliveryContract || { type: "final_answer" });
    const answer = diagnosis.providerFinalAnswer;
    console.log(JSON.stringify({
      ...diagnosis,
      providerFinalAnswer: answer ? { source: answer.source, eventType: answer.eventType, length: answer.text.length, sha256: digest(answer.text), evidence: answer.evidence } : null,
      originalRecordSha256: digest({ row, events: rawEvents }), eventCount: events.length,
      providerStarted: events.some(event => event.eventType === "provider_started"),
    }));
  }
} finally { db.close(); }
