CREATE SCHEMA "audit_log";
--> statement-breakpoint
CREATE SCHEMA "public_core";
--> statement-breakpoint
CREATE SCHEMA "rcs_ops";
--> statement-breakpoint
CREATE SCHEMA "rdf_ops";
--> statement-breakpoint
CREATE SCHEMA "rnp_ops";
--> statement-breakpoint
CREATE TYPE "audit_log"."agency" AS ENUM('RDF', 'RNP', 'RCS', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "audit_log"."entity_type" AS ENUM('APPLICANT', 'APPLICATION', 'DOCUMENT', 'OFFICER', 'CAMPAIGN', 'VENUE', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public_core"."agency" AS ENUM('RDF', 'RNP', 'RCS');--> statement-breakpoint
CREATE TYPE "public_core"."application_channel" AS ENUM('WEB', 'USSD', 'IREMBO_KIOSK', 'WALK_IN');--> statement-breakpoint
CREATE TYPE "public_core"."campaign_status" AS ENUM('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EXAMINATION_ACTIVE', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public_core"."gender" AS ENUM('MALE', 'FEMALE');--> statement-breakpoint
CREATE TYPE "public_core"."identity_verification_status" AS ENUM('PENDING', 'VERIFIED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "rcs_ops"."academic_eligibility_status" AS ENUM('PENDING', 'ELIGIBLE', 'INELIGIBLE');--> statement-breakpoint
CREATE TYPE "rcs_ops"."application_status" AS ENUM('DRAFT', 'SUBMITTED', 'ACADEMIC_VETTING', 'CRIMINAL_CLEARANCE', 'DOCUMENT_REVIEW_GREEN', 'DOCUMENT_REVIEW_AMBER', 'SLOT_ASSIGNED', 'PHYSICAL_TEST_SCHEDULED', 'PHYSICAL_TEST_COMPLETE', 'MEDICAL_REVIEW', 'FINAL_SHORTLIST', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "rcs_ops"."application_category" AS ENUM('GENERAL_ENLISTEE', 'OFFICER_ONE_YEAR', 'OFFICER_ONE_YEAR_SPECIALIST', 'OFFICER_FOUR_YEAR_UR');--> statement-breakpoint
CREATE TYPE "rcs_ops"."criminal_clearance_status" AS ENUM('PENDING', 'CLEARED', 'FLAGGED_CONVICTION', 'FLAGGED_PROSECUTION', 'FLAGGED_DISMISSED', 'UNDER_REVIEW');--> statement-breakpoint
CREATE TYPE "rcs_ops"."document_lane" AS ENUM('GREEN', 'AMBER', 'RED');--> statement-breakpoint
CREATE TYPE "rcs_ops"."document_type" AS ENUM('NATIONAL_ID', 'APPLICATION_FORM_WITH_PHOTO', 'BIRTH_CERTIFICATE', 'ALEVEL_CERTIFICATE', 'DEGREE_DIPLOMA_NOTARIZED', 'GOOD_CONDUCT_CERTIFICATE', 'NON_CONVICTION_CERTIFICATE', 'CELIBACY_CERTIFICATE', 'MEDICAL_CERTIFICATE_GOVT');--> statement-breakpoint
CREATE TYPE "rcs_ops"."ur_program" AS ENUM('GENERAL_MEDICINE', 'GENERAL_NURSING', 'COMPUTER_ENGINEERING', 'DENTAL_SURGERY');--> statement-breakpoint
CREATE TYPE "rdf_ops"."academic_eligibility_status" AS ENUM('PENDING', 'ELIGIBLE', 'INELIGIBLE');--> statement-breakpoint
CREATE TYPE "rdf_ops"."application_status" AS ENUM('DRAFT', 'SUBMITTED', 'ACADEMIC_VETTING', 'CRIMINAL_CLEARANCE', 'DOCUMENT_REVIEW_GREEN', 'DOCUMENT_REVIEW_AMBER', 'SLOT_ASSIGNED', 'PHYSICAL_TEST_SCHEDULED', 'PHYSICAL_TEST_COMPLETE', 'MEDICAL_REVIEW', 'FINAL_SHORTLIST', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'WALK_IN_REGISTERED', 'WALK_IN_ON_SITE_VETTING', 'WALK_IN_PHYSICAL_TEST', 'WALK_IN_REJECTED');--> statement-breakpoint
CREATE TYPE "rdf_ops"."application_category" AS ENUM('GENERAL_ENLISTMENT', 'RESERVE_FORCE_ALEVEL', 'RESERVE_FORCE_UNIVERSITY', 'RESERVE_FORCE_SPECIALIST');--> statement-breakpoint
CREATE TYPE "rdf_ops"."criminal_clearance_status" AS ENUM('PENDING', 'CLEARED', 'FLAGGED_CONVICTION', 'FLAGGED_DISMISSED', 'UNDER_REVIEW');--> statement-breakpoint
CREATE TYPE "rdf_ops"."document_lane" AS ENUM('GREEN', 'AMBER', 'RED');--> statement-breakpoint
CREATE TYPE "rdf_ops"."document_type" AS ENUM('NATIONAL_ID', 'OLEVEL_CERTIFICATE', 'ALEVEL_CERTIFICATE', 'DEGREE_DIPLOMA_COPY', 'GOOD_CONDUCT_CERTIFICATE', 'NON_CONVICTION_CERTIFICATE');--> statement-breakpoint
CREATE TYPE "rnp_ops"."academic_eligibility_status" AS ENUM('PENDING', 'ELIGIBLE', 'INELIGIBLE');--> statement-breakpoint
CREATE TYPE "rnp_ops"."application_status" AS ENUM('DRAFT', 'SUBMITTED', 'ACADEMIC_VETTING', 'CRIMINAL_CLEARANCE', 'DOCUMENT_REVIEW_GREEN', 'DOCUMENT_REVIEW_AMBER', 'SLOT_ASSIGNED', 'PHYSICAL_TEST_SCHEDULED', 'PHYSICAL_TEST_COMPLETE', 'MEDICAL_REVIEW', 'FINAL_SHORTLIST', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "rnp_ops"."application_category" AS ENUM('CADET_OFFICER', 'BASIC_POLICE_COURSE');--> statement-breakpoint
CREATE TYPE "rnp_ops"."criminal_clearance_status" AS ENUM('PENDING', 'CLEARED', 'FLAGGED_CONVICTION', 'FLAGGED_DISMISSED', 'UNDER_REVIEW');--> statement-breakpoint
CREATE TYPE "rnp_ops"."document_lane" AS ENUM('GREEN', 'AMBER', 'RED');--> statement-breakpoint
CREATE TYPE "rnp_ops"."document_type" AS ENUM('NATIONAL_ID', 'APPLICATION_FORM_WITH_PHOTO', 'ALEVEL_CERTIFICATE', 'DEGREE_DIPLOMA_COPY', 'GOOD_CONDUCT_CERTIFICATE');--> statement-breakpoint
CREATE TABLE "audit_log"."audit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kafka_event_id" varchar(128) NOT NULL,
	"correlation_id" varchar(128) NOT NULL,
	"causation_id" varchar(128),
	"entity_type" "audit_log"."entity_type" NOT NULL,
	"entity_id" varchar(128) NOT NULL,
	"agency" "audit_log"."agency" NOT NULL,
	"action" varchar(100) NOT NULL,
	"performed_by" varchar(128) NOT NULL,
	"performed_by_role" varchar(50),
	"previous_status" varchar(50),
	"new_status" varchar(50),
	"ip_address" varchar(45),
	"user_agent" varchar(512),
	"metadata" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_entries_kafka_event_id_unique" UNIQUE("kafka_event_id")
);
--> statement-breakpoint
CREATE TABLE "public_core"."applicant_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"national_id_hash" varchar(64) NOT NULL,
	"encrypted_full_name" text NOT NULL,
	"encrypted_date_of_birth" text NOT NULL,
	"encrypted_home_district" text NOT NULL,
	"encrypted_home_province" text NOT NULL,
	"gender" "public_core"."gender" NOT NULL,
	"nida_verification_request_id" varchar(128),
	"nida_verified_at" timestamp with time zone,
	"nida_match_confidence" varchar(6),
	"identity_status" "public_core"."identity_verification_status" DEFAULT 'PENDING' NOT NULL,
	"registration_channel" "public_core"."application_channel" NOT NULL,
	"phone_number_hash" varchar(64),
	"phone_verified_at" timestamp with time zone,
	"biometric_session_id" varchar(128),
	"biometric_verified_at" timestamp with time zone,
	"biometric_passed_liveness" boolean DEFAULT false,
	"biometric_face_match_confidence" varchar(6),
	"ussd_reservation_expires_at" timestamp with time zone,
	"ussd_session_completed_at" timestamp with time zone,
	"cross_agency_locked_at" timestamp with time zone,
	"cross_agency_locked_by_agency" "public_core"."agency",
	"cross_agency_lock_reason" varchar(30),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applicant_identities_national_id_hash_unique" UNIQUE("national_id_hash")
);
--> statement-breakpoint
CREATE TABLE "public_core"."applicant_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_id" uuid NOT NULL,
	"session_token" varchar(256) NOT NULL,
	"channel" "public_core"."application_channel" NOT NULL,
	"ussd_state" varchar(50),
	"ussd_menu_depth" integer DEFAULT 0,
	"ip_address" varchar(45),
	"user_agent" varchar(512),
	"expires_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applicant_sessions_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE "public_core"."campaign_venue_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"district" varchar(30) NOT NULL,
	"province" varchar(30) NOT NULL,
	"venue_name" varchar(200) NOT NULL,
	"exam_date" varchar(10) NOT NULL,
	"reporting_time_hour" integer NOT NULL,
	"capacity_limit" integer,
	"registered_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_core"."recruitment_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_label" varchar(50) NOT NULL,
	"agency" "public_core"."agency" NOT NULL,
	"status" "public_core"."campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"target_categories" text NOT NULL,
	"registration_opens_at" timestamp with time zone NOT NULL,
	"registration_closes_at" timestamp with time zone NOT NULL,
	"examination_start_date" varchar(10) NOT NULL,
	"examination_end_date" varchar(10) NOT NULL,
	"examination_reporting_hour" integer NOT NULL,
	"allows_walk_in" boolean DEFAULT false NOT NULL,
	"target_intake_count" integer,
	"contact_phone_numbers" text,
	"contact_website" varchar(100),
	"announcement_reference" varchar(200),
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recruitment_campaigns_campaign_label_unique" UNIQUE("campaign_label")
);
--> statement-breakpoint
CREATE TABLE "rcs_ops"."application_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" "rcs_ops"."application_status",
	"to_status" "rcs_ops"."application_status" NOT NULL,
	"reason" varchar(200),
	"performed_by" varchar(50) NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" varchar(128)
);
--> statement-breakpoint
CREATE TABLE "rcs_ops"."applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"processing_code" varchar(20) NOT NULL,
	"applicant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"category" "rcs_ops"."application_category" NOT NULL,
	"status" "rcs_ops"."application_status" DEFAULT 'DRAFT' NOT NULL,
	"nesa_index_number" varchar(20),
	"nesa_verification_request_id" varchar(128),
	"nesa_verified_at" timestamp with time zone,
	"hec_registration_number" varchar(50),
	"hec_verification_request_id" varchar(128),
	"hec_verified_at" timestamp with time zone,
	"declared_specialist_field" varchar(50),
	"ur_program_applied" "rcs_ops"."ur_program",
	"nesa_science_percentage" integer,
	"academic_status" "rcs_ops"."academic_eligibility_status" DEFAULT 'PENDING' NOT NULL,
	"academic_eligibility_detail" jsonb,
	"rib_request_id" varchar(128),
	"criminal_clearance_status" "rcs_ops"."criminal_clearance_status" DEFAULT 'PENDING' NOT NULL,
	"prosecution_check_performed" boolean DEFAULT false,
	"prosecution_check_at" timestamp with time zone,
	"criminal_clearance_at" timestamp with time zone,
	"document_lane" "rcs_ops"."document_lane",
	"document_forensics_score" integer,
	"document_forensics_flags" jsonb,
	"document_reviewed_by_id" uuid,
	"document_reviewed_at" timestamp with time zone,
	"document_review_decision" varchar(10),
	"celibacy_cert_verified" boolean DEFAULT false,
	"celibacy_cert_verified_at" timestamp with time zone,
	"medical_cert_verified" boolean DEFAULT false,
	"medical_cert_verified_at" timestamp with time zone,
	"medical_cert_physician_name" varchar(200),
	"birth_cert_verified" boolean DEFAULT false,
	"birth_cert_verified_at" timestamp with time zone,
	"venue_assignment_id" uuid,
	"physical_test_scheduled_at" timestamp with time zone,
	"assigned_district" varchar(30),
	"assigned_venue_name" varchar(200),
	"qr_invitation_code" varchar(64),
	"qr_invitation_issued_at" timestamp with time zone,
	"sms_notification_sent_at" timestamp with time zone,
	"physical_test_completed_at" timestamp with time zone,
	"physical_test_score_id" uuid,
	"final_decision_by_id" uuid,
	"final_decision_at" timestamp with time zone,
	"final_decision_notes" varchar(1000),
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_processing_code_unique" UNIQUE("processing_code"),
	CONSTRAINT "applications_qr_invitation_code_unique" UNIQUE("qr_invitation_code")
);
--> statement-breakpoint
CREATE TABLE "rcs_ops"."document_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"document_type" "rcs_ops"."document_type" NOT NULL,
	"is_notarized" boolean DEFAULT false,
	"notarization_reference" varchar(100),
	"minio_object_key" varchar(512),
	"minio_object_bucket" varchar(100),
	"file_size_bytes" integer,
	"mime_type" varchar(50),
	"virus_scan_status" varchar(20),
	"virus_scan_at" timestamp with time zone,
	"forensics_score" integer,
	"forensics_lane" "rcs_ops"."document_lane",
	"forensics_flags" jsonb,
	"forensics_completed_at" timestamp with time zone,
	"verified_via_api" boolean DEFAULT false,
	"api_verification_token" varchar(128),
	"api_verified_at" timestamp with time zone,
	"human_reviewed_by_id" uuid,
	"human_reviewed_at" timestamp with time zone,
	"human_review_decision" varchar(10),
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rcs_ops"."physical_test_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"vector_clock" jsonb NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"height_cm" integer,
	"weight_kg" integer,
	"run_3km_time_seconds" integer,
	"chest_cm" integer,
	"medical_fitness_status" varchar(20),
	"additional_notes" varchar(500),
	"device_signature" varchar(512) NOT NULL,
	"signed_payload_hash" varchar(64) NOT NULL,
	"capturing_officer_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now(),
	"sync_conflict_detected" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rdf_ops"."application_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" "rdf_ops"."application_status",
	"to_status" "rdf_ops"."application_status" NOT NULL,
	"reason" varchar(200),
	"performed_by" varchar(50) NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" varchar(128)
);
--> statement-breakpoint
CREATE TABLE "rdf_ops"."applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"processing_code" varchar(20) NOT NULL,
	"applicant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"category" "rdf_ops"."application_category" NOT NULL,
	"status" "rdf_ops"."application_status" DEFAULT 'DRAFT' NOT NULL,
	"nesa_index_number" varchar(20),
	"nesa_verification_request_id" varchar(128),
	"nesa_verified_at" timestamp with time zone,
	"hec_registration_number" varchar(50),
	"hec_verification_request_id" varchar(128),
	"hec_verified_at" timestamp with time zone,
	"declared_specialist_field" varchar(50),
	"academic_status" "rdf_ops"."academic_eligibility_status" DEFAULT 'PENDING' NOT NULL,
	"academic_eligibility_detail" jsonb,
	"rib_request_id" varchar(128),
	"criminal_clearance_status" "rdf_ops"."criminal_clearance_status" DEFAULT 'PENDING' NOT NULL,
	"criminal_clearance_at" timestamp with time zone,
	"document_lane" "rdf_ops"."document_lane",
	"document_forensics_score" integer,
	"document_forensics_flags" jsonb,
	"document_reviewed_by_id" uuid,
	"document_reviewed_at" timestamp with time zone,
	"document_review_decision" varchar(10),
	"document_review_notes" varchar(500),
	"venue_assignment_id" uuid,
	"physical_test_scheduled_at" timestamp with time zone,
	"assigned_district" varchar(30),
	"assigned_venue_name" varchar(200),
	"qr_invitation_code" varchar(64),
	"qr_invitation_issued_at" timestamp with time zone,
	"sms_notification_sent_at" timestamp with time zone,
	"sms_notification_status" varchar(20),
	"physical_test_completed_at" timestamp with time zone,
	"physical_test_score_id" uuid,
	"is_walk_in" boolean DEFAULT false NOT NULL,
	"medical_reviewed_by_id" uuid,
	"medical_reviewed_at" timestamp with time zone,
	"medical_fitness_status" varchar(20),
	"final_decision_by_id" uuid,
	"final_decision_at" timestamp with time zone,
	"final_decision_notes" varchar(1000),
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_processing_code_unique" UNIQUE("processing_code"),
	CONSTRAINT "applications_qr_invitation_code_unique" UNIQUE("qr_invitation_code")
);
--> statement-breakpoint
CREATE TABLE "rdf_ops"."document_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"document_type" "rdf_ops"."document_type" NOT NULL,
	"minio_object_key" varchar(512),
	"minio_object_bucket" varchar(100),
	"file_size_bytes" integer,
	"mime_type" varchar(50),
	"virus_scan_status" varchar(20),
	"virus_scan_at" timestamp with time zone,
	"forensics_score" integer,
	"forensics_lane" "rdf_ops"."document_lane",
	"forensics_flags" jsonb,
	"forensics_completed_at" timestamp with time zone,
	"verified_via_api" boolean DEFAULT false,
	"api_verification_token" varchar(128),
	"api_verified_at" timestamp with time zone,
	"human_reviewed_by_id" uuid,
	"human_reviewed_at" timestamp with time zone,
	"human_review_decision" varchar(10),
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rdf_ops"."physical_test_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"vector_clock" jsonb NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"height_cm" integer,
	"weight_kg" integer,
	"run_3km_time_seconds" integer,
	"chest_cm" integer,
	"medical_fitness_status" varchar(20),
	"additional_notes" varchar(500),
	"device_signature" varchar(512) NOT NULL,
	"signed_payload_hash" varchar(64) NOT NULL,
	"capturing_officer_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now(),
	"sync_conflict_detected" boolean DEFAULT false,
	"sync_conflict_resolution" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rnp_ops"."application_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" "rnp_ops"."application_status",
	"to_status" "rnp_ops"."application_status" NOT NULL,
	"reason" varchar(200),
	"performed_by" varchar(50) NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" varchar(128)
);
--> statement-breakpoint
CREATE TABLE "rnp_ops"."applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"processing_code" varchar(20) NOT NULL,
	"applicant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"category" "rnp_ops"."application_category" NOT NULL,
	"status" "rnp_ops"."application_status" DEFAULT 'DRAFT' NOT NULL,
	"nesa_index_number" varchar(20),
	"nesa_verification_request_id" varchar(128),
	"nesa_verified_at" timestamp with time zone,
	"hec_registration_number" varchar(50),
	"hec_verification_request_id" varchar(128),
	"hec_verified_at" timestamp with time zone,
	"declared_priority_field" varchar(50),
	"academic_status" "rnp_ops"."academic_eligibility_status" DEFAULT 'PENDING' NOT NULL,
	"academic_eligibility_detail" jsonb,
	"rib_request_id" varchar(128),
	"criminal_clearance_status" "rnp_ops"."criminal_clearance_status" DEFAULT 'PENDING' NOT NULL,
	"applied_criminal_threshold" varchar(30),
	"criminal_clearance_at" timestamp with time zone,
	"document_lane" "rnp_ops"."document_lane",
	"document_forensics_score" integer,
	"document_forensics_flags" jsonb,
	"document_reviewed_by_id" uuid,
	"document_reviewed_at" timestamp with time zone,
	"document_review_decision" varchar(10),
	"registration_dpu_district" varchar(30),
	"venue_assignment_id" uuid,
	"physical_test_scheduled_at" timestamp with time zone,
	"assigned_district" varchar(30),
	"assigned_venue_name" varchar(200),
	"qr_invitation_code" varchar(64),
	"qr_invitation_issued_at" timestamp with time zone,
	"sms_notification_sent_at" timestamp with time zone,
	"physical_test_completed_at" timestamp with time zone,
	"physical_test_score_id" uuid,
	"final_decision_by_id" uuid,
	"final_decision_at" timestamp with time zone,
	"final_decision_notes" varchar(1000),
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_processing_code_unique" UNIQUE("processing_code"),
	CONSTRAINT "applications_qr_invitation_code_unique" UNIQUE("qr_invitation_code")
);
--> statement-breakpoint
CREATE TABLE "rnp_ops"."document_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"document_type" "rnp_ops"."document_type" NOT NULL,
	"minio_object_key" varchar(512),
	"minio_object_bucket" varchar(100),
	"file_size_bytes" integer,
	"mime_type" varchar(50),
	"virus_scan_status" varchar(20),
	"virus_scan_at" timestamp with time zone,
	"forensics_score" integer,
	"forensics_lane" "rnp_ops"."document_lane",
	"forensics_flags" jsonb,
	"forensics_completed_at" timestamp with time zone,
	"verified_via_api" boolean DEFAULT false,
	"api_verification_token" varchar(128),
	"api_verified_at" timestamp with time zone,
	"human_reviewed_by_id" uuid,
	"human_reviewed_at" timestamp with time zone,
	"human_review_decision" varchar(10),
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rnp_ops"."physical_test_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"vector_clock" jsonb NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"height_cm" integer,
	"weight_kg" integer,
	"run_3km_time_seconds" integer,
	"chest_cm" integer,
	"medical_fitness_status" varchar(20),
	"additional_notes" varchar(500),
	"device_signature" varchar(512) NOT NULL,
	"signed_payload_hash" varchar(64) NOT NULL,
	"capturing_officer_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now(),
	"sync_conflict_detected" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public_core"."applicant_sessions" ADD CONSTRAINT "applicant_sessions_applicant_id_applicant_identities_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public_core"."applicant_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_core"."campaign_venue_assignments" ADD CONSTRAINT "campaign_venue_assignments_campaign_id_recruitment_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public_core"."recruitment_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rcs_ops"."application_status_history" ADD CONSTRAINT "application_status_history_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "rcs_ops"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rcs_ops"."applications" ADD CONSTRAINT "applications_applicant_id_applicant_identities_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public_core"."applicant_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rcs_ops"."document_records" ADD CONSTRAINT "document_records_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "rcs_ops"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rcs_ops"."physical_test_scores" ADD CONSTRAINT "physical_test_scores_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "rcs_ops"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rdf_ops"."application_status_history" ADD CONSTRAINT "application_status_history_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "rdf_ops"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rdf_ops"."applications" ADD CONSTRAINT "applications_applicant_id_applicant_identities_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public_core"."applicant_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rdf_ops"."document_records" ADD CONSTRAINT "document_records_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "rdf_ops"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rdf_ops"."physical_test_scores" ADD CONSTRAINT "physical_test_scores_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "rdf_ops"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rnp_ops"."application_status_history" ADD CONSTRAINT "application_status_history_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "rnp_ops"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rnp_ops"."applications" ADD CONSTRAINT "applications_applicant_id_applicant_identities_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public_core"."applicant_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rnp_ops"."document_records" ADD CONSTRAINT "document_records_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "rnp_ops"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rnp_ops"."physical_test_scores" ADD CONSTRAINT "physical_test_scores_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "rnp_ops"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_log"."audit_entries" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_audit_agency" ON "audit_log"."audit_entries" USING btree ("agency");--> statement-breakpoint
CREATE INDEX "idx_audit_action" ON "audit_log"."audit_entries" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_performed_by" ON "audit_log"."audit_entries" USING btree ("performed_by");--> statement-breakpoint
CREATE INDEX "idx_audit_occurred_at" ON "audit_log"."audit_entries" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_audit_correlation" ON "audit_log"."audit_entries" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pc_national_id_hash" ON "public_core"."applicant_identities" USING btree ("national_id_hash");--> statement-breakpoint
CREATE INDEX "idx_pc_identity_status" ON "public_core"."applicant_identities" USING btree ("identity_status");--> statement-breakpoint
CREATE INDEX "idx_pc_phone_hash" ON "public_core"."applicant_identities" USING btree ("phone_number_hash");--> statement-breakpoint
CREATE INDEX "idx_pc_created_at" ON "public_core"."applicant_identities" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pc_session_token" ON "public_core"."applicant_sessions" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "idx_pc_session_applicant" ON "public_core"."applicant_sessions" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "idx_pc_session_expires" ON "public_core"."applicant_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_pc_venue_campaign" ON "public_core"."campaign_venue_assignments" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_pc_venue_district" ON "public_core"."campaign_venue_assignments" USING btree ("district");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pc_venue_campaign_district" ON "public_core"."campaign_venue_assignments" USING btree ("campaign_id","district");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pc_campaign_label" ON "public_core"."recruitment_campaigns" USING btree ("campaign_label");--> statement-breakpoint
CREATE INDEX "idx_pc_campaign_agency" ON "public_core"."recruitment_campaigns" USING btree ("agency");--> statement-breakpoint
CREATE INDEX "idx_pc_campaign_status" ON "public_core"."recruitment_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_rcs_status_hist_app" ON "rcs_ops"."application_status_history" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rcs_processing_code" ON "rcs_ops"."applications" USING btree ("processing_code");--> statement-breakpoint
CREATE INDEX "idx_rcs_applicant_id" ON "rcs_ops"."applications" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "idx_rcs_campaign_id" ON "rcs_ops"."applications" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_rcs_status" ON "rcs_ops"."applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_rcs_document_lane" ON "rcs_ops"."applications" USING btree ("document_lane");--> statement-breakpoint
CREATE INDEX "idx_rcs_academic_status" ON "rcs_ops"."applications" USING btree ("academic_status");--> statement-breakpoint
CREATE INDEX "idx_rcs_category" ON "rcs_ops"."applications" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_rcs_criminal_status" ON "rcs_ops"."applications" USING btree ("criminal_clearance_status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rcs_qr_code" ON "rcs_ops"."applications" USING btree ("qr_invitation_code");--> statement-breakpoint
CREATE INDEX "idx_rcs_docs_application" ON "rcs_ops"."document_records" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_rcs_docs_type" ON "rcs_ops"."document_records" USING btree ("document_type");--> statement-breakpoint
CREATE INDEX "idx_rcs_scores_application" ON "rcs_ops"."physical_test_scores" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_rdf_status_hist_app" ON "rdf_ops"."application_status_history" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_rdf_status_hist_time" ON "rdf_ops"."application_status_history" USING btree ("performed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rdf_processing_code" ON "rdf_ops"."applications" USING btree ("processing_code");--> statement-breakpoint
CREATE INDEX "idx_rdf_applicant_id" ON "rdf_ops"."applications" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "idx_rdf_campaign_id" ON "rdf_ops"."applications" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_rdf_status" ON "rdf_ops"."applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_rdf_document_lane" ON "rdf_ops"."applications" USING btree ("document_lane");--> statement-breakpoint
CREATE INDEX "idx_rdf_academic_status" ON "rdf_ops"."applications" USING btree ("academic_status");--> statement-breakpoint
CREATE INDEX "idx_rdf_criminal_status" ON "rdf_ops"."applications" USING btree ("criminal_clearance_status");--> statement-breakpoint
CREATE INDEX "idx_rdf_district" ON "rdf_ops"."applications" USING btree ("assigned_district");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rdf_qr_code" ON "rdf_ops"."applications" USING btree ("qr_invitation_code");--> statement-breakpoint
CREATE INDEX "idx_rdf_docs_application" ON "rdf_ops"."document_records" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_rdf_docs_type" ON "rdf_ops"."document_records" USING btree ("document_type");--> statement-breakpoint
CREATE INDEX "idx_rdf_docs_lane" ON "rdf_ops"."document_records" USING btree ("forensics_lane");--> statement-breakpoint
CREATE INDEX "idx_rdf_scores_application" ON "rdf_ops"."physical_test_scores" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_rdf_scores_device" ON "rdf_ops"."physical_test_scores" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "idx_rdf_scores_captured" ON "rdf_ops"."physical_test_scores" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "idx_rnp_status_hist_app" ON "rnp_ops"."application_status_history" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_rnp_status_hist_time" ON "rnp_ops"."application_status_history" USING btree ("performed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rnp_processing_code" ON "rnp_ops"."applications" USING btree ("processing_code");--> statement-breakpoint
CREATE INDEX "idx_rnp_applicant_id" ON "rnp_ops"."applications" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "idx_rnp_campaign_id" ON "rnp_ops"."applications" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_rnp_status" ON "rnp_ops"."applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_rnp_document_lane" ON "rnp_ops"."applications" USING btree ("document_lane");--> statement-breakpoint
CREATE INDEX "idx_rnp_academic_status" ON "rnp_ops"."applications" USING btree ("academic_status");--> statement-breakpoint
CREATE INDEX "idx_rnp_category" ON "rnp_ops"."applications" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rnp_qr_code" ON "rnp_ops"."applications" USING btree ("qr_invitation_code");--> statement-breakpoint
CREATE INDEX "idx_rnp_docs_application" ON "rnp_ops"."document_records" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_rnp_docs_type" ON "rnp_ops"."document_records" USING btree ("document_type");--> statement-breakpoint
CREATE INDEX "idx_rnp_scores_application" ON "rnp_ops"."physical_test_scores" USING btree ("application_id");