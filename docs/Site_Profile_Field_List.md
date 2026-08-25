# Site Profile Master — Field List for Developer

## Profile Layer (stable, pre-populated)

### Site Details
- **institution_name**: string *(required)* — Legal name of the institution
- **site_type**: enum [Private Practice, Dedicated Research Center, Academic Medical Center, Hospital-Based, Community Health Center] *(required)*
- **address_street**: string *(required)*
- **address_city**: string *(required)*
- **address_state**: string *(required)*
- **address_zip**: string *(required)*
- **address_country**: string *(required)*
- **phone**: string *(required)*
- **fax**: string
- **multi_site**: boolean — Does the site have satellite offices?
- **satellite_locations**: array — List of satellite addresses if multi-site
- **office_hours**: string — e.g., 8:00 AM – 5:00 PM Mon-Fri
- **smo_affiliation**: string — SMO name if applicable
- **smo_staffing_model**: enum [None, Limited SMO, Full SMO]

### Principal Investigators
- **investigators** (array of objects):
  - name: string *(required)*
  - credentials: string — e.g., MD, PhD
  - specialty: string
  - email: string
  - phone: string
  - board_certified: boolean
  - years_research_experience: number
  - total_trials_conducted: number
  - role: enum
  - is_primary: boolean

### Key Contacts
- **contacts** (array of objects):
  - role: enum *(required)*
  - name: string *(required)*
  - title: string
  - email: string *(required)*
  - phone: string
  - last_confirmed: date
  - source_study: string — Study from which this contact was last confirmed

### IRB & Regulatory
- **irb_type**: enum [Central, Local, Either] *(required)*
- **central_irb_name**: string — e.g., Advarra, WCG
- **irb_meeting_frequency**: string
- **irb_submission_lead_days**: number — Workdays in advance
- **avg_irb_approval_days**: number
- **additional_committees_required**: boolean
- **additional_committee_details**: string
- **contract_parallel_with_irb**: boolean
- **contract_required_before_irb**: boolean
- **gcp_compliant**: boolean *(required)*
- **fda_audit_history**: boolean
- **fda_483_issued**: boolean
- **fda_audit_year**: number
- **ibc_registered**: boolean — Relevant for gene therapy
- **ibc_provider**: string — e.g., Advarra, Sabai

### Equipment & Capabilities
- **equipment_list** (array of objects):
  - category: enum
  - name: string *(required)* — e.g., SD-OCT, MAIA, Fundus Camera
  - make_model: string — e.g., Heidelberg Spectralis HRA+OCT
  - software_version: string
  - owned: boolean
  - notes: string
- **etdrs_certified_lanes**: number
- **etdrs_light_box**: boolean
- **etdrs_charts**: string — e.g., Charts 1, 2, R
- **certified_va_examiners**: number
- **certified_oct_photographers**: number
- **exam_rooms_available**: number
- **qcsf_capability**: boolean
- **cae_experience**: boolean — Controlled Adverse Environment capability
- **cae_space_available**: boolean
- **block_enrollment_capable**: boolean

### Reading Center Certifications
- **certifications** (array of objects):
  - reading_center: string — e.g., OIRRC, Merit, Duke DIRC
  - certified: boolean
  - certification_date: date
  - expiration_date: date

### Pharmacy & IP Storage
- **on_site_pharmacy**: boolean
- **aseptic_prep_area**: boolean
- **drug_refrigerator_2_8c**: boolean
- **freezer_minus_20c**: boolean
- **freezer_minus_80c**: boolean
- **room_temp_locked_storage**: boolean
- **temp_monitoring_24_7**: boolean
- **temp_monitoring_alarmed**: boolean
- **backup_generator**: boolean
- **clia_waiver**: boolean
- **clia_cert_number**: string
- **clia_expiration**: date
- **compounding_pharmacy_relationship**: string
- **dry_ice_access**: boolean

### Lab & Specimen Handling
- **phlebotomist_on_staff**: boolean
- **centrifuge_available**: boolean
- **centrifuge_make_model**: string
- **refrigerated_centrifuge**: boolean
- **iata_certified_staff**: boolean
- **pk_sampling_experience**: boolean
- **specimen_processing_capability**: array — e.g., blood, tear samples, nasal swabs

### Staffing Resources
- **study_coordinators_count**: number
- **coordinators_full_time**: boolean
- **coordinator_experience_years**: number
- **imaging_techs_count**: number
- **dedicated_regulatory_staff**: boolean
- **dedicated_data_entry**: boolean
- **cpr_certified_staff**: boolean
- **vitreoretinal_surgeon_access**: boolean

### Contract & Startup
- **avg_contract_negotiation_weeks**: number
- **avg_budget_turnaround_weeks**: number
- **estimated_total_startup_weeks**: number
- **electronic_signatures_accepted**: boolean
- **icf_translation_languages**: array
- **separate_budget_office**: boolean

### Medical Records & Systems
- **source_records_type**: enum [Paper, Electronic, Hybrid]
- **emr_system**: string
- **edc_systems_used**: array — e.g., Medidata, iMedNet, Veeva
- **remote_monitoring_capable**: boolean
- **guest_wifi_for_monitors**: boolean

### Research Experience
- **years_of_research**: number
- **total_trials_conducted**: number
- **phase_experience**: array — e.g., Phase 1, 2, 3, 4
- **gene_therapy_experience**: boolean
- **gene_therapy_trial_count**: number

## Indication Layer (tagged by therapeutic area)

- **indication**: string — e.g., Dry AMD, GA, Wet AMD, Dry Eye, DME, Glaucoma
- **patient_database_size**: number — Total patients with this condition in site database
- **trials_completed_in_indication**: number
- **trials_currently_enrolling**: number
- **estimated_monthly_patient_volume**: number
- **patient_travel_radius_miles**: number
- **last_confirmed**: date
- **source_study**: string

## Study-Specific Layer (always collected fresh)

- **study_interest**: boolean — Is the site interested in this specific study?
- **enrollment_estimate**: number — Estimated patients this site can enroll for this protocol
- **screen_failure_estimate_pct**: number — Anticipated screen fail rate
- **competing_studies**: array — List of active competing studies
- **competing_study_impact**: string — How competing studies affect enrollment capacity
- **current_staffing_capacity**: enum
- **protocol_concerns**: string — Any concerns about study design, I/E criteria, visit schedule
- **visit_schedule_feasible**: boolean
- **equipment_gaps**: string — Any equipment gaps vs. protocol requirements
- **recruitment_strategy**: string — How site plans to recruit — database, referral, advertising
- **advertising_needed**: boolean
