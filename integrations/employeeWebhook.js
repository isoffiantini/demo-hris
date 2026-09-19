const express = require("express");
const { readData, writeData } = require("../store");
const { resolveTrackingCode, utcDateTime } = require("./executionHistory");
const { patchFormAt, getEmployeeSyncForm, getAvatureRecordNames } = require("./hrisSync");

const router = express.Router();
const HRIS_BASE_URL = process.env.HRIS_BASE_URL || "https://moccasin-cattle-483922.hostingersite.com";

function employeeUrl(req, id) {
  return `${HRIS_BASE_URL}/#/people/${id}`;
}

async function handleWebhookEvent(req, avatureId) {
  const sync = await getEmployeeSyncForm(avatureId);
  if (!sync.form) return { action: "not-synced", detail: "no hris_employee_sync form found" };
  if (!sync.hrisExternalId) return { action: "skipped", detail: "form found but hris_external_id is missing" };

  const names = await getAvatureRecordNames(avatureId);
  if (!names.firstName || !names.lastName) {
    return { action: "skipped", detail: `names missing in Avature (first="${names.firstName}" last="${names.lastName}")` };
  }

  const data = readData();
  const employee = data.employees.find((e) => String(e.id) === String(sync.hrisExternalId));
  if (!employee) {
    return { action: "not-synced", detail: `hris_external_id=${sync.hrisExternalId} does not match any HRIS employee` };
  }
  if (employee.firstName === names.firstName && employee.lastName === names.lastName) {
    return { action: "match", detail: `names unchanged (${names.firstName} ${names.lastName})` };
  }

  employee.firstName = names.firstName;
  employee.lastName = names.lastName;
  writeData(data);

  if (sync.formId) {
    await patchFormAt(avatureId, sync.formId, {
      hrisExternalId: sync.hrisExternalId,
      hrisUrl: employeeUrl(req, employee.id),
      syncDetails: "Success",
      lastSynced: utcDateTime(),
    });
  } else {
    console.warn(`[webhook] record=${avatureId} no formId available; Last Synced not updated`);
  }
  return { action: "updated", detail: `names updated to ${names.firstName} ${names.lastName}` };
}

function formatWebhookResult(result) {
  return `${result.action}${result.detail ? `: ${result.detail}` : ""}`;
}

router.get("/webhook", (req, res) => {
  const challenge = req.get("avature-challenge-code") || req.query["avature-challenge-code"] || req.query.challenge_code || req.query.challenge || "";
  res.json({ "avature-challenge-code": challenge });
});

router.post("/webhook", async (req, res) => {
  const payload = req.body || {};
  const tracking = resolveTrackingCode(req);
  const events = Array.isArray(payload.events) ? payload.events : [];
  console.log(`[webhook] POST events=${events.length} trackingCode="${tracking}"`);
  if (!Object.keys(payload).length) {
    console.warn(`[webhook] POST body could not be parsed as JSON (raw body preview: "${String(req.rawBody || "").slice(0, 500)}")`);
  }
  res.json({ success: true });

  for (const ev of events) {
    const avatureId = ev.record && ev.record.id;
    if (avatureId === undefined || avatureId === null) {
      console.warn("[webhook] event without record.id; skipping");
      continue;
    }
    try {
      console.log(`[webhook] record=${avatureId} -> ${formatWebhookResult(await handleWebhookEvent(req, avatureId))}`);
    } catch (err) {
      console.error(`[webhook] record=${avatureId} -> failed: ${err.message}`);
    }
  }
});

module.exports = router;
