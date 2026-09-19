const { RECORD_TYPE_DEPARTMENT } = require("./hrisSync");
const { updateRecordName } = require("./avatureRecord");

async function syncDepartmentUpdate(previous, updated) {
  if (!previous.avatureId || previous.name === updated.name) return null;
  return updateRecordName(RECORD_TYPE_DEPARTMENT, previous.avatureId, updated.name);
}

module.exports = { syncDepartmentUpdate };
