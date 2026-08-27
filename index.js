const express = require("express");
const path = require("path");
const { readData, writeData, nextId } = require("./store");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

function validateEmployee(body, partial) {
  const required = ["firstName", "lastName", "email", "phoneNumber", "jobId"];
  const errors = [];
  for (const field of required) {
    if (!partial && !(field in body)) {
      errors.push(`${field} is required`);
    } else if (body[field] !== undefined && (body[field] === "" || body[field] === null)) {
      errors.push(`${field} cannot be empty`);
    }
  }
  return errors;
}

function validateJob(body, partial) {
  const required = ["name", "description", "department"];
  const errors = [];
  for (const field of required) {
    if (!partial && !(field in body)) {
      errors.push(`${field} is required`);
    } else if (body[field] !== undefined && (body[field] === "" || body[field] === null)) {
      errors.push(`${field} cannot be empty`);
    }
  }
  return errors;
}

function handleErrors(errors, res) {
  if (errors.length) {
    res.status(400).json({ errors });
    return true;
  }
  return false;
}

function getEntity(collectionName, id) {
  const data = readData();
  const entity = data[collectionName].find((item) => item.id === Number(id));
  return { data, entity };
}

function applyPartial(existing, body) {
  return { ...existing, ...body };
}

app.get("/employees", (req, res) => {
  const { data } = getEntity("employees");
  res.json(data.employees);
});

app.get("/employees/:id", (req, res) => {
  const { entity } = getEntity("employees", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Employee not found" });
  }
  res.json(entity);
});

app.post("/employees", (req, res) => {
  if (handleErrors(validateEmployee(req.body), res)) return;
  const data = readData();
  const employee = { id: nextId(data.employees), ...req.body };
  data.employees.push(employee);
  writeData(data);
  res.status(201).json(employee);
});

app.patch("/employees/:id", (req, res) => {
  if (handleErrors(validateEmployee(req.body, true), res)) return;
  const { data, entity } = getEntity("employees", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Employee not found" });
  }
  const updated = applyPartial(entity, req.body);
  data.employees = data.employees.map((item) => (item.id === updated.id ? updated : item));
  writeData(data);
  res.json(updated);
});

app.get("/jobs", (req, res) => {
  const { data } = getEntity("jobs");
  res.json(data.jobs);
});

app.get("/jobs/:id", (req, res) => {
  const { entity } = getEntity("jobs", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(entity);
});

app.post("/jobs", (req, res) => {
  if (handleErrors(validateJob(req.body), res)) return;
  const data = readData();
  const job = { id: nextId(data.jobs), ...req.body };
  data.jobs.push(job);
  writeData(data);
  res.status(201).json(job);
});

app.patch("/jobs/:id", (req, res) => {
  if (handleErrors(validateJob(req.body, true), res)) return;
  const { data, entity } = getEntity("jobs", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Job not found" });
  }
  const updated = applyPartial(entity, req.body);
  data.jobs = data.jobs.map((item) => (item.id === updated.id ? updated : item));
  writeData(data);
  res.json(updated);
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`demo-hris listening on http://localhost:${PORT}`);
});
