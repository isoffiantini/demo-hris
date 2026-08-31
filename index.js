const express = require("express");
const path = require("path");
const { readData, writeData, nextId } = require("./store");
const flowRouter = require("./integrations/flow");
const { EMPLOYMENT_STATUSES, EMPLOYMENT_STATUS_VALUES, EMPLOYMENT_STATUS_LABELS } = require("./config");

const app = express();
const PORT = process.env.PORT || 3000;

console.log(`[hris] starting - PORT=${PORT} JUNCTION_EVENTS_URL=${process.env.JUNCTION_EVENTS_URL || "https://junctiontraining.avature.net/junction/events/v2/-MSw1QmrDUfibjnwiEOdXY6xo2ODDQqMOtc7WcXW/ (default)"}`);

app.use(
  express.json({
    verify(req, res, buf) {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Avature-Challenge-Code, X-Avature-REST-API-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  if ((req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return next();
  }
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 100000) req.destroy();
  });
  req.on("end", () => {
    req.rawBody = raw;
    next();
  });
});

app.use((req, res, next) => {
  if (!req.body || !Object.keys(req.body).length) {
    const raw = typeof req.rawBody === "string" ? req.rawBody.trim() : "";
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        req.body = JSON.parse(req.rawBody);
        console.log(`[hris] parsed JSON body from raw body (content-type="${req.headers["content-type"] || "(none)"}")`);
      } catch (err) {
        console.warn(`[hris] raw body was not valid JSON: ${req.rawBody.slice(0, 300)}`);
      }
    }
  }
  next();
});

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    const pieces = [
      `[hris] ${req.method} ${req.originalUrl}`,
      `${res.statusCode}`,
      `${Date.now() - started}ms`,
      `ip=${req.ip}`,
      `ct=${req.headers["content-type"] || "(none)"}`,
    ];
    if (req.method === "POST") {
      const parsed = req.body && Object.keys(req.body).length;
      if (parsed) {
        pieces.push(`body=${JSON.stringify(req.body).slice(0, 2000)}`);
      } else {
        pieces.push(`rawBody=${(req.rawBody || "").slice(0, 2000)}`);
      }
    }
    if (Object.keys(req.query || {}).length) pieces.push(`query=${JSON.stringify(req.query)}`);
    console.log(pieces.join(" "));
  });
  next();
});

const JUNCTION_SYNC_URL =
  process.env.JUNCTION_SYNC_URL ||
  "https://junctiontraining.avature.net/junction/endpoint/NKs4quRQCujidlzZadG4RKPlAryAbPinTAJY9bs6/";

const JUNCTION_REHIRE_URL =
  process.env.JUNCTION_REHIRE_URL ||
  "https://junctiontraining.avature.net/junction/endpoint/-AN1TFDhSzXj-OpK_uch0Pf4q27KZ3lddmpWHCTo/";

const JUNCTION_REHIRE_TIMEOUT_MS = Number(process.env.JUNCTION_REHIRE_TIMEOUT_MS || 75000);

async function performSync(operation, res) {
  const started = Date.now();
  try {
    const upstream = await fetch(JUNCTION_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await upstream.text().catch(() => "");
    console.log(
      `[sync] operation=${operation} POST ${JUNCTION_SYNC_URL} -> ${upstream.status} (${Date.now() - started}ms, ${text.length} bytes)`
    );
    res.json({ ok: upstream.ok, status: upstream.status, body: text.slice(0, 2000) });
  } catch (err) {
    console.error(`[sync] operation=${operation} failed: ${err.message}`);
    res.status(502).json({ errors: [`Sync request failed: ${err.message}`] });
  }
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/sync-locations", (req, res) => performSync("sync_locations", res));

app.get("/sync-departments", (req, res) => performSync("sync_departments", res));

app.get("/sync-jobs", (req, res) => performSync("sync_jobs", res));

function rehireFormId(employee) {
  if (!employee) return null;
  const syncId = employee.avatureSyncFormId;
  if (syncId !== undefined && syncId !== null && syncId !== "") return syncId;
  const fallback = employee.hrisFormId;
  if (fallback !== undefined && fallback !== null && fallback !== "") return fallback;
  return null;
}

app.post("/notify-rehire", async (req, res) => {
  const { employee } = req.body || {};
  const started = Date.now();
  const payload = {
    employeeType: "ex employee",
    avatureId: (employee && employee.avaturePersonId) || null,
    notes: (employee && employee.whyExEmployee) || "",
    rehireEligible: !!(employee && employee.rehireEligible),
    date: new Date().toISOString().slice(0, 10),
    applicationId: (employee && employee.applicationId) || null,
    hrisFormId: rehireFormId(employee),
  };
  try {
    const upstream = await fetch(JUNCTION_REHIRE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(JUNCTION_REHIRE_TIMEOUT_MS),
    });
    const text = await upstream.text().catch(() => "");
    console.log(
      `[rehire] POST ${JUNCTION_REHIRE_URL} payload=${JSON.stringify(payload)} -> ${upstream.status} (${Date.now() - started}ms, ${text.length} bytes)`
    );
    res.json({ ok: upstream.ok, status: upstream.status, body: text.slice(0, 2000), payload });
  } catch (err) {
    console.error(`[rehire] POST failed: ${err.message}`);
    res.status(502).json({ errors: [`Rehire notification failed: ${err.message}`] });
  }
});

const CALLBACK_OPERATIONS = new Set(["sync-locations", "sync-departments", "sync-jobs"]);

// Field in the jobs callback payload that carries the HRIS job id, and the record `id` carries the Avature job id.
const JOB_HRIS_ID_FIELD = "schemaField_837_5_35914";

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseFormFields(rawBody) {
  const fields = {};
  if (typeof rawBody !== "string" || !rawBody) return fields;
  const boundaryMatch = rawBody.match(/^--([^\r\n]+)/);
  if (!boundaryMatch) return fields;
  const boundary = boundaryMatch[1];
  const chunks = rawBody.split(`--${boundary}`);
  for (let i = 1; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const header = chunk.match(/\r?\n?Content-Disposition:\s*form-data;\s*name="([^"]+)"[^\r\n]*(?:\r?\n){1,2}/);
    if (!header) continue;
    const name = header[1];
    let value = chunk.slice(header.index + header[0].length).replace(/\r?\n\s*$/, "");
    fields[name] = value;
  }
  return fields;
}

function fieldValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    return String(value.value ?? value.text ?? value.name ?? "");
  }
  return String(value);
}

function collectRecordsWithField(node, fieldKey, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectRecordsWithField(item, fieldKey, out);
    return;
  }
  if (Object.keys(node).some((k) => normalizeKey(k) === normalizeKey(fieldKey))) {
    out.push(node);
    return;
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === "object") collectRecordsWithField(value, fieldKey, out);
  }
}

function applyJobAvatureIds(body) {
  const records = [];
  collectRecordsWithField(body, JOB_HRIS_ID_FIELD, records);
  const data = readData();
  let updated = 0;
  const errors = [];
  for (const record of records) {
    const hrisJobId = Number(fieldValue(record[JOB_HRIS_ID_FIELD]));
    const avatureId = Number(fieldValue(record.id));
    if (!Number.isFinite(hrisJobId) || hrisJobId <= 0) {
      errors.push(`record ${JSON.stringify(record.id)} has invalid ${JOB_HRIS_ID_FIELD}`);
      continue;
    }
    if (!Number.isFinite(avatureId) || avatureId <= 0) {
      errors.push(`jobId=${hrisJobId} has no Avature id`);
      continue;
    }
    const job = data.jobs.find((j) => j.id === hrisJobId);
    if (!job) {
      errors.push(`jobId=${hrisJobId} not found in HRIS`);
      continue;
    }
    job.avatureId = avatureId;
    updated += 1;
    console.log(`[callback] sync-jobs map jobId=${hrisJobId} <- avatureId=${avatureId}`);
  }
  if (updated) writeData(data);
  console.log(`[callback] sync-jobs recordsWithHrisIdField=${records.length} updated=${updated} errors=${errors.length}`);
  return { updated, errors };
}

app.all("/callback/:operation", async (req, res) => {
  const operation = req.params.operation;
  if (!CALLBACK_OPERATIONS.has(operation)) {
    return res.status(404).json({ error: `Unknown callback operation '${operation}'` });
  }
  const receivedAt = new Date().toISOString();
  const bodyPreview = JSON.stringify(req.body || {}).slice(0, 2000);
  console.log(
    `[callback] ${req.method} /callback/${operation} at=${receivedAt} query=${JSON.stringify(req.query)} body=${bodyPreview}`
  );
  if (operation === "sync-jobs") {
    const rawBody = typeof req.rawBody === "string" ? req.rawBody : "";
    console.log(
      `[callback] sync-jobs debug ct="${req.headers["content-type"] || "(none)"}" rawBody=${rawBody.slice(0, 10000)} parsedBody=${bodyPreview.slice(0, 10000)}`
    );
  }
  const response = { ok: true, operation, method: req.method, receivedAt };
  if (operation === "sync-jobs") {
    try {
      const ct = req.headers["content-type"] || "";
      let processBody = req.body || {};
      if (ct.toLowerCase().startsWith("multipart/form-data") && typeof req.rawBody === "string") {
        const fields = parseFormFields(req.rawBody);
        if (fields.entityProperties) {
          try {
            processBody = JSON.parse(fields.entityProperties);
          } catch (err) {
            response.ok = false;
            response.errors = [`entityProperties is not valid JSON: ${err.message}`];
          }
        } else {
          processBody = {};
        }
      }
      const result = applyJobAvatureIds(processBody);
      response.updated = result.updated;
      if (result.errors.length) response.errors = result.errors;
      if (result.updated)
        console.log(`[callback] sync-jobs updated ${result.updated} job(s) with Avature ids`);
    } catch (err) {
      console.error(`[callback] sync-jobs processing failed: ${err.message}`);
      response.ok = false;
      response.errors = [err.message];
    }
  }
  res.json(response);
});

app.use(flowRouter);

app.get("/config", (req, res) => {
  res.json({
    employmentStatuses: EMPLOYMENT_STATUSES.map((s) => ({ value: s.value, label: s.label })),
  });
});

const JOB_STATUSES = ["open", "closed"];
const EMPLOYMENT_TYPES = ["Remote", "On-site"];

function checkRequiredAndEmpty(required, body, partial) {
  const errors = [];
  for (const field of required) {
    if (!partial && !(field in body)) {
      errors.push(`${field} is required`);
    } else if (body[field] !== undefined && (body[field] === "" || body[field] === null)) {
      errors.push(`${field} cannot be empty`);
    }
  }
  return errors;
}

function validateEmployee(body, partial) {
  const errors = checkRequiredAndEmpty(["firstName", "lastName", "email", "phoneNumber", "jobId"], body, partial);
  if (body.jobId !== undefined && !Number.isInteger(body.jobId)) {
    errors.push("jobId must be a positive integer");
  }
  if (!partial && body.employmentStatus === undefined) {
    errors.push("employmentStatus is required");
  }
  if (body.employmentStatus !== undefined && !EMPLOYMENT_STATUS_VALUES.includes(body.employmentStatus)) {
    errors.push(`employmentStatus must be one of: ${EMPLOYMENT_STATUS_VALUES.join(", ")}`);
  }
  if (!partial && body.hireDate === undefined) {
    errors.push("hireDate is required");
  }
  if (body.hireDate !== undefined && Number.isNaN(Date.parse(body.hireDate))) {
    errors.push("hireDate must be a valid date");
  }
  if (
    body.department !== undefined &&
    body.department !== null &&
    String(body.department).trim() === ""
  ) {
    errors.push("department cannot be empty");
  }
  if (
    body.whyExEmployee !== undefined &&
    body.whyExEmployee !== null &&
    String(body.whyExEmployee).trim() === ""
  ) {
    errors.push("whyExEmployee cannot be empty");
  }
  if (
    body.rehireEligible !== undefined &&
    body.rehireEligible !== null &&
    typeof body.rehireEligible !== "boolean"
  ) {
    errors.push("rehireEligible must be a boolean");
  }
  if (
    body.avaturePersonId !== undefined &&
    body.avaturePersonId !== null &&
    body.avaturePersonId !== ""
  ) {
    const ap = Number(body.avaturePersonId);
    if (!Number.isInteger(ap) || ap <= 0) {
      errors.push("avaturePersonId must be a positive integer");
    }
  }
  return errors;
}

function normalizeEmployeeInput(body) {
  let out = body;
  if ("whyExEmployee" in out) {
    const v = out.whyExEmployee;
    out = { ...out, whyExEmployee: v === undefined || v === null || v === "" ? null : String(v).trim() };
  }
  if ("rehireEligible" in out) {
    const v = out.rehireEligible;
    out = { ...out, rehireEligible: v === undefined || v === null ? false : !!v };
  }
  if ("avaturePersonId" in out) {
    const v = out.avaturePersonId;
    out = {
      ...out,
      avaturePersonId: v === undefined || v === null || v === "" ? null : Number(v),
    };
  }
  return out;
}

function validateJob(body, partial) {
  const errors = checkRequiredAndEmpty(["name", "description", "departmentId", "status", "employmentType", "locationId"], body, partial);
  if (body.status !== undefined && !JOB_STATUSES.includes(body.status)) {
    errors.push("status must be either 'open' or 'closed'");
  }
  if (body.employmentType !== undefined && !EMPLOYMENT_TYPES.includes(body.employmentType)) {
    errors.push("employmentType must be either 'Remote' or 'On-site'");
  }
  if (body.departmentId !== undefined && !Number.isInteger(body.departmentId)) {
    errors.push("departmentId must be a positive integer");
  }
  if (body.locationId !== undefined && !Number.isInteger(body.locationId)) {
    errors.push("locationId must be a positive integer");
  }
  if (
    body.avatureId !== undefined &&
    body.avatureId !== null &&
    body.avatureId !== ""
  ) {
    const av = Number(body.avatureId);
    if (!Number.isInteger(av) || av <= 0) {
      errors.push("avatureId must be a positive integer");
    }
  }
  return errors;
}

function normalizeJobInput(body) {
  if (!("avatureId" in body)) return body;
  const value = body.avatureId;
  if (value === undefined || value === null || value === "") return { ...body, avatureId: null };
  return { ...body, avatureId: Number(value) };
}

function validateDepartment(body, partial) {
  const errors = checkRequiredAndEmpty(["name"], body, partial);
  return errors;
}

function validateLocation(body, partial) {
  const errors = checkRequiredAndEmpty(["country", "state"], body, partial);
  return errors;
}

function handleErrors(errors, res) {
  if (errors.length) {
    res.status(400).json({ errors });
    return true;
  }
  return false;
}

function getEntity(collectionName, id) {
  const data = readData();
  const entity = data[collectionName].find((item) => item.id === Number(id));
  return { data, entity };
}

function applyPartial(existing, body) {
  return { ...existing, ...body };
}

function encodeCursor(id) {
  return Buffer.from(String(id)).toString("base64");
}

function decodeCursor(cursor) {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const num = Number(decoded);
    return Number.isFinite(num) ? num : null;
  } catch (e) {
    return null;
  }
}

function requestUrl(req) {
  const scheme = String(req.headers["x-forwarded-proto"] || req.protocol || "http")
    .split(",")[0]
    .trim();
  const host = req.get("host") || "";
  return new URL(req.originalUrl, `${scheme}://${host}`);
}

function paginateCursor(list, req, sortFn) {
  const pageSizeRaw = Number(req.query.pageSize);
  const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0
    ? Math.min(pageSizeRaw, 100)
    : 10;

  const sorted = sortFn ? [...list].sort(sortFn) : [...list].sort((a, b) => a.id - b.id);

  let startIndex = 0;
  if (req.query.cursor) {
    const cursorId = decodeCursor(req.query.cursor);
    if (cursorId !== null) {
      if (sortFn) {
        startIndex = Number.isInteger(cursorId) && cursorId >= 0 ? cursorId : sorted.length;
      } else {
        const i = sorted.findIndex((item) => item.id > cursorId);
        startIndex = i === -1 ? sorted.length : i;
      }
    }
  }

  const page = sorted.slice(startIndex, startIndex + pageSize);
  const hasMore = startIndex + page.length < sorted.length;
  const nextCursor = hasMore
    ? encodeCursor(sortFn ? startIndex + page.length : page[page.length - 1].id)
    : null;

  const selfUrl = requestUrl(req);
  const nextUrl = new URL(selfUrl.toString());
  if (nextCursor) nextUrl.searchParams.set("cursor", nextCursor);

  return {
    data: page,
    pageSize,
    next: nextCursor ? { cursor: nextCursor } : null,
    links: {
      self: selfUrl.toString(),
      next: nextCursor ? nextUrl.toString() : null,
    },
  };
}

function sortByHireDate(order) {
  const dir = String(order || "asc").toLowerCase() === "desc" ? -1 : 1;
  return (a, b) => {
    const da = Date.parse(a.hireDate || "");
    const db = Date.parse(b.hireDate || "");
    const fa = Number.isFinite(da);
    const fb = Number.isFinite(db);
    if (!fa && !fb) return a.id - b.id;
    if (!fa) return 1;
    if (!fb) return -1;
    if (da !== db) return (da - db) * dir;
    return a.id - b.id;
  };
}

function jobDepartment(job) {
  const data = readData();
  const dept = data.departments.find((d) => d.id === job.departmentId);
  return dept ? dept.name : null;
}

function serializeJob(job) {
  const data = readData();
  const dept = data.departments.find((d) => d.id === job.departmentId) || null;
  const loc = data.locations.find((l) => l.id === job.locationId) || null;
  const { departmentId, ...rest } = job;
  return {
    ...rest,
    department: dept ? { id: dept.id, name: dept.name } : null,
    location: loc ? { country: loc.country, state: loc.state } : null,
  };
}

// ---------- employees ----------

app.get("/employees", (req, res) => {
  const { data } = getEntity("employees");
  let list = data.employees;
  if (req.query.jobId !== undefined) {
    const jobId = Number(req.query.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ errors: ["jobId must be a positive integer"] });
    }
    list = list.filter((e) => e.jobId === jobId);
  }
  if (req.query.firstName !== undefined) {
    const name = String(req.query.firstName).trim().toLowerCase();
    if (name) {
      list = list.filter((e) =>
        String(e.firstName || "").toLowerCase().includes(name)
      );
    }
  }
  if (req.query.employmentStatus !== undefined) {
    const status = String(req.query.employmentStatus).trim();
    if (status && !EMPLOYMENT_STATUS_VALUES.includes(status)) {
      return res.status(400).json({ errors: [`employmentStatus must be one of: ${EMPLOYMENT_STATUS_VALUES.join(", ")}`] });
    }
    if (status) {
      list = list.filter((e) => e.employmentStatus === status);
    }
  }
  let sortFn = null;
  if (req.query.sort !== undefined) {
    if (String(req.query.sort) !== "hireDate") {
      return res.status(400).json({ errors: ["sort must be 'hireDate'"] });
    }
    sortFn = sortByHireDate(req.query.order);
  }
  res.json(paginateCursor(list, req, sortFn));
});

app.get("/employees/:id", (req, res) => {
  const { entity } = getEntity("employees", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Employee not found" });
  }
  res.json(entity);
});

app.post("/employees", (req, res) => {
  const body = normalizeEmployeeInput(req.body);
  if (handleErrors(validateEmployee(body, false), res)) return;
  const data = readData();
  const job = data.jobs.find((j) => j.id === body.jobId);
  if (!job) {
    return res.status(400).json({ errors: ["jobId references a job that does not exist"] });
  }
  const department = jobDepartment(job);
  if (body.department !== undefined && body.department !== department) {
    return res.status(400).json({ errors: ["department must match the department of the assigned job"] });
  }
  const employee = { id: nextId(data.employees), ...body, department };
  data.employees.push(employee);
  writeData(data);
  res.status(201).json(employee);
});

app.patch("/employees/:id", (req, res) => {
  const body = normalizeEmployeeInput(req.body);
  if (handleErrors(validateEmployee(body, true), res)) return;
  const { data, entity } = getEntity("employees", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Employee not found" });
  }
  const jobId = body.jobId !== undefined ? body.jobId : entity.jobId;
  const job = data.jobs.find((j) => j.id === jobId);
  if (!job) {
    return res.status(400).json({ errors: ["jobId references a job that does not exist"] });
  }
  const department = jobDepartment(job);
  if (body.department !== undefined && body.department !== department) {
    return res.status(400).json({ errors: ["department must match the department of the assigned job"] });
  }
  const updated = { ...applyPartial(entity, body), department };
  data.employees = data.employees.map((item) => (item.id === updated.id ? updated : item));
  writeData(data);
  res.json(updated);
});

app.delete("/employees/:id", (req, res) => {
  const { data, entity } = getEntity("employees", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Employee not found" });
  }
  data.employees = data.employees.filter((item) => item.id !== entity.id);
  writeData(data);
  res.status(204).end();
});

// ---------- jobs ----------

app.get("/jobs", (req, res) => {
  const { data } = getEntity("jobs");
  let jobs = data.jobs.map(serializeJob);
  if (req.query.status !== undefined) {
    const status = String(req.query.status).trim();
    if (status && !JOB_STATUSES.includes(status)) {
      return res.status(400).json({ errors: ["status must be 'open' or 'closed'"] });
    }
    if (status) {
      jobs = jobs.filter((j) => j.status === status);
    }
  }
  if (req.query.open !== undefined) {
    const open = String(req.query.open).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(open)) {
      jobs = jobs.filter((j) => j.status === "open");
    } else if (["0", "false", "no", "off"].includes(open)) {
      jobs = jobs.filter((j) => j.status === "closed");
    } else {
      return res.status(400).json({ errors: ["open must be 'true' or 'false'"] });
    }
  }
  res.json(paginateCursor(jobs, req));
});

app.get("/jobs/:id", (req, res) => {
  const { entity } = getEntity("jobs", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(serializeJob(entity));
});

app.post("/jobs", (req, res) => {
  if (handleErrors(validateJob(req.body, false), res)) return;
  const data = readData();
  const dept = data.departments.find((d) => d.id === req.body.departmentId);
  if (!dept) {
    return res.status(400).json({ errors: ["departmentId references a department that does not exist"] });
  }
  const loc = data.locations.find((l) => l.id === req.body.locationId);
  if (!loc) {
    return res.status(400).json({ errors: ["locationId references a location that does not exist"] });
  }
  const job = { id: nextId(data.jobs), ...normalizeJobInput(req.body) };
  data.jobs.push(job);
  writeData(data);
  res.status(201).json(serializeJob(job));
});

app.patch("/jobs/:id", (req, res) => {
  if (handleErrors(validateJob(req.body, true), res)) return;
  const { data, entity } = getEntity("jobs", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Job not found" });
  }
  const departmentId = req.body.departmentId !== undefined ? req.body.departmentId : entity.departmentId;
  if (!data.departments.find((d) => d.id === departmentId)) {
    return res.status(400).json({ errors: ["departmentId references a department that does not exist"] });
  }
  const locationId = req.body.locationId !== undefined ? req.body.locationId : entity.locationId;
  if (!data.locations.find((l) => l.id === locationId)) {
    return res.status(400).json({ errors: ["locationId references a location that does not exist"] });
  }
  const updated = applyPartial(entity, normalizeJobInput(req.body));
  data.jobs = data.jobs.map((item) => (item.id === updated.id ? updated : item));
  writeData(data);
  res.json(serializeJob(updated));
});

app.delete("/jobs/:id", (req, res) => {
  const { data, entity } = getEntity("jobs", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Job not found" });
  }
  data.jobs = data.jobs.filter((item) => item.id !== entity.id);
  writeData(data);
  res.status(204).end();
});

// ---------- departments ----------

app.get("/departments", (req, res) => {
  const { data } = getEntity("departments");
  res.json(paginateCursor(data.departments, req));
});

app.get("/departments/:id", (req, res) => {
  const { entity } = getEntity("departments", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Department not found" });
  }
  res.json(entity);
});

app.post("/departments", (req, res) => {
  if (handleErrors(validateDepartment(req.body, false), res)) return;
  const data = readData();
  if (data.departments.some((d) => d.name.toLowerCase() === req.body.name.toLowerCase())) {
    return res.status(400).json({ errors: ["A department with that name already exists"] });
  }
  const department = { id: nextId(data.departments), name: req.body.name, description: req.body.description || "" };
  data.departments.push(department);
  writeData(data);
  res.status(201).json(department);
});

app.patch("/departments/:id", (req, res) => {
  if (handleErrors(validateDepartment(req.body, true), res)) return;
  const { data, entity } = getEntity("departments", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Department not found" });
  }
  const updated = applyPartial(entity, req.body);
  data.departments = data.departments.map((item) => (item.id === updated.id ? updated : item));
  writeData(data);
  res.json(updated);
});

app.delete("/departments/:id", (req, res) => {
  const { data, entity } = getEntity("departments", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Department not found" });
  }
  if (data.jobs.some((j) => j.departmentId === entity.id)) {
    return res.status(400).json({ errors: ["Department is assigned to one or more jobs and cannot be deleted"] });
  }
  data.departments = data.departments.filter((item) => item.id !== entity.id);
  writeData(data);
  res.status(204).end();
});

// ---------- locations ----------

app.get("/locations", (req, res) => {
  const { data } = getEntity("locations");
  res.json(paginateCursor(data.locations, req));
});

app.get("/locations/:id", (req, res) => {
  const { entity } = getEntity("locations", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Location not found" });
  }
  res.json(entity);
});

app.post("/locations", (req, res) => {
  if (handleErrors(validateLocation(req.body, false), res)) return;
  const data = readData();
  const location = { id: nextId(data.locations), ...req.body };
  data.locations.push(location);
  writeData(data);
  res.status(201).json(location);
});

app.patch("/locations/:id", (req, res) => {
  if (handleErrors(validateLocation(req.body, true), res)) return;
  const { data, entity } = getEntity("locations", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Location not found" });
  }
  const updated = applyPartial(entity, req.body);
  data.locations = data.locations.map((item) => (item.id === updated.id ? updated : item));
  writeData(data);
  res.json(updated);
});

app.delete("/locations/:id", (req, res) => {
  const { data, entity } = getEntity("locations", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Location not found" });
  }
  if (data.jobs.some((j) => j.locationId === entity.id)) {
    return res.status(400).json({ errors: ["Location is assigned to one or more jobs and cannot be deleted"] });
  }
  data.locations = data.locations.filter((item) => item.id !== entity.id);
  writeData(data);
  res.status(204).end();
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`[hris] listening on http://localhost:${PORT}`);
});