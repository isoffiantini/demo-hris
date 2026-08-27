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
  const required = ["name", "description", "department", "status"];
  const errors = [];
  for (const field of required) {
    if (!partial && !(field in body)) {
      errors.push(`${field} is required`);
    } else if (body[field] !== undefined && (body[field] === "" || body[field] === null)) {
      errors.push(`${field} cannot be empty`);
    }
  }
  if (body.status !== undefined && !["open", "closed"].includes(body.status)) {
    errors.push("status must be either 'open' or 'closed'");
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

function encodeCursor(id) {
  return Buffer.from(String(id)).toString("base64");
}

function decodeCursor(cursor) {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const num = Number(decoded);
    return Number.isFinite(num) ? num : null;
  } catch (e) {
    return null;
  }
}

function paginateCursor(list, req) {
  const pageSizeRaw = Number(req.query.pageSize);
  const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0
    ? Math.min(pageSizeRaw, 100)
    : 10;

  const sorted = [...list].sort((a, b) => a.id - b.id);

  let startIndex = 0;
  if (req.query.cursor) {
    const cursorId = decodeCursor(req.query.cursor);
    if (cursorId !== null) {
      startIndex = sorted.findIndex((item) => item.id > cursorId);
      if (startIndex === -1) startIndex = sorted.length;
    }
  }

  const page = sorted.slice(startIndex, startIndex + pageSize);
  const last = page[page.length - 1];
  const hasMore = startIndex + page.length < sorted.length;

  return {
    data: page,
    pageSize,
    next: hasMore ? { cursor: encodeCursor(last.id) } : null,
  };
}

app.get("/employees", (req, res) => {
  const { data } = getEntity("employees");
  let list = data.employees;
  if (req.query.jobId !== undefined) {
    const jobId = Number(req.query.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ errors: ["jobId must be a positive integer"] });
    }
    list = list.filter((e) => e.jobId === jobId);
  }
  res.json(paginateCursor(list, req));
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

app.delete("/employees/:id", (req, res) => {
  const { data, entity } = getEntity("employees", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Employee not found" });
  }
  data.employees = data.employees.filter((item) => item.id !== entity.id);
  writeData(data);
  res.status(204).end();
});

app.get("/jobs", (req, res) => {
  const { data } = getEntity("jobs");
  res.json(paginateCursor(data.jobs, req));
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

app.delete("/jobs/:id", (req, res) => {
  const { data, entity } = getEntity("jobs", req.params.id);
  if (!entity) {
    return res.status(404).json({ error: "Job not found" });
  }
  data.jobs = data.jobs.filter((item) => item.id !== entity.id);
  writeData(data);
  res.status(204).end();
});

app.get("/departments", (req, res) => {
  const { data } = getEntity("jobs");
  const names = [...new Set(data.jobs.map((j) => j.department).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );
  const departments = names.map((name, i) => ({ id: i + 1, name }));

  const pageSizeRaw = Number(req.query.pageSize);
  const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0
    ? Math.min(pageSizeRaw, 100)
    : 10;

  let startIndex = 0;
  if (req.query.cursor) {
    const cursorId = decodeCursor(req.query.cursor);
    if (cursorId !== null) {
      startIndex = departments.findIndex((d) => d.id > cursorId);
      if (startIndex === -1) startIndex = departments.length;
    }
  }

  const page = departments.slice(startIndex, startIndex + pageSize);
  const last = page[page.length - 1];
  const hasMore = startIndex + page.length < departments.length;

  res.json({
    data: page,
    pageSize,
    next: hasMore ? { cursor: encodeCursor(last.id) } : null,
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`demo-hris listening on http://localhost:${PORT}`);
});
