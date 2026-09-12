const AVATURE_REST_BASE_URL =
  process.env.AVATURE_REST_BASE_URL ||
  "https://junctiontraining.avature.net";

const AVATURE_REST_API_KEY = process.env.AVATURE_REST_API_KEY || "";

const HRIS_SYNC_FORM_ID = Number(process.env.HRIS_SYNC_FORM_ID || 838);

// Avature record type (entity extension) ids, configurable per environment.
const RECORD_TYPE_EMPLOYEE = Number(process.env.AVATURE_RECORD_TYPE_EMPLOYEE || 2);
const RECORD_TYPE_JOB = Number(process.env.AVATURE_RECORD_TYPE_JOB || 7);
const RECORD_TYPE_DEPARTMENT = Number(process.env.AVATURE_RECORD_TYPE_DEPARTMENT || 9);

function apiKeyHeaders() {
  return {
    "X-Avature-REST-API-Key": AVATURE_REST_API_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function coreFormUrl(avatureId) {
  return `${coreFormBaseUrl(avatureId)}?use_canonical_names=1`;
}

function coreFormBaseUrl(avatureId) {
  return `${AVATURE_REST_BASE_URL}/rest/avature/core/v1/data/records_2/${avatureId}/forms_hris_employee_sync`;
}

function coreRecordUrl(avatureId) {
  return `${AVATURE_REST_BASE_URL}/rest/avature/core/v1/data/records_2/${avatureId}?use_canonical_names=1`;
}

function asList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.results)) return parsed.results;
    if (Array.isArray(parsed.items)) return parsed.items;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (parsed.data && Array.isArray(parsed.data.items)) return parsed.data.items;
    if (parsed.data && Array.isArray(parsed.data.records)) return parsed.data.records;
    if (parsed.pagination && Array.isArray(parsed.pagination.results)) return parsed.pagination.results;
  }
  return [];
}

function firstRecord(parsed) {
  const list = asList(parsed);
  if (list.length) return list[0];
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.id !== undefined && parsed.id !== null) return parsed;
  }
  return undefined;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valueOf(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    if (value.value !== undefined && value.value !== null) return String(value.value);
    if (value.text !== undefined && value.text !== null) return String(value.text);
    if (value.name !== undefined && value.name !== null) return String(value.name);
    return "";
  }
  return String(value);
}

function findFieldValue(source, patterns) {
  if (!source || typeof source !== "object") return undefined;
  const scopes = [source.fields, source.data, source];
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") continue;
    for (const key of Object.keys(scope)) {
      const nk = normalizeKey(key);
      for (const pattern of patterns) {
        if (nk === normalizeKey(pattern)) {
          const value = valueOf(scope[key]);
          if (value) return value;
        }
      }
    }
  }
  return undefined;
}

async function getEmployeeSyncForm(avatureId) {
  if (!AVATURE_REST_API_KEY) {
    console.warn("[hrisSync] AVATURE_REST_API_KEY is not set; cannot check sync form.");
    throw new Error("AVATURE_REST_API_KEY is not set");
  }
const url = coreFormUrl(avatureId);
  const { res, text } = await requestJson(url, { headers: apiKeyHeaders() });
  if (!res.ok) {
    throw new Error(`avature sync form GET failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const parsed = parseJson(text);
  const form = firstRecord(parsed);
  if (!form) {
    console.log(`[hrisSync] No hris_employee_sync form for record ${avatureId}; not synced.`);
    return { form: null, hrisExternalId: null, formId: null };
  }
  const formId = extractFormIdFromItem(form);
  const hrisExternalId = findFieldValue(form, ["hris_external_id", "hrisExternalId", "HRIS External ID"]);
  console.log(`[hrisSync] sync form found formId=${formId} hrisExternalId=${hrisExternalId ?? "(missing)"}`);
  return { form, hrisExternalId: hrisExternalId ?? null, formId: formId === null ? null : formId };
}

async function getAvatureRecordNames(avatureId) {
  if (!AVATURE_REST_API_KEY) {
    console.warn("[hrisSync] AVATURE_REST_API_KEY is not set; cannot fetch record names.");
    throw new Error("AVATURE_REST_API_KEY is not set");
  }
const url = coreRecordUrl(avatureId);
  const { res, text } = await requestJson(url, { headers: apiKeyHeaders() });
  if (!res.ok) {
    throw new Error(`avature record GET failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const record = firstRecord(parseJson(text));
  if (!record) {
    throw new Error(`avature record GET returned no records: ${text.slice(0, 300)}`);
  }
  const firstName = findFieldValue(record, ["first_name", "firstName", "First Name", "firstname"]);
  const lastName = findFieldValue(record, ["last_name", "lastName", "Last Name", "lastname"]);
  console.log(`[hrisSync] record=${avatureId} firstName="${firstName ?? ""}" lastName="${lastName ?? ""}"`);
  return {
    id: record.id !== undefined && record.id !== null ? String(record.id) : String(avatureId),
    firstName: firstName ?? "",
    lastName: lastName ?? "",
  };
}

function formUrl(personId) {
  return `${AVATURE_REST_BASE_URL}/rest/hrisSync/people/${personId}/form_${HRIS_SYNC_FORM_ID}`;
}

function formBody(personId, fields) {
  return {
    personId: Number(personId),
    "HRIS External ID": String(fields.hrisExternalId ?? ""),
    "HRIS URL": fields.hrisUrl || null,
    "Sync Details": String(fields.syncDetails ?? "Success"),
    "Last Synced": String(fields.lastSynced ?? ""),
    "Is Hired?": "Yes",
  };
}

async function requestJson(url, options) {
  const method = (options && options.method) || "GET";
  const res = await fetch(url, options);
  const text = await res.text().catch(() => "");
  console.log(`[hrisSync] ${method} ${url} -> ${res.status} (${text.length} bytes)`);
  return { res, text };
}

function extractFormIdFromItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.id !== undefined && item.id !== null) return item.id;
  if (item.formId !== undefined && item.formId !== null) return item.formId;
  return null;
}

function extractFormId(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const id = extractFormIdFromItem(item);
      if (id !== null) return id;
    }
    return null;
  }
  const direct = extractFormIdFromItem(parsed);
  if (direct !== null) return direct;
  if (Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      const id = extractFormIdFromItem(item);
      if (id !== null) return id;
    }
  }
  return null;
}

async function attachForm(personId, fields) {
  if (!AVATURE_REST_API_KEY) {
    console.warn("[hrisSync] AVATURE_REST_API_KEY is not set; skipping form sync.");
    return { action: "skipped", reason: "missing api key" };
  }

  const baseUrl = formUrl(personId);
  const body = formBody(personId, fields);

  const get = await requestJson(baseUrl, { headers: apiKeyHeaders() });
  if (!get.res.ok) {
    throw new Error(`hrisSync GET failed: ${get.res.status} ${get.text}`);
  }

  const getJson = parseJson(get.text);
  const items = getJson && Array.isArray(getJson.items) ? getJson.items : [];

  if (!items.length) {
    console.log("[hrisSync] No form exists (empty items); creating it");
    const post = await requestJson(baseUrl, {
      method: "POST",
      headers: apiKeyHeaders(),
      body: JSON.stringify(body),
    });
    if (!post.res.ok) {
      throw new Error(`hrisSync POST failed: ${post.res.status} ${post.text}`);
    }
    const createdId = extractFormId(parseJson(post.text));
    return {
      action: "created",
      status: post.res.status,
      formId: createdId === null ? undefined : createdId,
    };
  }

  const formId = extractFormIdFromItem(items[0]);
  if (formId === null || formId === undefined) {
    throw new Error(`hrisSync could not extract form id from GET response: ${get.text.slice(0, 500)}`);
  }

  console.log(`[hrisSync] Found form id=${formId}; updating`);
  return patchFormAt(personId, formId, fields);
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  }
}

async function patchFormAt(personId, formId, fields, baseUrlOverride) {
  if (!AVATURE_REST_API_KEY) {
    console.warn("[hrisSync] AVATURE_REST_API_KEY is not set; skipping form patch.");
    return { action: "skipped", reason: "missing api key" };
  }
  const baseUrl = baseUrlOverride || formUrl(personId);
  const patchUrl = `${baseUrl}/${formId}`;
  const body = formBody(personId, fields);
  const patch = await requestJson(patchUrl, {
    method: "PATCH",
    headers: apiKeyHeaders(),
    body: JSON.stringify(body),
  });
  if (!patch.res.ok) {
    throw new Error(`hrisSync PATCH failed: ${patch.res.status} ${patch.text}`);
  }
  const responseId = extractFormId(parseJson(patch.text));
  return { action: "patched", status: patch.res.status, formId: responseId === null ? formId : responseId };
}

function compoundApplicationUrl(applicationId) {
  return `${AVATURE_REST_BASE_URL}/rest/hrisSync/compoundRecords_8/${applicationId}`;
}

function coreRecordDeleteUrl(recordTypeId, id) {
  return `${AVATURE_REST_BASE_URL}/rest/avature/core/v1/data/records_${recordTypeId}/${id}`;
}

async function deleteAvatureRecord(recordTypeId, id) {
  if (!AVATURE_REST_API_KEY) {
    console.warn("[hrisSync] AVATURE_REST_API_KEY is not set; skipping record delete.");
    throw new Error("AVATURE_REST_API_KEY is not set");
  }
  const url = coreRecordDeleteUrl(recordTypeId, id);
  const { res, text } = await requestJson(url, { method: "DELETE", headers: apiKeyHeaders() });
  if (res.status === 404) {
    return { status: 404, alreadyDeleted: true };
  }
  if (!res.ok) {
    throw new Error(`avature record DELETE failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return { status: res.status, alreadyDeleted: false };
}

function compoundRecordsIndexUrl(recordTypeId) {
  return `${AVATURE_REST_BASE_URL}/rest/avature/core/v1/data/compoundRecords_${recordTypeId}`;
}

function compoundResults(parsed) {
  if (parsed && Array.isArray(parsed.results)) return parsed.results;
  if (Array.isArray(parsed)) return parsed;
  return [];
}

const TABLE_SCHEMA_IDS = { work_history: 21, education_history: 20 };
const tableSchemaCache = {};

function schemaResults(parsed) {
  if (parsed && Array.isArray(parsed.results)) return parsed.results;
  if (Array.isArray(parsed)) return parsed;
  return [];
}

function schemaNextCursor(parsed) {
  const pagination = parsed && parsed.pagination;
  return pagination && pagination.next && pagination.next.cursor ? pagination.next.cursor : null;
}

function fieldLabel(f) {
  const raw = String((f && f.label) || "");
  if (raw && raw !== String(f.id)) return raw;
  return String((f && f.id) || "");
}

async function fetchTableSchema(tableId) {
  const showUrl = `${AVATURE_REST_BASE_URL}/rest/avature/core/v1/schema/tables/${tableId}`;
  const { res: showRes, text: showText } = await requestJson(showUrl, { headers: apiKeyHeaders() });
  if (!showRes.ok) {
    throw new Error(`avature table schema GET failed: ${showRes.status} ${showText.slice(0, 300)}`);
  }
  const show = parseJson(showText);

  const base = `${AVATURE_REST_BASE_URL}/rest/avature/core/v1/schema/tables/${tableId}/fields`;
  const fieldMap = {};
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    let url = base;
    if (cursor) url += `?cursor=${encodeURIComponent(cursor)}`;
    const { res, text } = await requestJson(url, { headers: apiKeyHeaders() });
    if (!res.ok) {
      throw new Error(`avature table schema fields GET failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const parsed = parseJson(text);
    for (const f of schemaResults(parsed)) fieldMap[String(f.id)] = fieldLabel(f);
    cursor = schemaNextCursor(parsed);
    if (!cursor) break;
  }

  tableSchemaCache[tableId] = {
    label: String((show && show.label) || tableId),
    canonicalName: (show && show.canonicalName) || null,
    fieldMap,
  };
  return tableSchemaCache[tableId];
}

function getTableSchema(tableId) {
  if (tableSchemaCache[tableId]) return Promise.resolve(tableSchemaCache[tableId]);
  return fetchTableSchema(tableId);
}

function fieldToDisplay(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "object" && "display" in v) return String(v.display);
      if (typeof v === "object" && "label" in v) return String(v.label);
      return String(v);
    });
    const filtered = parts.filter((p) => p !== null && p !== "");
    return filtered.length ? filtered.join(", ") : null;
  }
  if (typeof value === "object") {
    if ("display" in value) return String(value.display);
    if ("label" in value) return String(value.label);
    if ("id" in value) return String(value.id);
    return JSON.stringify(value);
  }
  return String(value);
}

async function getPersonTable(avaturePersonId, tableName) {
  if (!AVATURE_REST_API_KEY) {
    console.warn("[hrisSync] AVATURE_REST_API_KEY is not set; cannot fetch person table.");
    throw new Error("AVATURE_REST_API_KEY is not set");
  }
  const tableId = TABLE_SCHEMA_IDS[tableName];
  if (!tableId) {
    throw new Error(`Unknown person table: ${tableName}`);
  }
  const schema = await getTableSchema(tableId);
  const url = `${AVATURE_REST_BASE_URL}/rest/avature/core/v1/data/records_${RECORD_TYPE_EMPLOYEE}/${avaturePersonId}/field_${tableName}`;
  const { res, text } = await requestJson(url, { headers: apiKeyHeaders() });
  if (!res.ok) {
    throw new Error(`avature table GET failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const parsed = parseJson(text);
  const rows = [];
  for (const row of schemaResults(parsed)) {
    const fields = [];
    for (const [key, value] of Object.entries(row)) {
      const label = schema.fieldMap[key];
      if (!label) continue;
      const display = fieldToDisplay(value);
      if (display === null) continue;
      fields.push({ key, label, value: display });
    }
    rows.push({ id: row.id !== undefined && row.id !== null ? row.id : null, fields });
  }
  return {
    id: Number(avaturePersonId),
    table: tableName,
    label: schema.label,
    count: rows.length,
    rows,
  };
}

function compoundNextCursor(parsed) {
  const pagination = parsed && parsed.pagination;
  return pagination && pagination.next && pagination.next.cursor ? pagination.next.cursor : null;
}

function isPersonRelatedRecord(related) {
  const url = String((related && related.url) || "");
  return url.includes(`records_${RECORD_TYPE_EMPLOYEE}/`) || url.includes(`records_2/`);
}

async function getJobCandidates(avatureJobId, { maxPages = 20 } = {}) {
  if (!AVATURE_REST_API_KEY) {
    console.warn("[hrisSync] AVATURE_REST_API_KEY is not set; cannot fetch candidates.");
    throw new Error("AVATURE_REST_API_KEY is not set");
  }
  const compoundTypeId = RECORD_TYPE_JOB + 1;
  const records = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    let url = `${compoundRecordsIndexUrl(compoundTypeId)}?object_id=${avatureJobId}&use_canonical_names=1`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const { res, text } = await requestJson(url, { headers: apiKeyHeaders() });
    if (!res.ok) {
      throw new Error(`avature compoundRecords GET failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const parsed = parseJson(text);
    records.push(...compoundResults(parsed));
    cursor = compoundNextCursor(parsed);
    if (!cursor) break;
  }

  const candidates = [];
  const seen = new Set();
  for (const cr of records) {
    const r1 = cr && cr.relatedRecord1;
    const r2 = cr && cr.relatedRecord2;
    if (!r1 || !r2) continue;
    let person = r1;
    let job = r2;
    if (isPersonRelatedRecord(r2) && !isPersonRelatedRecord(r1)) {
      person = r2;
      job = r1;
    }
    const personId = person.id;
    if (personId === undefined || personId === null || seen.has(String(personId))) continue;
    seen.add(String(personId));
    candidates.push({
      compoundRecordId: cr.id !== undefined && cr.id !== null ? cr.id : null,
      avaturePersonId: Number(personId),
      avatureJobId: job && job.id !== undefined && job.id !== null ? Number(job.id) : null,
      workflowStep: cr && cr.workflowStep
        ? {
            id: cr.workflowStep.id !== undefined && cr.workflowStep.id !== null ? cr.workflowStep.id : null,
            display: cr.workflowStep.display !== undefined && cr.workflowStep.display !== null
              ? String(cr.workflowStep.display)
              : "",
          }
        : null,
    });
  }
  return candidates;
}

async function moveApplicationToStep(applicationId, stepId) {
  if (!AVATURE_REST_API_KEY) {
    console.warn("[hrisSync] AVATURE_REST_API_KEY is not set; skipping workflow step update.");
    throw new Error("AVATURE_REST_API_KEY is not set");
  }
  const url = compoundApplicationUrl(applicationId);
  const body = { workflow: { step: { id: Number(stepId) } } };
  const { res, text } = await requestJson(url, {
    method: "PATCH",
    headers: apiKeyHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`hrisSync application step PATCH failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const parsed = parseJson(text);
  console.log(
    `[hrisSync] application=${applicationId} moved to step=${stepId} taskId=${(parsed && parsed.taskId) || "(none)"} status=${(parsed && parsed.status) || res.status}`
  );
  return {
    applicationId: String(applicationId),
    stepId: Number(stepId),
    status: res.status,
    taskId: parsed && parsed.taskId ? parsed.taskId : null,
  };
}

module.exports = {
  AVATURE_REST_BASE_URL,
  AVATURE_REST_API_KEY,
  HRIS_SYNC_FORM_ID,
  RECORD_TYPE_EMPLOYEE,
  RECORD_TYPE_JOB,
  RECORD_TYPE_DEPARTMENT,
  attachForm,
  patchFormAt,
  coreFormBaseUrl,
  deleteAvatureRecord,
  getEmployeeSyncForm,
  getAvatureRecordNames,
  getJobCandidates,
  getPersonTable,
  moveApplicationToStep,
};