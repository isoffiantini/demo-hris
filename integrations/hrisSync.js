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

function extractFormId(parsed) {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && item.id !== undefined) return item.id;
      if (item && item.formId !== undefined) return item.formId;
    }
    return null;
  }
  if (parsed && parsed.id !== undefined) return parsed.id;
  if (parsed && parsed.formId !== undefined) return parsed.formId;
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

  if (get.res.status === 404) {
    console.log("[hrisSync] Form not found; creating it");
    const post = await requestJson(baseUrl, {
      method: "POST",
      headers: apiKeyHeaders(),
      body: JSON.stringify(body),
    });
    console.log(`[hrisSync] POST status=${post.res.status} response=${post.text.slice(0, 500)}`);
    if (!post.res.ok) {
      throw new Error(`hrisSync POST failed: ${post.res.status} ${post.text}`);
    }
    return { action: "created", status: post.res.status };
  }

  if (!get.res.ok) {
    throw new Error(`hrisSync GET failed: ${get.res.status} ${get.text}`);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(get.text);
  } catch (e) {
    parsed = null;
  }
  const formId = extractFormId(parsed);
  if (formId === null || formId === undefined) {
    throw new Error(`hrisSync could not extract form id from GET response: ${get.text.slice(0, 500)}`);
  }

  const patchUrl = `${baseUrl}/${formId}`;
  console.log(`[hrisSync] Form id=${formId}; updating`);
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

module.exports = {
  AVATURE_REST_BASE_URL,
  AVATURE_REST_API_KEY,
  HRIS_SYNC_FORM_ID,
  attachForm,
};