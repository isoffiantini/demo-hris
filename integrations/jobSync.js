const { RECORD_TYPE_JOB } = require("./hrisSync");
const { updateRecordName } = require("./avatureRecord");

async function syncJobUpdate(previous, updated) {
  if (!previous.avatureId || previous.name === updated.name) return null;
  return updateRecordName(RECORD_TYPE_JOB, previous.avatureId, updated.name);
}

module.exports = { syncJobUpdate };
