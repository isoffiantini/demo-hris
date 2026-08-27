const express = require("express");
const { readData, writeData, nextId } = require("../store");

const router = express.Router();

function respondAsync(res) {
  res.json({ asyncResponse: { successful: true } });
}

function normalizeNull(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function toEmployeePayload(payload) {
  const props = payload.properties || {};
  return {
    firstName: props.firstName || "",
    lastName: props.lastName || "",
    email: props.email || "",
    phoneNumber: normalizeNull(props.phone),
    jobId: Number(props.job_hris_id),
  };
}

function upsertEmployee(employee) {
  const data = readData();
  const email = (employee.email || "").toLowerCase();
  const existing = data.employees.find((e) => (e.email || "").toLowerCase() === email);

  if (existing) {
    const updated = { ...existing, ...employee, id: existing.id };
    data.employees = data.employees.map((e) => (e.id === existing.id ? updated : e));
    writeData(data);
    return { record: updated, created: false };
  }

  const record = { id: nextId(data.employees), ...employee };
  data.employees.push(record);
  writeData(data);
  return { record, created: true };
}

router.get("/flow_create_employee", (req, res) => {
  const challenge = req.get("avature-challenge-code") || "";
  res.json({ "avature-challenge-code": challenge });
});

router.post("/flow_create_employee", (req, res) => {
  const employee = toEmployeePayload(req.body);
  upsertEmployee(employee);
  respondAsync(res);
});

module.exports = router;
