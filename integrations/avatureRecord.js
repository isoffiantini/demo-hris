const { AVATURE_REST_BASE_URL, AVATURE_REST_API_KEY } = require("./hrisSync");

async function updateRecordName(recordTypeId, avatureId, name) {
  if (!AVATURE_REST_API_KEY) {
    throw new Error("AVATURE_REST_API_KEY is not set");
  }
  const url = `${AVATURE_REST_BASE_URL}/rest/avature/core/v1/data/records_${recordTypeId}/${avatureId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "X-Avature-REST-API-Key": AVATURE_REST_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ name }),
  });
  const text = await res.text().catch(() => "");
  console.log(`[avatureRecord] PATCH ${url} -> ${res.status} (${text.length} bytes)`);
  if (!res.ok) {
    throw new Error(`avature record PATCH failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return { status: res.status };
}

module.exports = { updateRecordName };
