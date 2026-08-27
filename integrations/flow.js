const express = require("express");
const { readData, writeData, nextId } = require("../store");
const { resolveTrackingCode, resolveRecordId, sendErrorLog, utcDateTime, resolveLogContext, makeLog, sendLogSafe } = require("./junction");
const { attachForm } = require("./hrisSync");

const router = express.Router();

const RECORD_TYPE_EMPLOYEE = 2;

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
    employmentStatus: props.employmentStatus === "Ex Employee" ? "Ex Employee" : "Hired",
    hireDate: props.hireDate || new Date().toISOString().slice(0, 10),
  };
}

function departmentForJob(data, jobId) {
  const job = data.jobs.find((j) => j.id === Number(jobId));
  if (!job) return "";
  const dept = data.departments.find((d) => d.id === job.departmentId);
  return dept ? dept.name : "";
}

function upsertEmployee(employee) {
  const data = readData();
  const email = (employee.email || "").toLowerCase();
  const existing = data.employees.find((e) => (e.email || "").toLowerCase() === email);
  const department = departmentForJob(data, employee.jobId);

  if (existing) {
    const updated = { ...existing, ...employee, department, id: existing.id };
    data.employees = data.employees.map((e) => (e.id === existing.id ? updated : e));
    writeData(data);
    return { record: updated, created: false };
  }

  const record = { id: nextId(data.employees), ...employee, department };
  data.employees.push(record);
  writeData(data);
  return { record, created: true };
}

function employeeUrl(req, id) {
  return `${req.protocol}://${req.get("host")}/#/people/${id}`;
}

router.get("/flow_create_employee", (req, res) => {
  const challenge = req.get("avature-challenge-code") || "";
  res.json({ "avature-challenge-code": challenge });
});

router.post("/flow_create_employee", async (req, res) => {
  try {
    const employee = toEmployeePayload(req.body);
    const { record, created } = upsertEmployee(employee);
    const url = employeeUrl(req, record.id);

    const infoSummary = created
      ? "Employee successfully created in the HRIS."
      : "Employee email already exists - record updated.";
    const infoDetails = created
      ? `Employee successfully created in the HRIS. You can view the record at ${url}`
      : `An employee with email ${employee.email} already existed in the HRIS. The corresponding record was updated with the information received. You can view the record at ${url}`;

    const trackingCode = resolveTrackingCode(req);
    const personId = resolveRecordId(req);
    console.log(
      `[flow_create_employee] trackingCode="${trackingCode}" recordIdFromPayload=${JSON.stringify(personId)} body=${JSON.stringify(req.body || {})}`
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
        const result = await attachForm(personId, record.id, utcDateTime());
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