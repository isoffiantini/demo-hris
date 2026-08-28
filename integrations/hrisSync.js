const AVATURE_REST_BASE_URL =
  process.env.AVATURE_REST_BASE_URL ||
  "https://junctiontraining.avature.net";

const AVATURE_REST_API_KEY = process.env.AVATURE_REST_API_KEY || "";

const HRIS_SYNC_FORM_ID = Number(process.env.HRIS_SYNC_FORM_ID || 838);

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
  return { action: "patched", status: patch.res.status, formId };
}

function compoundApplicationUrl(applicationId) {
  return `${AVATURE_REST_BASE_URL}/rest/hrisSync/compoundRecords_8/${applicationId}`;
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
  attachForm,
  patchFormAt,
  coreFormBaseUrl,
  getEmployeeSyncForm,
  getAvatureRecordNames,
  moveApplicationToStep,
};