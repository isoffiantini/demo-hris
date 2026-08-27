const JUNCTION_EVENTS_URL =
  process.env.JUNCTION_EVENTS_URL ||
  "https://junctiontraining.avature.net/junction/events/v2/-MSw1QmrDUfibjnwiEOdXY6xo2ODDQqMOtc7WcXW/";

const TRACKING_CODE_HEADERS = [
  "avature-tracking-code",
  "tracking-code",
  "x-tracking-code",
  "x-avature-tracking-code",
];

const RECORD_ID_HEADERS = ["avature-record-id", "x-avature-record-id"];

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
    body.trackingCode,
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
    body.id,
    props.recordId,
    props.record_id,
    props.id,
    props.personId,
    props.candidateId,
    props.person_id,
    props.record,
    body.record,
    getHeaderValue(req, RECORD_ID_HEADERS),
  ];
  for (const candidate of candidates) {
    const id = idFromValue(candidate);
    if (id !== null && id !== "") return id;
  }
  return null;
}

function trackingDiagnostics(req) {
  const relevantHeaders = Object.entries(req.headers || {})
    .filter(([name]) => /track|external|ref|avature/i.test(name))
    .map(([name, value]) => `${name}=${value}`);
  return {
    query: req.query || {},
    relevantHeaders,
    bodyKeys: Object.keys(req.body || {}),
    propertiesKeys: Object.keys(((req.body || {}).properties) || {}),
  };
}

function utcDateTime() {
  return new Date().toISOString().replace(/Z$/, "+0000");
}

async function sendLog(log) {
  const payload = JSON.stringify({ logs: [log] });
  console.log(`[junction] POST ${JUNCTION_EVENTS_URL} body=${payload.slice(0, 2000)}`);
  const res = await fetch(JUNCTION_EVENTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  console.log(`[junction] response status=${res.status}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Junction events API responded ${res.status}: ${text}`);
  }
  return res.status;
}

function resolveLogContext(req, fallbackRecordId) {
  const trackingCode = resolveTrackingCode(req);
  if (!trackingCode) {
    console.warn(
      `[junction] No tracking code resolved; skipping event logs. diagnostics=${JSON.stringify(trackingDiagnostics(req))}`
    );
    return { trackingCode: null };
  }

  let recordId = resolveRecordId(req);
  if (recordId === null || recordId === "") {
    console.warn(
      `[junction] No recordId found in request payload; falling back to ${JSON.stringify(fallbackRecordId)}. Full body: ${JSON.stringify(req.body || {})}`
    );
    recordId = fallbackRecordId;
  } else {
    console.log(`[junction] Using recordId=${JSON.stringify(recordId)} from request payload`);
  }

  return { trackingCode, recordId };
}

function makeLog(ctx, recordTypeId, summary, details, status) {
  return {
    trackingCode: ctx.trackingCode,
    recordTypeId,
    recordId: ctx.recordId,
    summary,
    details,
    status,
    dateTime: utcDateTime(),
  };
}

async function sendLogSafe(log) {
  try {
    const status = await sendLog(log);
    console.log(
      `[junction] Logged event "${log.summary}" (HTTP ${status}) with trackingCode=${log.trackingCode} recordId=${JSON.stringify(log.recordId)}`
    );
    return true;
  } catch (err) {
    console.error(`[junction] Failed to send event "${log.summary}": ${err.message}`);
    return false;
  }
}

async function sendExecutionLogs(req, config) {
  const {
    recordTypeId,
    infoSummary,
    infoDetails,
    successSummary = "Flow finished successfully.",
    successDetails = "Execution was successful.",
    fallbackRecordId = null,
  } = config;

  const ctx = resolveLogContext(req, fallbackRecordId);
  if (!ctx.trackingCode) return { trackingCode: null, recordId: null, sent: 0 };

  const logs = [
    makeLog(ctx, recordTypeId, infoSummary, infoDetails, "INFO"),
    makeLog(ctx, recordTypeId, successSummary, successDetails, "SUCCESS"),
  ];

  let sent = 0;
  for (const log of logs) {
    if (await sendLogSafe(log)) sent += 1;
  }
  return { trackingCode: ctx.trackingCode, recordId: ctx.recordId, sent };
}

async function sendErrorLog(req, config) {
  const { recordTypeId, message, recordId } = config;
  const trackingCode = resolveTrackingCode(req);
  if (!trackingCode) {
    console.warn(
      `[junction] No tracking code resolved; skipping error event. diagnostics=${JSON.stringify(trackingDiagnostics(req))}`
    );
    return { trackingCode: null, sent: 0 };
  }
  const id = recordId !== undefined ? recordId : resolveRecordId(req);
  const log = {
    trackingCode,
    recordTypeId,
    recordId: id,
    summary: "Flow failed.",
    details: `Execution failed: ${message}`,
    status: "ERROR",
    dateTime: utcDateTime(),
  };
  try {
    const status = await sendLog(log);
    console.log(`[junction] Logged ERROR event (HTTP ${status}) with trackingCode=${trackingCode}`);
    return { trackingCode, sent: 1 };
  } catch (err) {
    console.error(`[junction] Failed to send error event: ${err.message}`);
    return { trackingCode, sent: 0 };
  }
}

module.exports = {
  JUNCTION_EVENTS_URL,
  resolveTrackingCode,
  resolveRecordId,
  utcDateTime,
  sendLog,
  sendLogSafe,
  sendExecutionLogs,
  sendErrorLog,
  resolveLogContext,
  makeLog,
};