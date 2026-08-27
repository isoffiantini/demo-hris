const express = require("express");
const { readData, writeData, nextId } = require("../store");

const router = express.Router();

const JUNCTION_EVENTS_URL =
  process.env.JUNCTION_EVENTS_URL ||
  "https://junctiontraining.avature.net/junction/events/v2/-MSw1QmrDUfibjnwiEOdXY6xo2ODDQqMOtc7WcXW/";
const RECORD_TYPE_EMPLOYEE = 2;

const TRACKING_CODE_HEADERS = [
  "avature-tracking-code",
  "tracking-code",
  "x-tracking-code",
  "x-avature-tracking-code",
];

const RECORD_ID_HEADERS = ["avature-record-id", "x-avature-record-id"];

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

function utcDateTime() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function getHeaderValue(req, names) {
  for (const name of names) {
    const value = req.get(name);
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function resolveTrackingCode(req) {
  const query = req.query || {};
  if (query.externalRef !== undefined && String(query.externalRef).trim() !== "") {
    return String(query.externalRef).trim();
  }
  const fromHeader = getHeaderValue(req, TRACKING_CODE_HEADERS);
  if (fromHeader) return fromHeader;
  const body = req.body || {};
  const props = body.properties || {};
  const candidates = [
    query.trackingCode,
    props.externalRef,
    props.trackingCode,
    props.tracking_code,
    body.externalRef,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      return String(candidate).trim();
    }
  }
  return "";
}

function idFromValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") {
    if (value.id !== undefined && value.id !== null) return idFromValue(value.id);
    return null;
  }
  if (value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : value;
}

function resolveRecordId(req) {
  const body = req.body || {};
  const props = body.properties || {};
  const candidates = [
    body.recordId,
    body.record_id,
    props.recordId,
    props.record_id,
    props.id,
    body.record,
    getHeaderValue(req, RECORD_ID_HEADERS),
  ];
  for (const candidate of candidates) {
    const id = idFromValue(candidate);
    if (id !== null && id !== "") return id;
  }
  return null;
}

async function sendEventLogs(logs) {
  const res = await fetch(JUNCTION_EVENTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logs }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Junction events API responded ${res.status}: ${text}`);
  }
}

function employeeUrl(req, id) {
  return `${req.protocol}://${req.get("host")}/#/people/${id}`;
}

function buildEmployeeLogs(req, employee, upserted) {
  const { record, created } = upserted;
  const trackingCode = resolveTrackingCode(req);
  const resolvedRecordId = resolveRecordId(req);
  const recordId = resolvedRecordId === null || resolvedRecordId === "" ? record.id : resolvedRecordId;
  const url = employeeUrl(req, record.id);

  const first = created
    ? {
        summary: "Employee successfully created in the HRIS.",
        details: `Employee successfully created in the HRIS. You can view the record at ${url}`,
      }
    : {
        summary: "Employee email already exists - record updated.",
        details: `An employee with email ${employee.email} already existed in the HRIS. The corresponding record was updated with the information received. You can view the record at ${url}`,
      };

  return {
    trackingCode,
    logs: [
      {
        trackingCode,
        recordTypeId: RECORD_TYPE_EMPLOYEE,
        recordId,
        summary: first.summary,
        details: first.details,
        status: "INFO",
        dateTime: utcDateTime(),
      },
      {
        trackingCode,
        recordTypeId: RECORD_TYPE_EMPLOYEE,
        recordId,
        summary: "Flow finished successfully.",
        details: "Execution was successful.",
        status: "SUCCESS",
        dateTime: utcDateTime(),
      },
    ],
  };
}

async function postLogsAsync(req, employee, upserted) {
  const { trackingCode, logs } = buildEmployeeLogs(req, employee, upserted);
  if (!trackingCode) {
    console.warn("No tracking code provided; skipping junction event logs.");
    return;
  }
  try {
    await sendEventLogs(logs);
  } catch (err) {
    console.error("Failed to send junction event logs:", err.message);
  }
}

router.get("/flow_create_employee", (req, res) => {
  const challenge = req.get("avature-challenge-code") || "";
  res.json({ "avature-challenge-code": challenge });
});

router.post("/flow_create_employee", async (req, res) => {
  try {
    const employee = toEmployeePayload(req.body);
    const upserted = upsertEmployee(employee);

    const trackingCode = resolveTrackingCode(req);
    if (trackingCode) {
      void postLogsAsync(req, employee, upserted);
    } else {
      console.warn("No tracking code provided; skipping junction event logs.");
    }
  } catch (err) {
    console.error("Flow create employee error:", err);
    const trackingCode = resolveTrackingCode(req);
    if (trackingCode) {
      const resolvedRecordId = resolveRecordId(req);
      const recordId =
        resolvedRecordId === null || resolvedRecordId === ""
          ? null
          : typeof resolvedRecordId === "number"
            ? resolvedRecordId
            : resolvedRecordId;
      const log = {
        trackingCode,
        recordTypeId: RECORD_TYPE_EMPLOYEE,
        recordId,
        summary: "Flow failed.",
        details: `Execution failed: ${err.message || String(err)}`,
        status: "ERROR",
        dateTime: utcDateTime(),
      };
      void (async () => {
        try {
          await sendEventLogs([log]);
        } catch (logErr) {
          console.error("Failed to send junction error log:", logErr.message);
        }
      })();
    }
  }

  respondAsync(res);
});

module.exports = router;