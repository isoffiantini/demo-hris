const express = require("express");
const { readData, writeData, nextId } = require("../store");
const { resolveTrackingCode, resolveRecordId, sendErrorLog, utcDateTime, resolveLogContext, makeLog, sendLogSafe } = require("./junction");
const { attachForm, patchFormAt, getEmployeeSyncForm, getAvatureRecordNames, moveApplicationToStep } = require("./hrisSync");
const { EMPLOYMENT_STATUS_VALUES } = require("../config");

const router = express.Router();

const RECORD_TYPE_EMPLOYEE = 2;
const APPLICATION_STEP_HIRED = 563;

const HRIS_BASE_URL = process.env.HRIS_BASE_URL || "https://moccasin-cattle-483922.hostingersite.com";

function respondAsync(res) {
  res.json({ asyncResponse: { successful: true } });
}

function normalizeNull(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function toEmployeePayload(payload) {
  const props = payload.properties || {};
  return {
    firstName: props.firstName || "",
    lastName: props.lastName || "",
    email: props.email || "",
    phoneNumber: normalizeNull(props.phone),
    jobId: Number(props.job_hris_id),
    employmentStatus: EMPLOYMENT_STATUS_VALUES.includes(props.employmentStatus)
      ? props.employmentStatus
      : EMPLOYMENT_STATUS_VALUES[0],
    hireDate: props.hireDate || new Date().toISOString().slice(0, 10),
    applicationId: normalizeStr(props.application_id) || normalizeStr(props.applicationId),
    hrisFormId: normalizeStr(props.hris_form_id) || normalizeStr(props.hrisFormId),
  };
}

function normalizeStr(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function departmentForJob(data, jobId) {
  const job = data.jobs.find((j) => j.id === Number(jobId));
  if (!job) return "";
  const dept = data.departments.find((d) => d.id === job.departmentId);
  return dept ? dept.name : "";
}

function upsertEmployee(employee, avaturePersonId) {
  const data = readData();
  const email = (employee.email || "").toLowerCase();
  const existing = data.employees.find((e) => (e.email || "").toLowerCase() === email);
  const department = departmentForJob(data, employee.jobId);
  const storedPersonId = avaturePersonId === null || avaturePersonId === undefined || avaturePersonId === ""
    ? null
    : avaturePersonId;

  if (existing) {
    const updated = {
      ...existing,
      ...employee,
      department,
      id: existing.id,
      avaturePersonId: existing.avaturePersonId || storedPersonId,
    };
    data.employees = data.employees.map((e) => (e.id === existing.id ? updated : e));
    writeData(data);
    return { record: updated, created: false };
  }

  const record = { id: nextId(data.employees), ...employee, department, avaturePersonId: storedPersonId };
  data.employees.push(record);
  writeData(data);
  return { record, created: true };
}

function employeeUrl(req, id) {
  return `${HRIS_BASE_URL}/#/people/${id}`;
}

function resolveApplicationId(payload) {
  const props = (payload && payload.properties) || {};
  const candidates = [props.application_id, props.applicationId, payload.application_id];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      return String(candidate).trim();
    }
  }
  return "";
}

function validateFlowInput(employee) {
  const errors = [];
  for (const field of ["firstName", "lastName", "email"]) {
    if (!employee[field] || String(employee[field]).trim() === "") {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function persistSyncFormId(recordId, formId) {
  if (formId === undefined || formId === null || formId === "") return;
  const data = readData();
  const employee = data.employees.find((e) => e.id === recordId);
  if (employee && String(employee.avatureSyncFormId || "") !== String(formId)) {
    data.employees = data.employees.map((e) =>
      e.id === recordId ? { ...e, avatureSyncFormId: formId } : e
    );
    writeData(data);
    console.log(`[hrisSync] Persisted avatureSyncFormId=${formId} on employee ${recordId}`);
  }
}

router.get("/webhook", (req, res) => {
  const challenge =
    req.get("avature-challenge-code") ||
    req.query["avature-challenge-code"] ||
    req.query.challenge_code ||
    req.query.challenge ||
    "";
  res.json({ "avature-challenge-code": challenge });
});

async function handleWebhookEvent(req, avatureId) {
  const sync = await getEmployeeSyncForm(avatureId);
  if (!sync.form) {
    return { action: "not-synced", detail: "no hris_employee_sync form found" };
  }
  if (!sync.hrisExternalId) {
    return { action: "skipped", detail: "form found but hris_external_id is missing" };
  }
  const names = await getAvatureRecordNames(avatureId);
  if (!names.firstName || !names.lastName) {
    return {
      action: "skipped",
      detail: `names missing in Avature (first="${names.firstName}" last="${names.lastName}")`,
    };
  }
  const data = readData();
  const employee = data.employees.find((e) => String(e.id) === String(sync.hrisExternalId));
  if (!employee) {
    return {
      action: "not-synced",
      detail: `hris_external_id=${sync.hrisExternalId} does not match any HRIS employee`,
    };
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

  return {
    action: "updated",
    detail: `names updated to ${names.firstName} ${names.lastName}`,
  };
}

function formatWebhookResult(result) {
  return `${result.action}${result.detail ? `: ${result.detail}` : ""}`;
}

router.post("/webhook", async (req, res) => {
  const payload = req.body || {};
  const tracking = resolveTrackingCode(req);
  const events = Array.isArray(payload.events) ? payload.events : [];
  const bodyKeys = Object.keys(payload);
  console.log(`[webhook] POST events=${events.length} trackingCode="${tracking}"`);

  if (!bodyKeys.length) {
    console.warn(
      `[webhook] POST body could not be parsed as JSON (raw body preview: "${String(req.rawBody || "").slice(0, 500)}")`
    );
  }

  res.json({ success: true });

  for (const ev of events) {
    const avatureId = ev.record && ev.record.id;
    if (avatureId === undefined || avatureId === null) {
      console.warn("[webhook] event without record.id; skipping");
      continue;
    }
    try {
      const result = await handleWebhookEvent(req, avatureId);
      console.log(`[webhook] record=${avatureId} -> ${formatWebhookResult(result)}`);
    } catch (err) {
      console.error(`[webhook] record=${avatureId} -> failed: ${err.message}`);
    }
  }
});

router.get("/flow_create_employee", (req, res) => {
  const challenge = req.get("avature-challenge-code") || "";
  res.json({ "avature-challenge-code": challenge });
});

router.post("/flow_create_employee", async (req, res) => {
  try {
    const employee = toEmployeePayload(req.body);
    const validationErrors = validateFlowInput(employee);
    if (validationErrors.length) {
      console.warn(`[flow_create_employee] Validation failed: ${validationErrors.join(", ")}`);
      void sendErrorLog(req, {
        recordTypeId: RECORD_TYPE_EMPLOYEE,
        message: `Validation failed: ${validationErrors.join(", ")}`,
      });

      const errorPersonId = resolveRecordId(req);
      if (errorPersonId !== null && errorPersonId !== "") {
        void (async () => {
          try {
            await attachForm(errorPersonId, {
              hrisExternalId: "",
              hrisUrl: null,
              syncDetails: `Validation failed: ${validationErrors.join(", ")}`,
              lastSynced: utcDateTime(),
            });
          } catch (err) {
            console.error(`[hrisSync] Failed to attach form on validation error: ${err.message}`);
          }
        })();
      } else {
        console.warn("[hrisSync] No Avature person id; cannot attach form on validation error.");
      }

      return res
        .status(400)
        .json({ asyncResponse: { successful: false, errors: validationErrors } });
    }

    const requestPersonId = resolveRecordId(req);
    const { record, created } = upsertEmployee(employee, requestPersonId);
    const personId = record.avaturePersonId;
    const url = employeeUrl(req, record.id);

    const infoSummary = created
      ? "Employee successfully created in the HRIS."
      : "Employee email already exists - record updated.";
    const infoDetails = created
      ? `Employee successfully created in the HRIS. You can view the record at ${url}`
      : `An employee with email ${employee.email} already existed in the HRIS. The corresponding record was updated with the information received. You can view the record at ${url}`;

    const trackingCode = resolveTrackingCode(req);
    const applicationId = resolveApplicationId(req.body);
    console.log(
      `[flow_create_employee] trackingCode="${trackingCode}" recordIdFromPayload=${JSON.stringify(requestPersonId)} avaturePersonId=${JSON.stringify(personId)} applicationId="${applicationId}" body=${JSON.stringify(req.body || {})}`
    );

    void (async () => {
      const ctx = resolveLogContext(req, record.id);
      if (!ctx.trackingCode) return;

      await sendLogSafe(makeLog(ctx, RECORD_TYPE_EMPLOYEE, infoSummary, infoDetails, "INFO"));

      if (personId === null || personId === "") {
        console.warn(
          "[hrisSync] No Avature person id (recordId) in request; skipping form sync. Full body: " +
            JSON.stringify(req.body || {})
        );
        await sendLogSafe(makeLog(ctx, RECORD_TYPE_EMPLOYEE, "Flow finished successfully.", "Execution was successful.", "SUCCESS"));
        return;
      }

      try {
        const result = await attachForm(personId, {
          hrisExternalId: record.id,
          hrisUrl: employeeUrl(req, record.id),
          syncDetails: "Success",
          lastSynced: utcDateTime(),
        });
        persistSyncFormId(record.id, result.formId);
        if (result.action === "skipped") {
          console.warn(`[hrisSync] Form sync skipped: ${result.reason}`);
          await sendLogSafe(
            makeLog(ctx, RECORD_TYPE_EMPLOYEE, "Flow failed.", `Execution failed: form sync skipped (${result.reason}).`, "ERROR")
          );
          return;
        }
        const actionText = result.action === "created" ? "created" : "updated";
        await sendLogSafe(
          makeLog(
            ctx,
            RECORD_TYPE_EMPLOYEE,
            "Person record synced into Avature.",
            `The person record has been synced into Avature: the sync form attached to the person was ${actionText} successfully.`,
            "INFO"
          )
        );

        if (applicationId) {
          try {
            await moveApplicationToStep(applicationId, APPLICATION_STEP_HIRED);
            await sendLogSafe(
              makeLog(
                ctx,
                RECORD_TYPE_EMPLOYEE,
                "Candidate moved to next workflow step.",
                `The candidate was moved to workflow step ${APPLICATION_STEP_HIRED} (application id ${applicationId}).`,
                "INFO"
              )
            );
          } catch (moveErr) {
            console.error(
              `[flow_create_employee] Failed to move application ${applicationId} to step ${APPLICATION_STEP_HIRED}: ${moveErr.message}`
            );
            await sendLogSafe(
              makeLog(
                ctx,
                RECORD_TYPE_EMPLOYEE,
                "Flow failed.",
                `Execution failed: could not move application ${applicationId} to workflow step ${APPLICATION_STEP_HIRED} (${moveErr.message}).`,
                "ERROR"
              )
            );
            return;
          }
        } else {
          console.warn("[flow_create_employee] No application_id in properties; skipping workflow step update.");
        }

        await sendLogSafe(makeLog(ctx, RECORD_TYPE_EMPLOYEE, "Flow finished successfully.", "Execution was successful.", "SUCCESS"));
      } catch (err) {
        console.error(`[hrisSync] Failed to attach form: ${err.message}`);
        await sendLogSafe(
          makeLog(ctx, RECORD_TYPE_EMPLOYEE, "Flow failed.", `Execution failed: ${err.message}`, "ERROR")
        );
      }
    })();
  } catch (err) {
    console.error("Flow create employee error:", err);
    void sendErrorLog(req, { recordTypeId: RECORD_TYPE_EMPLOYEE, message: err.message || String(err) });
  }

  respondAsync(res);
});

module.exports = router;