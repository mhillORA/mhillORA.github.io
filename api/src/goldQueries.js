/**
 * Gold-layer SELECT shapes for Cosmos docs.
 * Map these view names to your warehouse (Synapse / Fabric / Databricks SQL).
 * Keep grain stable: one row → one Cosmos document.
 */
const GOLD_QUERIES = {
  studies: `
SELECT
  study_code,
  study_name,
  indication,
  phase,
  status,
  enrolled,
  planned_to_date,
  revenue_at_risk,
  primary_driver,
  fpi_date,
  source_system,
  as_of
FROM lens.v_studies
`,
  visits: `
SELECT
  visit_id,
  study_code,
  subject_id,
  site_id,
  visit_name,
  visit_status,
  visit_date,
  window_start,
  window_end,
  as_of
FROM lens.v_study_visits
`,
  metrics: `
SELECT
  metric_type,
  grain_key,
  label,
  value_num,
  value_text,
  color_hint,
  chart_group,
  as_of
FROM lens.v_chart_metrics
`,
  sources: `
SELECT
  source_id,
  name,
  category,
  last_sync,
  scope_text,
  fresh
FROM lens.v_source_catalog
`
};

module.exports = { GOLD_QUERIES };
