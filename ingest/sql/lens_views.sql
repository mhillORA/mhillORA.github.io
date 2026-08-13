-- Map these to your warehouse gold tables.
-- Column names must match api/src/goldQueries.js.

CREATE VIEW lens.v_studies AS
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
  CAST(SYSUTCDATETIME() AS date) AS as_of
FROM gold.study_mart;  -- replace

CREATE VIEW lens.v_study_visits AS
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
  CAST(SYSUTCDATETIME() AS date) AS as_of
FROM gold.visit_occurrence;  -- replace

CREATE VIEW lens.v_chart_metrics AS
SELECT
  metric_type,
  grain_key,
  label,
  value_num,
  value_text,
  color_hint,
  chart_group,
  CAST(SYSUTCDATETIME() AS date) AS as_of
FROM gold.chart_metric_mart;  -- replace

CREATE VIEW lens.v_source_catalog AS
SELECT
  source_id,
  name,
  category,
  last_sync,
  scope_text,
  fresh
FROM gold.source_catalog;  -- replace
