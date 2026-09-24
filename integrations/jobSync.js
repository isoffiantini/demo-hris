const { RECORD_TYPE_JOB } = require("./hrisSync");
const { updateRecord } = require("./avatureRecord");

async function syncJobUpdate(previous, updated) {
  if (!previous.avatureId) return null;
  const fields = {};
  if (previous.name !== updated.name) fields.name = updated.name;
  if (previous.status !== updated.status) fields.isOpened = updated.status === "open";
  if (Object.keys(fields).length === 0) return null;
  return updateRecord(RECORD_TYPE_JOB, previous.avatureId, fields);
}

module.exports = { syncJobUpdate };
