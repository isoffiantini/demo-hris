const envList = process.env.EMPLOYMENT_STATUSES || "Hired:Hired,Ex Employee:Ex Employee";

const EMPLOYMENT_STATUSES = envList
  .split(",")
  .map((pair) => {
    const [value, label] = pair.split(":");
    return { value: (value || "").trim(), label: ((label || value) || "").trim() };
  })
  .filter((s) => s.value);

const EMPLOYMENT_STATUS_VALUES = EMPLOYMENT_STATUSES.map((s) => s.value);
const EMPLOYMENT_STATUS_LABELS = EMPLOYMENT_STATUSES.map((s) => s.label);

module.exports = {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_VALUES,
  EMPLOYMENT_STATUS_LABELS,
};
