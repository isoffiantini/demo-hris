const AVATURE_REST_BASE_URL =
  process.env.AVATURE_REST_BASE_URL ||
  "https://junctiontraining.avature.net";

const AVATURE_REST_API_KEY = process.env.AVATURE_REST_API_KEY || "";

const HRIS_SYNC_FORM_ID = Number(process.env.HRIS_SYNC_FORM_ID || 838);

function apiKeyHeaders() {
  return {
    "X-Avature-REST-API-Key": AVATURE_REST_API_KEY,
    "Content-Type": "application/json",
  };
}

function formUrl(personId) {
  return `${AVATURE_REST_BASE_URL}/rest/hrisSync/people/${personId}/form_${HRIS_SYNC_FORM_ID}`;
}

function formBody(personId, hrisExternalId, lastSynced) {
  return {
    personId: Number(personId),
    "HRIS External ID": String(hrisExternalId),
    "Last Synced": String(lastSynced),
  };
}

async function requestJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text().catch(() => "");
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

async function attachForm(personId, hrisExternalId, lastSynced) {
  if (!AVATURE_REST_API_KEY) {
    console.warn("[hrisSync] AVATURE_REST_API_KEY is not set; skipping form sync.");
    return { action: "skipped", reason: "missing api key" };
  }

  const baseUrl = formUrl(personId);
  const body = formBody(personId, hrisExternalId, lastSynced);

  console.log(`[hrisSync] GET ${baseUrl} (personId=${personId} hrisId=${hrisExternalId})`);
  const get = await requestJson(baseUrl, { headers: apiKeyHeaders() });
  console.log(`[hrisSync] GET status=${get.res.status}`);
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
    console.log(`[hrisSync] POST status=${post.res.status} response=${post.text.slice(0, 500)}`);
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

  const patchUrl = `${baseUrl}/${formId}`;
  console.log(`[hrisSync] Found form id=${formId}; updating`);
  const patch = await requestJson(patchUrl, {
    method: "PATCH",
    headers: apiKeyHeaders(),
    body: JSON.stringify(body),
  });
  console.log(`[hrisSync] PATCH status=${patch.res.status} response=${patch.text.slice(0, 500)}`);
  if (!patch.res.ok) {
    throw new Error(`hrisSync PATCH failed: ${patch.res.status} ${patch.text}`);
  }
  return { action: "updated", status: patch.res.status, formId };
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  AVATURE_REST_BASE_URL,
  AVATURE_REST_API_KEY,
  HRIS_SYNC_FORM_ID,
  attachForm,
};