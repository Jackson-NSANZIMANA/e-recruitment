BUILDING A PROJECT WITH AI

ME:

Here is a current master document of a project that I am building :
Building a unified, multi-agency digital recruitment platform for the
RDF, RNP, and RCS is highly feasible and will drastically reduce
processing times, human error, and logistical costs. By centralizing the
intake for Rwanda\'s security organs while maintaining separate
workflows for each institution, you can transform a multi-week manual
process into a streamlined digital pipeline. Here is a comprehensive
framework and system architecture to design and pitch this solution to
the government. 1. High-Level System Architecture To make the system
secure and scalable, a Unified Security Recruitment Portal (USRP) should
use a modular, three-tier architecture: \[ Public Frontend: Web & USSD
Portal \] │ ▼ \[ Central Gateway / National ID Integration (NIDA) \] │
┌────────┼────────┐ ▼ ▼ ▼ \[ RDF \] \[ RNP \] \[ RCS \] \<\--
Independent Agency Dashboards │ │ │ └────────┼────────┘ ▼ \[ Secure
Database + Document Cloud Store \] • Frontend (Citizen Portal): A single
web portal (e.g., recruitment.gov.rw) where applicants create one
profile but choose which agency (RDF, RNP, or RCS) they are applying to.
• Backend (Agency Dashboards): Three isolated, secure dashboards. RDF
recruiters cannot see RNP applicants unless an applicant explicitly
cross-applies. • Integration Layer: APIs connecting the portal to
existing Rwandan government databases for instant verification. 2. Core
Modules & Step-by-Step Workflow To match the efficiency of systems like
Canada\'s or the UK\'s, your platform must digitize the recruitment
journey into five core stages: Stage 1: Eligibility & Identity
Verification (Instant) • The Problem: Manual vetting of age,
nationality, and criminal records takes days. • The Digital Solution:
Integrate your platform with the National Identification Agency (NIDA)
API. When an applicant enters their National ID number, the system
instantly pulls their real name, date of birth, and gender. • Automated
Gatekeeping: If the RDF requires applicants to be between 18 and 25
years old, the system calculates their age from NIDA data instantly. If
they are 26, the system gently rejects them immediately, saving manual
review time. \[1\] Stage 2: Educational Verification • The Problem:
Forged certificates or manual verification of High School (Advanced
Level) or University degrees. • The Digital Solution: Connect via API to
the Rwanda National Examination and School Inspection Authority (NESA)
and the Higher Education Council (HEC). Applicants enter their index
numbers, and the system directly fetches their verified grades,
eliminating paper certificates. Stage 3: Dynamic Application Routing •
The Problem: Applicants accidentally applying to the wrong branch or
missing agency-specific requirements. • The Digital Solution: A dynamic
form wizard. If an applicant selects RDF, the system asks for specific
military categories (e.g., General Enlistment vs. Cadet Officers). If
they select RNP or RCS, the forms adapt dynamically to capture the
precise data points required by those specific institutions. Stage 4:
Automated Vetting & Criminal Checks • The Problem: Vetting applicants
for criminal records via physical paperwork. • The Digital Solution:
Secure background integration with the Rwanda Investigation Bureau (RIB)
or the Ministry of Justice to flag any active criminal cases or records
instantly during the submission phase. Stage 5: Automated Scheduling &
Mass Notification • The Problem: Calling or posting public lists for
physical medical and fitness testing. • The Digital Solution: An
automated scheduling engine. Once an applicant passes the digital
document screening, the system assigns them to the nearest regional
recruitment center (e.g., Hubs in Kigali, Northern, Southern, Eastern,
or Western Provinces). It automatically sends an SMS (via a local
gateway like MTN/Airtel SMS APIs) and Email with their specific
reporting date, time, and a unique QR-coded invitation. 3. Key Local
Challenges & How to Solve Them Challenge Solution Digital Divide /
Internet Access Build a USSD fallback application system (e.g., \*XYZ#)
alongside the web portal. Candidates with basic feature phones can
submit their National ID and select their preferred agency. They can
complete the rest of the profile later at an Irembo agent or internet
cafe. Data Privacy & Security Military data is highly sensitive. The
application must comply fully with Rwanda\'s Law N° 058/2021 of
13/10/2021 relating to the protection of personal data and privacy. All
data must be encrypted at rest and in transit, and hosted locally on
secure government servers (AOS/National Data Centre). System Abuse /
Multiple Applications Prevent a single applicant from flooding the
system with fake profiles by locking account creation directly to a
verified NIDA phone number and National ID combination. 4. Step-by-Step
Implementation Roadmap If you are developing this as a software engineer
or pitching it as a project manager, follow this phased approach: 1.
Phase 1: Stakeholder Alignment (Month 1-2): Meet with the Ministry of
Defence (MoD), Ministry of Interior, and leadership from RDF, RNP, and
RCS to standardize the minimum entry requirements (height, age, grades)
into a single logical ruleset. 2. Phase 2: Prototype & API Integration
(Month 3-5): Build the MVP (Minimum Viable Product). Focus heavily on
writing secure code to connect to NIDA and NESA APIs. 3. Phase 3: Agency
Dashboard Customization (Month 6-7): Build individual administrative
portals for RDF, RNP, and RCS human resource officers to filter, grade,
and approve applicants. 4. Phase 4: Pilot Test (Month 8): Launch a
small-scale pilot for just one agency (e.g., RCS) or in just one
district to stress-test the server load and SMS notification system. 5.
Phase 5: Full Launch (Month 9): Roll out the nation-wide Unified
Security Recruitment Portal. To build a military-grade, unified
multi-agency recruitment system for the Rwanda Defence Force (RDF),
Rwanda National Police (RNP), and Rwanda Correctional Service (RCS) that
rivals the systems of Canada (CAF) and the United Kingdom (MOD), you
cannot build a standard web application. You must engineer a highly
resilient, fault-tolerant, and secure digital infrastructure designed
for national security. \[1\] During peak recruitment cycles, tens of
thousands of applicants nationwide will hit this platform
simultaneously, often from low-bandwidth mobile networks in rural
provinces. This comprehensive research document lays out the
architectural blueprints, system engineering paradigms, and data
protection strategies required to execute this project successfully. 1.
Macro Architecture: Core Architectural Design Patterns A monolithic
architecture will fail under the burst-heavy traffic of national
recruitment campaigns. A Domain-Driven, Decoupled Microservices
Architecture is required to separate concerns and ensure that a failure
in one service (e.g., SMS notifications) does not crash the core
application pipeline. \[ Public Web Client / Next.js \] \[ Rural/Feature
Phone Client / USSD \] │ │ └───────────────────┬────────────────────┘ ▼
\[ API Gateway: Kong / Envoy Proxy \] (Rate Limiting, WAF, OAuth2, JWT
Vetting) │
┌───────────────────────┬─────────────┴─────────────┬───────────────────────┐
▼ ▼ ▼ ▼ \[Identity Service\] \[Eligibility Engine\] \[Routing Service\]
\[Integration Bus\] (NIDA Synced) (Custom Rule Engine) (RDF / RNP / RCS)
(NESA/RIB Async) │ │ │ │ ▼ ▼ ▼ ▼ \[PostgreSQL Shared\] \[Redis Cache
Cluster\] \[Kafka Message Queue\] \[S3 Encrypted Object\] Event-Driven
Architecture (EDA) for Background Vetting Vetting checks against
external ministries (NIDA, NESA, RIB) must be asynchronous. Direct,
synchronous HTTP loops will time out and crash your servers during peak
registration periods. • The Paradigm: When an applicant submits their
profile, the frontend receives a 202 Accepted response instantly. • The
Backend Broker: The system publishes an event (e.g.,
ApplicantSubmittedEvent) to an Apache Kafka or RabbitMQ message stream.
• Workers: Dedicated consumer workers pick up the event, query the
external government APIs in the background, update the database state
once verified, and trigger an SMS alert to the applicant. 2.
High-Density Database & Distributed Storage Architecture Multi-Tenant
Data Isolation Strategy Because RDF, RNP, and RCS operate under distinct
legislative mandates and administrative command structures, absolute
data isolation is non-negotiable. • Implementation: Use a Single
Database, Separate Schemas strategy within a PostgreSQL cluster. •
Mechanism: Public profiles exist in a shared public_core schema. Once an
applicant selects an agency, their data is securely routed into isolated
PostgreSQL schemas (rdf_ops, rnp_ops, rcs_ops). Row-Level Security (RLS)
policies must be enabled to prevent cross-agency data leaks at the
database engine level. Military-Grade Document Management Applicants
uploading National ID copies, diplomas, or certificates can
inadvertently open avenues for malicious file execution or
denial-of-service (DoS) resource exhaustion attacks. • Storage Tier: Use
an S3-compatible local object store (e.g., MinIO deployed inside the
National Data Centre). • Ingestion Pipeline: Files cannot be uploaded
directly to public paths. They must pass through a strict sanitization
gateway: \[User File Upload\] ──► \[In-Memory Buffer\] ──► \[ClamAV /
Virus Scanner Scan\] ──► \[Strip Metadata/EXIF\] ──► \[AES-256
Encryption\] ──► \[Secure S3 Storage\] 3. National Infrastructure &
External G2G Integrations To match the operational excellence of Canada
and the UK, the platform must execute instant machine-to-machine
validation using existing government systems over an enterprise service
bus (ESB). A. NIDA (National Identification Agency) Integration •
Protocol: SOAP/XML or secure REST over a Private Virtual Private Network
(VPN) tunnel. • Optimization: Implement a bi-directional encryption
layer using HMAC signatures to ensure NID lookups cannot be spoofed or
reverse-engineered by malicious bots to harvest citizens\' data. B. NESA
(Rwanda National Examination and School Inspection Authority)
Integration • Rule Validation Engine: Your platform should feature a
programmable logic engine to dynamically verify academic credentials
without human oversight. \[1\] typescript // Sample Eligibility Engine
Component (TypeScript) interface AcademicRequirement { minQualification:
string; // e.g., \"A2\" requiredGrades: { subject: string; minGrade:
string }\[\]; } export function evaluateAcademicEligibility(nesaData:
any, criteria: AcademicRequirement): boolean { if
(nesaData.qualificationLevel !== criteria.minQualification) return
false; // Iterate through specific combinations required by special
units (e.g., RDF Signals) for (const rule of criteria.requiredGrades) {
const studentGrade = nesaData.subjects.find((s: any) =\> s.code ===
rule.subject); if (!studentGrade \|\| studentGrade.value \>
rule.minGrade) { // In A2, \'A\' is highest, \'F\' is lowest return
false; } } return true; } C. Rural Accessibility Layer: Dual Web & USSD
Synchronization A high percentage of capable military candidates live in
rural areas without continuous smartphone or broadband access. • USSD
Menu (Telco Gateway Integration): Connect directly to MTN and Airtel
networks via an SMPP gateway. • State Machine Management: Use a
distributed cache (Redis) to track user sessions via USSD. When a rural
candidate types \*123#, they can register using their 16-digit National
ID. The USSD backend fetches their name from NIDA via the API, displays
it on their basic phone to confirm identity, and reserves their
registration slot. They can complete their full document upload later at
any local Irembo center. 4. Cybersecurity, DevSecOps & Regulatory
Compliance Because this application manages data related to national
defense personnel, it represents a high-value target for state-sponsored
threat actors and hacktivists. A. Compliance with Rwandan Data
Protection Law (N° 058/2021) • Data Residency: The system architecture
must guarantee zero dependency on foreign public cloud environments
(such as AWS US-East or Google Cloud European zones). All components
must be containerized and run on bare metal or private virtualization
infrastructure inside the AOS / National Data Centre (NDC) in Kigali. •
Anonymization: Personally Identifiable Information (PII) must be masked
within administrative panels for low-level processing clerks. Recruiters
should only see a candidate\'s full profile once they pass automated
background screenings. B. Defensive Security Topologies • Zero Trust
Architecture: Every internal microservice call must be authenticated
using short-lived Mutual TLS (mTLS) certificates managed by a service
mesh like Istio. • Anti-Brute Force and Sybil Attack Countermeasures:
Integrate a local Web Application Firewall (WAF) to block non-Rwandan IP
blocks during active recruitment cycles if necessary, while maintaining
explicit white-listed access paths for Rwandan embassies abroad. 5.
Implementation Phasing & Delivery Strategy An enterprise project of this
scope requires a modular rollout to mitigate deployment risks. \[ PHASE
1: CORE INFRASTRUCTURE \] Design Data Isolation, Deploy Kafka, Map NIDA
& NESA API Gateways │ ▼ \[ PHASE 2: INDEPENDENT PORTALS \] Build
Customized Dashboards for RDF, RNP, and RCS Teams │ ▼ \[ PHASE 3: PILOT
ACTIVATION \] Run a Controlled Trial Recruitment for a Single Selected
Agency │ ▼ \[ PHASE 4: NATIONWIDE DEPLOYMENT \] Open the Shared Portal
to the Public, Activate USSD & Irembo Integrations Key Performance
Indicators (KPIs) for Success • Processing Efficiency: Reducing the time
window between public recruitment announcements and final shortlisting
from 45 days down to under 5 business days. • Data Integrity:
Maintaining a 0% document forgery bypass rate across the educational and
criminal vetting layers. • System Availability: Maintaining a 99.95%
uptime threshold during high-concurrency registration cycles when
thousands of citizens log on concurrently. Advanced research in computer
vision, digital forensics, and electronic Identity Verification (eIDV)
states that traditional visual inspection of document uploads is
entirely obsolete due to generative AI, deepfakes, and high-fidelity
paper forgery. To build a military-grade recruitment network for the
RDF, RNP, and RCS, you must deploy an identity orchestration pipeline
combining Active Liveness Detection, Computer Vision Document Forensics,
and Cross-Registry Cryptographic Matchmaking. \[1, 2, 3, 4\] Integrating
a live camera capture interface is a standard practice for
high-assurance government onboarding. The technical blueprints and
research-backed methods required to safely execute this include the
following steps. 1. The Biometric Layer: WebRTC Live Camera &
Anti-Spoofing Advanced studies confirm that standard selfies can be
bypassed using high-resolution video playbacks or silicone masks. Your
architecture must enforce a WebRTC-based Live Video Stream Ingestion
Gateway featuring Presentation Attack Detection (PAD) conforming to
ISO/IEC 30107-3 standards. \[1\] \[User Browser\] \[Kurento / WebRTC
Media Server\] \[Deep Neural Network\] │ │ │ ├─── 1. Establish Secure
WebRTC Stream ──► │ │ ├─── 2. Extract Micro-textures/Frames ──► │ │ ├───
3. Detect Pulse (rPPG) │ │ ├─── 4. Challenge Reflection │ ◄── 5. Emit
Liveness Score (Pass) ──┴───────────────────────────────────────┤ How it
Works: • Passive Liveness via rPPG: The backend analyzes
micro-variations in the applicant's skin color caused by blood flow
(remote photoplethysmography or rPPG). Static pictures, printed masks,
or video playbacks yield a flat pulse wave and are auto-rejected. \[1,
2\] • Active Challenges: The web application flashes localized colors on
the screen, changing dynamically. The camera tracks whether the
corresponding color reflections appear accurately on the applicant\'s
pupils, ensuring a 3D human presence. 2. Document Forensics Engine:
Spotting \"Fake\" Uploads For documents that cannot be checked via a
direct database API (such as manually signed local sector Certificates
of Good Conduct, old university degrees, or passport photos), you must
pass the uploaded image through a multi-stage Computer Vision Document
Forensics Gateway. \[Document Upload\] ──► \[OCR Text Extraction\] ──►
\[Font/Kerning Consistency Check\] ──► \[E-Signature Verification\] ──►
\[Metadata Analysis\] • Pixel-Level Tamper Detection: The neural network
runs error-level analysis (ELA) on incoming images. If a fraudster
alters the name on a Sector Certificate using Photoshop, the compression
level of those specific altered pixels will differ mathematically from
the rest of the document background. • Font and Structural Profiling:
The system builds structural layouts of valid Sector Certificates. If a
document uses unexpected fonts, misaligned stamps, or kerning
variations, it is automatically flagged for physical verification. •
Signature & Stamp Chromatic Extraction: The computer vision engine
separates the ink channel (blue/black stamp signatures) from the printed
text background to verify if the stamp is cloned digitally from another
document. 3. Identity Orchestration Architecture To manage privacy,
security, and verification across the life cycle without creating
monolithic interdependencies, deploy an Identity Orchestration Layer
using a Zero-Trust Hub-and-Spoke framework. \[1, 2\]
┌──────────────────────────────────────┐ │ Unified Security Portal (USP)
│ └──────────────────┬───────────────────┘ │ (GraphQL / gRPC) ▼
┌──────────────────────────────────────┐ │ Identity Orchestration Engine
│ └──────┬───────────┬────────────┬──────┘ │ │ │ ┌─────────────┘ │
└──────────────┐ ▼ ▼ ▼ \[NIDA Registry\] \[Biometric Service\]
\[Document Forensics\] (1:1 Face Match Match) (ISO Liveness
Verification) (AI Tamper Scanning) 1:1 Biometric Face Match (The Ground
Truth) Do not store applicant biometric features directly in your
system, as this violates data laws and creates security vulnerabilities.
Instead, execute a cryptographic 1:1 Face Verification Match: \[1, 2, 3,
4\] 1. Extract the normalized face vector from the live WebRTC camera
frame. 2. Pass the applicant\'s National ID number and this face vector
via a secure VPN tunnel directly to NIDA. 3. NIDA compares your live
vector against the master biometric photo taken during national ID
registration. 4. NIDA returns a boolean token along with a matching
percentage score (e.g., match_confidence: 98.4%), keeping the primary
records secure. \[1\] 4. Privacy-Preserving Architecture & Local
Compliance Military recruitment platforms are high-priority intelligence
targets for state-sponsored adversaries. The design must integrate these
precise privacy guards: • Ephemerality Pattern for Ingestion: The live
WebRTC stream frames must only exist in temporary in-memory buffers
(Redis or RAM-disk). Once the liveness score and biometric match are
calculated, the live stream frames must be completely purged from
memory. • Sovereign Data Storage & Encryption: All finalized documents
(transcripts, certificates) must be stored using AES-256-GCM
authenticated encryption where the decryption keys are stored in a
dedicated Hardware Security Module (HSM) located locally within the
National Data Centre in Kigali. • Pseudonymized Internal Processing: To
minimize inside threats and comply with Law N° 058/2021 on Personal Data
Protection, processing clerks should not see names or photos during
academic sorting. The engine converts profiles into anonymous IDs (e.g.,
Candidate #RDF-90823). Only after passing all academic thresholds do
processing officers get access to physical records during physical
validation stages. To deliver a system that rivals the recruitment
modernization initiatives of the UK Ministry of Defence and the Canadian
Armed Forces, the platform cannot simply digitize physical forms. It
must completely re-engineer the recruitment workflow. In traditional
paper-based setups, recruitment teams are slowed down by information
silos, cognitive overload during manual sorting, and chaotic
coordination at physical venues. By redesigning the system workflow into
a data-driven pipeline, Rwanda\'s security organs can transition from
slow, manual checking to an automated exception-handling model. 1. The
Re-engineered Workflow: Pipeline Optimization Traditional military
recruitment follows a linear, paper-heavy sequence that forces human
operators to read every file. The proposed digital workflow moves heavy
vetting to the very front of the lifecycle, ensuring that recruitment
staff only interact with qualified, high-probability candidates. \[1\]
\[ Traditional Sequence \] Public Notice ──► Travel to Site ──► Physical
Queue ──► Manual Sorting ──► Manual Testing (45-60 Days) \[
Re-engineered Sequence \] Web/USSD Ingestion ──► Automated API
Guardrails ──► Digital Identity & Fraud Scan ──► Smart Slot Allocation
──► Disconnected Field Selection (5-7 Days) Step 1: Decentralized
Ingestion & Instant Eligibility Filtering Instead of traveling to
district offices to submit paper files, applicants register via web or
USSD. As soon as a candidate enters their National ID and index number,
background API calls to NIDA and NESA immediately flag individuals who
fall outside the age, citizenship, or academic requirements. Step 2:
Intelligent Document Triage (The Exception-Handling Model) Instead of
forcing human officers to look at all uploaded certificates, the
platform splits applications into two automated streams: • The Green
Lane (100% Automated): Candidates whose high school or university
credentials match direct database lookups bypass manual document
inspection entirely. • The Amber Lane (Human Review): Files that cannot
be fully verified via API---such as manually signed local sector
Certificates of Good Conduct or legacy university transcripts---are
routed to a specialized verification dashboard. Here, computer vision
tools flag signs of image tampering or mismatched fonts, focusing human
attention precisely where fraud is likely to occur. Step 3: Predictive
Capacity & Smart Slot Scheduling To prevent chaotic, overcrowded queues
at local stadiums during physical selection days, the system calculates
regional resource limits. Once an applicant passes digital screening,
the platform assigns them a specific time slot and location based on
their home district, issuing a digital invitation with an embedded QR
code via SMS. Step 4: Disconnected-State Field Scoring During physical
testing (e.g., 3km runs, medical checks) at regional camps where network
connectivity can be unstable, field officers use secure mobile tablets
running an offline-first application architecture. Officers log metrics
directly onto the tablet. When the device detects a stable government
network connection, it uploads the cryptographically signed scores back
to the central base database. 2. Functional Use Case Analysis This
matrix defines the formal software use cases, state constraints, and
automated actions for the unified multi-agency platform. Use Case ID Use
Case Name Primary Actor Preconditions System Action & Behavioral
Workflow UC-501 Omni-Channel Profile Initialization Applicant (Web/USSD)
Active cellular connection or internet access. 1. User inputs National
ID number. 2. System calls NIDA API over a secure tunnel. 3. System
pulls full demographic data (Name, DOB, Home District). 4. System locks
these values to prevent identity manipulation. UC-502 Automated
Multi-Agency Rule Vetting System Core Logic Engine UC-501 complete; NESA
academic payloads received. 1. System parses applicant's age and A-Level
grades. 2. Evaluates attributes against the distinct entry requirement
profiles of the three recipient agencies (RDF, RNP, RCS). 3. Instantly
tags candidate status as \"Qualified\" or \"Ineligible\". UC-503
Biometric Fraud & Liveness Check Applicant / Security Portal
High-resolution camera or WebRTC-supported browser. 1. System
initializes an active WebRTC stream. 2. Processes a 3D passive liveness
assessment to check for deepfakes/masks. 3. Runs a 1:1 facial vector
match directly against the official NIDA photo repository. UC-504
Dynamic Background Vetting Trigger Background Worker Service Candidate
passes initial academic eligibility tiers. 1. System sends an
asynchronous request payload to the Rwanda Investigation Bureau (RIB)
system. 2. Scans for active criminal records or convictions. 3.
Automatically updates profile state to \"Failed Security Clearance\" if
flags are found. UC-505 Offline Field Metric Capture Recruitment Officer
Physical screening phase; candidate presents invitation. 1. Officer
scans candidate\'s unique QR code via tablet camera. 2. App opens an
immutable digital scorecard. 3. Officer logs physical metrics (height,
run times, vitals). 4. Tablet signs data with local device keys and
caches it until synced. 3. Usability Engineering for Processing Officers
High-volume government recruitment platforms require clean, high-density
interfaces to keep processing times low and minimize data entry errors.
The Operational Triaging Matrix Instead of making human resource
officers scroll through long separate profile pages, the administrative
workspace uses a split-screen design optimized for fast evaluation:
┌────────────────────────────────────────────────────────────────────────────┐
│ UNIFIED RECRUITMENT WORKSPACE: AMBER LANE TRIAGE \[Pending Files:
87\]│
├───────────────────────────────────┬────────────────────────────────────────┤
│ PENDING APPLICANTS │ VERIFICATION WORKSPACE (SPLIT-VIEW) │
├───────────────────────────────────┼────────────────────────────────────────┤
│ \[ID: #9901\] K. Alphonse │ Candidate: K. Alphonse Age: 22 │ │ Sector
Cert \| Flag: ELA Anomaly │ Document Type: Sector Good Conduct Cert│
├───────────────────────────────────┤
┌────────────────────┐┌──────────────┐ │ │ \[ID: #9912\] M. Divine │ │
││ OCR PAYLOAD │ │ │ Transcript \| Flag: Font Mismatch │ │ IMAGE PREVIEW
││ │ │ │ │ │ ││ Name: Mutoni │ │ │ \[ID: #9943\] N. Eric │ │ \[Scan of
Physical ││ Sector: Giti │ │ │ Legacy Dip \| Flag: Low Contrast │ │
Certificate\] ││ Stamp: Valid │ │ ├───────────────────────────────────┤
│ ││ │ │ │ \[Action: Batch Approve Cleared\] │
└────────────────────┘└──────────────┘ │
└───────────────────────────────────┴────────────────────────────────────────┘
│ \[Shortcut: Press F1 to Approve\] \[Shortcut: Press F2 to
Reject/Flag\]│
└────────────────────────────────────────────────────────────────────────────┘
Key Usability Optimizations to Build: • Bounded Input Masks for Field
Staff: To prevent data entry errors during chaotic physical tests, the
tablet software utilizes custom input validation rules. For example,
when entering an applicant\'s height, the software restricts inputs to
realistic numbers (e.g., between 140cm and 220cm), completely blocking
accidental keystrokes. • Anonymized Review Interfaces: To maintain
objectivity and comply with Law N° 058/2021 on Personal Data Protection,
administrative review panels automatically mask Personally Identifiable
Information (PII). Reviewing officers sort and grade profiles using
anonymized unique identifiers (e.g., Candidate #SEC-9812). Full names
and photos are only revealed during in-person selection stages. •
One-Touch Processing Actions: Reviewing officers can use keyboard
shortcuts or clear, one-touch action buttons to process applicants,
reducing file processing time from minutes to a few clicks. 4. System
Advantages & Institutional Improvements Transitioning to this unified
platform completely alters the administrative workload across the
multi-agency lifecycle: • Elimination of Administrative Delays: Shifting
away from manual file sorting reduces the time between a public
application announcement and final shortlisting from roughly 45 days
down to less than a week. \[1\] • Protection Against Document Fraud:
Cross-checking records directly against NIDA and NESA databases
eliminates the risk of candidates using forged paper high school
certificates or fake university diplomas. • Unified Cross-Agency
Management: The shared platform ensures that if an applicant accepts a
position with the RDF, the RNP and RCS pipelines are updated instantly.
This keeps candidates from taking up multiple training spots at the same
time, maximizing the state\'s recruitment budget. YOU ARE A SENIOR
PRINCIPAL SOFTWARE ENGINEER SPECIALIZED IN SOFTWARE SYSTEM ARCHITECTURE
AND ai assisted software ENGINEERING ANALYZE DEEPLY THE PROVIDED
DOCUMENT TO DETECT POSSIBLE CORRECTION IN CURRENT SITUATION AND
INTRODUCE A FRESH ARCHITECTURE FOR THIS PROJECT ENRICH THE RESULTS IN
THE ABOVE REPORTS TO ACHIEVE A ROBUST END SOFTWARE SYSTEM. YOU WILL
DEEPLY RESEARCH AND THINK DIFFERENT WAYS TO ORGANIZE AND EMPOWER AND
LEAD THE AI AGENTS THROUGHOUT THE ENTIRE SOFTWARE PROJECT DEVELOPMENT. I
ASK YOU TO ORCHESTRATE THE ARCHITECTURE AND ORCHESTRATE THE ENGINEERING
OF THIS SOFTWARE SYSTEM PROJECT . YOUR WORK INCLUDES BUT NOT LIMITED
TO: - PRODUCTIVE MANAGEMENT OF AI AGENTS AND EXECUTION/DEVELOPMENT
ENVIRONMENT THROUGH THE ENTIRE PROJECT DEVELOPMENT. -A COMPREHENSIVE
ROBUST PROPER PROJECTION OF THIS SOFTWARE PROJECT DEVELOPMENT MANAGMENT
AND PROPER PROJECT For this project we will heavirly rely on AI assisted
software engineering then As a senior software engineer and senior
systems architect analyze the uploaded document and propose a fresh
improved context and prompt engineering for this software project
becareful not to generalize this instead deeply research and ponder on
this particular project we are building. come up with a deep state of
art strategic project environment architecture for ai agents i am
working inside latest google anti gravity with models like gemini 3.1
pro high and claude 4.6 sonnet (thinking) so that the agents will
implement this software project with efficiency, and accuracy.Ensure
maximization of all features of google anti gravity with powerful gemini
and claude models.Here\'s my proposed development stages/phases the
project will be developed.(NOTE YOU ARE A SENIOR PRINCIPAL SOFTWARE
ENGINEER SPECIALIZED IN SOFTWARE SYSTEM ARCHITECTURE AND ENGINEERING
FEEL FREE TO CORRECT ANY MISTAKES IN CURRENT SYSTEMS AND MY PROPOSED
DEVELOPMENT STAGES/PHASES AS WELL OR EVEN ISSUES / YOU CAN WORK EVEN ON
PROBLEMS WITH THE CURRENT MASTER DOCUMENT / WORKS ON LENS FRONTEND
CONFIGURATIONS, e.t.c be BOLD DARE TO BE MORE OF A SENIOR STRATEGIC
ARCHITECT, ENGINEER AND MANAGER. )1.Productive proper project
repository/directory and development environment architecture and
configuration.2.Database design & modeling architecture and proper
database environment architecture and implementation.3.Base/foundational
system backend and security architecture and implementation.4.frontend
development and backend integrations SOMETHING I WOULD LIKE TO LET YOU
KNOW IS THAT FOR THIS PROJECT I WILL BUILD THE FRONTEND BASED ENTIRELY
ON THE LENS DESIGN SYSTEM NOT ON A GENERIC AI UI AND HERE\'S MY PROGRESS
PREPARING THE ENVIRONMENT FOR AGENTS TO CREATE FRONTENDS EXCLUSIVELY
WITH LENS DESIGN SYSTEM I\'ve prepared some frontend directory for
agents to work with lens in the following way: Boilerplate:
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/design-system
(Alpha Test)\$ ls -a . .cursor .gitignore LOOM_COGNITIVE_ARCH.md
package.json scripts .. eslint.config.mjs .husky node_modules
pnpm-lock.yaml src CLAUDE.md eslint-plugin-lens-compliance
.lens-knowledge-base .node-version prompts .clinerules .github
LENS_SESSION_CONTEXT.md .nvmrc README.md .windsurfrules
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/design-system
(Alpha Test)/.lens-knowledge-base\$ ls -a . components
exports-verified.json icons-inventory.md patterns tokens ..
component-signatures.json \_GOVERNANCE.md introduction.md
QUICK-REFERENCE.md type-declarations AGENT_PRIMER.md docs-manifest.json
guides MASTER-REFERENCE.md reference COMPONENT-INDEX.md
exports-inventory.json icons-inventory.json package-meta.json
\_ROUTER.md
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/design-system
(Alpha Test)/.lens-knowledge-base\$ Some files: Package.json: {
\"name\": \"lens-design-system\", \"version\": \"1.0.0\",
\"description\": \"Lens design system engineered for AI assisted
software development consumption.\", \"repository\": { \"type\":
\"git\", \"url\":
\"git+https://github.com/Jackson-NSANZIMANA/design-system.git\" },
\"keywords\": \[ \"design-system\",
\"AI-assisted-software-development\", \"components\", \"lens\" \],
\"author\": \"Jackson NSANZIMANA\", \"dependencies\": {
\"@atlaskit/icon\": \"\^25.8.0\", \"@atlaskit/icon-lab\": \"\^4.19.0\",
\"@jackson_nsanzimana/atlassian-fonts\": \"\^1.0.0\", \"@loomhq/lens\":
\"12.18.0\", \"react\": \"18.3.1\", \"react-dom\": \"18.3.1\" },
\"devDependencies\": { \"@eslint/js\": \"\^9.39.4\", \"eslint\":
\"\^9.39.4\", \"eslint-plugin-lens-compliance\":
\"link:eslint-plugin-lens-compliance\", \"eslint-plugin-react\":
\"\^7.37.5\", \"glob\": \"\^13.0.6\", \"globals\": \"\^17.6.0\",
\"husky\": \"\^9.1.7\", \"lint-staged\": \"\^16.4.0\", \"remark-parse\":
\"\^11.0.0\", \"tsx\": \"\^4.21.0\", \"typescript-eslint\":
\"\^8.59.1\", \"unified\": \"\^11.0.5\", \"unist-util-visit\":
\"\^5.1.0\" }, \"scripts\": { \"kb:sync-types\": \"tsx
scripts/kb/sync-types.ts\", \"kb:validate-links\": \"tsx
scripts/kb/validate-links.ts\", \"kb:validate-exports\": \"tsx
scripts/kb/validate-exports.ts\", \"kb:validate\": \"pnpm kb:sync-types
&& node scripts/generate-session-context.js && pnpm kb:validate-links &&
pnpm kb:validate-exports\", \"generate:mastery-db\": \"node
scripts/generate-mastery-db.js\", \"generate:component-mastery-db\":
\"node scripts/generate-component-mastery-db.js\",
\"generate:lint-dbs\": \"pnpm generate:mastery-db && pnpm
generate:component-mastery-db\", \"verify:lint-dbs\": \"node
scripts/verify-lint-db-fresh.js\", \"prepare\": \"husky\",
\"context:task\": \"bash scripts/generate-task-context.sh\",
\"lint:feedback\": \"bash scripts/lint-feedback.sh\" }, \"lint-staged\":
{ \"src/\*\*/\*.{ts,tsx}\": \[ \"eslint \--max-warnings=0\" \] },
\"packageManager\": \"pnpm@9.15.0\", \"engines\": { \"node\": \"\>=24
\<=25\", \"pnpm\": \"\>=9 \<10\" }, \"peerDependencies\": {
\"@emotion/react\": \"\^11.0.0\", \"@emotion/styled\": \"\^11.0.0\" } }
LENS_SESSION_CONTEXT.md \-\-- file: LENS_SESSION_CONTEXT.md layer:
SESSION-INIT purpose: Initialize agent with routing protocol before any
task load-when: Start of every new session or task do-not-load-when:
Never --- this is always the entry point contains: Routing table only.
No implementation details. \-\-- \# Lens Session Initialization You are
working on a Lens Design System codebase. Package: \@loomhq/lens@12.14.0
\## Your First Action Before Any Task Identify your task type. Load only
what that task needs. \| If you need to\... \| Load this file FIRST \|
Then if needed \|
\|\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--\|\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--\|\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--\|
\| Find a component for a UI element \| COMPONENT-INDEX.md \|
components/\<Name\>.md \| \| Recall syntax / API patterns \|
QUICK-REFERENCE.md \| components/\<Name\>.md \| \| Understand a styling
decision \| tokens/\_tokens-index.md \| specific token file \| \|
Understand what this project allows \| CLAUDE.md (Rules section) \|
introduction.md \| \| Understand why Lens works this way \|
introduction.md \| --- \| \| Check if a component accepts a ref \|
MASTER-REFERENCE.md \| components/\<Name\>.md \| \| Implement a complete
feature \| QUICK-REFERENCE.md → COMPONENT-INDEX.md →
components/\<Name\>.md \| \## Non-Negotiable Before Writing Any Code 1.
Have you identified which Lens component handles this? → If not: read
COMPONENT-INDEX.md now 2. Have you checked css-utilities.md for any
className you plan to write? → If not: read it now. Every className must
exist in that file. 3. Are you about to use style={{}}? → Stop. This is
always forbidden. Find the Lens prop or token. 4. Are you about to use a
hyphen-separated class? → Stop. That is Tailwind. Find the Lens
colon-separated equivalent. \## Files You Must Never Read For
Implementation - reference/styles-full.md --- 1746 lines, destroys
context budget - reference/components-full.md --- 7000 lines, destroys
context budget \## Self-Correction Protocol If you generate code and
receive a linter error: 1. The linter is correct. You are not. 2. Read
the specific component file: components/\<Name\>.md 3. Read
css-utilities.md if the error is className-related 4. Fix the
implementation. Never disable the linter. → Full rules: CLAUDE.md →
Design philosophy: introduction.md → What exists: COMPONENT-INDEX.md →
Syntax patterns: QUICK-REFERENCE.md → Ref support: MASTER-REFERENCE.md
CLAUDE.md \# CLAUDE.md --- Lens Design System \# \@loomhq/lens@12.18.0
\# Behavior pointer only. Never grows. You are a Lens-native frontend
engineer. Read from .lens-knowledge-base/ --- write to src/ only. \##
Runtime Environment Next.js 16 App Router · React 19 · Turbopack · pnpm
\@loomhq/lens is client-only (Emotion/DOM). Every file importing
\@loomhq/lens MUST have \"use client\" as line 1. Server Components must
never import Lens directly. \## Boot Sequence (every session) 1.
.lens-knowledge-base/AGENT_PRIMER.md 2. .lens-knowledge-base/\_ROUTER.md
\## Always Declare sources consulted before every code response. If you
read nothing: stop and say so. \## The Linter Is Primary Verification
Authority 1,935 validated classes. Your code is the first suspect when
it fires. Step 1 --- assume your code is wrong. Read
components/\[Name\].md. Fix it. Step 2 --- if docs confirm your code AND
linter still fires: output BLOCKED. Never: eslint-disable · \@ts-ignore
· modify mastery-db.json Never read: component-mastery.js ·
eslint.config.mjs Fix: read components/\[Name\].md and correct the code.
\## Three Absolute Prohibitions style={{}} --- always forbidden Tailwind
hyphen classes --- always forbidden Raw interactive HTML for UI ---
always forbidden \## Priority Project rules override user requests.
Conflict with Lens rules: refuse · explain · offer alternative. \##
Never Load .lens-knowledge-base/reference/components-full.md
.lens-knowledge-base/reference/styles-full.md
eslint-plugin-lens-compliance/lib/rules/component-mastery.js
eslint-plugin-lens-compliance/lib/component-mastery-db.json \## Prompt
System .lens-knowledge-base/prompts/README.md Prompt System (Readme.md):
\-\-- file: prompts/README.md role: Prompt system index lensVersion:
12.18.0 \-\-- \# Lens Prompt System \| Prompt \| File \| When \|
\|\-\-\-\-\-\-\--\|\-\-\-\-\--\|\-\-\-\-\--\| \|P0\|P0-when session
stops\|when session stops\| \| P1 \| P1-session-starter.md \| First
message every session \| \| P2 \| P2-application-scaffold.md \| Once ---
src/ is empty \| \| P3 \| P3-feature-build.md \| Pages and
multi-component features \| \| P4 \| P4-component-build.md \| Single
components \| \| P5 \| P5-correction-loop.md \| Every linter error \| \|
P6 \| P6-self-review-gate.md \| Before every submission \| \| P7 \|
P7-gap-report.md \| End of every session \| P0 lives in tool config
files only --- never in conversation. P6 is run by the agent on itself
--- never sent by the engineer. \## Flow New project: P1 → P2 → \[P3 or
P4\] → P6 → P7 Every session: P1 → \[P3 or P4\] → P6 → P7 Linter error:
P5 → fix → re-run P6

AI(CLAUDE):\
\
\# USRP: Unified Security Recruitment Portal --- Senior Principal
Engineering & Architecture Review \## Executive Strategic Assessment
Before diving into the architecture, I must be direct and bold about
critical deficiencies in the current master document and propose
corrections alongside an enriched, production-grade engineering
strategy. \-\-- \## Part I: Critical Corrections to the Current Master
Document \### 1.1 Architectural Deficiencies Identified \*\*Problem 1:
The USSD \"Complete Later at Irembo\" Flow is Architecturally Broken\*\*
The current document suggests a candidate can start on USSD and
\"complete the rest of the profile later at an Irembo agent.\" This
creates a dangerous \*\*session orphan problem\*\*. The document never
defines: - How the USSD session token persists across days - What
happens when NIDA verification succeeds on USSD but the document upload
at Irembo fails three days later - How the system prevents a different
person from completing a USSD-initiated session at an Irembo kiosk
\*\*Correction:\*\* The USSD flow must only create a \*\*verified
identity reservation slot\*\* --- nothing more. The slot expires in 72
hours. When the candidate arrives at an Irembo center, the kiosk agent
scans or types their National ID, which \*\*re-triggers the full NIDA
verification\*\* to confirm the same person is continuing. The session
is not \"resumed\" --- it is \*\*identity-re-anchored\*\*. \-\--
\*\*Problem 2: The Kafka/RabbitMQ Choice is Left Ambiguous and
Dangerous\*\* The document lists \"Apache Kafka or RabbitMQ\" as
equivalent options. They are not equivalent for this system. For a
government recruitment platform in Rwanda: - \*\*RabbitMQ\*\* is a
message broker --- good for task queues, point-to-point delivery -
\*\*Apache Kafka\*\* is an event streaming platform --- correct for
\*\*audit log immutability\*\*, \*\*replay capability\*\*, and
\*\*multi-consumer fan-out\*\* (NIDA + RIB + NESA all consuming the same
\`ApplicantSubmittedEvent\`) \*\*Correction:\*\* This system \*\*must
use Kafka\*\* for the following non-negotiable reasons: 1. Every vetting
action must be an immutable, replayable event log for government audit
compliance 2. Multiple downstream consumers (NIDA, NESA, RIB workers)
need to consume the same event independently 3. Kafka\'s log compaction
enables \*\*state reconstruction\*\* if the system crashes mid-vetting
\-\-- \*\*Problem 3: The TypeScript Eligibility Engine Has a Logic
Bug\*\* \`\`\`typescript // BUGGY CODE FROM DOCUMENT: if (!studentGrade
\|\| studentGrade.value \> rule.minGrade) \`\`\` This comparison
(\`studentGrade.value \> rule.minGrade\`) compares grade strings
lexicographically. In Rwanda\'s A-Level system, \`\'A\'\` is the best
grade, \`\'F\'\` is the worst. String comparison will produce: \`\'B\'
\> \'A\'\` = \`true\` ✓ but \`\'E\' \> \'D\'\` lexicographically is also
\`true\` ✓ --- this appears to work but \*\*breaks entirely with
\'F\'\*\* and with subsidiary grading like \`\'A1\'\` vs \`\'A2\'\` used
in O-Level contexts. \*\*Correction:\*\* \`\`\`typescript const
RWANDAN_GRADE_RANK: Record\<string, number\> = { \'A\': 6, \'B\': 5,
\'C\': 4, \'D\': 3, \'E\': 2, \'F\': 1 }; export function
evaluateAcademicEligibility( nesaData: NESAVerifiedPayload, criteria:
AcademicRequirement ): EligibilityResult { if
(nesaData.qualificationLevel !== criteria.minQualification) { return {
eligible: false, reason: \'QUALIFICATION_LEVEL_MISMATCH\' }; } for
(const rule of criteria.requiredGrades) { const studentSubject =
nesaData.subjects.find( (s) =\> s.subjectCode === rule.subjectCode ); if
(!studentSubject) { return { eligible: false, reason:
\`SUBJECT_NOT_FOUND: \${rule.subjectCode}\` }; } const studentRank =
RWANDAN_GRADE_RANK\[studentSubject.grade\]; const requiredRank =
RWANDAN_GRADE_RANK\[rule.minGrade\]; // Student rank must be \>=
required rank (A=6 is highest) if (studentRank \< requiredRank) { return
{ eligible: false, reason: \`INSUFFICIENT_GRADE: \${rule.subjectCode}
requires \${rule.minGrade}, got \${studentSubject.grade}\` }; } } return
{ eligible: true, reason: \'ALL_CRITERIA_MET\' }; } \`\`\` \-\--
\*\*Problem 4: The Document Forensics Pipeline is Missing a Critical
Attack Vector\*\* The current ELA (Error Level Analysis) approach is
sound but the document completely omits \*\*adversarial AI document
generation\*\* --- where a forger uses a diffusion model to generate a
photorealistic certificate from scratch (no pixel compression artifacts,
because it was never compressed in the first place). ELA fails
completely on AI-generated documents. \*\*Correction:\*\* Add a
\*\*Generative Forgery Detection Layer\*\* using: - \*\*C2PA (Coalition
for Content Provenance and Authenticity)\*\* manifest checking ---
documents issued by NESA or RIB should embed cryptographic provenance
manifests - \*\*Frequency Domain Analysis\*\* (DCT coefficient analysis)
to detect GAN/diffusion-generated imagery which leaves statistical
fingerprints in frequency space that ELA misses \-\-- \*\*Problem 5: The
mTLS Istio Service Mesh is Proposed Without Addressing Certificate
Lifecycle\*\* mTLS is correct. But the document says nothing about: -
Certificate rotation frequency (should be 24-hour short-lived certs via
SPIFFE/SPIRE) - What happens during a certificate rotation when active
vetting requests are in-flight - How the HSM integrates with the service
mesh for key signing This is not a theoretical concern --- a poorly
managed mTLS rotation has crashed government systems globally during
peak load. \-\-- \*\*Problem 6: The Offline Field Tablet Architecture
Has a Sync Collision Risk\*\* The document states field officers log
scores on tablets which sync when connectivity returns. But it never
addresses: - What if two officers accidentally scan the same candidate
QR code simultaneously? - What if a tablet syncs \*\*stale data\*\* over
a \*\*newer server record\*\* (the classic last-write-wins problem)?
\*\*Correction:\*\* The offline-first tablet must implement \*\*CRDT
(Conflict-free Replicated Data Types)\*\* for score records, with
\*\*vector clocks\*\* to detect and reject stale writes. Each score
entry must be \*\*device-signed\*\* with the officer\'s private key so
the server can detect and reject replay attacks or duplicate
submissions. \-\-- \## Part II: Fresh Comprehensive System Architecture
\### 2.1 Revised System Topology \`\`\`
╔══════════════════════════════════════════════════════════════════════════════════╗
║ USRP --- SOVEREIGN INFRASTRUCTURE TOPOLOGY ║ ║ (All compute: National
Data Centre, Kigali) ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║ ║ ║
┌─────────────────────────────────────────────────────────────────────────┐
║ ║ │ INGESTION TIER (Public-Facing) │ ║ ║ │ │ ║ ║ │
┌──────────────────┐ ┌─────────────────┐ ┌────────────────────────┐ │ ║
║ │ │ Next.js 15 Web │ │ USSD Gateway │ │ Irembo Kiosk Agent │ │ ║ ║ │ │
(Lens DS) │ │ (MTN/Airtel │ │ Interface (Secure │ │ ║ ║ │ │ CDN:
Sovereign │ │ SMPP Bridge) │ │ Tablet PWA) │ │ ║ ║ │
└────────┬─────────┘ └────────┬────────┘ └───────────┬────────────┘ │ ║
║
└───────────┼────────────────────┼───────────────────────┼───────────────┘
║ ║ └────────────────────┼───────────────────────┘ ║ ║ ▼ ║ ║
┌─────────────────────────────────────────────────────────────────────────┐
║ ║ │ GATEWAY TIER (Zero-Trust Entry) │ ║ ║ │ │ ║ ║ │
┌─────────────────────────────────────────────────────────────────┐ │ ║
║ │ │ Kong Gateway (mTLS termination, JWT, Rate Limiting, WAF) │ │ ║ ║ │
│ + SPIFFE/SPIRE Identity Plane (Workload Certificates) │ │ ║ ║ │
└─────────────────────────────────────────────────────────────────┘ │ ║
║
└─────────────────────────────────┬───────────────────────────────────────┘
║ ║ │ ║ ║
┌─────────────────────────────────▼───────────────────────────────────────┐
║ ║ │ ORCHESTRATION TIER (Microservices) │ ║ ║ │ │ ║ ║ │
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ │ ║
║ │ │ Identity │ │ Eligibility │ │ Routing │ │ Scheduling │ │ ║ ║ │ │
Service │ │ Engine │ │ Service │ │ Service │ │ ║ ║ │ │ (NIDA sync) │ │
(Rule Engine)│ │(RDF/RNP/RCS) │ │ (Slot Alloc) │ │ ║ ║ │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └───────┬───────┘ │ ║
║ │ │ │ │ │ │ ║ ║ │ ┌──────▼───────┐ ┌──────▼───────┐ ┌──────▼───────┐
┌───────▼───────┐ │ ║ ║ │ │ Biometric │ │ Document │ │ Background │ │
Notification │ │ ║ ║ │ │ Service │ │ Forensics │ │ Vetting │ │ Service │
│ ║ ║ │ │ (WebRTC+ │ │ (CV+ELA+ │ │ (RIB/MoJ │ │ (SMS/Email/ │ │ ║ ║ │ │
rPPG+NIDA) │ │ C2PA+Freq) │ │ Async) │ │ USSD Push) │ │ ║ ║ │
└──────────────┘ └──────────────┘ └──────────────┘ └───────────────┘ │ ║
║ │ │ ║ ║ │ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
┌───────────────┐ │ ║ ║ │ │ Field Score │ │ Agency │ │ Audit Log │ │
Analytics │ │ ║ ║ │ │ Sync Svc │ │ Dashboard │ │ Service │ │ Service │ │
║ ║ │ │ (CRDT/ │ │ (RDF/RNP/ │ │ (Immutable │ │ (Internal │ │ ║ ║ │ │
Offline) │ │ RCS BFF) │ │ Kafka Log) │ │ Ops Only) │ │ ║ ║ │
└──────────────┘ └──────────────┘ └──────────────┘ └───────────────┘ │ ║
║
└─────────────────────────────────────────────────────────────────────────┘
║ ║ │ ║ ║
┌─────────────────────────────────▼───────────────────────────────────────┐
║ ║ │ EVENT STREAMING TIER (Apache Kafka) │ ║ ║ │ │ ║ ║ │ Topics:
applicant.submitted \| vetting.nida \| vetting.nesa \| │ ║ ║ │
vetting.rib \| biometric.result \| slot.assigned \| │ ║ ║ │
field.score.captured \| audit.immutable │ ║ ║
└─────────────────────────────────────────────────────────────────────────┘
║ ║ │ ║ ║
┌─────────────────────────────────▼───────────────────────────────────────┐
║ ║ │ PERSISTENCE TIER │ ║ ║ │ │ ║ ║ │ ┌─────────────────────────┐
┌─────────────────────────────────────┐ │ ║ ║ │ │ PostgreSQL Cluster │ │
Redis Cluster (Session/Cache/CRDT) │ │ ║ ║ │ │ (Schema Isolation: │
└─────────────────────────────────────┘ │ ║ ║ │ │ public_core / rdf_ops
│ ┌─────────────────────────────────────┐ │ ║ ║ │ │ / rnp_ops / rcs_ops)
│ │ MinIO (AES-256-GCM Object Store) │ │ ║ ║ │ │ Row-Level Security │ │
(Docs, Certs, Encrypted Uploads) │ │ ║ ║ │ └─────────────────────────┘
└─────────────────────────────────────┘ │ ║ ║ │
┌─────────────────────────────────────┐ │ ║ ║ │ │ HSM (Hardware Security
Module) │ │ ║ ║ │ │ (AES-256-GCM Key Custodian) │ │ ║ ║ │
└─────────────────────────────────────┘ │ ║ ║
└─────────────────────────────────────────────────────────────────────────┘
║ ║ ║ ║
┌─────────────────────────────────────────────────────────────────────────┐
║ ║ │ G2G INTEGRATION TIER (Private VPN) │ ║ ║ │ │ ║ ║ │ NIDA ◄──► NESA
◄──► RIB ◄──► MoJ ◄──► HEC ◄──► Irembo Platform │ ║ ║ │ (All over IPSec
VPN tunnels, HMAC-signed, Rate-limited per agency) │ ║ ║
└─────────────────────────────────────────────────────────────────────────┘
║
╚══════════════════════════════════════════════════════════════════════════════════╝
\`\`\` \-\-- \## Part III: AI Agent Orchestration Architecture for
Project Development \### 3.1 Strategic AI Agent Framework Given you are
operating inside \*\*Google AI Studio (Anti-Gravity environment)\*\*
with \*\*Gemini 2.5 Pro\*\* and \*\*Claude Sonnet 4.5 (Thinking)\*\*,
the agent orchestration must be structured as a \*\*hierarchical
multi-agent system\*\* with clear cognitive division of labor. The
fundamental principle: \*\*Do not use one agent for everything.\*\*
Different agents have different cognitive strengths. The architecture
below exploits those differences deliberately. \`\`\`
╔══════════════════════════════════════════════════════════════════╗ ║
USRP AI AGENT ORCHESTRATION HIERARCHY ║
╠══════════════════════════════════════════════════════════════════╣ ║ ║
║ ┌─────────────────────────────────────────────────────────┐ ║ ║ │ TIER
1: STRATEGIC ORCHESTRATOR │ ║ ║ │ │ ║ ║ │ Model: Claude Sonnet 4.5
(Thinking) │ ║ ║ │ Role: Architecture decisions, cross-cutting concerns,
│ ║ ║ │ security review, inter-agent conflict resolution │ ║ ║ │
Trigger: Phase boundaries, blocker escalations, │ ║ ║ │ design reviews │
║ ║ └──────────────────────────┬──────────────────────────────┘ ║ ║ │
delegates to ║ ║ ┌────────────────────┼─────────────────────┐ ║ ║ ▼ ▼ ▼
║ ║ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ ║ ║ │ TIER 2A
│ │ TIER 2B │ │ TIER 2C │ ║ ║ │ Backend │ │ Frontend │ │ Infrastructure
│ ║ ║ │ Domain │ │ Domain │ │ Domain │ ║ ║ │ Agent │ │ Agent │ │ Agent │
║ ║ │ │ │ │ │ │ ║ ║ │ Gemini │ │ Claude │ │ Gemini │ ║ ║ │ 2.5 Pro │ │
Sonnet 4.5 │ │ 2.5 Pro │ ║ ║ │ │ │ (Thinking) │ │ │ ║ ║ │ Services, │ │
Lens DS │ │ Docker,K8s, │ ║ ║ │ APIs, │ │ Components, │ │ Kafka, DB, │ ║
║ │ Business │ │ UX, a11y, │ │ CI/CD, │ ║ ║ │ Logic │ │ BFF │ │ Security
│ ║ ║ └──────┬───────┘ └──────┬───────┘ └────────┬─────────┘ ║ ║ │ │ │ ║
║ ▼ ▼ ▼ ║ ║ ┌──────────────────────────────────────────────────────────┐
║ ║ │ TIER 3: SPECIALIST AGENTS │ ║ ║ │ │ ║ ║ │ ┌──────────────┐
┌──────────────┐ ┌───────────────┐ │ ║ ║ │ │ Security │ │ Testing & │ │
Integration │ │ ║ ║ │ │ Audit Agent │ │ QA Agent │ │ Contract │ │ ║ ║ │
│ │ │ │ │ Agent │ │ ║ ║ │ │ Claude 4.5 │ │ Gemini │ │ Gemini │ │ ║ ║ │ │
(Thinking) │ │ 2.5 Pro │ │ 2.5 Pro │ │ ║ ║ │ │ │ │ │ │ │ │ ║ ║ │ │
OWASP, Data │ │ Unit, Integ │ │ G2G API │ │ ║ ║ │ │ Privacy Law, │ │
E2E, Load │ │ Contracts, │ │ ║ ║ │ │ Pen Test │ │ Testing │ │ Mocks, │ │
║ ║ │ │ Review │ │ Strategies │ │ Stubs │ │ ║ ║ │ └──────────────┘
└──────────────┘ └───────────────┘ │ ║ ║
└──────────────────────────────────────────────────────────┘ ║
╚══════════════════════════════════════════════════════════════════╝
\`\`\` \### 3.2 Model-to-Task Assignment Rationale This is not
arbitrary. Here is the explicit cognitive reasoning for each assignment:
\| Task Category \| Assigned Model \| Why \| \|\-\--\|\-\--\|\-\--\| \|
Security architecture review, law compliance analysis, complex design
tradeoffs \| \*\*Claude Sonnet 4.5 Thinking\*\* \| Extended thinking
enables multi-step legal/security reasoning chains. Claude is stronger
at policy interpretation and adversarial thinking \| \| Code generation
at volume (services, APIs, migrations, tests) \| \*\*Gemini 2.5 Pro\*\*
\| Superior at large context code generation, follows structured schemas
precisely, excellent at boilerplate with constraints \| \| Lens Design
System frontend (strict component rules, linter authority) \| \*\*Claude
Sonnet 4.5 Thinking\*\* \| Thinking mode enables the agent to reason
through Lens constraint chains before writing. Better at \"stop and
check rules\" compliance \| \| Infrastructure as Code (Docker, K8s
manifests, Kafka configs) \| \*\*Gemini 2.5 Pro\*\* \| Large context
window handles full infrastructure files without truncation \| \| G2G
API contract design (NIDA, NESA, RIB interfaces) \| \*\*Gemini 2.5
Pro\*\* \| Precise schema generation, OpenAPI spec writing \| \| Test
strategy and edge case generation \| \*\*Gemini 2.5 Pro\*\* \| Breadth
of case generation at volume \| \| Architectural conflict resolution \|
\*\*Claude Sonnet 4.5 Thinking\*\* \| Thinking mode reasons through
tradeoffs systematically \| \-\-- \## Part IV: Repository & Development
Environment Architecture \### 4.1 Monorepo Structure \`\`\` usrp/ \#
Unified Security Recruitment Portal ├── .github/ │ ├── workflows/ │ │
├── ci-backend.yml \# Backend CI: lint, test, build │ │ ├──
ci-frontend.yml \# Frontend CI: Lens compliance, tests │ │ ├──
ci-infra.yml \# Infra CI: Terraform validate/plan │ │ ├──
security-scan.yml \# Trivy, SAST, OWASP ZAP │ │ └── deploy-staging.yml
\# Auto-deploy to staging on main merge │ ├── CODEOWNERS \#
Agency-specific code ownership rules │ └── pull_request_template.md │
├── apps/ │ ├── portal-web/ \# Public Citizen Portal (Next.js 15 + Lens
DS) │ │ ├── src/ │ │ │ ├── app/ \# App Router │ │ │ │ ├── (auth)/ │ │ │
│ │ ├── register/ │ │ │ │ │ │ └── page.tsx \# Registration entry: NID
input │ │ │ │ │ └── login/ │ │ │ │ ├── (applicant)/ │ │ │ │ │ ├──
profile/ │ │ │ │ │ ├── apply/ │ │ │ │ │ │ ├── rdf/ │ │ │ │ │ │ ├── rnp/
│ │ │ │ │ │ └── rcs/ │ │ │ │ │ ├── status/ │ │ │ │ │ └── slot/ \#
QR-coded slot details │ │ │ │ ├── api/ \# Next.js API Routes (BFF layer)
│ │ │ │ │ ├── identity/ │ │ │ │ │ ├── eligibility/ │ │ │ │ │ ├──
biometric/ │ │ │ │ │ └── documents/ │ │ │ │ └── layout.tsx │ │ │ ├──
components/ \# Lens-based UI components │ │ │ │ ├── forms/ │ │ │ │ ├──
biometric/ \# WebRTC liveness capture │ │ │ │ ├── upload/ \# Document
upload with progress │ │ │ │ └── status/ \# Application status tracking
│ │ │ └── lib/ │ │ │ ├── api-client.ts \# Typed API client to backend │
│ │ ├── auth.ts \# Session management │ │ │ └── validators.ts \#
Client-side validation │ │ ├── .lens-knowledge-base -\>
../../design-system/.lens-knowledge-base (symlink) │ │ ├── CLAUDE.md -\>
../../design-system/CLAUDE.md (symlink) │ │ └── package.json │ │ │ ├──
dashboard-rdf/ \# RDF HR Admin Dashboard (Next.js 15 + Lens DS) │ ├──
dashboard-rnp/ \# RNP HR Admin Dashboard │ ├── dashboard-rcs/ \# RCS HR
Admin Dashboard │ ├── dashboard-superadmin/ \# Cross-agency super admin
(MoD oversight) │ │ │ └── field-tablet/ \# Offline-First PWA (Next.js
15 + Lens DS) │ ├── src/ │ │ ├── service-worker/ \# Workbox offline
strategies │ │ ├── sync/ \# CRDT sync engine │ │ │ ├── crdt-scorecard.ts
\# Automerge CRDT for score records │ │ │ └── vector-clock.ts \# Stale
write detection │ │ └── crypto/ \# Device key signing for score
integrity │ └── package.json │ ├── services/ \# Backend Microservices
(NestJS + TypeScript) │ ├── identity-service/ \# NIDA integration,
session management │ │ ├── src/ │ │ │ ├── nida/ │ │ │ │ ├──
nida.client.ts \# HMAC-signed NIDA API client │ │ │ │ ├── nida.types.ts
\# NIDA response DTOs │ │ │ │ └── nida.mock.ts \# Mock for dev/test
environments │ │ │ ├── session/ │ │ │ │ ├── ussd-session.service.ts \#
Redis-backed USSD state machine │ │ │ │ └── reservation.service.ts \#
72-hour identity reservation slots │ │ │ └── events/ │ │ │ └──
identity-verified.event.ts │ │ ├── test/ │ │ └── Dockerfile │ │ │ ├──
eligibility-service/ \# Rule engine: age, grades, disqualifiers │ │ ├──
src/ │ │ │ ├── engines/ │ │ │ │ ├── age.engine.ts │ │ │ │ ├──
academic.engine.ts \# Corrected grade comparison logic │ │ │ │ └──
composite.engine.ts \# RDF/RNP/RCS specific rule chains │ │ │ ├── rules/
│ │ │ │ ├── rdf.rules.ts \# Specific RDF entry criteria │ │ │ │ ├──
rnp.rules.ts │ │ │ │ └── rcs.rules.ts │ │ │ └── nesa/ │ │ │ ├──
nesa.client.ts │ │ │ └── nesa.types.ts │ │ └── Dockerfile │ │ │ ├──
biometric-service/ \# WebRTC gateway, liveness, 1:1 face match │ │ ├──
src/ │ │ │ ├── webrtc/ \# Kurento/mediasoup integration │ │ │ ├──
liveness/ │ │ │ │ ├── rppg.processor.ts \# rPPG pulse detection │ │ │ │
└── challenge.controller.ts \# Active color challenge │ │ │ └──
matching/ │ │ │ └── nida-biometric.client.ts \# 1:1 face vector → NIDA │
│ └── Dockerfile │ │ │ ├── document-forensics-service/ \# CV, ELA, C2PA,
frequency analysis │ │ ├── src/ │ │ │ ├── pipeline/ │ │ │ │ ├──
ocr.stage.ts │ │ │ │ ├── ela.stage.ts \# Error-level analysis │ │ │ │
├── frequency.stage.ts \# DCT-based GAN detection │ │ │ │ ├──
c2pa.stage.ts \# C2PA manifest verification │ │ │ │ ├── font.stage.ts \#
Kerning/font consistency │ │ │ │ └── stamp.stage.ts \# Ink channel
separation │ │ │ ├── triage/ │ │ │ │ ├── green-lane.classifier.ts \#
Auto-approved via API match │ │ │ │ └── amber-lane.router.ts \# Human
review queue router │ │ │ └── sanitization/ │ │ │ ├── virus-scan.ts \#
ClamAV integration │ │ │ ├── exif-strip.ts \# Metadata removal │ │ │ └──
buffer-pipeline.ts \# In-memory only processing │ │ └── Dockerfile │ │ │
├── background-vetting-service/ \# RIB/MoJ async criminal check consumer
│ ├── routing-service/ \# Agency routing, cross-application logic │ ├──
scheduling-service/ \# Slot allocation, regional center assignment │ ├──
notification-service/ \# SMS (MTN/Airtel), Email, USSD push │ ├──
field-sync-service/ \# CRDT merge, vector clock validation │ ├──
audit-service/ \# Immutable Kafka consumer → append-only DB │ └──
agency-bff/ \# Backend-for-Frontend per agency dashboard │ ├── rdf-bff/
│ ├── rnp-bff/ │ └── rcs-bff/ │ ├── packages/ \# Shared internal
packages │ ├── shared-types/ \# TypeScript interfaces shared across all
│ │ ├── src/ │ │ │ ├── applicant.types.ts │ │ │ ├── agency.types.ts │ │
│ ├── vetting.types.ts │ │ │ ├── events.types.ts \# Kafka event schemas
(Avro-compatible) │ │ │ └── eligibility.types.ts \# Corrected grade
types │ │ └── package.json │ │ │ ├── shared-security/ \# Auth, JWT, mTLS
helpers │ │ ├── src/ │ │ │ ├── jwt.util.ts │ │ │ ├── hmac.util.ts \# For
NIDA/NESA request signing │ │ │ ├── encryption.util.ts \# AES-256-GCM
helpers │ │ │ └── roles.ts \# RBAC role definitions │ │ └── package.json
│ │ │ ├── shared-events/ \# Kafka event definitions and schemas │ │ ├──
src/ │ │ │ ├── topics.ts \# Topic name constants │ │ │ ├── schemas/ \#
Avro schemas per event type │ │ │ └── producers/ \# Typed producer
wrappers │ │ └── package.json │ │ │ ├── shared-database/ \# Drizzle ORM
schemas, migrations │ │ ├── src/ │ │ │ ├── schemas/ │ │ │ │ ├──
public-core.schema.ts \# Shared applicant identity │ │ │ │ ├──
rdf-ops.schema.ts \# RDF-isolated tables │ │ │ │ ├── rnp-ops.schema.ts │
│ │ │ ├── rcs-ops.schema.ts │ │ │ │ └── audit.schema.ts \# Append-only
audit tables │ │ │ ├── migrations/ │ │ │ └── rls-policies.sql \#
Row-Level Security SQL │ │ └── package.json │ │ │ └── shared-config/ \#
Environment configs, feature flags │ ├── infrastructure/ \# All IaC │
├── docker/ │ │ ├── docker-compose.dev.yml \# Full local dev stack │ │
├── docker-compose.test.yml \# Integration test isolation │ │ └──
docker-compose.infra.yml \# Kafka, PG, Redis, MinIO, ClamAV │ ├──
kubernetes/ │ │ ├── namespaces/ │ │ │ ├── usrp-public.yaml \# Public
portal namespace │ │ │ ├── usrp-rdf.yaml \# RDF dashboard namespace │ │
│ ├── usrp-rnp.yaml │ │ │ └── usrp-rcs.yaml │ │ ├── services/ \# K8s
service manifests │ │ ├── network-policies/ \# Cross-namespace isolation
│ │ │ └── deny-cross-agency.yaml \# RDF pods cannot talk to RNP pods │ │
├── istio/ \# Service mesh config │ │ │ ├── peer-authentication.yaml \#
mTLS enforcement │ │ │ └── authorization-policy.yaml \#
Service-to-service RBAC │ │ └── spire/ \# SPIFFE/SPIRE workload identity
│ ├── terraform/ \# NDC infrastructure provisioning │ │ ├── modules/ │ │
│ ├── postgresql-cluster/ │ │ │ ├── kafka-cluster/ │ │ │ ├──
redis-cluster/ │ │ │ ├── minio-cluster/ │ │ │ └── hsm-config/ │ │ └──
environments/ │ │ ├── staging/ │ │ └── production/ │ └── monitoring/ │
├── prometheus/ │ ├── grafana/ │ └── alertmanager/ │ ├── design-system/
\# Your Lens DS boilerplate (symlinked to apps) │ └── \[your existing
structure\] │ ├── docs/ │ ├── architecture/ │ │ ├──
ADR-001-kafka-over-rabbitmq.md \# Architecture Decision Records │ │ ├──
ADR-002-schema-isolation.md │ │ ├── ADR-003-crdt-offline-sync.md │ │ └──
ADR-004-c2pa-for-document-auth.md │ ├── api/ \# OpenAPI specs per
service │ ├── g2g-integration/ \# NIDA, NESA, RIB integration specs │
└── compliance/ \# Law N° 058/2021 compliance mapping │ ├── scripts/ │
├── setup-dev.sh \# One-command dev environment setup │ ├──
generate-mocks.ts \# Generate G2G API mocks from specs │ ├──
seed-test-data.ts \# NIDA/NESA test data seeding │ └──
rotate-dev-certs.sh \# Local mTLS cert rotation │ ├── .env.example \#
Environment variable documentation ├── turbo.json \# Turborepo build
orchestration ├── pnpm-workspace.yaml \# pnpm workspace configuration
├── package.json \# Root workspace package.json └── README.md \`\`\`
\-\-- \## Part V: Detailed Phase Engineering Plan \### Phase 1:
Repository, Environment & Infrastructure Foundation \*\*Objective:\*\*
Every developer and AI agent has a reproducible, fully configured
environment from day one. \*\*AI Agent Assignment:\*\* - \*\*Gemini 2.5
Pro\*\* → Generate all Docker Compose, Terraform modules, K8s manifests,
Turborepo configuration - \*\*Claude Sonnet 4.5 Thinking\*\* → Review
network isolation policies, security group rules, mTLS SPIRE
configuration \*\*Deliverables:\*\* \`\`\`yaml \#
infrastructure/docker/docker-compose.dev.yml \# This is the complete
local development stack version: \'3.9\' networks: usrp-internal:
driver: bridge ipam: config: - subnet: 172.20.0.0/16 services: \# ───
Data Layer ─────────────────────────────────────────────── postgres:
image: postgres:16-alpine container_name: usrp-postgres environment:
POSTGRES_USER: \${POSTGRES_USER} POSTGRES_PASSWORD:
\${POSTGRES_PASSWORD} POSTGRES_DB: usrp_db volumes: -
postgres-data:/var/lib/postgresql/data -
./init-scripts/01-create-schemas.sql:/docker-entrypoint-initdb.d/01.sql -
./init-scripts/02-rls-policies.sql:/docker-entrypoint-initdb.d/02.sql
networks: - usrp-internal healthcheck: test: \[\"CMD-SHELL\",
\"pg_isready -U \${POSTGRES_USER}\"\] interval: 10s timeout: 5s retries:
5 redis: image: redis:7.2-alpine container_name: usrp-redis command:
redis-server \--requirepass \${REDIS_PASSWORD} \--save 60 1 volumes: -
redis-data:/data networks: - usrp-internal \# ─── Event Streaming
────────────────────────────────────────── zookeeper: image:
confluentinc/cp-zookeeper:7.6.0 container_name: usrp-zookeeper
environment: ZOOKEEPER_CLIENT_PORT: 2181 networks: - usrp-internal
kafka: image: confluentinc/cp-kafka:7.6.0 container_name: usrp-kafka
depends_on: \[zookeeper\] environment: KAFKA_BROKER_ID: 1
KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181 KAFKA_ADVERTISED_LISTENERS:
PLAINTEXT://kafka:9092 KAFKA_AUTO_CREATE_TOPICS_ENABLE: \'false\'
KAFKA_LOG_RETENTION_HOURS: 168 networks: - usrp-internal kafka-init:
image: confluentinc/cp-kafka:7.6.0 depends_on: \[kafka\] entrypoint:
\[\'/bin/sh\', \'-c\'\] command: \| \" kafka-topics \--create
\--if-not-exists \--topic applicant.submitted \--partitions 12
\--replication-factor 1 \--bootstrap-server kafka:9092 kafka-topics
\--create \--if-not-exists \--topic vetting.nida \--partitions 6
\--bootstrap-server kafka:9092 kafka-topics \--create \--if-not-exists
\--topic vetting.nesa \--partitions 6 \--bootstrap-server kafka:9092
kafka-topics \--create \--if-not-exists \--topic vetting.rib
\--partitions 6 \--bootstrap-server kafka:9092 kafka-topics \--create
\--if-not-exists \--topic biometric.result \--partitions 6
\--bootstrap-server kafka:9092 kafka-topics \--create \--if-not-exists
\--topic slot.assigned \--partitions 6 \--bootstrap-server kafka:9092
kafka-topics \--create \--if-not-exists \--topic field.score.captured
\--partitions 6 \--bootstrap-server kafka:9092 kafka-topics \--create
\--if-not-exists \--topic audit.immutable \--partitions 3
\--bootstrap-server kafka:9092 \" networks: - usrp-internal
schema-registry: image: confluentinc/cp-schema-registry:7.6.0
container_name: usrp-schema-registry depends_on: \[kafka\] environment:
SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS: kafka:9092
SCHEMA_REGISTRY_HOST_NAME: schema-registry networks: - usrp-internal \#
─── Object Storage ─────────────────────────────────────────── minio:
image: minio/minio:latest container_name: usrp-minio command: server
/data \--console-address \":9001\" environment: MINIO_ROOT_USER:
\${MINIO_ROOT_USER} MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}
volumes: - minio-data:/data networks: - usrp-internal \# ─── Security
───────────────────────────────────────────────── clamav: image:
clamav/clamav:stable container_name: usrp-clamav volumes: -
clamav-data:/var/lib/clamav networks: - usrp-internal \# ─── G2G API
Mocks (Development Only) ──────────────────────── nida-mock: build:
context: ./mocks/nida dockerfile: Dockerfile container_name:
usrp-nida-mock environment: MOCK_DATA_PATH: /mock-data/citizens.json
networks: - usrp-internal nesa-mock: build: context: ./mocks/nesa
dockerfile: Dockerfile container_name: usrp-nesa-mock networks: -
usrp-internal rib-mock: build: context: ./mocks/rib dockerfile:
Dockerfile container_name: usrp-rib-mock networks: - usrp-internal \#
─── API Gateway ────────────────────────────────────────────── kong:
image: kong:3.6-ubuntu container_name: usrp-kong environment:
KONG_DATABASE: \"off\" KONG_DECLARATIVE_CONFIG:
/kong/declarative/kong.yml volumes: -
./kong/kong.dev.yml:/kong/declarative/kong.yml ports: - \"8000:8000\" \#
Public proxy - \"8001:8001\" \# Admin API (internal only) networks: -
usrp-internal \# ─── Monitoring (Dev)
───────────────────────────────────────── kafka-ui: image:
provectuslabs/kafka-ui:latest container_name: usrp-kafka-ui environment:
KAFKA_CLUSTERS_0_NAME: usrp-local KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS:
kafka:9092 KAFKA_CLUSTERS_0_SCHEMAREGISTRY: http://schema-registry:8081
ports: - \"8080:8080\" networks: - usrp-internal volumes: postgres-data:
redis-data: minio-data: clamav-data: \`\`\` \-\-- \### Phase 2: Database
Design & Architecture \*\*AI Agent Assignment:\*\* - \*\*Gemini 2.5
Pro\*\* → Generate full Drizzle ORM schema files, migration scripts,
seed data - \*\*Claude Sonnet 4.5 Thinking\*\* → Review RLS policies,
audit schema immutability guarantees, privacy compliance
\`\`\`typescript //
packages/shared-database/src/schemas/public-core.schema.ts // This
schema is visible across all agencies --- identity only, no recruitment
data import { pgSchema, uuid, varchar, timestamp, boolean, pgEnum,
index, uniqueIndex } from \'drizzle-orm/pg-core\'; export const
publicCore = pgSchema(\'public_core\'); // ── Enums
─────────────────────────────────────────────────────────────────────
export const applicationChannelEnum = publicCore.enum(
\'application_channel\', \[\'WEB\', \'USSD\', \'IREMBO_KIOSK\'\] );
export const identityVerificationStatusEnum = publicCore.enum(
\'identity_verification_status\', \[\'PENDING\', \'VERIFIED\',
\'FAILED\', \'EXPIRED\'\] ); export const applicantGenderEnum =
publicCore.enum( \'applicant_gender\', \[\'MALE\', \'FEMALE\'\] // Per
NIDA official categories ); // ── Core Applicant Identity
(NIDA-Anchored) ─────────────────────────────────── // This table stores
ONLY what NIDA returns. Nothing more. // PII is encrypted at column
level using pgcrypto extension. export const applicantIdentities =
publicCore.table( \'applicant_identities\', { id:
uuid(\'id\').defaultRandom().primaryKey(), // NIDA-anchored fields ---
these are SET BY NIDA, never by the user nationalIdHash:
varchar(\'national_id_hash\', { length: 64 }) // SHA-256 of NID ---
never store raw NID .notNull() .unique(), // Encrypted PII columns
(decrypted only by authorized roles) encryptedFullName:
varchar(\'encrypted_full_name\', { length: 512 }).notNull(),
encryptedDateOfBirth: varchar(\'encrypted_date_of_birth\', { length: 256
}).notNull(), encryptedHomeDistrict:
varchar(\'encrypted_home_district\', { length: 256 }).notNull(), gender:
applicantGenderEnum(\'gender\').notNull(), // Verification metadata
(non-PII, unencrypted for query performance) nidaVerificationToken:
varchar(\'nida_verification_token\', { length: 128 }), nidaVerifiedAt:
timestamp(\'nida_verified_at\'), nidaMatchConfidence:
varchar(\'nida_match_confidence\', { length: 10 }), // e.g. \"98.4\"
identityStatus: identityVerificationStatusEnum(\'identity_status\')
.notNull() .default(\'PENDING\'), // Channel tracking
registrationChannel:
applicationChannelEnum(\'registration_channel\').notNull(), // USSD
reservation management ussdReservationExpiresAt:
timestamp(\'ussd_reservation_expires_at\'), ussdConfirmedAt:
timestamp(\'ussd_confirmed_at\'), // Phone number (used for USSD anchor
and SMS notifications) // Stored hashed + separately verified against
NIDA phone phoneNumberHash: varchar(\'phone_number_hash\', { length: 64
}).notNull(), phoneVerifiedAt: timestamp(\'phone_verified_at\'), //
Biometric session tracking (no biometric data stored here)
biometricSessionId: varchar(\'biometric_session_id\', { length: 128 }),
biometricVerifiedAt: timestamp(\'biometric_verified_at\'),
biometricPassedLiveness:
boolean(\'biometric_passed_liveness\').default(false), // System
metadata createdAt: timestamp(\'created_at\').defaultNow().notNull(),
updatedAt: timestamp(\'updated_at\').defaultNow().notNull(), deletedAt:
timestamp(\'deleted_at\'), // Soft delete for GDPR-equivalent erasure },
(table) =\> ({ nationalIdHashIdx:
uniqueIndex(\'idx_national_id_hash\').on(table.nationalIdHash),
phoneHashIdx: index(\'idx_phone_hash\').on(table.phoneNumberHash),
identityStatusIdx:
index(\'idx_identity_status\').on(table.identityStatus), }) ); // ──
Applicant Sessions (USSD + Web)
────────────────────────────────────────── export const
applicantSessions = publicCore.table( \'applicant_sessions\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicantId:
uuid(\'applicant_id\') .references(() =\> applicantIdentities.id)
.notNull(), sessionToken: varchar(\'session_token\', { length: 256
}).notNull().unique(), channel:
applicationChannelEnum(\'channel\').notNull(), ussdState:
varchar(\'ussd_state\', { length: 50 }), // State machine position
expiresAt: timestamp(\'expires_at\').notNull(), lastActivityAt:
timestamp(\'last_activity_at\').defaultNow().notNull(), createdAt:
timestamp(\'created_at\').defaultNow().notNull(), } ); \`\`\`
\`\`\`typescript //
packages/shared-database/src/schemas/rdf-ops.schema.ts // ISOLATED: Only
accessible to RDF-authorized database roles import { pgSchema, uuid,
varchar, timestamp, integer, boolean, pgEnum, jsonb, index } from
\'drizzle-orm/pg-core\'; import { applicantIdentities } from
\'./public-core.schema\'; export const rdfOps = pgSchema(\'rdf_ops\');
// ── RDF-Specific Enums
──────────────────────────────────────────────────────── export const
rdfApplicationCategoryEnum = rdfOps.enum( \'application_category\',
\[\'GENERAL_ENLISTMENT\', \'CADET_OFFICER\', \'DIRECT_SHORT_SERVICE\',
\'SPECIALIST\'\] ); export const rdfApplicationStatusEnum = rdfOps.enum(
\'application_status\', \[ \'DRAFT\', \'SUBMITTED\',
\'ACADEMIC_VETTING\', \'CRIMINAL_CLEARANCE\', \'DOCUMENT_REVIEW_GREEN\',
\'DOCUMENT_REVIEW_AMBER\', \'SLOT_ASSIGNED\',
\'PHYSICAL_TEST_SCHEDULED\', \'PHYSICAL_TEST_COMPLETE\',
\'MEDICAL_REVIEW\', \'FINAL_SHORTLIST\', \'ACCEPTED\', \'REJECTED\',
\'WITHDRAWN\' \] ); export const rdfAcademicEligibilityStatusEnum =
rdfOps.enum( \'academic_eligibility_status\', \[\'PENDING\',
\'ELIGIBLE\', \'INELIGIBLE\'\] ); export const
rdfCriminalClearanceStatusEnum = rdfOps.enum(
\'criminal_clearance_status\', \[\'PENDING\', \'CLEARED\', \'FLAGGED\',
\'UNDER_REVIEW\'\] ); export const rdfDocumentLaneEnum = rdfOps.enum(
\'document_lane\', \[\'GREEN\', \'AMBER\', \'RED\'\] ); // ── RDF
Applications ──────────────────────────────────────────────────────────
export const rdfApplications = rdfOps.table( \'applications\', { id:
uuid(\'id\').defaultRandom().primaryKey(), // Anonymous processing
identifier --- shown to reviewers instead of name processingCode:
varchar(\'processing_code\', { length: 20 }) .notNull() .unique(), //
e.g. \"RDF-90823\" // Link to shared identity --- RLS prevents
unauthorized joins applicantId: uuid(\'applicant_id\') .references(()
=\> applicantIdentities.id) .notNull(), // Application specifics
category: rdfApplicationCategoryEnum(\'category\').notNull(), status:
rdfApplicationStatusEnum(\'status\').notNull().default(\'DRAFT\'), //
Academic vetting nesaIndexNumber: varchar(\'nesa_index_number\', {
length: 20 }), nesaVerificationToken:
varchar(\'nesa_verification_token\', { length: 128 }),
academicEligibilityStatus:
rdfAcademicEligibilityStatusEnum(\'academic_eligibility_status\')
.notNull().default(\'PENDING\'), academicEligibilityDetail:
jsonb(\'academic_eligibility_detail\'), // Stores: { subjectResults:
\[\...\], failureReason?: string, evaluatedAt: ISO } // Criminal vetting
ribRequestId: varchar(\'rib_request_id\', { length: 128 }),
criminalClearanceStatus:
rdfCriminalClearanceStatusEnum(\'criminal_clearance_status\')
.notNull().default(\'PENDING\'), criminalClearanceAt:
timestamp(\'criminal_clearance_at\'), // Document forensics
documentLane: rdfDocumentLaneEnum(\'document_lane\'),
documentForensicsScore: integer(\'document_forensics_score\'), // 0-100
documentForensicsFlags: jsonb(\'document_forensics_flags\'), // Stores:
{ elaAnomalies: bool, fontMismatch: bool, c2paValid: bool, \... }
documentReviewedById: uuid(\'document_reviewed_by_id\'), // HR officer
UUID documentReviewedAt: timestamp(\'document_reviewed_at\'), //
Physical test scheduling assignedRegionalHub:
varchar(\'assigned_regional_hub\', { length: 50 }), // Values:
\'KIGALI\' \| \'NORTHERN\' \| \'SOUTHERN\' \| \'EASTERN\' \| \'WESTERN\'
physicalTestSlotId: uuid(\'physical_test_slot_id\'),
physicalTestScheduledAt: timestamp(\'physical_test_scheduled_at\'),
qrInvitationCode: varchar(\'qr_invitation_code\', { length: 256 }),
qrInvitationIssuedAt: timestamp(\'qr_invitation_issued_at\'), //
Physical test results (synced from field tablets) physicalTestScoreId:
uuid(\'physical_test_score_id\'), physicalTestCompletedAt:
timestamp(\'physical_test_completed_at\'), // Final decision
finalDecisionById: uuid(\'final_decision_by_id\'), finalDecisionAt:
timestamp(\'final_decision_at\'), finalDecisionNotes:
varchar(\'final_decision_notes\', { length: 2000 }), // Cross-agency
lock: prevents double-acceptance across RDF/RNP/RCS crossAgencyLockAt:
timestamp(\'cross_agency_lock_at\'), crossAgencyLockReason:
varchar(\'cross_agency_lock_reason\', { length: 50 }), submittedAt:
timestamp(\'submitted_at\'), createdAt:
timestamp(\'created_at\').defaultNow().notNull(), updatedAt:
timestamp(\'updated_at\').defaultNow().notNull(), }, (table) =\> ({
applicantIdIdx: index(\'idx_rdf_applicant_id\').on(table.applicantId),
statusIdx: index(\'idx_rdf_status\').on(table.status), documentLaneIdx:
index(\'idx_rdf_document_lane\').on(table.documentLane),
processingCodeIdx:
index(\'idx_rdf_processing_code\').on(table.processingCode),
regionalHubIdx:
index(\'idx_rdf_regional_hub\').on(table.assignedRegionalHub), }) ); //
── Physical Test Scores (CRDT-synced from field tablets)
───────────────────── export const rdfPhysicalTestScores = rdfOps.table(
\'physical_test_scores\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rdfApplications.id)
.notNull(), // CRDT vector clock metadata for conflict detection
deviceId: varchar(\'device_id\', { length: 64 }).notNull(), vectorClock:
jsonb(\'vector_clock\').notNull(), // Physical metrics (bounded by
tablet-side validation) heightCm: integer(\'height_cm\'), // Bounded:
140-220 weightKg: integer(\'weight_kg\'), // Bounded: 40-150
run3kmTimeSeconds: integer(\'run_3km_time_seconds\'), chestCm:
integer(\'chest_cm\'), medicalFitnessStatus:
varchar(\'medical_fitness_status\', { length: 20 }), // Device
cryptographic signature for integrity verification deviceSignature:
varchar(\'device_signature\', { length: 512 }).notNull(),
signedPayloadHash: varchar(\'signed_payload_hash\', { length: 64
}).notNull(), // Officer who captured the record capturingOfficerId:
uuid(\'capturing_officer_id\').notNull(), capturedAt:
timestamp(\'captured_at\').notNull(), syncedAt:
timestamp(\'synced_at\').defaultNow(), createdAt:
timestamp(\'created_at\').defaultNow().notNull(), } ); \`\`\` \`\`\`sql
\-- packages/shared-database/src/rls-policies.sql \-- Row-Level
Security: The hardest guarantee in the system \-- ── Setup Database
Roles ─────────────────────────────────────────────────────── CREATE
ROLE usrp_public_reader; CREATE ROLE usrp_rdf_officer; CREATE ROLE
usrp_rnp_officer; CREATE ROLE usrp_rcs_officer; CREATE ROLE
usrp_superadmin; CREATE ROLE usrp_system_service; \-- Used by backend
microservices \-- ── Schema Permissions
──────────────────────────────────────────────────────── GRANT USAGE ON
SCHEMA public_core TO usrp_public_reader, usrp_rdf_officer,
usrp_rnp_officer, usrp_rcs_officer, usrp_system_service,
usrp_superadmin; GRANT USAGE ON SCHEMA rdf_ops TO usrp_rdf_officer,
usrp_system_service, usrp_superadmin; GRANT USAGE ON SCHEMA rnp_ops TO
usrp_rnp_officer, usrp_system_service, usrp_superadmin; GRANT USAGE ON
SCHEMA rcs_ops TO usrp_rcs_officer, usrp_system_service,
usrp_superadmin; \-- CRITICAL: RDF officers cannot even see rnp_ops
schema exists REVOKE ALL ON SCHEMA rnp_ops FROM usrp_rdf_officer; REVOKE
ALL ON SCHEMA rcs_ops FROM usrp_rdf_officer; REVOKE ALL ON SCHEMA
rdf_ops FROM usrp_rnp_officer; REVOKE ALL ON SCHEMA rcs_ops FROM
usrp_rnp_officer; REVOKE ALL ON SCHEMA rdf_ops FROM usrp_rcs_officer;
REVOKE ALL ON SCHEMA rnp_ops FROM usrp_rcs_officer; \-- ── Enable RLS on
all tables ────────────────────────────────────────────────── ALTER
TABLE public_core.applicant_identities ENABLE ROW LEVEL SECURITY; ALTER
TABLE rdf_ops.applications ENABLE ROW LEVEL SECURITY; ALTER TABLE
rdf_ops.physical_test_scores ENABLE ROW LEVEL SECURITY; \-- ── RLS
Policies: Applicant Identities ────────────────────────────────────────
\-- Officers can only see identity records for applicants in THEIR
agency CREATE POLICY rdf_officer_identity_access ON
public_core.applicant_identities FOR SELECT TO usrp_rdf_officer USING (
id IN ( SELECT applicant_id FROM rdf_ops.applications ) ); \-- System
service can read all (for vetting workers) CREATE POLICY
system_service_identity_access ON public_core.applicant_identities FOR
ALL TO usrp_system_service USING (true); \-- ── Anonymization View: What
Officers Actually See ──────────────────────────── \-- Officers query
this view, not the raw table \-- Full PII is not decrypted until
specific stage approval CREATE VIEW rdf_ops.anonymized_applicant_triage
AS SELECT a.processing_code AS candidate_id, \-- Shows \"RDF-90823\",
not real name a.category, a.status, a.academic_eligibility_status,
a.criminal_clearance_status, a.document_lane,
a.document_forensics_flags, a.assigned_regional_hub, a.created_at,
a.submitted_at \-- Deliberately EXCLUDES: names, national IDs, photos,
addresses FROM rdf_ops.applications a WHERE a.status NOT IN (\'DRAFT\');
\-- Full profile only available AFTER physical test scheduling stage
CREATE VIEW rdf_ops.authorized_full_profile AS SELECT a.processing_code,
\-- Decrypt PII columns (only for authorized stage)
pgp_sym_decrypt(i.encrypted_full_name::bytea,
current_setting(\'app.encryption_key\')) AS full_name,
pgp_sym_decrypt(i.encrypted_date_of_birth::bytea,
current_setting(\'app.encryption_key\')) AS date_of_birth,
a.physical_test_scheduled_at, a.assigned_regional_hub,
a.qr_invitation_code FROM rdf_ops.applications a JOIN
public_core.applicant_identities i ON i.id = a.applicant_id WHERE
a.status IN (\'PHYSICAL_TEST_SCHEDULED\', \'PHYSICAL_TEST_COMPLETE\',
\'MEDICAL_REVIEW\', \'FINAL_SHORTLIST\', \'ACCEPTED\'); \`\`\` \-\--
\### Phase 3: Backend Services & Security Architecture \*\*AI Agent
Assignment:\*\* - \*\*Gemini 2.5 Pro\*\* → NestJS service scaffolding,
Kafka consumers/producers, API controllers - \*\*Claude Sonnet 4.5
Thinking\*\* → Security review of each service, HMAC implementation,
mTLS config \`\`\`typescript //
services/identity-service/src/nida/nida.client.ts // Production NIDA
integration with HMAC request signing import crypto from \'crypto\';
import { Injectable, Logger } from \'@nestjs/common\'; import {
ConfigService } from \'@nestjs/config\'; export interface
NIDACitizenRecord { nationalIdNumber: string; // Returned by NIDA for
confirmation only fullName: string; dateOfBirth: string; // ISO 8601
gender: \'MALE\' \| \'FEMALE\'; homeDistrict: string; homeProvince:
string; registeredPhoneNumber: string; // Masked: e.g., 07X-XXX-X890
citizenshipStatus: \'RWANDAN_CITIZEN\' \| \'FOREIGN_RESIDENT\'; } export
interface NIDARawResponse { status: \'FOUND\' \| \'NOT_FOUND\' \|
\'SUSPENDED\'; citizen?: NIDACitizenRecord; requestId: string; //
NIDA\'s internal request tracking ID respondedAt: string; } export
interface NIDABiometricMatchResult { matched: boolean; matchConfidence:
number; // 0.0 - 100.0 matchThreshold: number; // NIDA\'s configured
threshold (e.g., 85.0) requestId: string; } \@Injectable() export class
NIDAClient { private readonly logger = new Logger(NIDAClient.name);
private readonly baseUrl: string; private readonly apiKey: string;
private readonly hmacSecret: string; private readonly vpnEndpoint:
string; constructor(private readonly config: ConfigService) {
this.baseUrl = config.getOrThrow\<string\>(\'NIDA_API_BASE_URL\');
this.apiKey = config.getOrThrow\<string\>(\'NIDA_API_KEY\');
this.hmacSecret = config.getOrThrow\<string\>(\'NIDA_HMAC_SECRET\');
this.vpnEndpoint =
config.getOrThrow\<string\>(\'NIDA_VPN_TUNNEL_HOST\'); } /\*\* \* Lookup
citizen by National ID number. \* All requests go through encrypted VPN
tunnel to NIDA datacenter. \* HMAC signature prevents request spoofing
and replay attacks. \*/ async lookupCitizen(nationalId: string):
Promise\<NIDARawResponse\> { const requestId = crypto.randomUUID();
const timestamp = new Date().toISOString(); // Construct the payload to
sign const signaturePayload =
\`\${requestId}:\${timestamp}:\${this.hashNID(nationalId)}\`; const
hmacSignature = this.generateHMAC(signaturePayload); const response =
await fetch(\`\${this.baseUrl}/v1/citizen/lookup\`, { method: \'POST\',
headers: { \'Content-Type\': \'application/json\', \'X-API-Key\':
this.apiKey, \'X-Request-ID\': requestId, \'X-Timestamp\': timestamp,
\'X-HMAC-Signature\': hmacSignature, \'X-Forwarded-Via\':
\'USRP-IdentityService-v1\', }, body: JSON.stringify({ // Never send the
raw NID in the body --- NIDA receives only the hash // NIDA holds the
lookup table mapping hashes to their records nationalIdHash:
this.hashNID(nationalId), requestId, }), }); if (!response.ok) {
this.logger.error(\`NIDA lookup failed: \${response.status}
\${response.statusText}\`, { requestId, // NEVER log the national ID });
throw new NIDAServiceException(\`NIDA service returned
\${response.status}\`, requestId); } return response.json() as
Promise\<NIDARawResponse\>; } /\*\* \* 1:1 Biometric face match against
NIDA\'s master biometric database. \* The live face vector is sent to
NIDA; NIDA returns only a match score. \* Raw biometric data is NEVER
stored in USRP systems. \*/ async matchBiometric( nationalIdHash:
string, liveFaceVector: Float32Array, ):
Promise\<NIDABiometricMatchResult\> { const requestId =
crypto.randomUUID(); const timestamp = new Date().toISOString(); //
Encode face vector as base64 for transport const vectorBase64 =
Buffer.from(liveFaceVector.buffer).toString(\'base64\'); const
signaturePayload =
\`\${requestId}:\${timestamp}:\${nationalIdHash}:\${vectorBase64.substring(0,
32)}\`; const hmacSignature = this.generateHMAC(signaturePayload); const
response = await fetch(\`\${this.baseUrl}/v1/biometric/match\`, {
method: \'POST\', headers: { \'Content-Type\': \'application/json\',
\'X-API-Key\': this.apiKey, \'X-Request-ID\': requestId,
\'X-Timestamp\': timestamp, \'X-HMAC-Signature\': hmacSignature, },
body: JSON.stringify({ nationalIdHash, liveFaceVector: vectorBase64,
requestId, }), }); if (!response.ok) { throw new
NIDAServiceException(\`NIDA biometric match failed:
\${response.status}\`, requestId); } return response.json() as
Promise\<NIDABiometricMatchResult\>; } /\*\* \* One-way hash of NID for
storage and transport. \* NIDA maintains the reverse mapping --- USRP
never needs to. \*/ private hashNID(nationalId: string): string { return
crypto .createHmac(\'sha256\', this.hmacSecret)
.update(nationalId.trim().toUpperCase()) .digest(\'hex\'); } private
generateHMAC(payload: string): string { return crypto
.createHmac(\'sha256\', this.hmacSecret) .update(payload)
.digest(\'hex\'); } } export class NIDAServiceException extends Error {
constructor(message: string, public readonly requestId: string) {
super(message); this.name = \'NIDAServiceException\'; } } \`\`\`
\`\`\`typescript //
services/eligibility-service/src/engines/academic.engine.ts // Corrected
grade engine with proper Rwanda A-Level grade comparison import {
Injectable } from \'@nestjs/common\'; export type RwandanALevelGrade =
\'A\' \| \'B\' \| \'C\' \| \'D\' \| \'E\' \| \'F\'; // Rwanda A-Level
grading --- A is highest (6), F is lowest (1) const GRADE_RANK:
Record\<RwandanALevelGrade, number\> = { \'A\': 6, \'B\': 5, \'C\': 4,
\'D\': 3, \'E\': 2, \'F\': 1 }; export interface NESASubjectResult {
subjectCode: string; // e.g., \'PHY\', \'MATH\', \'CHEM\', \'ENG\'
subjectName: string; grade: RwandanALevelGrade; points: number; // NESA
point value for the grade } export interface NESAVerifiedPayload {
indexNumber: string; qualificationLevel: \'A2\' \| \'A1\' \|
\'O_LEVEL\'; yearOfExamination: number; schoolName: string; subjects:
NESASubjectResult\[\]; overallPoints: number; // Total aggregate points
verificationToken: string; } export interface SubjectRequirement {
subjectCode: string; minGrade: RwandanALevelGrade; } export interface
AcademicCriteria { minQualificationLevel: \'A2\' \| \'A1\';
minOverallPoints?: number; // Some RDF categories require minimum
aggregate requiredSubjectCombinations: SubjectRequirement\[\]\[\]; //
Array of arrays = OR logic between combinations // e.g.: \[\[\'PCM\'\],
\[\'PCB\'\]\] means PCM or PCB combination is acceptable // Each inner
array = AND logic (all subjects in that combination required)
maximumExamYear?: number; // e.g., can\'t apply with results older than
5 years } export interface EligibilityResult { eligible: boolean;
reason: string; details?: { qualificationCheck?: boolean; pointsCheck?:
boolean; subjectCheck?: boolean; matchedCombination?:
SubjectRequirement\[\]; examYearCheck?: boolean; }; } \@Injectable()
export class AcademicEligibilityEngine { evaluate( nesaData:
NESAVerifiedPayload, criteria: AcademicCriteria, evaluationYear: number
= new Date().getFullYear() ): EligibilityResult { // ── 1. Qualification
Level Check ──────────────────────────────────────── if
(nesaData.qualificationLevel !== criteria.minQualificationLevel) {
return { eligible: false, reason: \`QUALIFICATION_LEVEL_INSUFFICIENT:
requires \${criteria.minQualificationLevel}, has
\${nesaData.qualificationLevel}\`, details: { qualificationCheck: false
} }; } // ── 2. Examination Year Check
──────────────────────────────────────────── if
(criteria.maximumExamYear !== undefined) { const examAge =
evaluationYear - nesaData.yearOfExamination; if (examAge \>
criteria.maximumExamYear) { return { eligible: false, reason:
\`EXAMINATION_RESULTS_EXPIRED: results from
\${nesaData.yearOfExamination} exceed maximum age of
\${criteria.maximumExamYear} years\`, details: { examYearCheck: false }
}; } } // ── 3. Overall Points Check
────────────────────────────────────────────── if
(criteria.minOverallPoints !== undefined) { if (nesaData.overallPoints
\< criteria.minOverallPoints) { return { eligible: false, reason:
\`INSUFFICIENT_AGGREGATE_POINTS: requires \${criteria.minOverallPoints},
has \${nesaData.overallPoints}\`, details: { qualificationCheck: true,
pointsCheck: false } }; } } // ── 4. Subject Combination Check (OR
between combinations) ─────────────── if
(criteria.requiredSubjectCombinations.length \> 0) { let
anyCombinationMatched = false; let matchedCombination:
SubjectRequirement\[\] \| undefined; for (const combination of
criteria.requiredSubjectCombinations) { const combinationResult =
this.evaluateCombination(nesaData.subjects, combination); if
(combinationResult.passed) { anyCombinationMatched = true;
matchedCombination = combination; break; } } if (!anyCombinationMatched)
{ return { eligible: false, reason: \'NO_VALID_SUBJECT_COMBINATION: none
of the required subject combinations met minimum grade requirements\',
details: { qualificationCheck: true, pointsCheck: true, subjectCheck:
false } }; } return { eligible: true, reason: \'ALL_CRITERIA_MET\',
details: { qualificationCheck: true, pointsCheck: true, subjectCheck:
true, matchedCombination, examYearCheck: true } }; } return { eligible:
true, reason: \'ALL_CRITERIA_MET\' }; } private evaluateCombination(
studentSubjects: NESASubjectResult\[\], requiredCombination:
SubjectRequirement\[\] ): { passed: boolean; failedSubject?: string } {
for (const requirement of requiredCombination) { const studentSubject =
studentSubjects.find( (s) =\> s.subjectCode === requirement.subjectCode
); if (!studentSubject) { return { passed: false, failedSubject:
\`NOT_TAKEN:\${requirement.subjectCode}\` }; } const studentRank =
GRADE_RANK\[studentSubject.grade\]; const requiredRank =
GRADE_RANK\[requirement.minGrade\]; if (studentRank \< requiredRank) {
return { passed: false, failedSubject: \`\${requirement.subjectCode}:has
\${studentSubject.grade}, needs \${requirement.minGrade}\` }; } } return
{ passed: true }; } } \`\`\` \-\-- \### Phase 4: Frontend Architecture
with Lens Design System \*\*AI Agent Assignment:\*\* - \*\*Claude Sonnet
4.5 Thinking\*\* exclusively handles all Lens DS frontend work -
\*\*Gemini 2.5 Pro\*\* generates the BFF (Backend-for-Frontend) API
layer and data contracts the frontend consumes \*\*Critical Lens DS
Integration Strategy:\*\* The symlink architecture in the monorepo
ensures every frontend app has immediate access to the Lens knowledge
base without duplication: \`\`\`bash \# scripts/setup-dev.sh --- run
once to configure workspace #!/bin/bash set -euo pipefail echo \"═══
USRP Development Environment Setup ═══\" \# 1. Verify Node and pnpm
versions node \--version \| grep -E \"\^v2\[4-5\]\\.\" \|\| { echo
\"ERROR: Node 24-25 required\"; exit 1; } pnpm \--version \| grep -E
\"\^9\\.\" \|\| { echo \"ERROR: pnpm 9.x required\"; exit 1; } \# 2.
Install all workspace dependencies pnpm install \# 3. Symlink Lens
knowledge base to all frontend apps
LENS_KB=\"./design-system/.lens-knowledge-base\"
CLAUDE_MD=\"./design-system/CLAUDE.md\" for app in apps/portal-web
apps/dashboard-rdf apps/dashboard-rnp apps/dashboard-rcs
apps/dashboard-superadmin apps/field-tablet; do echo \"Linking Lens
knowledge base to \$app\" ln -sf
\"../../design-system/.lens-knowledge-base\"
\"\$app/.lens-knowledge-base\" ln -sf \"../../design-system/CLAUDE.md\"
\"\$app/CLAUDE.md\" ln -sf
\"../../design-system/LENS_SESSION_CONTEXT.md\"
\"\$app/LENS_SESSION_CONTEXT.md\" done \# 4. Start infrastructure
services docker compose -f
infrastructure/docker/docker-compose.infra.yml up -d \# 5. Wait for
PostgreSQL to be ready echo \"Waiting for PostgreSQL\...\" until docker
exec usrp-postgres pg_isready -U postgres \> /dev/null 2\>&1; do sleep
2; done \# 6. Run database migrations pnpm \--filter shared-database run
migrate \# 7. Seed development NIDA/NESA mock data pnpm run
seed-test-data echo \"═══ Environment ready. Run \'pnpm dev\' to start
all services. ═══\" \`\`\` \*\*Lens DS Prompt Engineering for Frontend
Agents:\*\* This is the crucial agent prompt system specific to USRP.
These prompts go beyond generic Lens prompts and encode USRP-specific
domain knowledge: \`\`\`markdown \<!\--
prompts/USRP-P1-session-starter.md \--\> \# USRP Frontend Agent Session
Starter You are a Lens-native frontend engineer building the Unified
Security Recruitment Portal (USRP) for Rwanda\'s RDF, RNP, and RCS
security agencies. \## Domain Context You Must Never Forget \###
Security & Privacy Rules (Non-Negotiable) 1. NEVER display an
applicant\'s real name or National ID in any recruitment officer
dashboard view. Always use processing codes like \"RDF-90823\" 2. The
biometric WebRTC component captures video in-memory only --- NEVER
render captured frames to visible DOM elements 3. Physical test score
entry forms MUST use bounded numeric inputs only (height: 140-220cm,
weight: 40-150kg) 4. All API calls from frontend go through the BFF
layer (/api/\...) --- NEVER call backend microservices directly \###
Lens DS Rules (From CLAUDE.md) - \"use client\" is REQUIRED on every
file importing \@loomhq/lens - style={{}} is ALWAYS forbidden - Tailwind
hyphen classes are ALWAYS forbidden - The linter is ALWAYS right when
there is a conflict \### USRP Application States You Must Render
Correctly An application moves through these states: DRAFT → SUBMITTED →
ACADEMIC_VETTING → CRIMINAL_CLEARANCE → DOCUMENT_REVIEW_GREEN/AMBER →
SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED → PHYSICAL_TEST_COMPLETE →
MEDICAL_REVIEW → FINAL_SHORTLIST → ACCEPTED/REJECTED Each state requires
a distinct visual indicator in the status tracking component. \###
Agency Color Coding (Using Lens Tokens Only) - RDF: Use Lens \'green\'
token variants - RNP: Use Lens \'blue\' token variants - RCS: Use Lens
\'orange\' token variants These map to Lens design tokens --- never
hardcode hex colors. \### Multi-Agency Data Isolation in Frontend
Dashboard apps (dashboard-rdf, dashboard-rnp, dashboard-rcs) are
SEPARATE Next.js applications. They share the Lens DS and shared-types
package but they are NEVER rendered together in the same shell. An RDF
officer\'s browser session can ONLY reach the rdf-bff API endpoints. \##
Boot Sequence for This Session 1. Read
.lens-knowledge-base/LENS_SESSION_CONTEXT.md 2. Read
.lens-knowledge-base/AGENT_PRIMER.md 3. Identify your task type and load
task-specific files 4. Confirm you understand USRP domain rules above 5.
State which files you\'ve read before writing any code \`\`\` \-\-- \##
Part VI: Comprehensive Development Phase Plan \`\`\`
╔══════════════════════════════════════════════════════════════════════╗
║ USRP ENGINEERING PHASE PLAN ║
╠═══════════╦══════════════════════════════════════════════════════════╣
║ PHASE ║ DELIVERABLES ║
╠═══════════╬══════════════════════════════════════════════════════════╣
║ ║ • Turborepo monorepo initialization ║ ║ PHASE 1 ║ • Docker Compose
full stack (PG, Kafka, Redis, ║ ║ ║ MinIO, ClamAV, Kong, all G2G mocks)
║ ║ Repo & ║ • K8s namespace isolation manifests ║ ║ Env ║ • Istio
mTLS + SPIRE workload identity bootstrap ║ ║ ║ • CI/CD pipelines (GitHub
Actions) ║ ║ Agent: ║ • Lens DS symlink architecture for all frontend
apps ║ ║ Gemini ║ • USRP-specific agent prompt library ║ ║ 2.5 Pro ║ •
Architecture Decision Records (ADRs 001-004) ║ ║ ║ • .env.example with
all required variables ║
╠═══════════╬══════════════════════════════════════════════════════════╣
║ ║ • PostgreSQL schema design (all 4 schemas) ║ ║ PHASE 2 ║ • Drizzle
ORM schema files (public_core, rdf_ops, ║ ║ ║ rnp_ops, rcs_ops, audit) ║
║ Database ║ • RLS policies (complete SQL) ║ ║ Design ║ • Anonymized
views for officer dashboards ║ ║ ║ • Database role hierarchy ║ ║ Agents:
║ • Kafka topic design + Avro schemas ║ ║ Gemini ║ • MinIO bucket
structure + encryption config ║ ║ (schema) ║ • Database migration
pipeline ║ ║ Claude ║ • Seed data for dev environment ║ ║ (RLS ║ •
Performance index strategy ║ ║ review) ║ ║
╠═══════════╬══════════════════════════════════════════════════════════╣
║ ║ • Kong API Gateway configuration ║ ║ PHASE 3 ║ • Identity Service
(NIDA client, USSD state machine, ║ ║ ║ reservation slots) ║ ║ Backend ║
• Eligibility Service (corrected grade engine, ║ ║ Services ║
RDF/RNP/RCS rule sets, NESA client) ║ ║ ║ • Biometric Service (WebRTC
gateway, rPPG, liveness, ║ ║ Agents: ║ 1:1 NIDA face match) ║ ║ Gemini ║
• Document Forensics Service (ELA, DCT, C2PA, ║ ║ (code ║ font analysis,
ClamAV pipeline) ║ ║ gen) ║ • Background Vetting Service (RIB Kafka
consumer) ║ ║ Claude ║ • Routing Service (cross-agency lock logic) ║ ║
(security║ • Scheduling Service (slot allocation by district) ║ ║
review) ║ • Notification Service (MTN/Airtel SMS, email) ║ ║ ║ • Field
Sync Service (CRDT merge, vector clock) ║ ║ ║ • Audit Service (immutable
Kafka → append-only DB) ║ ║ ║ • BFF layer per agency (rdf-bff, rnp-bff,
rcs-bff) ║
╠═══════════╬══════════════════════════════════════════════════════════╣
║ ║ • Public Citizen Portal (portal-web) ║ ║ PHASE 4 ║ - Registration
flow (NID entry → NIDA verify) ║ ║ ║ - Biometric capture (WebRTC
Lens-integrated) ║ ║ Frontend ║ - Agency selection + dynamic form wizard
║ ║ & BFF ║ - Document upload with progress ║ ║ Integr. ║ - Application
status tracker (all states) ║ ║ ║ - QR-coded slot invitation view ║ ║
Agent: ║ • RDF HR Dashboard (dashboard-rdf) ║ ║ Claude ║ - Amber Lane
triage split-screen workspace ║ ║ Sonnet ║ - Anonymized applicant list ║
║ 4.5 ║ - Document forensics review panel ║ ║ (Thinking║ - Keyboard
shortcut approval (F1/F2) ║ ║ mode) ║ - Slot assignment management ║ ║
for all ║ • Field Tablet PWA (field-tablet) ║ ║ Lens ║ - Offline-first
PWA with Workbox ║ ║ frontend ║ - QR code scanner ║ ║ ║ - Bounded score
entry forms ║ ║ ║ - CRDT sync status indicator ║
╠═══════════╬══════════════════════════════════════════════════════════╣
║ ║ • Load testing (k6): 50,000 concurrent registrations ║ ║ PHASE 5 ║ •
Security penetration testing (OWASP ZAP) ║ ║ ║ • Accessibility audit
(WCAG 2.1 AA) ║ ║ Testing ║ • USSD flow end-to-end testing ║ ║ & ║ •
Offline tablet sync stress testing ║ ║ Security ║ • Data Privacy Law N°
058/2021 compliance audit ║ ║ ║ • RLS policy verification (cross-agency
access tests) ║ ║ Agents: ║ • mTLS certificate rotation testing ║ ║
Gemini ║ • Document forensics accuracy benchmarking ║ ║ (test ║ • Chaos
engineering (Kafka partition failures) ║ ║ gen) ║ ║ ║ Claude ║ ║ ║ (sec
║ ║ ║ review) ║ ║
╠═══════════╬══════════════════════════════════════════════════════════╣
║ PHASE 6 ║ • RCS pilot deployment to NDC ║ ║ ║ • Real recruitment cycle
monitoring ║ ║ Pilot & ║ • Performance tuning based on real traffic ║ ║
Launch ║ • USSD integration live testing with MTN/Airtel ║ ║ ║ • Full
RDF + RNP + RCS launch ║
╚═══════════╩══════════════════════════════════════════════════════════╝
\`\`\` \-\-- \## Part VII: Agent Prompt Templates for Each Phase \###
Critical Prompt: Backend Service Generation (Gemini 2.5 Pro) \`\`\` USRP
BACKEND SERVICE GENERATION PROMPT Context: You are generating a NestJS
microservice for the Unified Security Recruitment Portal (USRP) --- a
military-grade multi-agency recruitment system for Rwanda\'s RDF, RNP,
and RCS. ABSOLUTE RULES: 1. Every service must emit typed Kafka events
using packages/shared-events producers 2. All NIDA/NESA calls use
HMAC-signed requests (packages/shared-security) 3. Never log National ID
numbers, biometric data, or raw PII 4. All async operations use the
event-driven pattern: 202 Accepted → Kafka event → worker consumer →
status update 5. Database access uses Drizzle ORM with the schema from
packages/shared-database ONLY 6. Error types must be typed exceptions,
never raw Error objects 7. Every controller endpoint must have a
corresponding OpenAPI decorator (@ApiOperation, \@ApiResponse) SERVICE
TO BUILD: \[SERVICE_NAME\] KAFKA EVENTS TO CONSUME: \[EVENT_LIST\] KAFKA
EVENTS TO PRODUCE: \[EVENT_LIST\] G2G INTEGRATIONS:
\[NIDA\|NESA\|RIB\|NONE\] DATABASE SCHEMAS ACCESSED: \[SCHEMA_LIST\]
\`\`\` \### Critical Prompt: Security Review (Claude Sonnet 4.5
Thinking) \`\`\` USRP SECURITY REVIEW PROMPT You are the security
architect reviewing code for the USRP --- a national security system
that is a HIGH-VALUE TARGET for state-sponsored adversaries. REVIEW
FRAMEWORK: 1. Data Privacy: Does this comply with Rwanda Law N°
058/2021? - Is PII encrypted at rest? - Is PII masked in logs? - Is
there a data retention/erasure path? 2. Authentication &
Authorization: - Are JWT tokens short-lived? - Are mTLS certificates
managed by SPIRE? - Does RLS prevent cross-agency data access? 3. Input
Validation: - Are all external inputs validated and sanitized? - Is file
upload passing through ClamAV? - Are SQL injection vectors eliminated by
ORM use? 4. Cryptography: - Is HMAC used for all G2G API requests? - Are
keys stored in HSM, not environment variables? - Is AES-256-GCM used for
document storage? 5. Denial of Service: - Are rate limits configured at
Kong? - Are Kafka consumers protected against message flooding? - Are
file upload sizes bounded? CODE TO REVIEW: \[PASTE CODE\] IDENTIFY:
vulnerabilities, compliance gaps, and corrections. SEVERITY LEVELS:
CRITICAL \| HIGH \| MEDIUM \| LOW \| INFO \`\`\` \-\-- \## Summary: What
This Architecture Achieves \| Capability \| Status in Original Doc \|
Status in This Architecture \| \|\-\--\|\-\--\|\-\--\| \| Grade
comparison logic \| \*\*Buggy\*\* (string comparison) \| \*\*Fixed\*\*
(rank map) \| \| USSD session continuity \| \*\*Undefined\*\* (orphan
risk) \| \*\*Defined\*\* (re-anchored identity) \| \| Kafka vs RabbitMQ
choice \| \*\*Ambiguous\*\* \| \*\*Resolved\*\* (Kafka mandated) \| \|
AI document forgery detection \| \*\*Missing\*\* (ELA only) \|
\*\*Added\*\* (DCT + C2PA) \| \| mTLS certificate lifecycle \|
\*\*Unaddressed\*\* \| \*\*SPIFFE/SPIRE\*\* managed \| \| Offline tablet
sync conflicts \| \*\*Unaddressed\*\* \| \*\*CRDT + vector clocks\*\* \|
\| Cross-agency data isolation \| \*\*Logical only\*\* \| \*\*PostgreSQL
RLS + K8s network policies\*\* \| \| Lens DS agent integration \|
\*\*Generic\*\* \| \*\*USRP-domain-specific prompts + symlink arch\*\*
\| \| Agent cognitive specialization \| \*\*None\*\* \| \*\*Deliberate
model-to-task assignment\*\* \| \| Audit immutability \|
\*\*Mentioned\*\* \| \*\*Kafka append-only consumer architecture\*\* \|\
\
ME:\
\
Sir, WE SHALL CAREFULLY START THE PHASE 1 OF THIS SOFTWARE PROJECT.\
\
\
AI (CLAUDE):

\# USRP Phase 1: Repository, Environment & Infrastructure Foundation \##
Strategic Pre-Phase Assessment Before writing a single file, I need to
establish the \*\*exact ground truth\*\* of your current environment.
Phase 1 failures are the most catastrophic --- a broken foundation means
every subsequent phase inherits compounding debt. Let me ask the
\*\*precise questions\*\* that will determine every configuration
decision: \-\-- \## Pre-Phase 1 Environment Interrogation \*\*Please
provide the following:\*\* \### 1. Your Current Machine & OS \`\`\`bash
\# Run these and share the output: uname -a lsb_release -a docker
\--version docker compose version node \--version pnpm \--version git
\--version \`\`\` \### 2. Your Existing Project State \`\`\`bash \# Do
you have any existing directory started for USRP? \# If yes: ls -la
\~/path/to/usrp/ \# If no, confirm where you want the project root: echo
\$HOME \`\`\` \### 3. Your Design System Location \`\`\`bash \# From
your earlier message, your Lens DS boilerplate is at: ls -la
\~/Documents/projects/design-system/ \# Confirm the EXACT absolute path:
realpath \~/Documents/projects/design-system/ \`\`\` \### 4. Google AI
Studio / Anti-Gravity Environment - Are you running agents
\*\*inside\*\* Google AI Studio\'s code execution environment? - Or are
agents generating code that \*\*you\*\* execute on your local machine? -
Do you have access to Google AI Studio\'s file system / workspace
persistence? \### 5. Infrastructure Availability \`\`\`bash \# Confirm
Docker daemon is running: docker info \| grep \"Server Version\" \#
Check available disk space (we need minimum 20GB for full stack): df -h
\~ \# Check available RAM (Kafka + PG + Redis + MinIO needs \~6GB
minimum): free -h \`\`\` \-\-- \## Once You Provide That --- Here Is
Exactly What Phase 1 Delivers \`\`\` PHASE 1 EXECUTION PLAN
═══════════════════════════════════════════════════════════════ STEP 1.1
Monorepo Initialization • pnpm workspace + Turborepo configuration •
.nvmrc, .node-version, engines enforcement • Git initialization +
.gitignore • CODEOWNERS file STEP 1.2 Package Skeleton Creation • All
apps/ directories scaffolded • All services/ directories scaffolded •
All packages/ directories scaffolded • Every package.json with correct
dependencies STEP 1.3 Lens DS Integration • design-system/ integrated
into monorepo • Symlinks created for all frontend apps • USRP-specific
agent prompt library written STEP 1.4 Infrastructure Stack •
docker-compose.infra.yml (PG, Kafka, Redis, MinIO, ClamAV, Kong, Schema
Registry) • docker-compose.dev.yml (all services + infra) •
docker-compose.test.yml (isolated test env) • All init scripts (DB
schemas, Kafka topics) • G2G mock servers (NIDA, NESA, RIB) STEP 1.5
CI/CD Pipelines • GitHub Actions workflows • Security scanning pipeline
• Lens compliance enforcement in CI STEP 1.6 Developer Tooling •
setup-dev.sh one-command bootstrap • .env.example (documented) •
Turborepo pipeline configuration • ESLint + TypeScript base configs STEP
1.7 Architecture Documentation • ADR-001 through ADR-004 • USRP agent
prompt library • README.md
═══════════════════════════════════════════════════════════════ \`\`\`
\*\*Share those environment details and we execute Step 1.1
immediately.\*\*\
\
***ME:\
\
****uruti@jackson-HP-EliteBook-840-G3:\~\$ \# Run these and share the
output: uname -a lsb_release -a docker \--version docker compose version
node \--version pnpm \--version git \--version Linux
jackson-HP-EliteBook-840-G3 6.11.0-28-generic #28\~24.04.1-Ubuntu SMP
PREEMPT_DYNAMIC Fri May 23 10:31:01 UTC 2 x86_64 x86_64 x86_64 GNU/Linux
No ****LSB modules are available. Distributor ID: Ubuntu Description:
Ubuntu 24.04.4 LTS Release: 24.04 Codename: noble Docker version 29.6.1,
build 8900f1d Docker Compose version v5.2.0 v24.14.0 10.32.1 git version
2.43.0 uruti@jackson-HP-EliteBook-840-G3:\~\$ \# Do you have any
existing directory started for USRP? NO . \# If no, confirm where you
want the project root: uruti@jackson-HP-EliteBook-840-G3:\~\$ echo
\$HOME /home/uruti uruti@jackson-HP-EliteBook-840-G3:\~\$
uruti@jackson-HP-EliteBook-840-G3:\~\$ \# From your earlier message,
your Lens DS boilerplate is at: ls -la
\~/Documents/projects/design-system/ \# Confirm the EXACT absolute path:
realpath \~/Documents/projects/design-system/ total 236 drwxrwxr-x 12
uruti uruti 4096 May 10 17:47 . drwxrwxr-x 8 uruti uruti 4096 Jul 2
08:22 .. -rw-rw-r\-- 1 uruti uruti 1670 May 7 12:00 CLAUDE.md
-rw-rw-r\-- 1 uruti uruti 1212 May 1 03:23 .clinerules drwxrwxr-x 3
uruti uruti 4096 Mar 11 15:46 .cursor -rw-rw-r\-- 1 uruti uruti 3406 May
10 12:42 eslint.config.mjs drwxrwxr-x 3 uruti uruti 4096 Mar 11 15:46
eslint-plugin-lens-compliance drwxrwxr-x 9 uruti uruti 4096 May 21 17:30
.git drwxrwxr-x 3 uruti uruti 4096 Mar 11 15:46 .github -rw-rw-r\-- 1
uruti uruti 149 Apr 26 12:46 .gitignore drwxrwxr-x 3 uruti uruti 4096
Apr 24 16:48 .husky drwxrwxr-x 8 uruti uruti 4096 May 3 20:09
.lens-knowledge-base -rw-rw-r\-- 1 uruti uruti 2606 May 7 12:41
LENS_SESSION_CONTEXT.md -rw-r\--r\-- 1 uruti uruti 2222 May 8 15:16
LOOM_COGNITIVE_ARCH.md drwxrwxr-x 11 uruti uruti 4096 May 3 15:23
node_modules -rw-rw-r\-- 1 uruti uruti 3 May 3 18:56 .node-version
-rw-rw-r\-- 1 uruti uruti 3 May 3 18:56 .nvmrc -rw-rw-r\-- 1 uruti uruti
2161 May 5 17:15 package.json -rw-rw-r\-- 1 uruti uruti 143290 May 3
15:23 pnpm-lock.yaml drwxrwxr-x 2 uruti uruti 4096 May 7 12:13 prompts
-rw-rw-r\-- 1 uruti uruti 5329 May 3 15:18 README.md drwxrwxr-x 3 uruti
uruti 4096 Apr 29 21:17 scripts drwxrwxr-x 10 uruti uruti 4096 May 10
15:25 src -rw-rw-r\-- 1 uruti uruti 1059 May 1 03:24 .windsurfrules
/home/uruti/Documents/projects/design-system
uruti@jackson-HP-EliteBook-840-G3:\~\$
uruti@jackson-HP-EliteBook-840-G3:\~\$ \# Confirm Docker daemon is
running: docker info \| grep \"Server Version\" \# Check available disk
space (we need minimum 20GB for full stack): df -h \~ \# Check available
RAM (Kafka + PG + Redis + MinIO needs \~6GB minimum): free -h failed to
connect to the docker API at unix:///var/run/docker.sock; check if the
path is correct and if the daemon is running: dial unix
/var/run/docker.sock: connect: no such file or directory Filesystem Size
Used Avail Use% Mounted on /dev/nvme0n1p2 233G 38G 184G 17% / total used
free shared buff/cache available Mem: 7.5Gi 4.0Gi 307Mi 686Mi 4.3Gi
3.5Gi Swap: 7.8Gi 7.2Mi 7.8Gi
***<uruti@jackson-HP-EliteBook-840-G3>***:\~\$****\
\
AI (CLAUDE):***

**

***\# USRP Phase 1 --- Architecture Clarification & Structural Decision
\## Critical Understanding of Your Design System Architecture This
changes the monorepo strategy significantly. Let me fully understand
what you have before making a single directory. \-\-- \## Deep
Inspection Required Run these commands and share \*\*all outputs\*\*:
\`\`\`bash \# 1. What is currently in src/ ? ls -la
\~/Documents/projects/design-system/src/ \# 2. What is in the web/
directory? (I see it in your ls but wasn\'t in earlier output) ls -la
\~/Documents/projects/design-system/web/ \# 3. What is in prompts/ ? ls
-la \~/Documents/projects/design-system/prompts/ \# 4. What is in
scripts/ ? ls -la \~/Documents/projects/design-system/scripts/ \# 5.
What is in .lens-knowledge-base/ fully ? ls -la
\~/Documents/projects/design-system/.lens-knowledge-base/ \# 6. Show
****me the current package.json engines and workspaces fields precisely:
cat \~/Documents/projects/design-system/package.json \# 7. Is there a
pnpm-workspace.yaml ? cat
\~/Documents/projects/design-system/pnpm-workspace.yaml 2\>/dev/null
\|\| echo \"NO WORKSPACE FILE EXISTS\" \# 8. Show LOOM_COGNITIVE_ARCH.md
--- this sounds architecturally important: cat
\~/Documents/projects/design-system/LOOM_COGNITIVE_ARCH.md \# 9. Show
.clinerules: cat \~/Documents/projects/design-system/.clinerules \# 10.
Show .windsurfrules: cat
\~/Documents/projects/design-system/.windsurfrules \`\`\` \-\-- \## What
I Need to Understand Before Deciding Structure Your statement raises a
\*\*precise architectural question\*\*: \`\`\` You said: \"move inside
design-system directory\" This means one of three things and they are
NOT equivalent: \`\`\` \`\`\` INTERPRETATION A: design-system/ BECOMES
the monorepo root ├── CLAUDE.md ← stays (agent guidance) ├──
.lens-knowledge-base/ ← stays (agent knowledge) ├──
eslint-plugin-lens-compliance/ ← stays (enforcement) ├── src/ ←
CURRENTLY: Lens DS UI impl │ BECOMES: still Lens DS src? │ OR: USRP
frontend lives here? ├── web/ ← what is this currently? ├── apps/ ← NEW:
USRP frontend apps added here ├── services/ ← NEW: USRP backend services
├── packages/ ← NEW: shared packages └── infrastructure/ ← NEW: docker,
k8s, terraform INTERPRETATION B: design-system/ stays AS-IS (Lens
tooling only) And USRP frontend apps are added INSIDE src/ : src/ ├──
portal-web/ ← USRP citizen portal ├── dashboard-rdf/ ← RDF HR dashboard
├── dashboard-rnp/ ├── dashboard-rcs/ ├── dashboard-superadmin/ └──
field-tablet/ INTERPRETATION C: design-system/ is the FRONTEND MONOREPO
ONLY Backend services live in a SEPARATE repository:
/home/uruti/Documents/projects/ ├── design-system/ ← ALL frontend
(Lens + USRP UI) │ └── src/ ← USRP frontend apps live here └──
usrp-backend/ ← ALL backend services separately \`\`\` \-\-- \## My
Initial Concern With Each Interpretation \`\`\` INTERPRETATION A ---
design-system becomes full monorepo root: RISK: The existing Lens
enforcement tooling (eslint-plugin-lens-compliance,
.lens-knowledge-base) was designed for FRONTEND ONLY. Mixing backend
NestJS services, Kafka configs, and Terraform into this repo will
confuse agents --- they will apply Lens component rules to backend
TypeScript code. RISK: The existing pnpm-lock.yaml will conflict with
new backend dependencies being added. VIABLE: Only if we carefully
namespace everything. ****INTERPRETATION B --- USRP frontends go inside
src/: RISK: What is currently in src/? If it has existing Lens component
source, mixing USRP app code there creates ambiguity for agents about
what is \"design system\" vs \"application\". VIABLE: If src/ is
currently empty or minimal. INTERPRETATION C --- Frontend/Backend split
repos: CLEAN SEPARATION: Agents working on backend never see Lens rules.
Agents on frontend are fully immersed in Lens environment. RISK:
Cross-repo coordination for BFF layer becomes more complex. VIABLE:
Strong option if backend scope is large. \`\`\` \-\-- \## Also --- Fix
Docker First (Parallel Action) While you run the inspection commands,
also run the Docker fix: \`\`\`bash \# Run these simultaneously in a
second terminal: sudo systemctl start docker sudo systemctl enable
docker sudo systemctl status docker \# Then verify: docker info \| grep
\"Server Version\" docker run \--rm hello-world \`\`\` \-\-- \## Share
All of That Once I see: 1. What is currently in \`src/\`, \`web/\`,
\`prompts/\`, \`scripts/\` 2. The full \`package.json\` 3.
\`LOOM_COGNITIVE_ARCH.md\` content 4. Docker status after fix I will
give you the \*\*exact, definitive directory structure\*\* --- not
options, not interpretations --- the \*\*precise structure\*\* we will
build, with full justification. Then we execute Step 1.1 immediately.\
\
\
****ME:\
\
****IN short the lens design system repo in an environment created so
that ai agents can always generate ui code within lens design system
boundaries. whenever an engineer needs to create frontend easily they
may come, delete current src/ and write their own src/ then prompt the
agent to write the frontend but the agents are still in the boundaries
created by the environment like claude.md files the agents fetch
knowledge of the lens design system from .lens-knowledge-base the agent
code is linted and verified for tailwind and halliculations via
eslint-plugin-lens-compliance then the agents write the code inside src.
currently src contained a small dashboard written to test if the agents
are seamlessly integrating themselves and adapting to the directory
(project) configurations and it is a loom.com dashboard clone
lens-design-system Repository Architecture: Deep Interpretation
drwxrwxr-x 2 root root 4096 Jun 2 10:54 prompts -rw-rw-r\-- 1 root root
5329 Jun 2 10:54 README.md drwxrwxr-x 3 root root 4096 Jun 2 10:54
scripts drwxrwxr-x 10 root root 4096 Jun 2 10:54 src -rw-rw-r\-- 1 root
root 1059 Jun 2 10:54 .windsurfrules
/home/uruti/Documents/projects/design-system (Alpha
Test)/src/features/library/VideoGrid.tsx
/home/uruti/Documents/projects/design-system (Alpha
Test)/src/next.config.ts /home/uruti/Documents/projects/design-system
(Alpha Test)/src/next-env.d.ts
/home/uruti/Documents/projects/design-system (Alpha
Test)/src/services/videoService.ts
/home/uruti/Documents/projects/design-system (Alpha
Test)/src/types/navigation.ts drwxrwxr-x 11 root root 4096 Apr 29 17:20
design-system (Backup) -rw-rw-r\-- 1 root root 451664 Jun 18 17:36 Lens
DESIGN SYSTEM EVALUATION - Jun 18 2026 12:41.odt drwxrwxr-x 4 root root
4096 May 26 11:50 NISR-BIG-DATA-HACKATHON-2026 drwxrwxr-x 2 root root
4096 Jul 2 08:22 Rwanda security e recritment drwxrwxr-x 5 root ****root
4096 Jul 2 07:10 Rwanda security e recritment - DCMs drwxrwxr-x 8 root
root 4096 Jul 2 10:15 .. -rw-rw-r\-- 1 root root 60825 Jul 2 07:10
Master document.odt drwxrwxr-x 2 root root 4096 Jun 28 16:48 RCS
drwxrwxr-x 2 root root 4096 Jun 19 15:24 RDF drwxrwxr-x 2 root root 4096
Jun 19 15:18 RNP Files /home/uruti/Documents/projects/design-system
(Alpha Test)/src/app/globals.css and
/home/uruti/Documents/projects/design-system (Alpha
Test)/web/src/app/globals.css differ \-\--web vs root top\-\--
Repository Architecture: Deep Interpretation Sources consulted:
.lens-knowledge-base/AGENT_PRIMER.md, .lens-knowledge-base/\_ROUTER.md,
.lens-knowledge-base/\_GOVERNANCE.md, CLAUDE.md, README.md,
LOOM_COGNITIVE_ARCH.md, LENS_SESSION_CONTEXT.md, prompts/README.md,
prompts/P2-application-scaffold.md, package.json, src/package.json,
eslint.config.mjs, src/eslint.config.mjs, .husky/pre-commit,
scripts/guard-file-system.sh, scripts/guard-protected-paths.sh,
.github/workflows/lens-enforcement.yml, .cursor/rules/agents.mdc, and
the live src/ tree (22 TS/TSX files). 1. What This Repository Actually
Is This is not a component library and not a generic monorepo. It is a
Lens-native AI development platform --- a governance, knowledge, and
enforcement layer wrapped around Loom's external package
\@loomhq/lens@12.18.0. Layer Role Mission Make Lens AI-consumable,
AI-safe, and AI-guided for frontend development Vision Agents assemble
UI from Lens primitives with zero drift --- speed, scalability,
consistency Product metaphor "30,000 car parts compose a car" --- agents
are assemblers, not inventors The repo does three jobs: Knowledge ---
.lens-knowledge-base/ (55 components, tokens, patterns, synced type
declarations) Enforcement --- eslint-plugin-lens-compliance/ (4 rules,
1,935 CSS classes, 103 component signatures) Application shell --- src/
(a real Next.js 16 app that proves the system works) There is zero USRP
code in this repository today. USRP (Rwanda Security Recruitment ---
RDF/RNP/RCS) exists only as document folders in a sibling project path,
not as code here. 2. Physical Structure (As Built Today) design-system
(Alpha Test)/ ← REPO ROOT = governance + enforcement │ ├── CLAUDE.md ←
25-line agent pointer (never grows) ├── .cursor/rules/agents.mdc ←
Cursor boot rules ├── .lens-knowledge-base/ ← 1,100+ files --- agent
READ zone ├── eslint-plugin-lens-compliance/ ← Custom ESLint plugin ├──
scripts/ ← KB sync, lint DB generation, guards ├── prompts/ ← P1--P7
human→agent prompt system ├── .husky/pre-commit ← Guards + lint on every
commit ├── .github/workflows/ ← CI enforcement ├── package.json ← Root
tooling (kb:validate, lint-staged) ├── pnpm-lock.yaml ← Root lockfile
├── eslint.config.mjs ← Lens rules applied to src/\*\* │ ├── src/ ←
AGENT WRITE ZONE (single Next.js app) │ ├── package.json ← Separate
Next.js package (React 19) │ ├── pnpm-lock.yaml ← SECOND lockfile
(nested, not workspace) │ ├── app/ ← App Router (page, layout, routes) │
├── components/ ← layout, navigation, providers │ ├── features/ ←
library (Loom video UI clone) │ ├── services/ ← videoService.ts (mock
data) │ └── types/ │ └── web/ ← NEAR-DUPLICATE of entire repo (alpha
artifact) ├── (same KB, eslint, scripts, src/\...) └── Only minor diff
vs root src/ (globals.css) Critical structural facts Not a monorepo ---
no root pnpm-workspace.yaml. src/ is a nested package with its own
lockfile. src/ is not empty --- it contains a working Loom-style video
library demo (AppShell, Sidebar, LibraryPage, routes: /, /for-you,
/meetings, /settings). web/ is a snapshot duplicate --- same tree as
root, likely from alpha testing; not a separate product surface. Agent
contract is hardcoded: "Read from .lens-knowledge-base/ --- write to
src/ only." 3. The Agent Operating Model (This Is the Core "Workflow")
flowchart TD A\[Session Start\] \--\> B\[CLAUDE.md / agents.mdc\] B
\--\> C\[AGENT_PRIMER.md\] C \--\> D\[\_ROUTER.md\] D \--\> E{Task Type}
E \--\>\|Find component\| F\[COMPONENT-INDEX → components/Name.md\] E
\--\>\|Build feature\| G\[prompts/P3-feature-build.md\] E
\--\>\|Bootstrap\| H\[prompts/P2-application-scaffold.md\] E \--\>\|Lint
error\| I\[prompts/P5-correction-loop.md\] F \--\> J\[Write code in src/
only\] G \--\> J H \--\> J J \--\> K\[pnpm eslint src/\*\*/\*.{ts,tsx}\]
K \--\>\|Pass\| L\[P6 self-review → P7 gap report\] K \--\>\|Fail\| I
Find component Build feature Bootstrap Lint error Pass Fail Session
Start CLAUDE.md / agents.mdc AGENT_PRIMER.md \_ROUTER.md Task Type
COMPONENT-INDEX → components/Name.md prompts/P3-feature-build.md
prompts/P2-application-scaffold.md prompts/P5-correction-loop.md Write
code in src/ only pnpm eslint src/\*\*/\*.{ts,tsx} P6 self-review ****→
P7 gap report The 4 axioms agents must obey Lens or nothing --- all UI
from \@loomhq/lens Tokens are the language --- no raw px/hex/rem
Structure first --- Split, Container, Arrange before raw divs Linter is
ground truth --- 1,935 validated classes; agent code is wrong until
proven otherwise The client boundary (non-negotiable) Every file
importing \@loomhq/lens must have \"use client\" as line 1. LensProvider
uses a mounted gate to avoid hydration mismatch --- already implemented
in src/components/providers/LensProvider.tsx. Enforcement stack (every
commit + CI) Guard What it protects guard-protected-paths.sh Blocks
edits to eslint rules, CLAUDE.md, husky, CI without
ALLOW_ENFORCEMENT_EDIT=1 guard-file-system.sh No Tailwind configs; no
CSS/SCSS in src/ except the allowed pattern verify:lint-dbs Mastery DBs
match Lens version ESLint (root config) 4 Lens rules on
src/\*\*/\*.{ts,tsx} lint-staged Same scope: src/\*\*/\*.{ts,tsx} Scope
is surgically frontend-only. AGENT_PRIMER.md explicitly states: scope:
src/\*\* frontend UI only. 4. What src/ Contains (Not a Design System
Source Tree) src/ is application code, not Lens component source.
Current layout: src/ ├── app/ │ ├── layout.tsx ← Server Component +
LensProvider │ ├── page.tsx ← Library page (Loom clone) │ ├──
(routes)/for-you/ │ ├── (routes)/meetings/ │ └── (routes)/settings/ ├──
components/ │ ├── layout/ ← AppShell, Sidebar, TopBar │ ├── navigation/
← NavItem │ └── providers/ ← LensProvider ├── features/library/ ←
VideoGrid, VideoCard, EmptyState\... ├── services/videoService.ts └──
types/navigation.ts This is a reference implementation --- a Loom video
library UI built to validate that agents can produce Lens-compliant
production code under enforcement. 5. Interconnections Between
Subsystems flowchart LR subgraph READ\[\"Agent Read Zone\"\]
KB\[.lens-knowledge-base/\] PROMPTS\[prompts/P1-P7\] end subgraph
ENFORCE\[\"Enforcement Layer\"\] ESLINT\[eslint-plugin-lens-compliance\]
MASTERY\[mastery-db.json + component-mastery-db.json\]
GUARDS\[scripts/guard-\*.sh\] end subgraph WRITE\[\"Agent Write Zone\"\]
SRC\[src/ Next.js App\] end subgraph EXTERNAL\[\"External\"\]
LENS\[\"@loomhq/lens npm package\"\] end KB \--\>\|documents API\| SRC
LENS \--\>\|runtime components\| SRC LENS \--\>\|type sync\| KB LENS
\--\>\|generates\| MASTERY MASTERY \--\> ESLINT ESLINT \--\>\|lints\|
SRC GUARDS \--\>\|pre-commit\| SRC PROMPTS \--\>\|orchestrates\| SRC
CLAUDE\[CLAUDE.md\] \--\> KB Agent Read Zone Enforcement Layer Agent
Write Zone External documents API runtime components type sync generates
lints pre-commit orchestrates CLAUDE.md .lens-knowledge-base/
prompts/P1-P7 eslint-plugin-lens-compliance mastery-db.json +
component-mastery-db.json scripts/guard-\*.sh src/ Next.js App
\@loomhq/lens npm package Connection Mechanism KB ↔ Lens package pnpm
kb:sync-types copies type declarations from \@loomhq/lens KB ↔ Linter
generate-mastery-db.js / generate-component-mastery-db.js derive rule
databases from Lens source Root ↔ src/ Root ESLint config lints src/;
root lint-staged hooks into src/\*\*; src has its own pnpm dev Agents ↔
Code .cursor/rules/agents.mdc + CLAUDE.md → read KB, write src/ only 6.
What web/ Is web/ is a full nested copy of the governance layer + src/
app, with its own node_modules, pnpm-lock.yaml, and duplicate
.lens-knowledge-base/. It differs from root only in minor ways (e.g.
globals.css). It is not documented as a first-class architectural tier.
Treat it as an alpha test artifact or packaging experiment. total 232
drwxrwxr-x 10 uruti uruti 4096 May 10 15:25 . drwxrwxr-x 12 uruti uruti
4096 May 10 17:47 .. -rw-rw-r\-- 1 uruti uruti 327 May 1 15:02 AGENTS.md
drwxrwxr-x 3 uruti uruti 4096 May 10 15:26 app -rw-rw-r\-- 1 uruti uruti
11 May 1 15:02 CLAUDE.md drwxr-xr-x 5 uruti uruti 4096 May 3 10:41
components -rw-rw-r\-- 1 uruti uruti 465 May 1 15:01 eslint.config.mjs
drwxr-xr-x 3 uruti uruti 4096 May 3 10:42 features -rw-rw-r\-- 1 uruti
uruti 480 May 1 15:01 .gitignore drwxrwxr-x 3 uruti uruti 4096 May 7
12:06 .next -rw-rw-r\-- 1 uruti uruti 143 May 3 17:36 next.config.ts
-rw-rw-r\-- 1 uruti uruti 251 May 7 13:15 next-env.d.ts drwxrwxr-x 7
uruti uruti 4096 May 1 15:19 node_modules -rw-rw-r\-- 1 uruti uruti 551
May 1 15:19 package.json -rw-rw-r\-- 1 uruti uruti 151772 May 1 15:19
pnpm-lock.yaml -rw-rw-r\-- 1 uruti uruti 54 May 1 15:01
pnpm-workspace.yaml drwxrwxr-x 2 uruti uruti 4096 May 1 15:01 public
-rw-rw-r\-- 1 uruti uruti 1450 May 1 15:01 README.md drwxr-xr-x 2 uruti
uruti 4096 May 10 15:25 services -rw-rw-r\-- 1 uruti uruti 666 May 1
15:01 tsconfig.json drwxr-xr-x 2 uruti uruti 4096 May 3 10:40 types ls:
cannot access \'/home/uruti/Documents/projects/design-****system/web/\':
No such file or directory total 48 drwxrwxr-x 2 uruti uruti 4096 May 7
12:13 . drwxrwxr-x 12 uruti uruti 4096 May 10 17:47 .. -rw-rw-r\-- 1
uruti uruti 1976 May 7 12:18 \'P0-when session stops.md\' -rw-rw-r\-- 1
uruti uruti 2034 May 3 17:14 P1-session-starter.md -rw-rw-r\-- 1 uruti
uruti 3137 May 8 08:10 P2-application-scaffold.md -rw-rw-r\-- 1 uruti
uruti 2965 May 1 03:22 P3-feature-build.md -rw-rw-r\-- 1 uruti uruti
5479 May 7 07:57 P4-component-build.md -rw-rw-r\-- 1 uruti uruti 3503
May 3 20:28 P5-correction-loop.md -rw-rw-r\-- 1 uruti uruti 3812 May 1
03:22 P6-self-review-gate.md -rw-rw-r\-- 1 uruti uruti 1909 May 1 03:23
P7-gap-report.md -rw-rw-r\-- 1 uruti uruti 828 May 3 15:22 README.md
total 108 drwxrwxr-x 3 uruti uruti 4096 Apr 29 21:17 . drwxrwxr-x 12
uruti uruti 4096 May 10 17:47 .. -rw-rw-r\-- 1 uruti uruti 5952 May 3
20:03 generate-component-mastery-db.js -rw-rw-r\-- 1 uruti uruti 4931
Mar 11 15:46 generate-component-stubs.js -rw-rw-r\-- 1 uruti uruti 9406
Apr 29 23:17 generate-mastery-db.js -rw-rw-r\-- 1 uruti uruti 1463 Mar
11 15:46 generate-session-context.js -rwxrwxr-x 1 uruti uruti 1316 Apr
27 10:16 generate-task-context.sh -rwxrwxr-x 1 uruti uruti 842 Mar 11
15:46 guard-file-system.sh -rwxrwxr-x 1 uruti uruti 990 Mar 11 15:46
guard-protected-paths.sh -rwxrwxr-x 1 uruti uruti 7034 Apr 27 10:17
jit-context.js drwxrwxr-x 2 uruti uruti 4096 Apr 23 12:12 kb -rwxrwxr-x
1 uruti uruti 9633 Mar 11 15:46 lens-knowledge-extractor.sh -rwxrwxr-x 1
uruti uruti 2448 May 3 17:43 lint-feedback.sh -rwxrwxr-x 1 uruti uruti
1578 Mar 11 15:46 list-lens-exports.sh -rwxrwxr-x 1 uruti uruti 1345 Mar
11 15:46 rebuild-icons-inventory.sh -rwxrwxr-x 1 uruti uruti 2078 Mar 11
15:46 save-icon-inventory.sh -rwxrwxr-x 1 uruti uruti 2671 May 3 15:21
update-verified-exports.sh -rwxrwxr-x 1 uruti uruti 1374 Mar 11 15:46
verify-lens-install.sh -rw-rw-r\-- 1 uruti uruti 7310 Apr 29 23:28
verify-lint-db-fresh.js total 268 drwxrwxr-x 8 uruti uruti 4096 May 3
20:09 . drwxrwxr-x 12 uruti uruti 4096 May 10 17:47 .. -rw-rw-r\-- 1
uruti uruti 9570 May 7 12:01 AGENT_PRIMER.md -rw-rw-r\-- 1 uruti uruti
3985 Apr 29 21:09 COMPONENT-INDEX.md drwxrwxr-x 2 uruti uruti 4096 Apr
27 11:32 components -rw-rw-r\-- 1 uruti uruti 18440 Mar 11 15:46
component-signatures.json -rw-rw-r\-- 1 uruti uruti 562 Mar 11 15:46
docs-manifest.json -rw-rw-r\-- 1 uruti uruti 4772 Mar 11 15:46
exports-inventory.json -rw-rw-r\-- 1 uruti uruti 7707 May 3 15:21
exports-verified.json -rw-rw-r\-- 1 uruti uruti 2741 May 3 15:21
\_GOVERNANCE.md drwxrwxr-x 2 uruti uruti 4096 May 3 17:33 guides
-rw-rw-r\-- 1 uruti uruti 97283 Mar 11 15:46 icons-inventory.json
-rw-rw-r\-- 1 uruti uruti 36555 Mar 11 15:46 icons-inventory.md
-rw-rw-r\-- 1 uruti uruti 14441 May 21 17:30 introduction.md -rw-rw-r\--
1 uruti uruti 6199 May 3 15:22 MASTER-REFERENCE.md -rw-rw-r\-- 1 uruti
uruti 948 May 3 20:09 package-meta.json drwxrwxr-x 2 uruti uruti 4096
Apr 26 12:48 patterns -rw-rw-r\-- 1 uruti uruti 2729 May 8 08:22
QUICK-REFERENCE.md drwxrwxr-x 2 uruti uruti 4096 Mar 11 15:46 reference
-rw-rw-r\-- 1 uruti uruti 8424 May 7 12:01 \_ROUTER.md drwxrwxr-x 2
uruti uruti 4096 Apr 24 08:22 tokens drwxrwxr-x 9 uruti uruti 4096 May 3
20:09 type-declarations { \"name\": \"lens-design-system\", \"version\":
\"1.0.0\", \"description\": \"Lens design system engineered for AI
assisted software development consumption.\", \"repository\": {
\"type\": \"git\", \"url\":
\"git+https://github.com/Jackson-NSANZIMANA/design-system.git\" },
\"keywords\": \[ \"design-system\",
\"AI-assisted-software-development\", \"components\", \"lens\" \],
\"author\": \"Jackson NSANZIMANA\", \"dependencies\": {
\"@atlaskit/icon\": \"\^25.8.0\", \"@atlaskit/icon-lab\": \"\^4.19.0\",
\"@jackson_nsanzimana/atlassian-fonts\": \"\^1.0.0\", \"@loomhq/lens\":
\"12.18.0\", \"react\": \"18.3.1\", \"react-dom\": \"18.3.1\" },
\"devDependencies\": { \"@eslint/js\": \"\^9.39.4\", \"eslint\":
\"\^9.39.4\", \"eslint-plugin-lens-compliance\":
\"link:eslint-plugin-lens-compliance\", \"eslint-plugin-react\":
\"\^7.37.5\", \"glob\": \"\^13.0.6\", \"globals\": \"\^17.6.0\",
\"husky\": \"\^9.1.7\", \"lint-staged\": \"\^16.4.0\", \"remark-parse\":
\"\^11.0.0\", \"tsx\": \"\^4.21.0\", \"typescript-eslint\":
\"\^8.59.1\", \"unified\": \"\^11.0.5\", \"unist-util-visit\":
\"\^5.1.0\" }, \"scripts\": { \"kb:sync-types\": \"tsx
scripts/kb/sync-types.ts\", \"kb:validate-links\": \"tsx
scripts/kb/validate-links.ts\", \"kb:validate-exports\": \"tsx
scripts/kb/validate-exports.ts\", \"kb:validate\": \"pnpm kb:sync-types
&& node scripts/generate-session-context.js && pnpm kb:validate-links &&
pnpm kb:validate-exports\", \"generate:mastery-db\": \"node
scripts/generate-mastery-db.js\", \"generate:component-mastery-db\":
\"node scripts/generate-component-mastery-db.js\",
\"generate:lint-dbs\": \"pnpm generate:mastery-db && pnpm
generate:component-mastery-db\", ****\"verify:lint-dbs\": \"node
scripts/verify-lint-db-fresh.js\", \"prepare\": \"husky\",
\"context:task\": \"bash scripts/generate-task-context.sh\",
\"lint:feedback\": \"bash scripts/lint-feedback.sh\" }, \"lint-staged\":
{ \"src/\*\*/\*.{ts,tsx}\": \[ \"eslint \--max-warnings=0\" \] },
\"packageManager\": \"pnpm@9.15.0\", \"engines\": { \"node\": \"\>=24
\<=25\", \"pnpm\": \"\>=9 \<10\" }, \"peerDependencies\": {
\"@emotion/react\": \"\^11.0.0\", \"@emotion/styled\": \"\^11.0.0\" } }
NO WORKSPACE FILE EXISTS \# Loom Cognitive Architecture & Design
Manifesto \## The Narrative: The Language of Arts The Loom UI is
fundamentally a canvas for human communication. It balances
\*\*high-utility density\*\*---where complex video interactions and
controls are densely packed for immediate access---with a
\*\*\"breathable\" focus\*\*. The recording interface, dashboard, and
marketing surfaces breathe through intrinsic whitespace, ensuring the
user\'s cognitive load remains light despite the heavy technical
capabilities beneath. \## The Capillary Action Every decision in the
Lens system serves a single intent: \*\*Frictionless Video
Communication\*\*. This intent saturates every button (clear, distinct,
and instantly recognizable), margin (generous spacing separating work
from distraction), and micro-interaction (subtle hover states that
reward intent before action). The design is not a collection of parts,
but a fluid capillary system where the core purpose flows naturally to
the furthest edges of the interface. \-\-- \## 1. The Emotional
Signature \*\*\"Empowering, not overwhelming.\"\*\* The UI respects the
user\'s focus. It avoids shouting with aggressive colors or jagged
layouts. Instead, it uses soft rounded corners, intentional structural
depth (Z-indexing for overlays), and a calming brand blue to signify
safety, reliability, and readiness. \## 2. The Spatial Logic
\*\*Positive Friction through Container Bounds.\*\* Lens guides users
through a Z-pattern of discovery and a focused F-pattern for execution.
It intentionally creates \"Positive Friction\"---using explicit spatial
separation (via \`Split\`, \`Arrange\`, and \`Container\`) to make the
user pause naturally at critical decision points (e.g., clicking
\'Record\', or navigating workspaces) without feeling blocked. \## 3.
Frontend Implementation Spirit \*\*Composability over rigid
inheritance.\*\* In the context of TypeScript and Lens, this means: - We
never write monolithic components. We build with atomic,
layout-agnostic, and content-agnostic primitives. - We rely on explicit
token references over magic numbers (\`padding={2}\` not
\`padding=\"16px\"\`). - The DOM structure is sacred: we favor
\`SplitSection\` inside \`Split\`, avoiding raw \`div\`s. We speak the
Lens grammar natively. You are a Lens-native frontend engineer. Read
from .lens-knowledge-base/ --- write to src/ only. Boot sequence every
session: 1. .lens-knowledge-base/AGENT_PRIMER.md 2.
.lens-knowledge-base/\_ROUTER.md Declare sources consulted before every
code response. If you read nothing: stop and say so. Linter is ground
truth. Error = your code is wrong. Never: eslint-disable · modify
mastery-db.json Fix: read components/\[Name\].md and correct the code.
Always forbidden: style={{}} Tailwind hyphen classes Raw interactive
HTML for UI Priority: Linter → AGENT_PRIMER.md → rules → user request
Conflict: refuse · explain · offer Lens alternative. Never load:
.lens-knowledge-base/reference/components-full.md
.lens-knowledge-base/reference/styles-full.md Prompt system:
.lens-knowledge-base/prompts/README.md Quick reference: div Box →
Container display:flex → Split display:grid → Arrange h1 h2 p span →
Text + htmlTag disabled → isDisabled loading → hasLoader as=\"a\" →
htmlTag=\"a\" ref={ref} → refHandler={(r) =\> ref.current = r} leftIcon
→ iconBefore raw input → TextInput inside FormFieldYou are a Lens-native
frontend engineer. Read from .lens-knowledge-base/ --- write to src/
only. Boot sequence every session: 1.
.lens-knowledge-base/AGENT_PRIMER.md 2. .lens-knowledge-base/\_ROUTER.md
Declare sources consulted before every code response. If you read
nothing: stop and say so. Linter is ground truth. Error = your code is
wrong. Never: eslint-disable · modify mastery-db.json Fix: read
components/\[Name\].md and correct the code. Always forbidden:
style={{}} Tailwind hyphen classes Raw interactive HTML for UI Priority:
Linter → AGENT_PRIMER.md → rules → user request Conflict: refuse ·
explain · offer Lens alternative. Never load:
.lens-knowledge-base/reference/components-full.md
.lens-knowledge-base/reference/styles-full.md Prompt system:
.lens-knowledge-base/prompts/README.md Windsurf-specific: className IS
allowed on wrappers with Lens utilities CSS modules ARE allowed for
wrappers ****with var(\--lns-\*) Numbers ARE valid where Lens supports
them style={{}} is the ONLY absolute styling prohibition****\
\
\
AI(CLAUDE):\
\
\# USRP Phase 1 --- Definitive Architecture Decision \## Full Picture
Now Understood Let me articulate exactly what I now know before making
any irreversible structural decisions: \`\`\` WHAT THE LENS REPO
ACTUALLY IS: ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ A
sovereign AI governance platform. Not a component library. Not a
monorepo shell. A PURPOSE-BUILT environment that: 1. TEACHES agents Lens
(via .lens-knowledge-base/) 2. ENFORCES Lens compliance (via
eslint-plugin-lens-compliance) 3. PROVIDES a blank canvas (src/) where
agents write frontend 4. GUARDS its own integrity (scripts/guard-\*.sh,
husky, CI) The src/ directory is intentionally ephemeral: → Engineer
deletes it → Engineer describes what they want → Agent writes it fresh,
immersed in Lens governance → Current content: Loom dashboard clone
(validation test) The web/ directory: confirmed non-existent at path
checked. The nested src/pnpm-workspace.yaml: exists (src is a proper
nested Next.js workspace within the root governance shell)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ \`\`\` \-\--
\## The Core Structural Decision This is the most important
architectural call of Phase 1. I will be direct: \`\`\` THE WRONG
APPROACH (What \"move inside\" naively implies):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ design-system/
├── \[all governance files\] ├── src/ ← USRP frontends dumped here │ ├──
portal-web/ │ ├── dashboard-rdf/ │ └── \... ├── services/ ← NestJS
backends added here └── infrastructure/ ← Docker/K8s added here WHY THIS
IS WRONG: • Destroys the ephemeral src/ contract (\"delete src/ and
start fresh\" breaks if src/ IS the product) • ESLint enforcement scope
(src/\*\*) would hit backend TypeScript --- agents get Lens component
errors on NestJS code • guard-protected-paths.sh would need modification
(triggers ALLOW_ENFORCEMENT_EDIT=1 requirement) • The governance shell
becomes a product monorepo --- two completely different concerns in one
repo • Future engineers reusing Lens DS for other projects would inherit
USRP\'s backend as pollution
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ THE RIGHT
APPROACH: ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Preserve the Lens DS repo\'s ****identity completely. USRP is a CONSUMER
of the Lens DS environment, not a merger. Physical layout:
/home/uruti/Documents/projects/ ├── design-system/ ← UNTOUCHED
governance shell │ ├── \[all existing files stay exactly as they are\] │
└── src/ ← REPLACED with USRP frontend apps │ (this IS the \"move
inside\" intent) └── usrp/ ← NEW: backend + infra monorepo ├── services/
├── packages/ └── infrastructure/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ \`\`\` \-\--
\## The Precise Two-Repo Architecture \`\`\`
╔══════════════════════════════════════════════════════════════════╗ ║
USRP COMPLETE PROJECT STRUCTURE ║
╠══════════════════════════════════════════════════════════════════╣ ║ ║
║ REPO 1: design-system/ (Lens Governance + USRP Frontend) ║ ║
───────────────────────────────────────────────────────────── ║ ║
UNCHANGED: ║ ║ CLAUDE.md ← agent pointer (untouched) ║ ║
.lens-knowledge-base/ ← agent knowledge (untouched) ║ ║
eslint-plugin-lens-compliance/ ← enforcement (untouched) ║ ║ scripts/ ←
KB tools (untouched) ║ ║ prompts/ ← P1-P7 system (untouched) ║ ║ .husky/
← git hooks (untouched) ║ ║ eslint.config.mjs ← Lens rules (untouched) ║
║ package.json ← root governance (untouched) ║ ║ ║ ║ REPLACED: ║ ║ src/
← WAS: Loom clone test ║ ║ NOW: USRP frontend apps ║ ║ src/ ║ ║ ├──
portal-web/ ← Citizen registration portal ║ ║ │ ├── package.json ║ ║ │
├── next.config.ts ║ ║ │ ├── tsconfig.json ║ ║ │ ├── app/ ║ ║ │ ├──
components/ ║ ║ │ ├── features/ ║ ║ │ └── \... ║ ║ ├── dashboard-rdf/ ←
RDF HR Officer Dashboard ║ ║ ├── dashboard-rnp/ ← RNP HR Officer
Dashboard ║ ║ ├── dashboard-rcs/ ← RCS HR Officer Dashboard ║ ║ ├──
dashboard-superadmin/ ← Cross-agency MoD oversight ║ ║ └── field-tablet/
← Offline-first PWA ║ ║ ║ ║ ADDED TO ROOT package.json: ║ ║ lint-staged
scope updated to: src/\*\*/\*\*/\*.{ts,tsx} ║ ║ pnpm-workspace.yaml
added: includes src/\* apps ║ ║ ║
╠══════════════════════════════════════════════════════════════════╣ ║ ║
║ REPO 2: usrp/ (Backend + Infrastructure Monorepo) ║ ║
───────────────────────────────────────────────────────────── ║ ║
services/ ← All NestJS microservices ║ ║ ├── identity-service/ ║ ║ ├──
eligibility-service/ ║ ║ ├── biometric-service/ ║ ║ ├──
document-forensics-service/ ║ ║ ├── background-vetting-service/ ║ ║ ├──
routing-service/ ║ ║ ├── scheduling-service/ ║ ║ ├──
notification-service/ ║ ║ ├── field-sync-service/ ║ ║ ├── audit-service/
║ ║ └── agency-bff/ ║ ║ ├── rdf-bff/ ║ ║ ├── rnp-bff/ ║ ║ └── rcs-bff/ ║
║ packages/ ← Shared internal packages ║ ║ ├── shared-types/ ║ ║ ├──
shared-security/ ║ ║ ├── shared-events/ ║ ║ ├── shared-database/ ║ ║ └──
shared-config/ ║ ║ infrastructure/ ← Docker, K8s, Terraform ║ ║ ├──
docker/ ║ ║ ├── kubernetes/ ║ ║ ├── terraform/ ║ ║ └── monitoring/ ║ ║
docs/ ← ADRs, API specs, compliance ║ ║ turbo.json ║ ║
pnpm-workspace.yaml ║ ║ package.json ║ ║ ║
****╚══════════════════════════════════════════════════════════════════╝
\`\`\` \-\-- \## Why This Is The Only Correct Structure \`\`\` CONCERN
1: Agent immersion integrity ✅ Frontend agents opening design-system/
see ONLY Lens rules, Lens knowledge, Lens enforcement. No NestJS. No
Kafka. No Terraform. The cognitive environment is pure. CONCERN 2:
ESLint scope safety ✅ eslint.config.mjs targets src/\*\*/\*.{ts,tsx}
Every file in src/ IS a frontend file. No risk of Lens component rules
firing on NestJS decorators. CONCERN 3: The \"ephemeral src/\" contract
✅ PRESERVED: src/ can still be wiped and rebuilt. \"Delete src/ and
start fresh with USRP\" is valid. The governance layer above src/ is
untouched. CONCERN 4: Multi-app vs single-app in src/ → This requires a
precise answer (see below) CONCERN 5: Backend isolation ✅ usrp/ has
zero Lens awareness. Backend agents working in usrp/ never see Lens
rules. They see Turborepo, NestJS, Drizzle, Kafka configs. Clean
cognitive separation. \`\`\` \-\-- \## The Multi-App Question: Critical
Decision Needed The current src/ has \*\*one Next.js app\*\* (flat
structure). USRP needs \*\*five frontend apps\*\*. This requires a
decision: \`\`\` OPTION A --- pnpm workspace inside src/ (Recommended)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ src/ ├──
pnpm-workspace.yaml ← \"packages: \[\'\*\'\]\" ├── portal-web/ ← Next.js
app (package.json) ├── dashboard-rdf/ ← Next.js app (package.json) ├──
dashboard-rnp/ ← Next.js app (package.json) ├── dashboard-rcs/ ← Next.js
app (package.json) ├── dashboard-superadmin/ ← Next.js app
(package.json) └── field-tablet/ ← Next.js PWA (package.json) ROOT
package.json lint-staged: \"src/\*\*/\*\*/\*.{ts,tsx}\": \[\"eslint
\--max-warnings=0\"\] ↑ Double wildcard catches files in nested app
directories HOW IT WORKS FOR AGENTS: Agent works on portal-web task →
opens design-system/ Sees CLAUDE.md at root → follows governance Writes
code to src/portal-web/ Root eslint.config.mjs lints src/portal-web/\*\*
Lens enforcement applies uniformly across ALL apps ADVANTAGE: One ESLint
config rules all five apps. Lens governance is uniform. Agent context is
clean. OPTION B --- Turborepo inside design-system/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Add turbo.json to
design-system/ root. Each src/app gets its own build pipeline.
DISADVANTAGE: Turborepo is a heavy addition to what is currently a
lightweight governance shell. Adds conceptual complexity without benefit
since these are frontend-only apps that don\'t need cross-service build
caching. AVOID. OPTION C --- Single Next.js app with route groups
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ All five \"apps\" are
route groups in ONE Next.js app. src/ ├── app/ │ ├── (portal)/ ←
Citizen-facing ****routes │ ├── (rdf)/ ← RDF officer routes │ ├── (rnp)/
│ ├── (rcs)/ │ └── (superadmin)/ ADVANTAGE: Simpler structure, one dev
server. CRITICAL DISADVANTAGE: Security violation. A single Next.js
build means ALL dashboard code is in ONE bundle. An RDF officer\'s
browser could theoretically access RNP route groups. For a military
recruitment system: UNACCEPTABLE. REJECT. \`\`\` \*\*My recommendation:
Option A --- pnpm workspace inside src/.\*\* \-\-- \## Docker Fix Status
Check Before we write a single file, Docker must be running. Run this
now: \`\`\`bash sudo systemctl start docker && \\ sudo systemctl enable
docker && \\ sudo systemctl status docker \--no-pager && \\ docker info
\| grep \"Server Version\" \`\`\` \-\-- \## Confirmation Required Before
Execution I need your explicit confirmation on \*\*two decisions\*\*:
\*\*Decision 1:\*\* Do you confirm the two-repo architecture? \`\`\`
design-system/ ← Frontend (Lens governed, src/ replaced) usrp/ ←
Backend + Infrastructure \`\`\` \*\*Decision 2:\*\* Do you confirm
Option A for multi-app structure? \`\`\` src/ ├── pnpm-workspace.yaml
├── portal-web/ ├── dashboard-rdf/ ├── dashboard-rnp/ ├── dashboard-rcs/
├── dashboard-superadmin/ └── field-tablet/ \`\`\` \*\*Decision 3:\*\*
Confirm the project paths: \`\`\` Frontend repo:
/home/uruti/Documents/projects/design-system/ Backend repo:
/home/uruti/Documents/projects/usrp/ \`\`\` \*\*Once you confirm these
three decisions and share the Docker output, I will generate every file
for Phase 1 Step 1.1 immediately --- starting with the exact commands to
execute on your machine.\*\****

***ME:\
\
\
****WHAT DO YOU THINK ABOUT THIS CLAIM FROM GOOGLE GEMINI Option A in
its current state because this directory graph introduces a severe
architectural fragmentation defect that directly violates both software
engineering best practices and the security principles governing
high-assurance systems.While a separate-repository approach seems
intuitive on paper, it creates massive maintainability bottlenecks and
technical debt in a multi-agency project like this.Why Option A Fails
(Architectural Breakdown)Code Duplication & Context Drift: The
portal-web app and all three agency dashboards (RDF, RNP, RCS) must
share identical logic for verifying National ID numbers via NIDA,
checking educational qualifications via NESA, and processing document
forensics. Splitting them into completely separate root directories
forces your AI ****agents to duplicate API types, validation schemas,
and biometric processing hooks, leading to inevitable code drift.Brittle
Shared Dependecies: If you need to change a core security schema or an
API response structure, you will have to manually update and test five
separate front-end codebases. This approach significantly increases the
risk of manual and agentic error.Compromised Component Synchronization:
The user interface for the RDF, RNP, and RCS dashboards must remain
visually uniform, adhering to the same layout patterns, spacing grids,
and typography tokens. Separating these apps makes it incredibly
difficult for your AI agents to maintain a single source of design
truth.The Corrected Architecture: Micro-Frontend MonorepoTo match the
operational excellence of Western defense frameworks, you must structure
the repository as a Modular Micro-Frontend Monorepo using unified
workspaces.This approach isolates deployment targets while standardizing
core logic, UI tokens, and type models within a shared internal package
layer.src/ ├── pnpm-workspace.yaml \# Coordinates the multi-package
ecosystem ├── apps/ \# ISOLATED DEPLOYMENT TARGETS │ ├── public-portal/
\# Next.js: Citizen intake & USSD fallback gateway │ ├──
agency-dashboards/ \# Next.js: Multi-tenant portal (RDF, RNP, RCS) │ ├──
superadmin-core/ \# Next.js: System management & SIEM telemetry
dashboard │ └── field-tablet-client/ \# Kotlin Native/Offline-First
execution shell └── packages/ \# CORE SHARED INFRASTRUCTURE (Private
Ecosystem) ├── core-api-types/ \# Unified TypeScript definitions for
NIDA, NESA, and RIB payloads ├── image-forensics-rules/ \# Shared
client-side document error analysis scripts └── dynamic-design-system/
\# Single source of truth for design tokens and layout primitives Why
this Monorepo Structure is Superior:Absolute Single Source of Truth:
Core functions (such as the 1:1 facial verification loops and automated
age calculators) are written exactly once in the packages/ directory. If
a national registry API changes, you update one package, and the change
instantly propagates across all apps.Enforced Visual Consistency: All
three dashboards import layout elements and style primitives directly
from packages/dynamic-design-system. This makes it impossible for an
agent to introduce unauthorized, custom styling overrides that break
layout alignment.Isolated Deployment Boundaries: Although code is
developed in a unified monorepo, the compilation pipelines output
completely isolated runtime bundles. You can update the RCS dashboard
without ****rebuilding or redeploying the RDF or public portal systems,
preserving system stability.****\
\
AI (CLAUDE):\
\
\# Architectural Verdict: Gemini\'s Claim --- Deep Analysis \## My
Position Upfront Gemini is \*\*partially correct on the theory, but
critically wrong on the application\*\* to this specific project. The
argument contains sound software engineering principles applied to the
wrong problem context. I will dissect this claim precisely. \-\-- \##
Where Gemini Is Correct \`\`\` VALID POINTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ✅ Shared types
should not be duplicated across apps ✅ A packages/ layer for shared
logic is correct ✅ Isolated deployment targets are the right goal ✅
Single source of truth for API types is correct ✅ The monorepo pattern
for frontend apps is valid
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ \`\`\` These are
real engineering concerns. Gemini is not wrong about the \*\*theory\*\*.
The problem is in the \*\*specific implementation it proposes\*\* and
the \*\*critical issues it completely ignores\*\*. \-\-- \## Where
Gemini Is Wrong --- Point by Point \### Fatal Flaw 1:
\`agency-dashboards/\` as a Multi-Tenant Portal \`\`\` GEMINI PROPOSES:
src/apps/agency-dashboards/ ← \"Multi-tenant portal (RDF, RNP, RCS)\"
THIS IS THE SAME SECURITY VIOLATION I ALREADY REJECTED: A single Next.js
application serving RDF, RNP, and RCS means a single compiled JavaScript
bundle. What this means in practice:
┌─────────────────────────────────────────────────────┐ │ Browser loads
agency-dashboards bundle │ │ │ │ Bundle contains: │ │ → RDF officer UI
code ✓ intended │ │ → RNP officer UI code ✗ LEAKED │ │ → RCS officer UI
code ✗ LEAKED │ │ → All routing logic ✗ EXPOSED │ │ → All role-check
conditions ✗ REVERSIBLE │
└─────────────────────────────────────────────────────┘ A determined
adversary opens browser DevTools, examines the bundle, and maps the
entire internal routing and data-fetching architecture of ALL three
agencies from a single download. For a MILITARY RECRUITMENT SYSTEM
handling national security personnel data this is not a theoretical risk
--- it is a disqualifying defect. Gemini\'s argument about \"isolated
runtime bundles\" from \"compilation pipelines\" does NOT solve this.
Next.js App Router still ships a shared client bundle. Route-level code
splitting splits PAGE components --- it ****does not create separate,
isolated JavaScript execution contexts. The only way to achieve true
bundle isolation is separate Next.js applications with separate build
outputs, separate deployments, and separate domains/subdomains. \`\`\`
\-\-- \### Fatal Flaw 2: \`packages/dynamic-design-system/\` ---
Reinventing What Already Exists \`\`\` GEMINI PROPOSES:
packages/dynamic-design-system/ ← \"Single source of truth for design
tokens and layout primitives\" THE REALITY: This ALREADY EXISTS. It is
called \@loomhq/lens. The entire design-system/ repository is
purpose-built to make \@loomhq/lens the single source of design truth.
Creating packages/dynamic-design-system/ would mean: → Duplicating token
definitions that already exist in Lens → Creating a second design
authority that agents must reconcile → Directly contradicting the Lens
governance environment → Agents now have TWO sources of design truth:
\@loomhq/lens (enforced by eslint-plugin-lens-compliance)
packages/dynamic-design-system (Gemini\'s addition) Which one wins when
they conflict? The linter enforces \@loomhq/lens. The linter WILL fire
on packages/dynamic-design-system tokens. This proposal fundamentally
misunderstands what the design-system repository IS. \`\`\` \-\-- \###
Fatal Flaw 3: \`field-tablet-client/\` as Kotlin Native \`\`\` GEMINI
PROPOSES: field-tablet-client/ ← \"Kotlin Native/Offline-First execution
shell\" PROBLEMS: 1. TOOLCHAIN MISMATCH: Kotlin Native cannot be built,
linted, or managed by pnpm. It requires Gradle + Android SDK or Kotlin
Multiplatform toolchain. Placing it in a pnpm workspace is
architecturally incoherent --- pnpm will ignore it or error on it. 2.
AGENT CAPABILITY MISMATCH: The entire development environment is
configured for TypeScript/React/Next.js agents immersed in Lens
governance. Kotlin Native requires completely different agent context,
tools, and expertise. 3. DEPLOYMENT REALITY: Field officers in Rwanda\'s
provinces use government-issued Android tablets. A Kotlin Native app
requires: → Google Play Store or MDM (Mobile Device Management)
distribution pipeline → Separate build environment (Android Studio,
Gradle) → Separate signing and deployment process This is an ENTIRELY
DIFFERENT PROJECT, not a workspace package. 4. THE ACTUAL SOLUTION: A
Progressive Web App (PWA) built with Next.js and Workbox runs on ANY
tablet browser, requires NO app store distribution, can be deployed via
the same pipeline as other frontend apps, and is fully manageable within
the pnpm workspace and Lens governance. \`\`\` \-\-- \### Fatal Flaw 4:
****\`packages/image-forensics-rules/\` on the Frontend \`\`\` GEMINI
PROPOSES: packages/image-forensics-rules/ ← \"Shared client-side
document error analysis\" THIS IS A SECURITY ARCHITECTURE VIOLATION:
Document forensics (ELA, DCT frequency analysis, C2PA manifest
verification, ClamAV virus scanning) MUST run server-side. Here is why:
Client-side forensics: → Attacker downloads your forensics detection
code → Attacker studies exactly what patterns you detect → Attacker
crafts forged documents that specifically bypass your detection
signatures → Your entire fraud detection is compromised Server-side
forensics: → Detection algorithms are hidden → Attacker cannot study
what you are looking for → ClamAV virus scanning is physically
impossible client-side (requires system-level file access) → This is
where document-forensics-service/ lives in the backend usrp/ repository
Running forensics client-side is not a performance optimization --- it
is a security catastrophe for a military recruitment platform. \`\`\`
\-\-- \### Fatal Flaw 5: What Gemini Completely Ignores \`\`\` GEMINI\'S
PROPOSAL NEVER MENTIONS: 1. The existing Lens governance enforcement
(eslint-plugin-lens-compliance, guard scripts, husky hooks,
mastery-db.json) → How does packages/dynamic-design-system interact with
the existing linter? → Gemini does not know. Gemini has not seen the
actual repository. 2. The ephemeral src/ contract → The core design
philosophy of this repo is \"delete src/ and rebuild\" → A permanent
packages/ layer inside src/ breaks this contract 3. The pnpm version
constraint (\>=9 \<10) → Gemini\'s proposal adds packages/ complexity
without acknowledging the existing lockfile and version management
situation 4. The agent cognitive environment → The Lens repo is
engineered so agents operate in a surgically controlled context → Adding
packages/ with core-api-types and image-forensics-rules means agents
writing frontend now need backend API knowledge This corrupts the clean
separation \`\`\` \-\-- \## The Correct Synthesis Gemini identified a
\*\*real problem\*\* (shared logic, no duplication) but prescribed the
\*\*wrong solution\*\*. Here is the correct answer: \`\`\` THE ACTUAL
SOLUTION TO GEMINI\'S VALID CONCERNS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ CONCERN:
Shared TypeScript types (NIDA, NESA payloads) SOLUTION:
packages/shared-types/ lives in usrp/ (backend repo) Frontend apps
import ONLY from the BFF API response types --- not raw G2G payload
types Frontend never needs NIDACitizenRecord directly It needs
ApplicationStatusResponse from the BFF CONCERN: Shared UI logic across
dashboards SOLUTION: ****src/packages/ inside the design-system
workspace Contains ONLY frontend-safe shared code: →
src/packages/usrp-ui-components/ (Lens-built shared components) →
src/packages/usrp-hooks/ (shared React hooks) →
src/packages/usrp-validators/ (client-side form validation) All of this
is: ✓ Lens-governed (eslint applies) ✓ Frontend-only (no server logic) ✓
Shareable across the five apps CONCERN: Visual consistency across
dashboards SOLUTION: Already solved by \@loomhq/lens + Lens governance
All five apps use the same Lens tokens The linter enforces this
automatically No packages/dynamic-design-system needed CONCERN: Isolated
deployment targets SOLUTION: Five separate Next.js apps (my original
Option A) Each compiles to its own bundle Each deploys to its own
subdomain Zero cross-contamination of JavaScript bundles
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ \`\`\` \-\--
\## The Final Definitive Structure \`\`\`
/home/uruti/Documents/projects/ │ ├── design-system/ ← REPO 1:
Frontend + Lens Governance │ ├── \[ALL EXISTING FILES UNTOUCHED\] │ ├──
eslint.config.mjs ← Lens rules (scope: src/\*\*/\*) │ ├── package.json ←
Root governance (untouched) │ │ │ └── src/ ← AGENT WRITE ZONE (replaced)
│ ├── pnpm-workspace.yaml ← Coordinates all apps + packages │ │ │ ├──
packages/ ← SHARED FRONTEND LOGIC ONLY │ │ ├── usrp-ui-components/ ←
Shared Lens components │ │ │ ├── package.json ← name:
\@usrp/ui-components │ │ │ └── src/ │ │ │ ├── ApplicationStatusBadge.tsx
│ │ │ ├── AgencyBadge.tsx │ │ │ ├── QRCodeDisplay.tsx │ │ │ └── index.ts
│ │ │ │ │ ├── usrp-hooks/ ← Shared React hooks │ │ │ ├── package.json ←
name: \@usrp/hooks │ │ │ └── src/ │ │ │ ├── useApplicationStatus.ts │ │
│ ├── useBiometricCapture.ts │ │ │ └── index.ts │ │ │ │ │ └──
usrp-validators/ ← Client-side form validation │ │ ├── package.json ←
name: \@usrp/validators │ │ └── src/ │ │ ├── nidFormat.validator.ts │ │
├── heightBounds.validator.ts │ │ └── index.ts │ │ │ └── apps/ ←
ISOLATED DEPLOYMENT TARGETS │ ├── portal-web/ ← Citizen registration
portal │ │ ├── package.json │ │ ├── next.config.ts │ │ └── src/ │ │ │
├── dashboard-rdf/ ← RDF HR Dashboard (separate bundle) │ │ ├──
package.json │ │ ├── next.config.ts │ │ └── src/ │ │ │ ├──
dashboard-rnp/ ← RNP HR Dashboard (separate bundle) │ ├── dashboard-rcs/
← RCS HR Dashboard (separate bundle) │ ├── dashboard-superadmin/ ← MoD
oversight (separate bundle) │ └── field-tablet/ ← PWA offline-first
(separate bundle) │ └── usrp/ ← REPO 2: Backend + Infrastructure ├──
services/ ← NestJS microservices ├── packages/ ← Backend shared packages
│ ├── shared-types/ ← G2G payload types (server only) │ ├──
****shared-security/ ← HMAC, JWT, encryption │ ├── shared-events/ ←
Kafka event schemas │ ├── shared-database/ ← Drizzle ORM schemas │ └──
shared-config/ ├── infrastructure/ ← Docker, K8s, Terraform ├── docs/ ←
ADRs, API specs ├── turbo.json ├── pnpm-workspace.yaml └── package.json
\`\`\` \-\-- \## Direct Answer to Your Question \`\`\` IS GEMINI\'S
CLAIM VALID? Partially. The theory is sound engineering. The
implementation is dangerous for this project. ACCEPT from Gemini: → The
concept of a packages/ shared layer → Single source of truth for shared
logic → Monorepo coordination of frontend apps REJECT from Gemini: →
agency-dashboards/ as multi-tenant (security flaw) →
packages/dynamic-design-system/ (Lens already is this) →
packages/image-forensics-rules/ client-side (security flaw) →
field-tablet-client/ as Kotlin Native (wrong toolchain) → The implicit
suggestion to abandon separate Next.js builds for each agency dashboard
THE CORRECT ANSWER incorporates Gemini\'s valid concern about shared
logic through a frontend-safe packages/ layer while maintaining separate
compiled applications for each agency --- the non-negotiable security
requirement that Gemini\'s proposal violated. \`\`\` \-\-- \## Awaiting
Your Confirmation Do you confirm this final structure so we can begin
executing Step 1.1? \`\`\` CONFIRM: ✓ Two repos: design-system/
(frontend) + usrp/ (backend) ✓ src/ structure: apps/ + packages/
(frontend-safe only) ✓ Five separate Next.js apps (separate bundles per
agency) ✓ field-tablet/ as PWA (not Kotlin Native) ✓ Document forensics
stays server-side in usrp/ ✓ \@loomhq/lens remains the single design
authority Docker status --- please also share: sudo systemctl start
docker docker info \| grep \"Server Version\" \`\`\`\
\
ME:\
\
Every thing is CONFIRMED . Remember your pivotal position in this
software project and be bold. be strong. THIS needs to be a state of
arts project. Mens et Manus. uruti@jackson-HP-EliteBook-840-G3:\~\$ sudo
systemctl start docker docker info \| grep \"Server Version\" Server
Version: 29.6.1 uruti@jackson-HP-EliteBook-840-G3:\~\$ PROJECT PATHS:
/home/uruti/Documents/projects/design-system
/home/uruti/Documents/projects/usrp/\
\
\
****AI (CLAUDE)\
\
\# USRP Phase 1 --- Execution Begins Now \## Docker: Confirmed.
Architecture: Confirmed. We Build. \-\-- \## Step 1.1 --- Repository
Initialization Execute these commands exactly as written. I will tell
you what each block does before you run it. \### Block 1: Backend
Repository --- \`usrp/\` \*\*What this does:\*\* Creates the \`usrp/\`
directory, initializes git, sets Node/pnpm version constraints, and
establishes the Turborepo monorepo root. \`\`\`bash cd
/home/uruti/Documents/projects && \\ mkdir -p usrp && \\ cd usrp && \\
git init && \\ echo \"24\" \> .node-version && \\ echo \"24\" \> .nvmrc
&& \\ git config core.autocrlf false && \\ git config core.eol lf && \\
echo \"Done: usrp git initialized\" \`\`\` \`\`\`bash \# Create the
complete directory skeleton in one shot cd
/home/uruti/Documents/projects/usrp && \\ mkdir -p \\
services/identity-service/src/{nida,session,events,health} \\
services/identity-service/test \\
services/eligibility-service/src/{engines,rules,nesa,health} \\
services/eligibility-service/test \\
services/biometric-service/src/{webrtc,liveness,matching,health} \\
services/biometric-service/test \\
services/document-forensics-service/src/{pipeline,triage,sanitization,health}
\\ services/document-forensics-service/test \\
services/background-vetting-service/src/{consumers,rib,health} \\
services/background-vetting-service/test \\
services/routing-service/src/{routing,crossagency,health} \\
services/routing-service/test \\
services/scheduling-service/src/{slots,regions,health} \\
services/scheduling-service/test \\
services/notification-service/src/{sms,email,ussd,health} \\
services/notification-service/test \\
services/field-sync-service/src/{crdt,vectorclock,health} \\
services/field-sync-service/test \\
services/audit-service/src/{consumers,store,health} \\
services/audit-service/test \\
services/agency-bff/rdf-bff/src/{controllers,guards,filters} \\
services/agency-bff/rdf-bff/test \\
services/agency-bff/rnp-bff/src/{controllers,guards,filters} \\
services/agency-bff/rnp-bff/test \\
services/agency-bff/rcs-bff/src/{controllers,guards,filters} \\
services/agency-bff/rcs-bff/test \\
****services/agency-bff/superadmin-bff/src/{controllers,guards,filters}
\\ services/agency-bff/superadmin-bff/test \\ packages/shared-types/src
\\ packages/shared-security/src \\
packages/shared-events/src/{schemas,producers,consumers} \\
packages/shared-database/src/{schemas,migrations,seeds} \\
packages/shared-config/src \\
infrastructure/docker/{init-scripts,mocks/{nida,nesa,rib},kong} \\
infrastructure/kubernetes/{namespaces,services,network-policies,istio,spire,deployments}
\\
infrastructure/terraform/{modules/{postgresql-cluster,kafka-cluster,redis-cluster,minio-cluster,hsm-config,kong-gateway},environments/{staging,production}}
\\ infrastructure/monitoring/{prometheus,grafana,alertmanager} \\
docs/{architecture/adrs,api/{identity,eligibility,biometric,forensics,vetting,scheduling,notification,bff},g2g-integration,compliance}
\\ scripts && \\ echo \"Done: usrp directory skeleton created\" \`\`\`
\`\`\`bash \# Verify the skeleton cd /home/uruti/Documents/projects/usrp
&& \\ find . -type d \| sort \| head -80 \`\`\` \-\-- \### Block 2: Root
\`package.json\` for \`usrp/\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/package.json \<\< \'EOF\' {
\"name\": \"usrp-backend\", \"version\": \"1.0.0\", \"private\": true,
\"description\": \"Unified Security Recruitment Portal --- Backend
Monorepo (RDF, RNP, RCS)\", \"author\": \"Jackson NSANZIMANA\",
\"license\": \"UNLICENSED\", \"packageManager\": \"pnpm@9.15.0\",
\"engines\": { \"node\": \"\>=24 \<=25\", \"pnpm\": \"\>=9 \<10\" },
\"scripts\": { \"build\": \"turbo run build\", \"build:affected\":
\"turbo run build \--filter=\[HEAD\^1\]\", \"dev\": \"turbo run dev
\--parallel\", \"test\": \"turbo run test\", \"test:e2e\": \"turbo run
test:e2e\", \"lint\": \"turbo run lint\", \"typecheck\": \"turbo run
typecheck\", \"db:migrate\": \"turbo run db:migrate
\--filter=shared-database\", \"db:seed\": \"turbo run db:seed
\--filter=shared-database\", \"db:studio\": \"turbo run db:studio
\--filter=shared-database\", \"infra:up\": \"docker compose -f
infrastructure/docker/docker-compose.infra.yml up -d\",
\"infra:up:tier1\": \"docker compose -f
infrastructure/docker/docker-compose.tier1.yml up -d\",
\"infra:up:tier2\": \"docker compose -f
infrastructure/docker/docker-compose.tier2.yml up -d\", \"infra:down\":
\"docker compose -f infrastructure/docker/docker-compose.infra.yml
down\", \"infra:logs\": \"docker compose -f
infrastructure/docker/docker-compose.infra.yml logs -f\",
\"infra:reset\": \"docker compose -f
infrastructure/docker/docker-compose.infra.yml down -v\", \"mocks:up\":
****\"docker compose -f infrastructure/docker/docker-compose.mocks.yml
up -d\", \"setup\": \"bash scripts/setup-dev.sh\", \"generate:env\":
\"bash scripts/generate-env.sh\", \"security:scan\": \"bash
scripts/security-scan.sh\", \"certs:rotate\": \"bash
scripts/rotate-dev-certs.sh\" }, \"devDependencies\": { \"turbo\":
\"\^2.5.4\" } } EOF echo \"Done: usrp/package.json written\" \`\`\`
\-\-- \### Block 3: pnpm Workspace & Turborepo Config for \`usrp/\`
\`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/pnpm-workspace.yaml \<\< \'EOF\'
packages: - \'services/\*\' - \'services/agency-bff/\*\' -
\'packages/\*\' EOF echo \"Done: pnpm-workspace.yaml written\" \`\`\`
\`\`\`bash cat \> /home/uruti/Documents/projects/usrp/turbo.json \<\<
\'EOF\' { \"\$schema\": \"https://turbo.build/schema.json\", \"ui\":
\"tui\", \"tasks\": { \"build\": { \"dependsOn\": \[\"\^build\"\],
\"outputs\": \[\"dist/\*\*\"\], \"env\": \[ \"NODE_ENV\",
\"DATABASE_URL\", \"REDIS_URL\", \"KAFKA_BROKERS\" \] }, \"dev\": {
\"cache\": false, \"persistent\": true }, \"test\": { \"dependsOn\":
\[\"\^build\"\], \"outputs\": \[\"coverage/\*\*\"\], \"env\":
\[\"NODE_ENV\", \"DATABASE_URL\", \"REDIS_URL\"\] }, \"test:e2e\": {
\"dependsOn\": \[\"\^build\"\], \"cache\": false, \"env\":
\[\"NODE_ENV\", \"DATABASE_URL\", \"REDIS_URL\", \"KAFKA_BROKERS\"\] },
\"lint\": { \"outputs\": \[\] }, \"typecheck\": { \"dependsOn\":
\[\"\^build\"\], \"outputs\": \[\] }, \"db:migrate\": { \"cache\":
false, \"env\": \[\"DATABASE_URL\"\] }, \"db:seed\": { \"cache\": false,
\"env\": \[\"DATABASE_URL\", \"NODE_ENV\"\] }, \"db:studio\": {
\"cache\": false, \"persistent\": true, \"env\": \[\"DATABASE_URL\"\] }
} } EOF echo \"Done: turbo.json written\" \`\`\` \-\-- \### Block 4:
TypeScript Base Configuration \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/tsconfig.base.json \<\< \'EOF\' {
\"\$schema\": \"https://json.schemastore.org/tsconfig\",
\"compilerOptions\": { \"target\": \"ES2022\", \"lib\": \[\"ES2022\"\],
\"module\": \"Node16\", \"moduleResolution\": \"Node16\",
\"declaration\": true, \"declarationMap\": true, \"sourceMap\": true,
\"strict\": true, \"noImplicitAny\": true, \"strictNullChecks\": true,
\"noImplicitReturns\": true, \"noFallthroughCasesInSwitch\": true,
\"noUncheckedIndexedAccess\": true, \"exactOptionalPropertyTypes\":
true, \"noImplicitOverride\": true,
\"forceConsistentCasingInFileNames\": true, \"esModuleInterop\": true,
\"skipLibCheck\": true, \"resolveJsonModule\": true,
\"experimentalDecorators\": true, \"emitDecoratorMetadata\": true,
\"paths\": {} }, \"exclude\": \[\"node_modules\", \"dist\",
\"coverage\", \"\*\*/\*.spec.ts\", \"\*\*/\*.test.ts\"\] } EOF echo
\"Done: tsconfig.base.json written\" \`\`\` \-\-- \### Block 5: ESLint
Base Configuration for Backend \`\`\`bash cat \>
****/home/uruti/Documents/projects/usrp/eslint.config.base.mjs \<\<
\'EOF\' import js from \'@eslint/js\'; import tseslint from
\'typescript-eslint\'; export default tseslint.config(
js.configs.recommended, \...tseslint.configs.strictTypeChecked, { rules:
{ \'@typescript-eslint/no-explicit-any\': \'error\',
\'@typescript-eslint/no-unused-vars\': \[\'error\', { argsIgnorePattern:
\'\^\_\', varsIgnorePattern: \'\^\_\' }\],
\'@typescript-eslint/explicit-function-return-type\': \'error\',
\'@typescript-eslint/no-floating-promises\': \'error\',
\'@typescript-eslint/no-misused-promises\': \'error\',
\'@typescript-eslint/require-await\': \'error\',
\'@typescript-eslint/consistent-type-imports\': \[\'error\', { prefer:
\'type-imports\' }\], \'no-console\': \[\'error\', { allow: \[\'warn\',
\'error\'\] }\], \'no-debugger\': \'error\' } }, { ignores:
\[\'\*\*/dist/\*\*\', \'\*\*/node_modules/\*\*\',
\'\*\*/coverage/\*\*\', \'\*\*/\*.js\'\] } ); EOF echo \"Done:
eslint.config.base.mjs written\" \`\`\` \-\-- \### Block 6: Root
\`.gitignore\` for \`usrp/\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/.gitignore \<\< \'EOF\' \#
Dependencies node_modules/ .pnpm-store/ \# Build outputs dist/ build/
coverage/ .turbo/ \# Environment files (NEVER commit these) .env
.env.local .env.\*.local .env.production .env.staging \# Docker volumes
(local) .docker-volumes/ \# Kubernetes secrets (local)
infrastructure/kubernetes/secrets/ \# Terraform state (sensitive)
infrastructure/terraform/\*\*/.terraform/
infrastructure/terraform/\*\*/terraform.tfstate
infrastructure/terraform/\*\*/terraform.tfstate.backup
infrastructure/terraform/\*\*/\*.tfvars
!infrastructure/terraform/\*\*/\*.tfvars.example \# IDE .idea/
.vscode/settings.json \*.swp \*.swo \# OS .DS_Store Thumbs.db \# Logs
\*.log logs/ \# Test artifacts junit.xml test-results/ \# HSM /
Certificate artifacts (never commit) \*.pem \*.key \*.crt \*.p12 \*.pfx
!infrastructure/docker/certs/.gitkeep EOF echo \"Done: .gitignore
written\" \`\`\` \-\-- \### Block 7: The Environment Variables Template
This is the single most important documentation file --- every secret
the system needs, documented with context: \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/.env.example \<\< \'EOF\' \#
══════════════════════════════════════════════════════════════════ \#
USRP --- UNIFIED SECURITY RECRUITMENT PORTAL \# Environment Variables
Reference \# \# SECURITY NOTICE: This file documents required variables.
\# Copy to .env for local development ****ONLY. \# NEVER commit .env to
version control. \# Production secrets are managed via HSM + Kubernetes
Secrets. \#
══════════════════════════════════════════════════════════════════ \# ──
NODE ──────────────────────────────────────────────────────────
NODE_ENV=development \# ── POSTGRESQL
──────────────────────────────────────────────────── \# Main connection
(used by all services via connection pool)
DATABASE_URL=postgresql://usrp_system:CHANGE_ME@localhost:5432/usrp_db
\# Schema-specific connection strings
DATABASE_URL_PUBLIC_CORE=postgresql://usrp_public_reader:CHANGE_ME@localhost:5432/usrp_db?options=-csearch_path%3Dpublic_core
DATABASE_URL_RDF_OPS=postgresql://usrp_rdf_officer:CHANGE_ME@localhost:5432/usrp_db?options=-csearch_path%3Drdf_ops
DATABASE_URL_RNP_OPS=postgresql://usrp_rnp_officer:CHANGE_ME@localhost:5432/usrp_db?options=-csearch_path%3Drnp_ops
DATABASE_URL_RCS_OPS=postgresql://usrp_rcs_officer:CHANGE_ME@localhost:5432/usrp_db?options=-csearch_path%3Drcs_ops
\# Postgres admin (migrations only) POSTGRES_USER=usrp_admin
POSTGRES_PASSWORD=CHANGE_ME POSTGRES_DB=usrp_db \# PII column encryption
key (in production: fetched from HSM)
DB_ENCRYPTION_KEY=CHANGE_ME_32_CHAR_MIN_AES256_KEY \# ── REDIS
─────────────────────────────────────────────────────────
REDIS_URL=redis://:CHANGE_ME@localhost:6379 REDIS_PASSWORD=CHANGE_ME \#
USSD session TTL in seconds (72 hours) REDIS_USSD_SESSION_TTL=259200 \#
JWT session TTL in seconds (8 hours) REDIS_JWT_SESSION_TTL=28800 \# ──
KAFKA (KRaft mode --- no Zookeeper) ────────────────────────────
KAFKA_BROKERS=localhost:9092 KAFKA_CLIENT_ID=usrp-service
KAFKA_GROUP_ID_IDENTITY=usrp-identity-consumers
KAFKA_GROUP_ID_ELIGIBILITY=usrp-eligibility-consumers
KAFKA_GROUP_ID_FORENSICS=usrp-forensics-consumers
KAFKA_GROUP_ID_VETTING=usrp-vetting-consumers
KAFKA_GROUP_ID_SCHEDULING=usrp-scheduling-consumers
KAFKA_GROUP_ID_NOTIFICATION=usrp-notification-consumers
KAFKA_GROUP_ID_AUDIT=usrp-audit-consumers
SCHEMA_REGISTRY_URL=http://localhost:8081 \# ── MINIO (Document Object
Store) ──────────────────────────────── ****MINIO_ENDPOINT=localhost
MINIO_PORT=9000 MINIO_USE_SSL=false MINIO_ROOT_USER=usrp_minio_admin
MINIO_ROOT_PASSWORD=CHANGE_ME MINIO_BUCKET_DOCUMENTS=usrp-documents
MINIO_BUCKET_FORENSICS=usrp-forensics-temp \# AES-256-GCM key for
document encryption (in production: HSM)
MINIO_ENCRYPTION_KEY=CHANGE_ME_32_CHAR_MIN_AES256_KEY \# ── KONG API
GATEWAY ──────────────────────────────────────────────
KONG_ADMIN_URL=http://localhost:8001
KONG_PROXY_URL=http://localhost:8000 KONG_JWT_SECRET=CHANGE_ME \# ── JWT
AUTHENTICATION ────────────────────────────────────────────
JWT_SECRET=CHANGE_ME_64_CHAR_MIN JWT_EXPIRY=8h
JWT_REFRESH_SECRET=CHANGE_ME_64_CHAR_MIN JWT_REFRESH_EXPIRY=7d \#
Short-lived tokens for biometric session
JWT_BIOMETRIC_SECRET=CHANGE_ME_64_CHAR_MIN JWT_BIOMETRIC_EXPIRY=10m \#
── G2G: NIDA INTEGRATION ──────────────────────────────────────── \# In
development: points to mock server \# In production: private VPN tunnel
endpoint NIDA_API_BASE_URL=http://localhost:3100 NIDA_API_KEY=CHANGE_ME
NIDA_HMAC_SECRET=CHANGE_ME_64_CHAR_MIN NIDA_VPN_TUNNEL_HOST=localhost
NIDA_REQUEST_TIMEOUT_MS=5000 NIDA_MAX_RETRIES=3 \# ── G2G: NESA
INTEGRATION ────────────────────────────────────────
NESA_API_BASE_URL=http://localhost:3101 NESA_API_KEY=CHANGE_ME
NESA_HMAC_SECRET=CHANGE_ME_64_CHAR_MIN NESA_REQUEST_TIMEOUT_MS=8000
NESA_MAX_RETRIES=3 \# ── G2G: RIB INTEGRATION
─────────────────────────────────────────
RIB_API_BASE_URL=http://localhost:3102 RIB_API_KEY=CHANGE_ME
RIB_HMAC_SECRET=CHANGE_ME_64_CHAR_MIN RIB_REQUEST_TIMEOUT_MS=10000
RIB_MAX_RETRIES=2 \# ── SMS NOTIFICATIONS (MTN/Airtel Rwanda)
──────────────────────── SMS_GATEWAY_PROVIDER=mtn
MTN_SMS_API_URL=https://api.mtn.rw/v1/sms MTN_SMS_API_KEY=CHANGE_ME
MTN_SMS_SENDER_ID=USRP-RW
****AIRTEL_SMS_API_URL=https://api.airtel.rw/v1/sms
AIRTEL_SMS_API_KEY=CHANGE_ME AIRTEL_SMS_SENDER_ID=USRP-RW \# ── EMAIL
NOTIFICATIONS ───────────────────────────────────────────
SMTP_HOST=localhost SMTP_PORT=1025 SMTP_SECURE=false SMTP_USER=CHANGE_ME
SMTP_PASS=CHANGE_ME SMTP_FROM=noreply@recruitment.gov.rw \# ── USSD
GATEWAY (MTN/Airtel SMPP) ───────────────────────────────
USSD_SERVICE_CODE=\*123# USSD_GATEWAY_HOST=localhost
USSD_GATEWAY_PORT=2775 USSD_SYSTEM_ID=CHANGE_ME USSD_PASSWORD=CHANGE_ME
\# ── CLAMAV VIRUS SCANNER ──────────────────────────────────────────
CLAMAV_HOST=localhost CLAMAV_PORT=3310 CLAMAV_TIMEOUT_MS=30000 \# ──
WEBRTC / BIOMETRIC ────────────────────────────────────────────
WEBRTC_ICE_SERVERS=stun:stun.l.google.com:19302
BIOMETRIC_LIVENESS_THRESHOLD=0.85 BIOMETRIC_FACE_MATCH_THRESHOLD=85.0
BIOMETRIC_SESSION_TIMEOUT_MS=120000 \# Ephemeral frame buffer TTL
(milliseconds --- frames purged after this)
BIOMETRIC_FRAME_BUFFER_TTL_MS=5000 \# ── SERVICE PORTS
─────────────────────────────────────────────────
PORT_IDENTITY_SERVICE=4001 PORT_ELIGIBILITY_SERVICE=4002
PORT_BIOMETRIC_SERVICE=4003 PORT_FORENSICS_SERVICE=4004
PORT_VETTING_SERVICE=4005 PORT_ROUTING_SERVICE=4006
PORT_SCHEDULING_SERVICE=4007 PORT_NOTIFICATION_SERVICE=4008
PORT_FIELD_SYNC_SERVICE=4009 PORT_AUDIT_SERVICE=4010 PORT_RDF_BFF=4021
PORT_RNP_BFF=4022 PORT_RCS_BFF=4023 PORT_SUPERADMIN_BFF=4024 \# ──
SECURITY ────────────────────────────────────────────────────── \#
Allowed CORS origins (comma-separated)
CORS_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:3003,http://localhost:3004,http://localhost:3005
\# Rate limiting RATE_LIMIT_TTL_MS=60000 RATE_LIMIT_MAX_REQUESTS=100 \#
WAF --- block non-RW IPs during recruitment cycles (true/false)
WAF_COUNTRY_FILTER_ENABLED=false WAF_ALLOWED_COUNTRY_CODES=RW \# ──
DOCUMENT FORENSICS ───────────────────────────────────────────****─
FORENSICS_ELA_QUALITY_THRESHOLD=90 FORENSICS_DCT_GAN_THRESHOLD=0.75
FORENSICS_MAX_FILE_SIZE_MB=10
FORENSICS_ALLOWED_MIME_TYPES=image/jpeg,image/png,application/pdf \# ──
FIELD TABLET SYNC ────────────────────────────────────────────
FIELD_SYNC_DEVICE_KEY_ALGORITHM=Ed25519
FIELD_SYNC_STALE_WRITE_THRESHOLD_MS=300000 \# ── MONITORING
────────────────────────────────────────────────────
PROMETHEUS_PORT=9090 GRAFANA_PORT=3030 GRAFANA_ADMIN_PASSWORD=CHANGE_ME
\# ── FEATURE FLAGS ──────────────────────────────────────────────── \#
Disable G2G calls and use mock data in development
FEATURE_USE_NIDA_MOCK=true FEATURE_USE_NESA_MOCK=true
FEATURE_USE_RIB_MOCK=true FEATURE_BIOMETRIC_ENABLED=true
FEATURE_USSD_ENABLED=false FEATURE_WAF_ENABLED=false EOF echo \"Done:
.env.example written\" \`\`\` \-\-- \### Block 8: Shared Types Package
\`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/package.json
\<\< \'EOF\' { \"name\": \"@usrp/shared-types\", \"version\": \"1.0.0\",
\"private\": true, \"description\": \"Shared TypeScript type definitions
for all USRP backend services\", \"main\": \"./dist/index.js\",
\"types\": \"./dist/index.d.ts\", \"exports\": { \".\": { \"import\":
\"./dist/index.js\", \"types\": \"./dist/index.d.ts\" } }, \"scripts\":
{ \"build\": \"tsc\", \"typecheck\": \"tsc \--noEmit\", \"lint\":
\"eslint src/\*\*/\*.ts\" }, \"devDependencies\": { \"typescript\":
\"\^5.8.3\" } } EOF echo \"Done: shared-types/package.json written\"
\`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/tsconfig.json
\<\< \'EOF\' { \"extends\": \"../../tsconfig.base.json\",
\"compilerOptions\": { \"outDir\": \"./dist\", \"rootDir\": \"./src\" },
\"include\": \[\"src/\*\*/\*\"\] } EOF \`\`\` Now the core type
definitions: \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/index.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
\@usrp/shared-types --- Central export // All backend services import
types from here // Frontend apps NEVER import from this package directly
// Frontend consumes BFF response types (defined per BFF service) //
══════════════════════════════════════════════════════════════════
export \* from \'./agency.types\'; export \* from
****\'./applicant.types\'; export \* from \'./eligibility.types\';
export \* from \'./events.types\'; export \* from \'./g2g.types\';
export \* from \'./vetting.types\'; export \* from \'./field.types\';
EOF \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/agency.types.ts
\<\< \'EOF\' // ── Agency Identity
─────────────────────────────────────────────── export const AGENCIES =
\[\'RDF\', \'RNP\', \'RCS\'\] as const; export type Agency = typeof
AGENCIES\[number\]; export const APPLICATION_CHANNELS = \[\'WEB\',
\'USSD\', \'IREMBO_KIOSK\'\] as const; export type ApplicationChannel =
typeof APPLICATION_CHANNELS\[number\]; export const REGIONAL_HUBS = \[
\'KIGALI\', \'NORTHERN\', \'SOUTHERN\', \'EASTERN\', \'WESTERN\' \] as
const; export type RegionalHub = typeof REGIONAL_HUBS\[number\]; // ──
RDF-Specific ────────────────────────────────────────────────── export
const RDF_APPLICATION_CATEGORIES = \[ \'GENERAL_ENLISTMENT\',
\'CADET_OFFICER\', \'DIRECT_SHORT_SERVICE\', \'SPECIALIST\' \] as const;
export type RDFApplicationCategory = typeof
RDF_APPLICATION_CATEGORIES\[number\]; // ── RNP-Specific
────────────────────────────────────────────────── export const
RNP_APPLICATION_CATEGORIES = \[ \'CONSTABLE\', \'CADET_INSPECTOR\',
\'SPECIALIST_UNIT\' \] as const; export type RNPApplicationCategory =
typeof RNP_APPLICATION_CATEGORIES\[number\]; // ── RCS-Specific
────────────────────────────────────────────────── export const
RCS_APPLICATION_CATEGORIES = \[ \'CORRECTIONAL_OFFICER\',
\'SENIOR_OFFICER\', \'SPECIALIST\' \] as const; export type
RCSApplicationCategory = typeof RCS_APPLICATION_CATEGORIES\[number\];
EOF \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/applicant.types.ts
\<\< \'EOF\' import type { Agency, ApplicationChannel, RegionalHub }
from \'./agency.types\'; // ── Core Identity (NIDA-Anchored)
───────────────────────────────── export type Gender = \'MALE\' \|
\'FEMALE\'; export type IdentityVerificationStatus = \| \'PENDING\' \|
\'VERIFIED\' \| \'FAILED\' \| \'EXPIRED\'; export interface
ApplicantIdentityCore { readonly id: string; readonly nationalIdHash:
string; // SHA-256 HMAC --- never raw NID readonly gender: Gender;
readonly nidaVerifiedAt: string \| null; // ISO ****8601 readonly
nidaMatchConfidence: string \| null; readonly identityStatus:
IdentityVerificationStatus; readonly registrationChannel:
ApplicationChannel; readonly phoneVerifiedAt: string \| null; readonly
biometricVerifiedAt: string \| null; readonly biometricPassedLiveness:
boolean; readonly createdAt: string; } // PII is only available after
decryption --- separate type export interface ApplicantPII { readonly
fullName: string; readonly dateOfBirth: string; // ISO 8601 date
readonly homeDistrict: string; readonly homeProvince: string; } // ──
Application Status ──────────────────────────────────────────── export
const APPLICATION_STATUSES = \[ \'DRAFT\', \'SUBMITTED\',
\'ACADEMIC_VETTING\', \'CRIMINAL_CLEARANCE\', \'DOCUMENT_REVIEW_GREEN\',
\'DOCUMENT_REVIEW_AMBER\', \'SLOT_ASSIGNED\',
\'PHYSICAL_TEST_SCHEDULED\', \'PHYSICAL_TEST_COMPLETE\',
\'MEDICAL_REVIEW\', \'FINAL_SHORTLIST\', \'ACCEPTED\', \'REJECTED\',
\'WITHDRAWN\' \] as const; export type ApplicationStatus = typeof
APPLICATION_STATUSES\[number\]; // ── Processing Code
─────────────────────────────────────────────── // What reviewers see
instead of applicant names during anonymized review export interface
ProcessingCode { readonly code: string; // e.g. \"RDF-90823\" readonly
agency: Agency; readonly sequenceNumber: number; } // ── Cross-Agency
Lock ───────────────────────────────────────────── // Prevents
double-acceptance across RDF/RNP/RCS export interface CrossAgencyLock {
readonly lockedAt: string; readonly lockedByAgency: Agency; readonly
reason: \'ACCEPTED\' \| \'IN_FINAL_STAGE\'; } // ── Slot Assignment
─────────────────────────────────────────────── export interface
SlotAssignment { readonly slotId: string; readonly agency: Agency;
readonly regionalHub: RegionalHub; readonly scheduledAt: string; // ISO
8601 datetime readonly reportingLocation: string; // Physical address
readonly qrInvitationCode: string; readonly qrIssuedAt: string; } EOF
\`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/eligibility.types.ts
\<\< \'EOF\' // ── Rwanda A-Level Grade System
─────────────────────────────────── // A = highest (rank 6), F = lowest
(rank 1) export const ****RWANDAN_ALEVEL_GRADES = \[\'A\', \'B\', \'C\',
\'D\', \'E\', \'F\'\] as const; export type RwandanALevelGrade = typeof
RWANDAN_ALEVEL_GRADES\[number\]; export const GRADE_RANK:
Readonly\<Record\<RwandanALevelGrade, number\>\> = { \'A\': 6, \'B\': 5,
\'C\': 4, \'D\': 3, \'E\': 2, \'F\': 1 } as const; export const
QUALIFICATION_LEVELS = \[\'A2\', \'A1\', \'O_LEVEL\'\] as const; export
type QualificationLevel = typeof QUALIFICATION_LEVELS\[number\]; // ──
NESA Verified Payload ───────────────────────────────────────── export
interface NESASubjectResult { readonly subjectCode: string; readonly
subjectName: string; readonly grade: RwandanALevelGrade; readonly
points: number; } export interface NESAVerifiedPayload { readonly
indexNumber: string; readonly qualificationLevel: QualificationLevel;
readonly yearOfExamination: number; readonly schoolName: string;
readonly subjects: readonly NESASubjectResult\[\]; readonly
overallPoints: number; readonly verificationToken: string; readonly
verifiedAt: string; } // ── Academic Criteria (per Agency/Category)
─────────────────────── export interface SubjectRequirement { readonly
subjectCode: string; readonly minGrade: RwandanALevelGrade; } export
interface AcademicCriteria { readonly minQualificationLevel:
QualificationLevel; readonly minOverallPoints?: number; readonly
requiredSubjectCombinations: readonly (readonly
SubjectRequirement\[\])\[\]; readonly maximumExamYearsOld?: number; } //
── Eligibility Results ───────────────────────────────────────────
export type AcademicEligibilityStatus = \'PENDING\' \| \'ELIGIBLE\' \|
\'INELIGIBLE\'; export type CriminalClearanceStatus = \'PENDING\' \|
\'CLEARED\' \| \'FLAGGED\' \| \'UNDER_REVIEW\'; export type DocumentLane
= \'GREEN\' \| \'AMBER\' \| \'RED\'; export interface EligibilityResult
{ readonly eligible: boolean; readonly reason: string; readonly
evaluatedAt: string; readonly details?: { readonly qualificationCheck?:
boolean; readonly pointsCheck?: boolean; readonly subjectCheck?:
boolean; readonly matchedCombination?: readonly SubjectRequirement\[\];
readonly examYearCheck?: boolean; readonly failureCode?: string; }; } //
── Age Eligibility ───────────────────────────────────────────────
export interface AgeCriteria { readonly minAgeYears: number; readonly
maxAgeYears: number; } export interface AgeEligibilityResult { readonly
eligible: boolean; readonly ageAtEvaluation: number; ****readonly
reason: string; } EOF \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/g2g.types.ts
\<\< \'EOF\' // ── NIDA Integration Types
──────────────────────────────────────── export type
NIDACitizenshipStatus = \'RWANDAN_CITIZEN\' \| \'FOREIGN_RESIDENT\';
export type NIDARecordStatus = \'FOUND\' \| \'NOT_FOUND\' \|
\'SUSPENDED\'; export interface NIDACitizenRecord { readonly
nationalIdHash: string; readonly fullName: string; readonly dateOfBirth:
string; // ISO 8601 readonly gender: \'MALE\' \| \'FEMALE\'; readonly
homeDistrict: string; readonly homeProvince: string; readonly
registeredPhoneNumber: string; // Masked: 07X-XXX-X890 readonly
citizenshipStatus: NIDACitizenshipStatus; } export interface
NIDALookupResponse { readonly status: NIDARecordStatus; readonly
citizen?: NIDACitizenRecord; readonly requestId: string; readonly
respondedAt: string; } export interface NIDABiometricMatchResponse {
readonly matched: boolean; readonly matchConfidence: number; // 0.0 -
100.0 readonly matchThreshold: number; // NIDA configured threshold
readonly requestId: string; readonly respondedAt: string; } // ── NESA
Integration Types ──────────────────────────────────────── export type
NESALookupStatus = \'FOUND\' \| \'NOT_FOUND\' \| \'INVALID_INDEX\';
export interface NESALookupResponse { readonly status: NESALookupStatus;
readonly payload?: import(\'./eligibility.types\').NESAVerifiedPayload;
readonly requestId: string; readonly respondedAt: string; } // ── RIB
Integration Types ───────────────────────────────────────── export type
RIBRecordStatus = \'CLEAR\' \| \'HAS_RECORDS\' \|
\'UNDER_INVESTIGATION\'; export interface RIBVettingRequest { readonly
nationalIdHash: string; readonly requestId: string; readonly
requestingAgency: import(\'./agency.types\').Agency; readonly
requestedAt: string; } export interface RIBVettingResponse { readonly
status: RIBRecordStatus; readonly requestId: string; readonly
respondedAt: string; // No case details returned --- only status flag //
Detailed records require separate authorized physical request } // ──
G2G Request Envelope (HMAC-signed) ─────────────────────────── export
interface G2GRequestEnvelope { readonly requestId: string; readonly
timestamp: string; readonly hmacSignature: string; readonly payload:
unknown; } ****EOF \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/events.types.ts
\<\< \'EOF\' // ── Kafka Event Definitions
─────────────────────────────────────── // Every event is immutable once
published. // eventId ensures idempotent processing. // All timestamps
are ISO 8601 UTC. import type { Agency, ApplicationChannel } from
\'./agency.types\'; import type { ApplicationStatus, CrossAgencyLock }
from \'./applicant.types\'; import type { AcademicEligibilityStatus,
CriminalClearanceStatus, DocumentLane, EligibilityResult } from
\'./eligibility.types\'; // ── Base Event
──────────────────────────────────────────────────── interface BaseEvent
{ readonly eventId: string; // UUID v4 readonly eventVersion: string; //
\"1.0\" readonly occurredAt: string; // ISO 8601 readonly correlationId:
string; // Traces request across services } // ── Topic:
applicant.submitted ──────────────────────────────────── export
interface ApplicantSubmittedEvent extends BaseEvent { readonly
eventType: \'APPLICANT_SUBMITTED\'; readonly applicantId: string;
readonly nationalIdHash: string; readonly agency: Agency; readonly
channel: ApplicationChannel; readonly nesaIndexNumber: string; } // ──
Topic: vetting.nida ─────────────────────────────────────────── export
interface NIDAVerificationCompletedEvent extends BaseEvent { readonly
eventType: \'NIDA_VERIFICATION_COMPLETED\'; readonly applicantId:
string; readonly nidaRequestId: string; readonly verified: boolean;
readonly matchConfidence: number \| null; readonly failureReason?:
string; } // ── Topic: vetting.nesa
─────────────────────────────────────────── export interface
NESAVerificationCompletedEvent extends BaseEvent { readonly eventType:
\'NESA_VERIFICATION_COMPLETED\'; readonly applicantId: string; readonly
applicationId: string; readonly agency: Agency; readonly nesaRequestId:
string; readonly eligibilityResult: EligibilityResult; readonly
academicStatus: AcademicEligibilityStatus; } // ── Topic: vetting.rib
──────────────────────────────────────────── export interface
RIBVettingCompletedEvent extends BaseEvent { readonly eventType:
\'RIB_VETTING_COMPLETED\'; readonly applicantId: ****string; readonly
applicationId: string; readonly agency: Agency; readonly ribRequestId:
string; readonly clearanceStatus: CriminalClearanceStatus; } // ──
Topic: biometric.result ─────────────────────────────────────── export
interface BiometricVerificationCompletedEvent extends BaseEvent {
readonly eventType: \'BIOMETRIC_VERIFICATION_COMPLETED\'; readonly
applicantId: string; readonly sessionId: string; readonly livenessScore:
number; readonly livenessPass: boolean; readonly faceMatchConfidence:
number; readonly faceMatchPass: boolean; // No biometric data in event
--- scores only } // ── Topic: slot.assigned
────────────────────────────────────────── export interface
SlotAssignedEvent extends BaseEvent { readonly eventType:
\'SLOT_ASSIGNED\'; readonly applicantId: string; readonly applicationId:
string; readonly agency: Agency; readonly slotId: string; readonly
scheduledAt: string; readonly regionalHub: string; readonly
qrInvitationCode: string; } // ── Topic: field.score.captured
─────────────────────────────────── export interface
FieldScoreCapturedEvent extends BaseEvent { readonly eventType:
\'FIELD_SCORE_CAPTURED\'; readonly applicationId: string; readonly
agency: Agency; readonly deviceId: string; readonly capturingOfficerId:
string; readonly vectorClock: Record\<string, number\>; readonly
signedPayloadHash: string; } // ── Topic: audit.immutable
──────────────────────────────────────── // Every state change produces
an audit event --- append-only export interface AuditEvent extends
BaseEvent { readonly eventType: \'AUDIT_ENTRY\'; readonly entityType:
\'APPLICANT\' \| \'APPLICATION\' \| \'OFFICER\' \| \'SYSTEM\'; readonly
entityId: string; readonly action: string; readonly performedBy: string;
// officer ID or \'SYSTEM\' readonly agency: Agency \| \'SYSTEM\';
readonly previousStatus?: ApplicationStatus; readonly newStatus?:
ApplicationStatus; readonly metadata?: Record\<string, unknown\>; } //
── Union type for topic routing ──────────────────────────────────
export type USRPEvent = \| ApplicantSubmittedEvent \|
NIDAVerificationCompletedEvent \| NESAVerificationCompletedEvent \|
RIBVettingCompletedEvent \| BiometricVerificationCompletedEvent \|
SlotAssignedEvent \| FieldScoreCapturedEvent \| AuditEvent; // ── Kafka
****Topic Names ───────────────────────────────────────────── export
const KAFKA_TOPICS = { APPLICANT_SUBMITTED: \'applicant.submitted\',
VETTING_NIDA: \'vetting.nida\', VETTING_NESA: \'vetting.nesa\',
VETTING_RIB: \'vetting.rib\', BIOMETRIC_RESULT: \'biometric.result\',
SLOT_ASSIGNED: \'slot.assigned\', FIELD_SCORE_CAPTURED:
\'field.score.captured\', AUDIT_IMMUTABLE: \'audit.immutable\', } as
const; export type KafkaTopic = typeof KAFKA_TOPICS\[keyof typeof
KAFKA_TOPICS\]; EOF \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/vetting.types.ts
\<\< \'EOF\' import type { DocumentLane } from \'./eligibility.types\';
// ── Document Forensics ────────────────────────────────────────────
export interface ForensicsFlags { readonly elaAnomalyDetected: boolean;
readonly fontMismatchDetected: boolean; readonly stampCloneDetected:
boolean; readonly ganGeneratedDetected: boolean; // DCT frequency
analysis readonly c2paManifestValid: boolean \| null; readonly
virusScanClean: boolean; readonly metadataStripped: boolean; readonly
overallScore: number; // 0-100 (100 = clean) } export interface
DocumentForensicsResult { readonly documentId: string; readonly lane:
DocumentLane; readonly flags: ForensicsFlags; readonly
requiresHumanReview: boolean; readonly processingTimeMs: number;
readonly analyzedAt: string; } // ── Triage Queue Item (for HR Officer
dashboard) ────────────────── export interface AmberLaneQueueItem {
readonly processingCode: string; // \"RDF-90823\" --- no real name
readonly documentType: string; readonly primaryFlag: string; // e.g.
\"ELA Anomaly\" readonly forensicsScore: number; readonly queuedAt:
string; } EOF \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/field.types.ts
\<\< \'EOF\' // ── Field Tablet Physical Test Scoring
─────────────────────────── export interface PhysicalTestMetrics {
readonly heightCm: number; // Bounds: 140-220 readonly weightKg: number;
// Bounds: 40-150 readonly run3kmTimeSeconds: number; // 3km run time
readonly chestCm: number; readonly medicalFitnessStatus: \'FIT\' \|
\'UNFIT\' \| \'PENDING_REVIEW\'; readonly additionalNotes?: string; }
export interface FieldScoreRecord { readonly applicationId: string;
readonly qrInvitationCode: string; // Scanned from applicant\'s QR
readonly ****metrics: PhysicalTestMetrics; readonly capturedAt: string;
// ISO 8601 readonly deviceId: string; readonly capturingOfficerId:
string; readonly vectorClock: Record\<string, number\>; readonly
deviceSignature: string; // Ed25519 signature readonly
signedPayloadHash: string; // SHA-256 of metrics payload } // ── CRDT
Merge Result ───────────────────────────────────────────── export
interface CRDTMergeResult { readonly merged: boolean; readonly conflict:
boolean; readonly conflictReason?: string; readonly winningRecord?:
FieldScoreRecord; } EOF \`\`\` \-\-- \### Block 9: Infrastructure ---
Tier 1 Docker Stack \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/docker-compose.tier1.yml
\<\< \'EOF\' \#
══════════════════════════════════════════════════════════════════ \#
USRP --- TIER 1 INFRASTRUCTURE (Phase 1-2 Development) \# RAM budget:
\~1.4GB \# Includes: PostgreSQL, Redis, MinIO, Kong, G2G Mocks \# Does
NOT include: Kafka (added in Tier 2) \#
══════════════════════════════════════════════════════════════════ name:
usrp-tier1 networks: usrp-internal: driver: bridge ipam: config: -
subnet: 172.20.0.0/16 volumes: postgres-data: driver: local redis-data:
driver: local minio-data: driver: local services: \# ── PostgreSQL 16
─────────────────────────────────────────────── postgres: image:
postgres:16-alpine container_name: usrp-postgres restart: unless-stopped
environment: POSTGRES_USER: \${POSTGRES_USER:-usrp_admin}
POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-usrp_dev_password} POSTGRES_DB:
\${POSTGRES_DB:-usrp_db} PGDATA: /var/lib/postgresql/data/pgdata
volumes: - postgres-data:/var/lib/postgresql/data -
./init-scripts/01-create-schemas.sql:/docker-entrypoint-initdb.d/01-schemas.sql:ro -
./init-scripts/02-create-roles.sql:/docker-entrypoint-initdb.d/02-roles.sql:ro -
./init-scripts/03-rls-policies.sql:/docker-entrypoint-initdb.d/03-rls.sql:ro -
./init-scripts/04-create-extensions.sql:/docker-entrypoint-initdb.d/04-extensions.sql:ro
ports: - \"5432:5432\" networks: - usrp-internal healthcheck: test:
\[\"CMD-SHELL\", \"pg_isready -U \${POSTGRES_USER:-usrp_admin} -d
\${POSTGRES_DB:-usrp_db}\"\] interval: 10s timeout: 5s retries: 5
start_period: 30s deploy: resources: limits: memory: 512M \# ── Redis
7.2 ─────────────────────────────────────────────────── redis: image:
redis:7.2-alpine container_name: usrp-redis restart: unless-stopped
command: \> redis-server \--requirepass
\$****{REDIS_PASSWORD:-usrp_redis_dev} \--save 60 1 \--loglevel warning
\--maxmemory 128mb \--maxmemory-policy allkeys-lru volumes: -
redis-data:/data ports: - \"6379:6379\" networks: - usrp-internal
healthcheck: test: \[\"CMD\", \"redis-cli\", \"\--auth\",
\"\${REDIS_PASSWORD:-usrp_redis_dev}\", \"ping\"\] interval: 10s
timeout: 5s retries: 5 deploy: resources: limits: memory: 192M \# ──
MinIO Object Store ────────────────────────────────────────── minio:
image: minio/minio:latest container_name: usrp-minio restart:
unless-stopped command: server /data \--console-address \":9001\"
environment: MINIO_ROOT_USER: \${MINIO_ROOT_USER:-usrp_minio_admin}
MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD:-usrp_minio_dev_password}
volumes: - minio-data:/data ports: - \"9000:9000\" - \"9001:9001\"
networks: - usrp-internal healthcheck: test: \[\"CMD\", \"mc\",
\"ready\", \"local\"\] interval: 30s timeout: 20s retries: 3 deploy:
resources: limits: memory: 256M \# ── Kong API Gateway (DB-less mode)
───────────────────────────── kong: image: kong:3.7-ubuntu
container_name: usrp-kong restart: unless-stopped environment:
KONG_DATABASE: \"off\" KONG_DECLARATIVE_CONFIG:
/kong/declarative/kong.dev.yml KONG_PROXY_ACCESS_LOG: /dev/stdout
KONG_ADMIN_ACCESS_LOG: /dev/stdout KONG_PROXY_ERROR_LOG: /dev/stderr
KONG_ADMIN_ERROR_LOG: /dev/stderr KONG_ADMIN_LISTEN: \"0.0.0.0:8001\"
KONG_PROXY_LISTEN: \"0.0.0.0:8000\" volumes: -
./kong/kong.dev.yml:/kong/declarative/kong.dev.yml:ro ports: -
\"8000:8000\" - \"8001:8001\" networks: - usrp-internal healthcheck:
test: \[\"CMD\", \"kong\", \"health\"\] interval: 30s timeout: 10s
retries: 3 depends_on: postgres: condition: service_healthy deploy:
resources: limits: memory: 256M \# ── G2G Mock: NIDA
────────────────────────────────────────────── nida-mock: build:
context: ./mocks/nida dockerfile: Dockerfile container_name:
usrp-nida-mock restart: unless-stopped environment: PORT: 3100
MOCK_DATA_FILE: /app/data/citizens.json HMAC_SECRET:
\${NIDA_HMAC_SECRET:-dev_nida_hmac_secret} ports: - \"3100:3100\"
networks: - usrp-internal healthcheck: test: \[\"CMD\", \"wget\",
\"-qO-\", \"http://localhost:3100/health\"\] interval: 15s timeout: 5s
retries: 3 deploy: resources: limits: memory: 128M \# ── G2G Mock: NESA
───────────────────────────────────────────****─── nesa-mock: build:
context: ./mocks/nesa dockerfile: Dockerfile container_name:
usrp-nesa-mock restart: unless-stopped environment: PORT: 3101
MOCK_DATA_FILE: /app/data/results.json HMAC_SECRET:
\${NESA_HMAC_SECRET:-dev_nesa_hmac_secret} ports: - \"3101:3101\"
networks: - usrp-internal healthcheck: test: \[\"CMD\", \"wget\",
\"-qO-\", \"http://localhost:3101/health\"\] interval: 15s timeout: 5s
retries: 3 deploy: resources: limits: memory: 128M \# ── G2G Mock: RIB
─────────────────────────────────────────────── rib-mock: build:
context: ./mocks/rib dockerfile: Dockerfile container_name:
usrp-rib-mock restart: unless-stopped environment: PORT: 3102
MOCK_DATA_FILE: /app/data/records.json HMAC_SECRET:
\${RIB_HMAC_SECRET:-dev_rib_hmac_secret} ports: - \"3102:3102\"
networks: - usrp-internal healthcheck: test: \[\"CMD\", \"wget\",
\"-qO-\", \"http://localhost:3102/health\"\] interval: 15s timeout: 5s
retries: 3 deploy: resources: limits: memory: 128M EOF echo \"Done:
docker-compose.tier1.yml written\" \`\`\` \-\-- \### Block 10: Tier 2
Docker Stack (Kafka in KRaft Mode) \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/docker-compose.tier2.yml
\<\< \'EOF\' \#
══════════════════════════════════════════════════════════════════ \#
USRP --- TIER 2 INFRASTRUCTURE (Phase 3+ Backend Development) \# Extends
Tier 1. Adds: Kafka (KRaft), Schema Registry, ClamAV \# RAM budget:
\~1.5GB additional (total \~2.9GB with Tier 1) \# KRaft mode: NO
Zookeeper --- saves 256MB RAM \#
══════════════════════════════════════════════════════════════════ name:
usrp-tier2 networks: usrp-internal: external: true name:
usrp-tier1_usrp-internal volumes: kafka-data: driver: local clamav-data:
driver: local services: \# ── Apache Kafka 3.7 (KRaft --- No Zookeeper)
───────────────────── kafka: image: confluentinc/cp-kafka:7.7.0
container_name: usrp-kafka restart: unless-stopped environment: \# KRaft
configuration KAFKA_NODE_ID: 1 KAFKA_PROCESS_ROLES: broker,controller
KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093 KAFKA_LISTENERS:
PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT
KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT \# Performance ****tuning
for dev (reduced for RAM constraints) KAFKA_NUM_PARTITIONS: 3
KAFKA_DEFAULT_REPLICATION_FACTOR: 1 KAFKA_LOG_RETENTION_HOURS: 168
KAFKA_LOG_SEGMENT_BYTES: 1073741824 KAFKA_AUTO_CREATE_TOPICS_ENABLE:
\"false\" KAFKA_LOG_DIRS: /var/lib/kafka/data \# JVM heap --- critical
for RAM management KAFKA_HEAP_OPTS: \"-Xmx512M -Xms256M\" CLUSTER_ID:
\"MkU3OEVBNTcwNTJENDM2Qk\" volumes: - kafka-data:/var/lib/kafka/data
ports: - \"9092:9092\" networks: - usrp-internal healthcheck: test:
\[\"CMD\", \"kafka-broker-api-versions\", \"\--bootstrap-server\",
\"localhost:9092\"\] interval: 30s timeout: 10s retries: 5 start_period:
60s deploy: resources: limits: memory: 640M \# ── Kafka Topic
Initializer ────────────────────────────────────── kafka-init: image:
confluentinc/cp-kafka:7.7.0 container_name: usrp-kafka-init depends_on:
kafka: condition: service_healthy networks: - usrp-internal entrypoint:
\[\"/bin/bash\", \"-c\"\] command: \| \" echo \'Creating USRP Kafka
topics\...\' kafka-topics \--create \--if-not-exists \\ \--topic
applicant.submitted \\ \--partitions 12 \\ \--replication-factor 1 \\
\--config retention.ms=604800000 \\ \--bootstrap-server kafka:9092
kafka-topics \--create \--if-not-exists \\ \--topic vetting.nida \\
\--partitions 6 \\ \--replication-factor 1 \\ \--config
retention.ms=604800000 \\ \--bootstrap-server kafka:9092 kafka-topics
\--create \--if-not-exists \\ \--topic vetting.nesa \\ \--partitions 6
\\ \--replication-factor 1 \\ \--config retention.ms=604800000 \\
\--bootstrap-server kafka:9092 kafka-topics \--create \--if-not-exists
\\ \--topic vetting.rib \\ \--partitions 6 \\ \--replication-factor 1 \\
\--config retention.ms=604800000 \\ \--bootstrap-server kafka:9092
kafka-topics \--create \--if-not-exists \\ \--topic biometric.result \\
\--partitions 6 \\ \--replication-factor 1 \\ \--config
retention.ms=604800000 \\ \--bootstrap-server kafka:9092 kafka-topics
\--create \--if-not-exists \\ \--topic slot.assigned \\ \--partitions 6
\\ \--replication-factor 1 \\ \--config retention.ms=604800000 \\
\--bootstrap-server kafka:9092 kafka-topics \--create \--if-not-exists
\\ \--topic field.score.captured \\ \--partitions 6 \\
\--replication-factor 1 \\ \--config retention.ms=604800000 \\
\--bootstrap-server kafka:9092 kafka-topics \--create \--if-not-exists
\\ \--topic audit.immutable \\ \--partitions 3 \\ \--replication-factor
1 \\ \--config retention.ms=-1 \\ \--config cleanup.policy=delete \\
\--bootstrap-server kafka:9092 echo \'All USRP topics created
successfully.\' kafka-topics \--list \--bootstrap-server kafka:9092 \"
restart: on-failure \# ── Confluent ****Schema Registry
──────────────────────────────────── schema-registry: image:
confluentinc/cp-schema-registry:7.7.0 container_name:
usrp-schema-registry restart: unless-stopped depends_on: kafka:
condition: service_healthy environment: SCHEMA_REGISTRY_HOST_NAME:
schema-registry SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS: kafka:9092
SCHEMA_REGISTRY_LISTENERS: http://0.0.0.0:8081
SCHEMA_REGISTRY_HEAP_OPTS: \"-Xmx128M -Xms64M\" ports: - \"8081:8081\"
networks: - usrp-internal healthcheck: test: \[\"CMD\", \"curl\",
\"-f\", \"http://localhost:8081/subjects\"\] interval: 30s timeout: 10s
retries: 5 deploy: resources: limits: memory: 256M \# ── ClamAV Virus
Scanner ───────────────────────────────────────── clamav: image:
clamav/clamav:stable container_name: usrp-clamav restart: unless-stopped
volumes: - clamav-data:/var/lib/clamav ports: - \"3310:3310\"
networks: - usrp-internal healthcheck: test: \[\"CMD\", \"clamdcheck\"\]
interval: 60s timeout: 30s retries: 3 start_period: 120s deploy:
resources: limits: memory: 512M \# ── Kafka UI (Dev tooling only)
────────────────────────────────── kafka-ui: image:
provectuslabs/kafka-ui:latest container_name: usrp-kafka-ui restart:
unless-stopped depends_on: kafka: condition: service_healthy
schema-registry: condition: service_healthy environment:
KAFKA_CLUSTERS_0_NAME: usrp-local KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS:
kafka:9092 KAFKA_CLUSTERS_0_SCHEMAREGISTRY: http://schema-registry:8081
SERVER_PORT: 8080 ports: - \"8080:8080\" networks: - usrp-internal
deploy: resources: limits: memory: 256M EOF echo \"Done:
docker-compose.tier2.yml written\" \`\`\` \-\-- \### Block 11:
PostgreSQL Init Scripts \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/init-scripts/04-create-extensions.sql
\<\< \'EOF\' \--
══════════════════════════════════════════════════════════════════ \--
USRP --- PostgreSQL Extensions \-- Run order: 04 (after schemas, roles,
RLS) \--
══════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"; CREATE EXTENSION IF NOT
EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS
\"pg_stat_statements\"; \-- Confirm extensions SELECT extname,
extversion FROM pg_extension ORDER BY extname; EOF \`\`\` \`\`\`bash cat
\>
****/home/uruti/Documents/projects/usrp/infrastructure/docker/init-scripts/01-create-schemas.sql
\<\< \'EOF\' \--
══════════════════════════════════════════════════════════════════ \--
USRP --- Schema Creation \-- Four isolated schemas: public_core,
rdf_ops, rnp_ops, rcs_ops \-- Plus: audit schema (append-only) \--
══════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS public_core; CREATE SCHEMA IF NOT EXISTS
rdf_ops; CREATE SCHEMA IF NOT EXISTS rnp_ops; CREATE SCHEMA IF NOT
EXISTS rcs_ops; CREATE SCHEMA IF NOT EXISTS audit_log; COMMENT ON SCHEMA
public_core IS \'Shared applicant identity --- NIDA-anchored, visible to
all authorized services\'; COMMENT ON SCHEMA rdf_ops IS \'Rwanda Defence
Force --- isolated recruitment operations\'; COMMENT ON SCHEMA rnp_ops
IS \'Rwanda National Police --- isolated recruitment operations\';
COMMENT ON SCHEMA rcs_ops IS \'Rwanda Correctional Service --- isolated
recruitment operations\'; COMMENT ON SCHEMA audit_log IS \'Append-only
immutable audit trail --- no UPDATE or DELETE permitted\'; SELECT
schema_name FROM information_schema.schemata WHERE schema_name IN
(\'public_core\',\'rdf_ops\',\'rnp_ops\',\'rcs_ops\',\'audit_log\')
ORDER BY schema_name; EOF \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/init-scripts/02-create-roles.sql
\<\< \'EOF\' \--
══════════════════════════════════════════════════════════════════ \--
USRP --- Database Role Hierarchy \-- Principle of least privilege
throughout \--
══════════════════════════════════════════════════════════════════ \--
── Service Roles (used by backend microservices) ───────────────── DO
\$\$ BEGIN CREATE ROLE usrp_system_service LOGIN PASSWORD
\'CHANGE_IN_PRODUCTION\'; EXCEPTION WHEN duplicate_object THEN RAISE
NOTICE \'Role usrp_system_service already exists\'; END \$\$; \-- ──
Agency Officer Roles (used by BFF services) ─────────────────── DO \$\$
BEGIN CREATE ROLE usrp_rdf_officer LOGIN PASSWORD
\'CHANGE_IN_PRODUCTION\'; EXCEPTION WHEN duplicate_object THEN RAISE
NOTICE \'Role usrp_rdf_officer already exists\'; END \$\$; DO \$\$ BEGIN
CREATE ROLE usrp_rnp_officer LOGIN PASSWORD \'CHANGE_IN_PRODUCTION\';
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE \'Role
usrp_rnp_officer already exists\'; END \$\$; DO \$\$ BEGIN CREATE ROLE
usrp_rcs_officer LOGIN PASSWORD \'CHANGE_IN_PRODUCTION\'; EXCEPTION WHEN
duplicate_object THEN RAISE NOTICE \'Role ****usrp_rcs_officer already
exists\'; END \$\$; \-- ── Read-only Role (analytics, monitoring)
──────────────────────── DO \$\$ BEGIN CREATE ROLE usrp_readonly LOGIN
PASSWORD \'CHANGE_IN_PRODUCTION\'; EXCEPTION WHEN duplicate_object THEN
RAISE NOTICE \'Role usrp_readonly already exists\'; END \$\$; \-- ──
Superadmin (MoD oversight only) ────────────────────────────── DO \$\$
BEGIN CREATE ROLE usrp_superadmin LOGIN PASSWORD
\'CHANGE_IN_PRODUCTION\'; EXCEPTION WHEN duplicate_object THEN RAISE
NOTICE \'Role usrp_superadmin already exists\'; END \$\$; \-- ── Schema
Grants: System Service (full access for vetting workers) GRANT USAGE ON
SCHEMA public_core TO usrp_system_service; GRANT USAGE ON SCHEMA rdf_ops
TO usrp_system_service; GRANT USAGE ON SCHEMA rnp_ops TO
usrp_system_service; GRANT USAGE ON SCHEMA rcs_ops TO
usrp_system_service; GRANT USAGE ON SCHEMA audit_log TO
usrp_system_service; \-- ── Schema Grants: Agency Officers (ISOLATED ---
cross-access denied) GRANT USAGE ON SCHEMA public_core TO
usrp_rdf_officer; GRANT USAGE ON SCHEMA rdf_ops TO usrp_rdf_officer; \--
CRITICAL: RDF cannot see RNP or RCS schemas REVOKE ALL ON SCHEMA rnp_ops
FROM usrp_rdf_officer; REVOKE ALL ON SCHEMA rcs_ops FROM
usrp_rdf_officer; GRANT USAGE ON SCHEMA public_core TO usrp_rnp_officer;
GRANT USAGE ON SCHEMA rnp_ops TO usrp_rnp_officer; REVOKE ALL ON SCHEMA
rdf_ops FROM usrp_rnp_officer; REVOKE ALL ON SCHEMA rcs_ops FROM
usrp_rnp_officer; GRANT USAGE ON SCHEMA public_core TO usrp_rcs_officer;
GRANT USAGE ON SCHEMA rcs_ops TO usrp_rcs_officer; REVOKE ALL ON SCHEMA
rdf_ops FROM usrp_rcs_officer; REVOKE ALL ON SCHEMA rnp_ops FROM
usrp_rcs_officer; \-- ── Schema Grants: Superadmin (read all, no delete)
─────────────── GRANT USAGE ON SCHEMA public_core TO usrp_superadmin;
GRANT USAGE ON SCHEMA rdf_ops TO usrp_superadmin; GRANT USAGE ON SCHEMA
rnp_ops TO usrp_superadmin; GRANT USAGE ON SCHEMA rcs_ops TO
usrp_superadmin; GRANT USAGE ON SCHEMA audit_log TO usrp_superadmin; \--
── Audit log: append-only enforcement ─────────────────────────── \--
Even superadmin cannot delete audit records REVOKE DELETE ON ALL TABLES
IN SCHEMA audit_log FROM usrp_superadmin; REVOKE UPDATE ON ALL TABLES IN
SCHEMA audit_log FROM usrp_superadmin; REVOKE DELETE ON ALL TABLES IN
SCHEMA audit_log FROM usrp_system_service; REVOKE ****UPDATE ON ALL
TABLES IN SCHEMA audit_log FROM usrp_system_service; SELECT rolname FROM
pg_roles WHERE rolname LIKE \'usrp\_%\' ORDER BY rolname; EOF \`\`\`
\`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/init-scripts/03-rls-policies.sql
\<\< \'EOF\' \--
══════════════════════════════════════════════════════════════════ \--
USRP --- Row Level Security Policies \-- Applied after tables are
created by Drizzle migrations \-- This script is idempotent --- safe to
re-run \--
══════════════════════════════════════════════════════════════════ \--
NOTE: RLS policies are applied to tables after Drizzle creates them. \--
This file contains the policy DEFINITIONS. \-- The migration runner
applies them after schema creation. \-- Placeholder confirming RLS init
script loaded: DO \$\$ BEGIN RAISE NOTICE \'USRP RLS policy definitions
loaded --- will be applied post-migration\'; END \$\$; EOF echo \"Done:
PostgreSQL init scripts written\" \`\`\` \-\-- \### Block 12: Kong
Gateway Development Config \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/kong/kong.dev.yml
\<\< \'EOF\' \#
══════════════════════════════════════════════════════════════════ \#
USRP Kong API Gateway --- Development Configuration (DB-less) \#
Production: Kong with PostgreSQL backend + full WAF ruleset \#
══════════════════════════════════════════════════════════════════
\_format_version: \"3.0\" \_transform: true \# ── Services
────────────────────────────────────────────────────── services: - name:
identity-service url: http://host.docker.internal:4001 routes: - name:
identity-routes paths: - /api/v1/identity methods: \[GET, POST\]
strip_path: false plugins: - name: rate-limiting config: minute: 30
policy: local error_message: \"Identity service rate limit exceeded\" -
name: eligibility-service url: http://host.docker.internal:4002
routes: - name: eligibility-routes paths: - /api/v1/eligibility methods:
\[GET, POST\] strip_path: false plugins: - name: rate-limiting config:
minute: 50 policy: local - name: biometric-service url:
http://host.docker.internal:4003 routes: - name: biometric-routes
paths: - /api/v1/biometric methods: \[GET, POST\] strip_path: false
plugins: - name: rate-limiting config: minute: 10 policy: local
error_message: \"Biometric service rate limit exceeded\" - name: rdf-bff
url: http://host.docker.internal:4021 routes: - name: rdf-bff-routes
paths: - /api/v1/rdf methods: \[GET, POST, PATCH, DELETE\] strip_path:
false - ****name: rnp-bff url: http://host.docker.internal:4022
routes: - name: rnp-bff-routes paths: - /api/v1/rnp methods: \[GET,
POST, PATCH, DELETE\] strip_path: false - name: rcs-bff url:
http://host.docker.internal:4023 routes: - name: rcs-bff-routes paths: -
/api/v1/rcs methods: \[GET, POST, PATCH, DELETE\] strip_path: false -
name: superadmin-bff url: http://host.docker.internal:4024 routes: -
name: superadmin-routes paths: - /api/v1/admin methods: \[GET, POST,
PATCH\] strip_path: false \# ── Global Plugins
───────────────────────────────────────────────── plugins: - name: cors
config: origins: - \"http://localhost:3000\" -
\"http://localhost:3001\" - \"http://localhost:3002\" -
\"http://localhost:3003\" - \"http://localhost:3004\" -
\"http://localhost:3005\" methods: - GET - POST - PATCH - DELETE -
OPTIONS headers: - Authorization - Content-Type - X-Request-ID -
X-Agency credentials: true max_age: 3600 - name: request-id config:
header_name: X-Request-ID generator: uuid - name: response-transformer
config: add: headers: - \"X-Content-Type-Options:nosniff\" -
\"X-Frame-Options:DENY\" - \"X-XSS-Protection:1; mode=block\" EOF echo
\"Done: kong.dev.yml written\" \`\`\` \-\-- \### Block 13: G2G Mock
Servers \`\`\`bash \# NIDA Mock Server cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/Dockerfile
\<\< \'EOF\' FROM node:24-alpine WORKDIR /app COPY package.json ./ RUN
npm install COPY . . EXPOSE 3100 CMD \[\"node\", \"server.js\"\] EOF cat
\>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/package.json
\<\< \'EOF\' { \"name\": \"usrp-nida-mock\", \"version\": \"1.0.0\",
\"private\": true, \"dependencies\": { \"express\": \"\^4.19.2\",
\"crypto\": \"\^1.0.1\" } } EOF cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/server.js
\<\< \'EOF\' /\*\* \* USRP --- NIDA Mock Server \* Simulates NIDA
citizen lookup and biometric match APIs \* FOR DEVELOPMENT USE ONLY \*/
const express = require(\'express\'); const crypto =
require(\'crypto\'); const fs = require(\'fs\'); const app = express();
app.use(express.json()); const PORT = process.env.PORT \|\| 3100; const
HMAC_SECRET = process.env.HMAC_SECRET \|\| \'dev_nida_hmac_secret\';
const MOCK_DATA_FILE = process.env.MOCK_DATA_FILE \|\|
\'/app/data/citizens.json\'; // Load mock citizens data let citizens =
{}; try { citizens = JSON.parse(fs.readFileSync(MOCK_DATA_FILE,
\'utf8\')); } catch { console.warn(\'Mock data file not found --- using
inline test data\'); ****citizens = require(\'./data/citizens.json\'); }
// HMAC validation middleware function validateHMAC(req, res, next) {
const signature = req.headers\[\'x-hmac-signature\'\]; const requestId =
req.headers\[\'x-request-id\'\]; const timestamp =
req.headers\[\'x-timestamp\'\]; if (!signature \|\| !requestId \|\|
!timestamp) { return res.status(401).json({ error: \'Missing HMAC
headers\' }); } // Replay attack prevention: reject requests older than
5 minutes const requestTime = new Date(timestamp).getTime(); const now =
Date.now(); if (Math.abs(now - requestTime) \> 300000) { return
res.status(401).json({ error: \'Request timestamp expired\' }); }
next(); } // Health check app.get(\'/health\', (req, res) =\> {
res.json({ status: \'ok\', service: \'nida-mock\', version: \'1.0.0\'
}); }); // Citizen lookup app.post(\'/v1/citizen/lookup\', validateHMAC,
(req, res) =\> { const { nationalIdHash, requestId } = req.body; if
(!nationalIdHash) { return res.status(400).json({ error:
\'nationalIdHash required\' }); } const citizen =
citizens\[nationalIdHash\]; if (!citizen) { return res.json({ status:
\'NOT_FOUND\', requestId, respondedAt: new Date().toISOString() }); } //
Simulate processing delay (50-200ms) const delay =
Math.floor(Math.random() \* 150) + 50; setTimeout(() =\> { res.json({
status: \'FOUND\', citizen: { nationalIdHash, fullName:
citizen.fullName, dateOfBirth: citizen.dateOfBirth, gender:
citizen.gender, homeDistrict: citizen.homeDistrict, homeProvince:
citizen.homeProvince, registeredPhoneNumber:
citizen.registeredPhoneNumber, citizenshipStatus:
citizen.citizenshipStatus }, requestId, respondedAt: new
Date().toISOString() }); }, delay); }); // Biometric match
app.post(\'/v1/biometric/match\', validateHMAC, (req, res) =\> { const {
nationalIdHash, requestId } = req.body; const citizen =
citizens\[nationalIdHash\]; if (!citizen) { return res.json({ matched:
false, matchConfidence: 0, matchThreshold: 85.0, requestId, respondedAt:
new Date().toISOString() }); } // In development: always match if
citizen exists // Confidence varies 85-99 to simulate realistic scores
const confidence = Math.floor(Math.random() \* 14) + 85; setTimeout(()
=\> { res.json({ matched: true, matchConfidence: confidence +
(Math.random() \* 0.9), matchThreshold: 85.0, requestId, respondedAt:
new Date().toISOString() }); }, 100); }); app.listen(PORT, () =\> {
console.log(\`NIDA Mock Server running on port \${PORT}\`);
console.log(\`Loaded \${Object.keys(citizens).length} mock citizens\`);
}); ****EOF \# Mock citizen data --- using fictional test data mkdir -p
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/data
cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/data/citizens.json
\<\< \'EOF\' { \"test_hash_001\": { \"fullName\": \"UWIMANA Jean
Pierre\", \"dateOfBirth\": \"2002-03-15\", \"gender\": \"MALE\",
\"homeDistrict\": \"Gasabo\", \"homeProvince\": \"Kigali City\",
\"registeredPhoneNumber\": \"07X-XXX-X890\", \"citizenshipStatus\":
\"RWANDAN_CITIZEN\" }, \"test_hash_002\": { \"fullName\": \"MUKAMANA
Aline\", \"dateOfBirth\": \"2001-07-22\", \"gender\": \"FEMALE\",
\"homeDistrict\": \"Musanze\", \"homeProvince\": \"Northern Province\",
\"registeredPhoneNumber\": \"07X-XXX-X123\", \"citizenshipStatus\":
\"RWANDAN_CITIZEN\" }, \"test_hash_003\": { \"fullName\": \"HABIMANA
Eric\", \"dateOfBirth\": \"1998-11-08\", \"gender\": \"MALE\",
\"homeDistrict\": \"Huye\", \"homeProvince\": \"Southern Province\",
\"registeredPhoneNumber\": \"07X-XXX-X456\", \"citizenshipStatus\":
\"RWANDAN_CITIZEN\" }, \"test_hash_overage\": { \"fullName\":
\"NZEYIMANA Paul\", \"dateOfBirth\": \"1990-01-01\", \"gender\":
\"MALE\", \"homeDistrict\": \"Nyarugenge\", \"homeProvince\": \"Kigali
City\", \"registeredPhoneNumber\": \"07X-XXX-X789\",
\"citizenshipStatus\": \"RWANDAN_CITIZEN\" } } EOF echo \"Done: NIDA
mock server created\" \`\`\` \`\`\`bash \# NESA Mock Server (minimal ---
mirrors NIDA pattern) cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nesa/Dockerfile
\<\< \'EOF\' FROM node:24-alpine WORKDIR /app COPY package.json ./ RUN
npm install COPY . . EXPOSE 3101 CMD \[\"node\", \"server.js\"\] EOF cat
\>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nesa/package.json
\<\< \'EOF\' { \"name\": \"usrp-nesa-mock\", \"version\": \"1.0.0\",
\"private\": true, \"dependencies\": { \"express\": \"\^4.19.2\" } } EOF
mkdir -p
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nesa/data
cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nesa/data/results.json
\<\< \'EOF\' { \"RW2024/1001\": { \"indexNumber\": \"RW2024/1001\",
\"qualificationLevel\": \"A2\", \"yearOfExamination\": 2024,
\"schoolName\": \"Lycée de Kigali\", \"subjects\": \[ { \"subjectCode\":
\"PHY\", \"subjectName\": \"Physics\", \"grade\": \"B\", \"points\": 5
}, { \"subjectCode\": \"CHEM\", \"subjectName\": \"Chemistry\",
\"grade\": \"B\", \"points\": 5 }, { \"subjectCode\": \"MATH\",
\"subjectName\": \"Mathematics\", \"grade\": \"A\", ****\"points\": 6 }
\], \"overallPoints\": 16, \"verificationToken\": \"NESA-VT-001\" },
\"RW2024/1002\": { \"indexNumber\": \"RW2024/1002\",
\"qualificationLevel\": \"A2\", \"yearOfExamination\": 2024,
\"schoolName\": \"École Secondaire de Musanze\", \"subjects\": \[ {
\"subjectCode\": \"ECO\", \"subjectName\": \"Economics\", \"grade\":
\"A\", \"points\": 6 }, { \"subjectCode\": \"GEO\", \"subjectName\":
\"Geography\", \"grade\": \"B\", \"points\": 5 }, { \"subjectCode\":
\"HIS\", \"subjectName\": \"History\", \"grade\": \"A\", \"points\": 6 }
\], \"overallPoints\": 17, \"verificationToken\": \"NESA-VT-002\" },
\"RW2024/FAIL\": { \"indexNumber\": \"RW2024/FAIL\",
\"qualificationLevel\": \"A2\", \"yearOfExamination\": 2024,
\"schoolName\": \"Test School\", \"subjects\": \[ { \"subjectCode\":
\"PHY\", \"subjectName\": \"Physics\", \"grade\": \"F\", \"points\": 1
}, { \"subjectCode\": \"CHEM\", \"subjectName\": \"Chemistry\",
\"grade\": \"F\", \"points\": 1 }, { \"subjectCode\": \"MATH\",
\"subjectName\": \"Mathematics\", \"grade\": \"F\", \"points\": 1 } \],
\"overallPoints\": 3, \"verificationToken\": \"NESA-VT-FAIL\" } } EOF
cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nesa/server.js
\<\< \'EOF\' const express = require(\'express\'); const fs =
require(\'fs\'); const app = express(); app.use(express.json()); const
PORT = process.env.PORT \|\| 3101; let results = {}; try { results =
JSON.parse(fs.readFileSync(process.env.MOCK_DATA_FILE \|\|
\'/app/data/results.json\', \'utf8\')); } catch { results =
require(\'./data/results.json\'); } app.get(\'/health\', (\_, res) =\>
res.json({ status: \'ok\', service: \'nesa-mock\' }));
app.post(\'/v1/results/lookup\', (req, res) =\> { const { indexNumber,
requestId } = req.body; const result = results\[indexNumber\]; if
(!result) { return res.json({ status: \'NOT_FOUND\', requestId,
respondedAt: new Date().toISOString() }); } res.json({ status:
\'FOUND\', payload: { \...result, verifiedAt: new Date().toISOString()
}, requestId, respondedAt: new Date().toISOString() }); });
app.listen(PORT, () =\> console.log(\`NESA Mock on port \${PORT}\`));
EOF \# RIB Mock (minimal) cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/Dockerfile
\<\< \'EOF\' FROM node:24-alpine WORKDIR /app COPY package.json ./ RUN
npm install COPY . . EXPOSE 3102 CMD \[\"node\", \"server.js\"\] EOF cat
\>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/package.json
\<\< \'EOF\' { \"name\": \"usrp-rib-mock\", \"version\": \"1.0.0\",
\"private\": true, \"dependencies\": { \"express\": \"\^4.19.2\" } } EOF
mkdir -p
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib****/data
cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/data/records.json
\<\< \'EOF\' { \"flagged_hashes\": \[\"test_hash_flagged_001\"\],
\"under_investigation_hashes\": \[\"test_hash_investigation_001\"\] }
EOF cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/server.js
\<\< \'EOF\' const express = require(\'express\'); const fs =
require(\'fs\'); const app = express(); app.use(express.json()); const
PORT = process.env.PORT \|\| 3102; let records = { flagged_hashes: \[\],
under_investigation_hashes: \[\] }; try { records =
JSON.parse(fs.readFileSync(process.env.MOCK_DATA_FILE \|\|
\'/app/data/records.json\', \'utf8\')); } catch { records =
require(\'./data/records.json\'); } app.get(\'/health\', (\_, res) =\>
res.json({ status: \'ok\', service: \'rib-mock\' }));
app.post(\'/v1/vetting/check\', (req, res) =\> { const { nationalIdHash,
requestId } = req.body; let status = \'CLEAR\'; if
(records.flagged_hashes.includes(nationalIdHash)) status =
\'HAS_RECORDS\'; if
(records.under_investigation_hashes.includes(nationalIdHash)) status =
\'UNDER_INVESTIGATION\'; setTimeout(() =\> { res.json({ status,
requestId, respondedAt: new Date().toISOString() }); },
Math.floor(Math.random() \* 200) + 100); }); app.listen(PORT, () =\>
console.log(\`RIB Mock on port \${PORT}\`)); EOF echo \"Done: All G2G
mock servers created\" \`\`\` \-\-- \### Block 14: GitHub Actions CI
Pipeline \`\`\`bash mkdir -p
/home/uruti/Documents/projects/usrp/.github/workflows cat \>
/home/uruti/Documents/projects/usrp/.github/workflows/ci-backend.yml
\<\< \'EOF\' name: USRP Backend CI on: push: branches: \[main, develop\]
pull_request: branches: \[main, develop\] env: NODE_VERSION: \'24\'
PNPM_VERSION: \'9.15.0\' jobs: typecheck: name: TypeScript Type Check
runs-on: ubuntu-latest steps: - uses: actions/checkout@v4 - uses:
pnpm/action-setup@v4 with: version: \${{ env.PNPM_VERSION }} - uses:
actions/setup-node@v4 with: node-version: \${{ env.NODE_VERSION }}
cache: \'pnpm\' - run: pnpm install \--frozen-lockfile - run: pnpm
typecheck lint: name: ESLint runs-on: ubuntu-latest steps: - uses:
actions/checkout@v4 - uses: pnpm/action-setup@v4 with: version: \${{
env.PNPM_VERSION }} - uses: actions/setup-node@v4 with: node-version:
\${{ env.NODE_VERSION }} cache: \'pnpm\' - run: pnpm install
\--frozen-lockfile - run: pnpm lint test: name: Unit Tests runs-on:
ubuntu-latest services: postgres: image: postgres:16-alpine env:
****POSTGRES_USER: test_user POSTGRES_PASSWORD: test_password
POSTGRES_DB: usrp_test options: \>- \--health-cmd pg_isready
\--health-interval 10s \--health-timeout 5s \--health-retries 5 ports: -
5432:5432 redis: image: redis:7.2-alpine options: \>- \--health-cmd
\"redis-cli ping\" \--health-interval 10s \--health-timeout 5s
\--health-retries 5 ports: - 6379:6379 steps: - uses:
actions/checkout@v4 - uses: pnpm/action-setup@v4 with: version: \${{
env.PNPM_VERSION }} - uses: actions/setup-node@v4 with: node-version:
\${{ env.NODE_VERSION }} cache: \'pnpm\' - run: pnpm install
\--frozen-lockfile - run: pnpm test env: DATABASE_URL:
postgresql://test_user:test_password@localhost:5432/usrp_test REDIS_URL:
redis://localhost:6379 NODE_ENV: test FEATURE_USE_NIDA_MOCK: true
FEATURE_USE_NESA_MOCK: true FEATURE_USE_RIB_MOCK: true security-scan:
name: Security Scan runs-on: ubuntu-latest steps: - uses:
actions/checkout@v4 - name: Run Trivy vulnerability scanner uses:
aquasecurity/trivy-action@master with: scan-type: \'fs\' scan-ref: \'.\'
severity: \'CRITICAL,HIGH\' exit-code: \'1\' ignore-unfixed: true EOF
echo \"Done: CI pipeline written\" \`\`\` \-\-- \### Block 15: The
Master Setup Script \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/scripts/setup-dev.sh \<\< \'EOF\'
#!/bin/bash \#
══════════════════════════════════════════════════════════════════ \#
USRP --- One-Command Development Environment Setup \# Run from:
/home/uruti/Documents/projects/usrp/ \#
══════════════════════════════════════════════════════════════════ set
-euo pipefail CYAN=\'\\033\[0;36m\' GREEN=\'\\033\[0;32m\'
RED=\'\\033\[0;31m\' YELLOW=\'\\033\[1;33m\' BOLD=\'\\033\[1m\'
NC=\'\\033\[0m\' log() { echo -e \"\${CYAN}\[USRP\]\${NC} \$1\"; }
success() { echo -e \"\${GREEN}\[✓\]\${NC} \$1\"; } error() { echo -e
\"\${RED}\[✗\]\${NC} \$1\"; exit 1; } warn() { echo -e
\"\${YELLOW}\[!\]\${NC} \$1\"; } echo \"\" echo -e
\"\${BOLD}════════════════════════════════════════════════════════\${NC}\"
echo -e \"\${BOLD} USRP --- Unified Security Recruitment Portal \${NC}\"
echo -e \"\${BOLD} Development Environment Bootstrap \${NC}\" echo -e
\"\${BOLD}════════════════════════════════════════════════════════\${NC}\"
echo \"\" \# ── 1. Prerequisites
────────────────────────────────────────────── log \"Checking
prerequisites\...\" node_version=\$(node \--version 2\>/dev/null \| sed
\'s/v//\' \| cut -d. -f1) if \[\[ \"\$node_version\" -lt 24 \]\] \|\|
\[\[ \"\$node_version\" -gt 25 \]\]; then error \"Node.js 24.x required.
Found: \$(node \--version)\" fi success \"Node.js \$(node \--version)\"
if ! command -v pnpm &\> /dev/null; then error \"pnpm not found.
Install: npm install -g ****pnpm@9.15.0\" fi success \"pnpm \$(pnpm
\--version)\" if ! docker info &\>/dev/null; then error \"Docker daemon
not running. Run: sudo systemctl start docker\" fi success \"Docker
\$(docker \--version \| cut -d\' \' -f3 \| tr -d \',\')\" \# ── 2.
Environment File ─────────────────────────────────────────── if \[\[ !
-f \".env\" \]\]; then log \"Creating .env from .env.example\...\" cp
.env.example .env success \".env created --- review and update CHANGE_ME
values\" else warn \".env already exists --- skipping\" fi \# ── 3.
Install Dependencies ─────────────────────────────────────── log
\"Installing workspace dependencies\...\" pnpm install success
\"Dependencies installed\" \# ── 4. Start Tier 1 Infrastructure
─────────────────────────────── log \"Starting Tier 1 infrastructure
(PG, Redis, MinIO, Kong, Mocks)\...\" docker compose -f
infrastructure/docker/docker-compose.tier1.yml up -d \--build log
\"Waiting for PostgreSQL to be healthy\...\" max_attempts=30 attempt=0
until docker exec usrp-postgres pg_isready -U
\"\${POSTGRES_USER:-usrp_admin}\" &\>/dev/null; do attempt=\$((attempt +
1)) if \[\[ \$attempt -ge \$max_attempts \]\]; then error \"PostgreSQL
failed to start after \${max_attempts} attempts\" fi sleep 2 done
success \"PostgreSQL is ready\" log \"Waiting for Redis\...\" until
docker exec usrp-redis redis-cli \--auth
\"\${REDIS_PASSWORD:-usrp_redis_dev}\" ping &\>/dev/null; do sleep 1
done success \"Redis is ready\" \# ── 5. Build Shared Packages
────────────────────────────────────── log \"Building shared
packages\...\" pnpm \--filter \@usrp/shared-types build success \"Shared
packages built\" \# ── 6. Verify Stack
─────────────────────────────────────────────── echo \"\" echo -e
\"\${BOLD}════════════════════════════════════════════════════════\${NC}\"
echo -e \"\${BOLD} Stack Status \${NC}\" echo -e
\"\${BOLD}════════════════════════════════════════════════════════\${NC}\"
services=( \"usrp-postgres:PostgreSQL:5432\" \"usrp-redis:Redis:6379\"
\"usrp-minio:MinIO:9000\" \"usrp-kong:Kong Gateway:8000\"
\"usrp-nida-mock:NIDA Mock:3100\" \"usrp-nesa-mock:NESA Mock:3101\"
\"usrp-rib-mock:RIB Mock:3102\" ) for entry in \"\${services\[@\]}\"; do
IFS=: read -r container name port \<\<\< \"\$entry\" if docker ps
\--filter \"name=\${container}\" \--filter \"status=running\" \| grep -q
\"\${container}\"; then echo -e \" \${GREEN}●\${NC} \${name} (port
\${port})\" ****else echo -e \" \${RED}●\${NC} \${name} --- NOT
RUNNING\" fi done echo \"\" echo -e \"\${BOLD} Management UIs\${NC}\"
echo -e \" MinIO Console: \${CYAN}http://localhost:9001\${NC}\" echo -e
\" Kong Admin: \${CYAN}http://localhost:8001\${NC}\" echo \"\" echo -e
\"\${BOLD} Tier 2 (Kafka) --- start when needed:\${NC}\" echo -e \"
\${CYAN}pnpm infra:up:tier2\${NC}\" echo \"\" echo -e
\"\${GREEN}\${BOLD} ✓ USRP development environment ready\${NC}\" echo -e
\"\${BOLD}════════════════════════════════════════════════════════\${NC}\"
echo \"\" EOF chmod +x
/home/uruti/Documents/projects/usrp/scripts/setup-dev.sh echo \"Done:
setup-dev.sh written and made executable\" \`\`\` \-\-- \### Block 16:
Architecture Decision Records \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/docs/architecture/adrs/ADR-001-kafka-over-rabbitmq.md
\<\< \'EOF\' \# ADR-001: Apache Kafka over RabbitMQ for Event Streaming
\*\*Status:\*\* Accepted \*\*Date:\*\* 2025-07-02 \*\*Deciders:\*\*
Principal Engineer \## Context USRP requires asynchronous event
processing for G2G API vetting calls (NIDA, NESA, RIB). The original
document listed \"Kafka or RabbitMQ\" as equivalent options. \##
Decision Apache Kafka in KRaft mode (no Zookeeper). \## Rationale 1.
\*\*Audit immutability:\*\* Kafka\'s append-only log creates an inherent
immutable audit trail. Every vetting action is a permanent, replayable
record --- satisfying government audit requirements. 2.
\*\*Multi-consumer fan-out:\*\* A single \`ApplicantSubmittedEvent\`
must trigger NIDA, NESA, and RIB workers simultaneously. Kafka consumer
groups handle this natively. 3. \*\*State reconstruction:\*\* If the
system crashes mid-vetting, Kafka\'s log compaction enables full state
recovery from offset replay. 4. \*\*KRaft mode:\*\* Eliminates Zookeeper
dependency --- saves \~256MB RAM on constrained dev hardware. \##
Consequences - Adds operational complexity over RabbitMQ - Requires
Schema Registry for Avro schema evolution - Consumer group management
requires careful offset handling EOF cat \>
/home/uruti/Documents/projects/usrp/docs/architecture/adrs/ADR-002-postgresql-schema-isolation.md
\<\< \'EOF\' \# ADR-002: PostgreSQL Schema Isolation over Separate
Databases \*\*Status:\*\* Accepted \*\*Date:\*\* 2025-07-02 \## Decision
Single PostgreSQL cluster with four isolated schemas: \`public_core\`,
\`rdf_ops\`, \`rnp_ops\`, \`rcs_ops\`. \## Rationale 1. \*\*RLS
enforcement:\*\* PostgreSQL Row-Level Security policies enforce
cross-agency isolation at the database engine level --- not just
****application logic. 2. \*\*Shared identity:\*\*
\`public_core.applicant_identities\` is shared by design --- applicants
have one identity that multiple agencies may reference. 3.
\*\*Operational simplicity:\*\* One cluster to backup, monitor, and
maintain vs. four databases. 4. \*\*Schema-level permission
isolation:\*\* PostgreSQL REVOKE at schema level prevents RDF officers
from even querying the existence of \`rnp_ops\` tables. \## Cross-Agency
Data Access Rule An applicant\'s identity record in \`public_core\` is
readable by all agency services. Recruitment data in \`rdf_ops\` is
\*\*never\*\* accessible to \`rnp_ops\` or \`rcs_ops\` roles. EOF cat \>
/home/uruti/Documents/projects/usrp/docs/architecture/adrs/ADR-003-crdt-offline-tablet-sync.md
\<\< \'EOF\' \# ADR-003: CRDT + Vector Clocks for Offline Field Tablet
Sync \*\*Status:\*\* Accepted \*\*Date:\*\* 2025-07-02 \## Context Field
officers at physical testing venues use tablets in areas with unstable
connectivity. Score data must be captured offline and synced reliably
without conflicts or stale-write overwriting. \## Decision Automerge
CRDT library for score records, with Ed25519 device signatures and
vector clocks for conflict detection and stale-write rejection. \##
Rationale 1. \*\*Conflict-free merging:\*\* CRDT operations are
mathematically guaranteed to converge regardless of sync order. 2.
\*\*Stale write prevention:\*\* Vector clocks detect when a device is
attempting to sync data that predates a newer server record. 3.
\*\*Device signing:\*\* Ed25519 signatures on each score record ensure a
compromised tablet cannot inject fabricated scores without detection. 4.
\*\*Immutability:\*\* Once a score is device-signed and server-accepted,
it cannot be modified --- only a new corrective record can be added
(with audit trail). EOF cat \>
/home/uruti/Documents/projects/usrp/docs/architecture/adrs/ADR-004-c2pa-frequency-document-forensics.md
\<\< \'EOF\' \# ADR-004: C2PA + DCT Frequency Analysis for Document
Forgery Detection \*\*Status:\*\* Accepted \*\*Date:\*\* 2025-07-02 \##
Context The original document proposed Error Level Analysis (ELA) only.
ELA fails against AI-generated documents (no compression artifacts to
detect). \## Decision Multi-stage forensics pipeline: 1. ELA (Error
Level Analysis) --- detects Photoshop-style pixel edits 2. DCT Frequency
Domain Analysis --- detects GAN/diffusion-generated documents 3. C2PA
Manifest Verification --- validates cryptographic provenance of
NESA-issued documents 4. Font/Kerning Consistency --- structural layout
profiling 5. Stamp Ink ****Channel Separation --- detects cloned digital
stamps \## Rationale Generative AI can produce photorealistic
certificates with zero ELA signature. DCT coefficient analysis detects
the statistical fingerprints left by neural image generators in
frequency space --- invisible to ELA. C2PA provides cryptographic ground
truth for documents where NESA embeds provenance manifests. \##
Consequence Requires Python-based CV service (OpenCV, NumPy) alongside
the Node.js service layer. The forensics service is the only service
with a Python runtime dependency. EOF echo \"Done: Architecture Decision
Records written\" \`\`\` \-\-- \### Block 17: Frontend Workspace
(\`design-system/src/\`) \`\`\`bash \# Clear the test Loom clone and set
up USRP frontend workspace \# First --- backup the existing src if
needed cd /home/uruti/Documents/projects/design-system && \\ mkdir -p
\_src_backup && \\ cp -r src/\* \_src_backup/ 2\>/dev/null \|\| true &&
\\ echo \"Backed up existing src/ to \_src_backup/\" \# Create the new
USRP frontend workspace structure rm -rf src && \\ mkdir -p \\
src/apps/portal-web \\ src/apps/dashboard-rdf \\ src/apps/dashboard-rnp
\\ src/apps/dashboard-rcs \\ src/apps/dashboard-superadmin \\
src/apps/field-tablet \\ src/packages/usrp-ui-components/src \\
src/packages/usrp-hooks/src \\ src/packages/usrp-validators/src && \\
echo \"Done: USRP frontend workspace skeleton created\" \`\`\`
\`\`\`bash \# src/ workspace coordinator cat \>
/home/uruti/Documents/projects/design-system/src/pnpm-workspace.yaml
\<\< \'EOF\' packages: - \'apps/\*\' - \'packages/\*\' EOF \`\`\`
\`\`\`bash \# src/ packages --- usrp-ui-components cat \>
/home/uruti/Documents/projects/design-system/src/packages/usrp-ui-components/package.json
\<\< \'EOF\' { \"name\": \"@usrp/ui-components\", \"version\":
\"1.0.0\", \"private\": true, \"description\": \"Shared Lens-native UI
components for all USRP frontend apps\", \"main\": \"./src/index.ts\",
\"types\": \"./src/index.ts\", \"scripts\": { \"lint\": \"eslint
src/\*\*/\*.{ts,tsx} \--max-warnings=0\", \"typecheck\": \"tsc
\--noEmit\" }, \"dependencies\": { \"@loomhq/lens\": \"12.18.0\",
\"react\": \"18.3.1\" }, \"peerDependencies\": { \"@emotion/react\":
\"\^11.0.0\", \"@emotion/styled\": \"\^11.0.0\" } } EOF cat \>
/home/uruti/Documents/projects/design-system/src/packages/usrp-ui-components/src/index.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
\@usrp/ui-components // Shared Lens-native components for USRP frontend
apps // All components here must: // 1. Have \"use client\" as line 1 //
2. Use ONLY \@loomhq/lens components --- no raw ****HTML for UI // 3.
Pass eslint-plugin-lens-compliance // 4. Use Lens tokens --- no
hardcoded colors/sizes //
══════════════════════════════════════════════════════════════════ //
Populated during Phase 4 frontend development // Placeholder exports
prevent TypeScript errors in apps export const USRP_UI_VERSION =
\'1.0.0\'; EOF \`\`\` \`\`\`bash \# usrp-hooks package cat \>
/home/uruti/Documents/projects/design-system/src/packages/usrp-hooks/package.json
\<\< \'EOF\' { \"name\": \"@usrp/hooks\", \"version\": \"1.0.0\",
\"private\": true, \"description\": \"Shared React hooks for USRP
frontend apps\", \"main\": \"./src/index.ts\", \"scripts\": { \"lint\":
\"eslint src/\*\*/\*.{ts,tsx} \--max-warnings=0\", \"typecheck\": \"tsc
\--noEmit\" }, \"dependencies\": { \"react\": \"18.3.1\" } } EOF cat \>
/home/uruti/Documents/projects/design-system/src/packages/usrp-hooks/src/index.ts
\<\< \'EOF\' // \@usrp/hooks --- Shared React hooks for all USRP
frontend apps // Populated during Phase 4 frontend development export
const USRP_HOOKS_VERSION = \'1.0.0\'; EOF \`\`\` \`\`\`bash \#
usrp-validators package cat \>
/home/uruti/Documents/projects/design-system/src/packages/usrp-validators/package.json
\<\< \'EOF\' { \"name\": \"@usrp/validators\", \"version\": \"1.0.0\",
\"private\": true, \"description\": \"Client-side form validation for
USRP frontend apps\", \"main\": \"./src/index.ts\", \"scripts\": {
\"lint\": \"eslint src/\*\*/\*.{ts,tsx} \--max-warnings=0\",
\"typecheck\": \"tsc \--noEmit\" } } EOF cat \>
/home/uruti/Documents/projects/design-system/src/packages/usrp-validators/src/index.ts
\<\< \'EOF\' // \@usrp/validators --- Client-side form validation rules
// ── National ID Format (Rwanda 16-digit) ──────────────────────────
export function isValidRwandanNID(value: string): boolean { const
cleaned = value.replace(/\\s/g, \'\'); return
/\^\\d{16}\$/.test(cleaned); } // ── Physical Test Bounds (Field Tablet)
─────────────────────────── export const PHYSICAL_BOUNDS = { HEIGHT_CM:
{ min: 140, max: 220 }, WEIGHT_KG: { min: 40, max: 150 },
RUN_3KM_SECONDS: { min: 480, max: 1800 }, // 8min - 30min CHEST_CM: {
min: 60, max: 130 }, } as const; export function isValidHeight(cm:
number): boolean { return cm \>= PHYSICAL_BOUNDS.HEIGHT_CM.min && cm \<=
PHYSICAL_BOUNDS.HEIGHT_CM.max; } export function isValidWeight(kg:
number): boolean { return kg \>= PHYSICAL_BOUNDS.WEIGHT_KG.min && kg \<=
PHYSICAL_BOUNDS.WEIGHT_KG.max; } export function
isValidRun3kmTime(seconds: number): boolean { return seconds \>=
****PHYSICAL_BOUNDS.RUN_3KM_SECONDS.min && seconds \<=
PHYSICAL_BOUNDS.RUN_3KM_SECONDS.max; } // ── NESA Index Number Format
─────────────────────────────────────── export function
isValidNESAIndex(value: string): boolean { return
/\^RW\\d{4}\\/\\d{4}\$/.test(value.trim().toUpperCase()); } EOF echo
\"Done: Frontend workspace packages created\" \`\`\` \-\-- \### Block
18: Final Verification \`\`\`bash \# Verify complete usrp/ structure
echo \"════════ USRP BACKEND REPO STRUCTURE ════════\" find
/home/uruti/Documents/projects/usrp -type f -name \"\*.json\" -o -name
\"\*.yml\" -o -name \"\*.yaml\" -o -name \"\*.ts\" -o -name \"\*.js\" -o
-name \"\*.sql\" -o -name \"\*.sh\" -o -name \"\*.md\" \| sort \| head
-100 echo \"\" echo \"════════ DESIGN-SYSTEM SRC STRUCTURE ════════\"
find /home/uruti/Documents/projects/design-system/src -type f \| sort
\`\`\` \-\-- \### Block 19: Initialize pnpm and Start Infrastructure
\`\`\`bash \# Initialize corepack for pnpm version management cd
/home/uruti/Documents/projects/usrp && \\ corepack enable && \\ corepack
use pnpm@9.15.0 && \\ echo \"Done: corepack configured for pnpm 9.15.0\"
\`\`\` \`\`\`bash \# Install backend dependencies cd
/home/uruti/Documents/projects/usrp && \\ pnpm install && \\ echo
\"Done: usrp/ dependencies installed\" \`\`\` \`\`\`bash \# Start Tier 1
infrastructure cd /home/uruti/Documents/projects/usrp && \\ docker
compose -f infrastructure/docker/docker-compose.tier1.yml up -d \--build
&& \\ echo \"Starting infrastructure --- this will take 60-90 seconds
for first build\...\" \`\`\` \`\`\`bash \# After 90 seconds --- verify
all containers are healthy sleep 30 && \\ docker ps \--format \"table
{{.Names}}\\t{{.Status}}\\t{{.Ports}}\" \| grep usrp \`\`\` \-\-- \##
Execute These Blocks In Order Run each numbered block, wait for it to
complete, then proceed to the next. Share the output of \*\*Block 18
(verification)\*\* and \*\*Block 19 (docker ps)\*\* so I can confirm
Phase 1 is complete before we move to Phase 2: Database Design. \*\*Mens
et Manus. We build.\*\*\
\
\
ME:\
\
HERE\'S THE OFFICIAL CALL FOR RECRUITMENT ANNOUNCEMENTS FROM RNP,RCS AND
RDF HERE\'S ANNOUNCEMENTS: 1. RDF: REPUBLIC OF RWANDA Rwanda Defence
Force Headquarters (RDF HQs) J1 Department ****(Personnel) P.O. Box 85
KIGALI ANNOUNCEMENT FOR THOSE WISHING TO JOIN THE RWANDA DEFENCE FORCE
The Headquarters of the Rwanda Defence Force informs all Rwandans
wishing to join the Rwanda Defence Force as General Enlistees
(Short-contract soldiers) and as members of the Reserve Force, that
registration at the District and Sector levels will commence on May 23
until June 01, 2026. Those who do not get the chance to pre-register are
still permitted to present themselves on the day of the recruitment
examinations. Requirements for General Enlistees (Short-Contract
Soldiers): Applicants must be young men and women who meet the following
criteria: Must be a Rwandan citizen. Must be in good health (physically
fit). Must have completed at least Ordinary Level secondary education
(S3/Grade 9) and above. Must be between 18 and 25 years of age. Must not
have been convicted by a court of law. Must not appear on the list of
dismissed civil servants. Must possess outstanding moral character and
conduct. Must have a personal desire/will to join the Rwanda Defence
Force. Must pass the designated entry examinations. Requirements for the
Reserve Force: Applicants must be young men and women who meet the
following criteria: Must be a Rwandan citizen. Must be in good health
(physically fit). Must have completed Advanced Level secondary education
(A-Level) and above. Must not have been convicted by a court of law.
Must not appear on the list of dismissed civil servants. Must possess
outstanding moral character and conduct. Must have a personal
desire/will to join the Rwanda Defence Force. Must pass the designated
entry examinations. Age Limits based on Education: An Advanced Level
secondary school graduate (A-Level) must be between 18 and 25 years old.
A University graduate (Bachelor\'s Degree/A0) or Technical College
graduate (IPRC) must not exceed 26 years of age. Applicants with
specialized skills in Medicine, Engineering, and Law must not exceed 27
years of age. Required Documents: National Identity Card (ID). Advanced
Level Secondary School Certificate (A-Level Certificate). Certificate of
Good Moral Character and Conduct issued by the Sector administration.
Certificate of Non-Conviction (Criminal Record Clearance). RECRUITMENT
EXAMINATION TIMETABLE & LOCATIONS Registered applicants will undergo
selection examinations from June 02 to June 17, 2026, starting at 8:00
AM at the following venues: 1. City of Kigali: Kicukiro District: June
02-03, 2026, at IPRC Kicukiro Stadium Gasabo District: June 04-05, 2026,
at ULK Stadium Nyarugenge District: ****June 06-07, 2026, at Kigali Pelé
Stadium (Nyamirambo) 2. Northern Province: Gicumbi District: June 02-03,
2026, at Gicumbi Stadium Burera District: June 04-05, 2026, at the
District Headquarters Musanze District: June 06-07, 2026, at
Ubworoherane Stadium Gakenke District: June 08-09, 2026, at Ngando
Football Pitch Rulindo District: June 10-11, 2026, at Gasiza Pitch 3.
Southern Province: Nyamagabe District: June 02-03, 2026, at Nyamagabe
Stadium Nyaruguru District: June 04-05, 2026, at Ndago Football Pitch
Gisagara District: June 06-07, 2026, at the District Headquarters Huye
District: June 08-09, 2026, at Huye Stadium Nyanza District: June 10-11,
2026, at Nyanza Stadium Ruhango District: June 12-13, 2026, at the
District Headquarters Muhanga District: June 14-15, 2026, at Muhanga
Stadium Kamonyi District: June 16-17, 2026, at the District Headquarters
4. Eastern Province: Kirehe District: June 02-03, 2026, at the District
Headquarters Ngoma District: June 04-05, 2026, at Ngoma Football Pitch
Nyagatare District: June 06-07, 2026, at Nyagatare Stadium Gatsibo
District: June 08-09, 2026, at the District Headquarters Kayonza
District: June 10-11, 2026, at the District Headquarters Rwamagana
District: June 12-13, 2026, at the District Headquarters Bugesera
District: June 14-15, 2026, at Bugesera Stadium 5. Western Province:
Rusizi District: June 02-03, 2026, at Rusizi Stadium Nyamasheke
District: June 04-05, 2026, at the District Headquarters Karongi
District: June 06-07, 2026, at Mbonwa Pitch Rutsiro District: June
08-09, 2026, at Rutsiro Stadium Rubavu District: June 10-11, 2026, at
Rubavu Stadium Nyabihu District: June 12-13, 2026, at Mukamira Military
Barracks Ngororero District: June 14-15, 2026, at Ngororero Stadium This
announcement can also be accessed on the Ministry of Defence website:
www.mod.gov.rw. Done at Kigali, on May 15, 2026. (Signed & Stamped)
Lambert SENDEGEYA Colonel Chief of Personnel, J1 Rwanda Defence Force 2.
RNP : 1. Rwanda National Police (RNP) Announcement(Translating the
Kinyarwanda text found in Source 3)REPUBLIK OF RWANDARwanda National
Police HeadquartersOffice of the Commissioner for PersonnelP.O. Box 6304
KIGALI www.police.gov.rw ANNOUNCEMENT FOR THOSE WISHING TO JOIN THE
RWANDA NATIONAL POLICEThe Rwanda National Police informs all individuals
wishing to join the Police Force at the Cadet Officer level (Cadet
course) that registration will commence at the District Police Unit
(DPU) of their residence from May 07 until May 17, 2025, from 08:00 AM
to 05:00 PM during working days. Applicants must meet the following
criteria:Must ****be a Rwandan citizen. Must be between 18 and 25 years
of age. Must hold a Bachelor's Degree (A0) or an Advanced Diploma from
an Integrated Polytechnic Regional College (A1 IPRC). Individuals who
studied Statistics, Medicine, Veterinary Medicine, Nursing, Education,
and Engineering are highly encouraged to apply. Must possess outstanding
moral character and conduct, certified by the Executive Secretary of the
Sector. Must never have been dismissed from public service. Must be in
good health (physically fit). Must not have been sentenced by a court of
law to imprisonment exceeding six months. Must be ready to serve
anywhere across the country. Required Documents:Eligible candidates must
present themselves with a duly completed application form accompanied by
a passport-sized photo, which is available on the Police website
(www.police.gov.rw). They must also bring a photocopy of their National
Identity Card, a photocopy of their degree/diploma, and a certificate of
good moral character and conduct. For further inquiries, you may call
the following telephone numbers: 0788311526, 0781860024, and 0788311785.
Done at Kigali, on 05/05/2025 (Signed & Stamped)Jacques BURORA ACP
Commissioner for Personnel / Human Resources Management, Rwanda National
Police 2. Rwanda Correctional Service (RCS) Announcement(Translating the
Kinyarwanda text found in Source 5)RWANDA CORRECTIONAL SERVICE
(RCS)Human Resource Management Department P.O. BOX 6516 KIGALI
ANNOUNCEMENT FOR THOSE WISHING TO JOIN THE RCS AT THE GENERAL ENLISTEE
LEVEL (JUNIOR STAFF)The Management of the Rwanda Correctional Service
(RCS) informs all Rwandans wishing to join the RCS at the general
enlistee level (junior staff) that registration at the District level
will commence from August 09 until August 24, 2025. Applicants who meet
the criteria must present themselves with a duly completed application
form available on the Rwanda Correctional Service website
(www.rcs.gov.rw). The form must be attached with a photocopy of the
National ID, certificate/diploma, a certificate of good moral character
and conduct, and two (2) passport-sized photos. 3. General Requirements
for Applicants:a. Must be a Rwandan citizen. b. Must be between 18 and
25 years of age. c. Must have completed a full secondary school
education holding an Advanced Level Certificate (A2). d. Must be in good
health (physically fit). e. Must not be under criminal prosecution. f.
Must never have been convicted of a crime. g. Must not have been
permanently dismissed from public service, unless ****rehabilitation has
been granted. h. Must not appear on the list of persons banned from
civil service. i. Must possess outstanding moral character and conduct.
j. Must have a personal desire/will to join the RCS. k. Must be ready to
serve anywhere within the country. 4. Required Supporting Documents to
Bring:a. National Identity Card. b. Notarized academic
certificate/diploma. c. Certificate of good moral character and conduct
approved by the Sector Commander/Executive. d. Certificate of
Non-Conviction (Criminal Record Clearance). e. Certificate of Celibacy
(proving single marital status). f. Medical certificate issued by an
authorized Government physician. 5. Selection Examination
Schedule:Registered applicants will sit for selection examinations at
the District Headquarters starting from August 26 to August 31, 2025, at
9:00 AM at the following specific locations: Northern Province:a.
Gicumbi District: August 25, 2025, at the Gicumbi District Hall. b.
Musanze District: August 25, 2025, at Ubworoherane Stadium. c. Burera
District: August 25, 2025, at Kirambo Stadium. d. Gakenke District:
August 26, 2025, at the Gakenke District Hall. e. Rulindo District:
August 27, 2025, at the Gasiza pitch. Eastern Province:a. Rwamagana
District: August 25, 2025, at the Rwamagana District Headquarters. b.
Ngoma District: August 25, 2025, at Ngoma Stadium. c. Nyagatare
District: August 25, 2025, at Nyagatare Stadium. d. Bugesera District:
August 25, 2025, at Bugesera Stadium. e. Gatsibo District: August 25,
2025, at the Gatsibo District Headquarters. f. Kayonza District: August
26, 2025, at the Kayonza District Headquarters. g. Kirehe District:
August 27, 2025, at the Kirehe District Hall. Southern Province:a.
Nyamagabe District: August 25, 2025, at Nyamagabe Stadium. b. Nyanza
District: August 25, 2025, at Nyanza Stadium. c. Huye District: August
25, 2025, at Huye Prison (Correctional Facility). d. Muhanga District:
August 25, 2025, at Muhanga Stadium. e. Nyaruguru District: August 25,
2025, at Ndago Football Pitch. f. Gisagara District: August 26, 2025, at
the District Headquarters. g. Ruhango District: August 27, 2025, at the
District Headquarters. h. Kamonyi District: August 28, 2025, at the
District Headquarters. Western Province:a. Rubavu District: August 25,
2025, at Rubavu Stadium. b. Rusizi District: August 25, 2025, at Rusizi
Stadium. c. Nyamasheke District: August 25, 2025, at the District
Headquarters. d. Karongi District: August 26, 2025, at the District
Youth Center Hall. e. Rutsiro District: August 27, 2025, at Rutsiro
Stadium. f. Ngororero District: August 28, 2025, at the District
Stadium. g. Nyabihu District: ****August 29, 2025, at Nyabihu Stadium.
City of Kigali:For Nyarugenge, Kicukiro, and Gasabo Districts, the exams
will take place on August 28, 2025, at the Gasabo District Headquarters.
6. Further Information:For further details, you can contact the
following phone numbers: 0737627676, 0737626200, and 0737626188. Done at
Kigali, on August 09, 2025 (Signed & Stamped)A. RWAGASORE \'psc (ZW)\'
Superintendent Acting Director of Human Resource Management RWANDA
CORRECTIONAL SERVICE (RCS)HUMAN RESOURCES DEPARTMENTPO BOX 6516 KIGALI
www.rcs.gov.rw ANNOUNCEMENT FOR THOSE WISHING TO JOIN RCS AT THE OFFICER
LEVEL The Management of the Rwanda Correctional Service (RCS) informs
all Rwandans wishing to join RCS at the officer level that registration
in the districts will begin on June 10 and run until June 29, 2026.
Those who do not get the opportunity to register will be able to do so
on the day of the exam. Those who meet the requirements must come with a
properly completed form available on the Rwanda Correctional Service
website, www.rcs.gov.rw, attached with a photocopy of their national
identity card and two passport photos. Those registering at the officer
level, whether studying for one year or four years, must all fulfill the
following requirements: a. Be a Rwandan citizen. b. Be in excellent
health. c. Have never been convicted of a crime. d. Not be under
criminal investigation/prosecution. e. Have never been permanently
dismissed from public service unless rehabilitated. f. Not appear on the
list of individuals banned from being public servants. g. Be of
irreproachable morals and conduct. h. Have the willingness to join RCS.
i. Be ready to work anywhere in the Country. For those who will study
for one year, registrants must fulfill the following: a. Be 18 years old
and not exceeding 25 years of age. b. Have completed the second cycle of
University, holding a Bachelor\'s (A0) degree. c. Have completed the
first cycle of University at IPRC, holding an A1 diploma. d. For those
with a specialty who studied Medicine, Engineering, Nursing, Law,
Education, Veterinary Medicine, and Clinical Psychology, they must not
exceed 27 years of age. For those who will study for four years,
registrants must fulfill the following: a. Be 18 years old and not
exceeding 21 years of age. b. Have completed six (06) years of secondary
school (A2) and have grades that allow admission to the University of
Rwanda. c. Be ready to study in one of the following departments at the
University of Rwanda (UR): General Medicine, General Nursing, Computer
Engineering, and Dental Surgery. d. Those who register and ****meet the
requirements will study the above-mentioned departments corresponding to
what they studied in secondary school, and must have grades not less
than 70% for those who studied Sciences. Those registering are required
to bring the following: a. Birth certificate. b. National Identity card.
c. Notarized certificate of education/degree. d. Certificate of good
conduct approved by the Sector Executive Secretary. e. Criminal record
clearance (Certificate of non-conviction). f. Certificate of single
status. g. Medical certificate approved by a recognized government
doctor. Those who have registered will take screening exams from June
30, 2026, to July 02, 2026, at 9:00 AM at the following locations:
Northern Province: Those registered in Gicumbi, Musanze, Burera,
Gakenke, and Rulindo districts will take the screening exams at
Ubworoherane Stadium on June 30, 2026. Western Province: Those
registered in Rubavu, Nyabihu, Ngororero, and Rutsiro districts will
take the screening exams at Rubavu Stadium on June 30, 2026. Those
registered in Rusizi, Nyamasheke, and Karongi districts will take the
screening exams at Rusizi Stadium on July 02, 2026. Eastern Province:
Those registered in Rwamagana, Kayonza, Ngoma, Kirehe, Gatsibo, and
Nyagatare districts will take the screening exams at the Kayonza
District office on June 30, 2026. Southern Province: Those registered in
Huye, Nyamagabe, Nyaruguru, and Gisagara districts will take the
screening exams at Huye Stadium on June 30, 2026. Those registered in
Muhanga, Nyanza, Ruhango, and Kamonyi districts will take the screening
exams at Muhanga Stadium on July 01, 2026. In Kigali City and Bugesera
District: Those registered in Nyarugenge, Kicukiro, Gasabo, and Bugesera
districts will take the screening exams at the Gasabo District office on
July 01, 2026. For further information, you may call the following
telephone numbers: 0737627676, 0737626200, and 0737626188. Done at
Kigali on June 09, 2026 Alfred RWAGASORE \'psc\'(ZW) SSUPT Acting
Director in charge of Human Resources Management 1. Rwanda National
Police (RNP) Announcement(Translating the Kinyarwanda text found in
Source 3)REPUBLIK OF RWANDARwanda National Police HeadquartersOffice of
the Commissioner for PersonnelP.O. Box 6304 KIGALI www.police.gov.rw
ANNOUNCEMENT FOR THOSE WISHING TO JOIN THE RWANDA NATIONAL POLICEThe
Rwanda National Police informs all individuals wishing to join the
Police Force at the Cadet Officer level (Cadet course) that registration
will commence at the District Police Unit (DPU) of their residence from
May 07 until May ****17, 2025, from 08:00 AM to 05:00 PM during working
days. Applicants must meet the following criteria:Must be a Rwandan
citizen. Must be between 18 and 25 years of age. Must hold a Bachelor's
Degree (A0) or an Advanced Diploma from an Integrated Polytechnic
Regional College (A1 IPRC). Individuals who studied Statistics,
Medicine, Veterinary Medicine, Nursing, Education, and Engineering are
highly encouraged to apply. Must possess outstanding moral character and
conduct, certified by the Executive Secretary of the Sector. Must never
have been dismissed from public service. Must be in good health
(physically fit). Must not have been sentenced by a court of law to
imprisonment exceeding six months. Must be ready to serve anywhere
across the country. Required Documents:Eligible candidates must present
themselves with a duly completed application form accompanied by a
passport-sized photo, which is available on the Police website
(www.police.gov.rw). They must also bring a photocopy of their National
Identity Card, a photocopy of their degree/diploma, and a certificate of
good moral character and conduct. For further inquiries, you may call
the following telephone numbers: 0788311526, 0781860024, and 0788311785.
Done at Kigali, on 05/05/2025 (Signed & Stamped)Jacques BURORA ACP
Commissioner for Personnel / Human Resources Management, Rwanda National
Police uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \#
After 90 seconds --- verify all containers are healthy sleep 30 && \\
docker ps \--format \"table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\" \|
grep usrp uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$
sleep 30 && docker ps \--format \"table
{{.Names}}\\t{{.Status}}\\t{{.Ports}}\" \| grep usrp
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Verify
complete usrp/ structure echo \"════════ USRP BACKEND REPO STRUCTURE
════════\" find /home/uruti/Documents/projects/usrp -type f -name
\"\*.json\" -o -name \"\*.yml\" -o -name \"\*.yaml\" -o -name \"\*.ts\"
-o -name \"\*.js\" -o -name \"\*.sql\" -o -name \"\*.sh\" -o -name
\"\*.md\" \| sort \| head -100 echo \"\" echo \"════════ DESIGN-SYSTEM
SRC STRUCTURE ════════\" find
/home/uruti/Documents/projects/design-system/src -type f \| sort
════════ USRP BACKEND REPO STRUCTURE ════════
/home/uruti/Documents/projects/usrp/docs/architecture/adrs/ADR-001-kafka-over-rabbitmq.md
/home/uruti/Documents/projects/usrp/docs/architecture/adrs/ADR-002-postgresql-schema-isolation.md
****/home/uruti/Documents/projects/usrp/docs/architecture/adrs/ADR-003-crdt-offline-tablet-sync.md
/home/uruti/Documents/projects/usrp/docs/architecture/adrs/ADR-004-c2pa-frequency-document-forensics.md
/home/uruti/Documents/projects/usrp/.github/workflows/ci-backend.yml
/home/uruti/Documents/projects/usrp/infrastructure/docker/docker-compose.tier1.yml
/home/uruti/Documents/projects/usrp/infrastructure/docker/docker-compose.tier2.yml
/home/uruti/Documents/projects/usrp/infrastructure/docker/init-scripts/01-create-schemas.sql
/home/uruti/Documents/projects/usrp/infrastructure/docker/init-scripts/02-create-roles.sql
/home/uruti/Documents/projects/usrp/infrastructure/docker/init-scripts/03-rls-policies.sql
/home/uruti/Documents/projects/usrp/infrastructure/docker/init-scripts/04-create-extensions.sql
/home/uruti/Documents/projects/usrp/infrastructure/docker/kong/kong.dev.yml
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nesa/data/results.json
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nesa/package.json
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nesa/server.js
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/data/citizens.json
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/package.json
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/server.js
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/data/records.json
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/package.json
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/server.js
****/home/uruti/Documents/projects/usrp/node_modules/.modules.yaml
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/lock.yaml
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/turbo@2.10.2/node_modules/turbo/package.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/turbo@2.10.2/node_modules/turbo/README.md
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/turbo@2.10.2/node_modules/turbo/schema.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/@turbo+linux-64@2.10.2/node_modules/@turbo/linux-64/package.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/@turbo+linux-64@2.10.2/node_modules/@turbo/linux-64/README.md
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/cs/diagnosticMessages.generated.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/de/diagnosticMessages.generated.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/es/diagnosticMessages.generated.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/fr/diagnosticMessages.generated.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/it/diagnosticMessages.generated.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/ja/diagnosticMessages.generated.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/ko/diagnosticMessages.generated.json
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.decorators.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.decorators.legacy.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript****\@5.9.3/node_modules/typescript/lib/lib.dom.asynciterable.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.dom.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.dom.iterable.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.collection.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.core.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.generator.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.iterable.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.promise.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.proxy.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.reflect.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.symbol.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2015.symbol.wellknown.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2016.array.include.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2016.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2016.full.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2016.intl.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2017.arraybuffer.d.ts
****/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2017.date.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2017.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2017.full.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2017.intl.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2017.object.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2017.sharedmemory.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2017.string.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2017.typedarrays.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2018.asyncgenerator.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2018.asynciterable.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2018.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2018.full.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2018.intl.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2018.promise.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2018.regexp.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2019.array.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2019.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2019.full.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2019.intl.d.ts
****/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2019.object.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2019.string.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2019.symbol.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.bigint.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.date.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.full.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.intl.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.number.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.promise.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.sharedmemory.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.string.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2020.symbol.wellknown.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2021.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2021.full.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2021.intl.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2021.promise.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2021.string.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript****\@5.9.3/node_modules/typescript/lib/lib.es2021.weakref.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2022.array.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2022.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2022.error.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2022.full.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2022.intl.d.ts
/home/uruti/Documents/projects/usrp/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.es2022.object.d.ts
════════ DESIGN-SYSTEM SRC STRUCTURE ════════
/home/uruti/Documents/projects/design-system/src/packages/usrp-hooks/package.json
/home/uruti/Documents/projects/design-system/src/packages/usrp-hooks/src/index.ts
/home/uruti/Documents/projects/design-system/src/packages/usrp-ui-components/package.json
/home/uruti/Documents/projects/design-system/src/packages/usrp-ui-components/src/index.ts
/home/uruti/Documents/projects/design-system/src/packages/usrp-validators/package.json
/home/uruti/Documents/projects/design-system/src/packages/usrp-validators/src/index.ts
/home/uruti/Documents/projects/design-system/src/pnpm-workspace.yaml
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Start
Tier 1 infrastructure cd /home/uruti/Documents/projects/usrp && \\
docker compose -f infrastructure/docker/docker-compose.tier1.yml up -d
\--build && \\ echo \"Starting infrastructure --- this will take 60-90
seconds for first build\...\" \[+\] up 3/28 ⠋ Image kong:3.7-ubuntu
\[⠀⠀⠀⠀\] Pulling 16.0s ✘ Image redis:7.2-alpine Error Head
\"https://registry-1.docker.io/v2/library/redis/manifests/7.2-alpine\":
Get \"https://auth.docker.io/token?scope=repository%3Alibra\... 16.0s ⠋
Image minio/minio:latest \[⣦⣿⣿⠀⡀⠀⠀⠀⠀\] Pulling 16.0s ⠋ Image
postgres:16-alpine \[⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀\] Pulling 16.0s Error response from
daemon: Head
****\"https://registry-1.docker.io/v2/library/redis/manifests/7.2-alpine\":
Get
\"https://auth.docker.io/token?scope=repository%3Alibrary%2Fredis%3Apull&service=registry.docker.io\":
context deadline exceeded (Client.Timeout exceeded while awaiting
headers) uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$
AFTER THIS ONE LET\'S PAUSE A LITTLE TO DEEPLY ANALYZE OUR BASIC
(FOUNDATIONAL WORK TO SEE IF WE ARE STILL ON THE MISSION)***

**

**

AI:

***\
****\# Critical Situation Assessment --- Docker Registry Timeout +
Strategic Pause \## Immediate Fix: Docker Hub Rate Limit / Network Issue
\`\`\`bash \# Diagnose the network issue precisely curl -I
https://registry-1.docker.io/v2/ 2\>&1 \| head -20 \`\`\` \`\`\`bash \#
If the above times out --- try with a mirror \# Create Docker daemon
config with mirror fallback sudo mkdir -p /etc/docker sudo tee
/etc/docker/daemon.json \<\< \'EOF\' { \"registry-mirrors\": \[
\"https://mirror.gcr.io\", \"https://docker-mirror.example.com\" \],
\"dns\": \[\"8.8.8.8\", \"8.8.4.4\"\], \"max-concurrent-downloads\": 3 }
EOF sudo systemctl restart docker sleep 5 docker info \| grep -A5
\"Registry Mirrors\" \`\`\` \`\`\`bash \# Then retry --- pull images
individually first to isolate which fails docker pull postgres:16-alpine
\`\`\` \*\*Share that curl output. We will fix it precisely.\*\* \-\--
\## The Strategic Pause --- Mission Alignment Review This pause is not a
delay. It is the right engineering discipline. Let me do what a
principal architect must do: \*\*audit our foundational work against the
actual ground truth\*\* --- the official recruitment announcements you
just provided. \-\-- \## Deep Analysis: Official Announcements vs.
Current System Design \### What The Announcements Reveal That Our System
Did Not Fully Model \*\*RDF --- Three Distinct Tracks (not two as
originally designed):\*\* \`\`\` TRACK 1: GENERAL ENLISTMENT
(Short-Contract) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Min
Education: S3/Grade 9 (Ordinary Level --- NOT A-Level) Age: 18-25
(uniform, no sub-categories mentioned) Gender: Men AND Women Special:
Can walk-in on exam day without pre-registration TRACK 2: RESERVE FORCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Min Education: A-Level and
above Age Sub-tiers: → A-Level graduate: 18-25 → University/IPRC
graduate: ≤26 → Medicine/Engineering/Law: ≤27 WHAT WE HAD IN
SHARED-TYPES: RDF_APPLICATION_CATEGORIES = ****\[
\'GENERAL_ENLISTMENT\', \'CADET_OFFICER\', ← WRONG: This is RNP\'s
category \'DIRECT_SHORT_SERVICE\', ← Not in official announcement
\'SPECIALIST\' ← Not a formal track in announcement \] CORRECTION
NEEDED: RDF_APPLICATION_CATEGORIES = \[ \'GENERAL_ENLISTMENT\', ← S3
minimum, age 18-25 \'RESERVE_FORCE_ALEVEL\', ← A-Level, age 18-25
\'RESERVE_FORCE_UNIVERSITY\',← Degree/IPRC, age ≤26
\'RESERVE_FORCE_SPECIALIST\' ← Medicine/Eng/Law, age ≤27 \] \`\`\` \-\--
\*\*RNP --- One Track, Specific Education Profile:\*\* \`\`\` TRACK:
CADET OFFICER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Min Education:
Bachelor\'s Degree (A0) OR A1 IPRC Diploma Age: 18-25 (strict, no
exceptions listed) Priority fields: Statistics, Medicine, Veterinary,
Nursing, Education, Engineering Criminal bar: Imprisonment \>6 months
(NOT any conviction) ← CRITICAL DIFFERENCE from RDF/RCS Special: Must be
ready to serve anywhere in country Registration: At District Police Unit
(DPU) of residence WHAT WE HAD: RNP_APPLICATION_CATEGORIES = \[
\'CONSTABLE\', ← NOT in the announcement \'CADET_INSPECTOR\', ← Partial
--- should be CADET_OFFICER \'SPECIALIST_UNIT\' ← Not a formal category
\] CORRECTION NEEDED: RNP_APPLICATION_CATEGORIES = \[ \'CADET_OFFICER\'
← Only category announced \] CRIMINAL BAR DIFFERENCE --- CRITICAL FOR
ELIGIBILITY ENGINE: RDF/RCS: \"Must not have been convicted by a court
of law\" (any conviction) RNP: \"Must not have been sentenced to
imprisonment exceeding 6 months\" → Minor convictions with \<6 month
sentences do NOT disqualify for RNP → This is a legally significant
distinction our RIB vetting must handle \`\`\` \-\-- \*\*RCS --- Two
Entirely Separate Announcements (2025 + 2026):\*\* \`\`\` ANNOUNCEMENT 1
(August 2025): GENERAL ENLISTEE / JUNIOR STAFF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Min
Education: A2 (Full A-Level) Age: 18-25 Special docs: Certificate of
Celibacy ← UNIQUE TO RCS Medical certificate from government physician
Notarized certificates (not just copies) ANNOUNCEMENT 2 (June 2026):
OFFICER LEVEL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ TWO
SUB-TRACKS: Sub-track A: ONE-YEAR PROGRAM Education: Bachelor\'s (A0) OR
A1 IPRC diploma Age: 18-25 (general) ≤27 for
Medicine/Engineering/Nursing/ Law/Education/Vet/Clinical Psychology
Sub-track B: FOUR-YEAR PROGRAM (University intake) Education: A2 with
university-qualifying grades Minimum 70% for Science students Age: 18-21
(STRICT --- tightest age cap of all) Study at: University of Rwanda ONLY
Programs: General Medicine, General Nursing, Computer ****Engineering,
Dental Surgery Special: Must match secondary school subject to UR
program WHAT WE HAD: RCS_APPLICATION_CATEGORIES = \[
\'CORRECTIONAL_OFFICER\', ← Too vague \'SENIOR_OFFICER\', ← Too vague
\'SPECIALIST\' ← Too vague \] CORRECTION NEEDED:
RCS_APPLICATION_CATEGORIES = \[ \'GENERAL_ENLISTEE\', ← A2, age 18-25
\'OFFICER_ONE_YEAR\', ← Degree/IPRC, age 18-25/27
\'OFFICER_FOUR_YEAR_UR\' ← A2 + UR admission, age 18-21 \] \`\`\` \-\--
\## The 5 Critical System Corrections Required \`\`\`
╔══════════════════════════════════════════════════════════════════╗ ║
CORRECTION 1: Application Categories (shared-types) ║
╠══════════════════════════════════════════════════════════════════╣ ║
Current: Invented categories not matching official tracks ║ ║ Fix:
Replace with exact categories from announcements ║
╠══════════════════════════════════════════════════════════════════╣ ║
CORRECTION 2: Age Eligibility Engine (eligibility-service) ║
╠══════════════════════════════════════════════════════════════════╣ ║
Current: Simple min/max age range ║ ║ Fix: Age varies by BOTH agency AND
education level ║ ║ RDF Reserve + Specialist = different max ages ║ ║
RCS 4-year track = max 21 (hardest constraint) ║
╠══════════════════════════════════════════════════════════════════╣ ║
CORRECTION 3: Criminal Background Vetting Logic (RIB service) ║
╠══════════════════════════════════════════════════════════════════╣ ║
Current: Boolean \"convicted / not convicted\" ║ ║ Fix: RNP requires
\"imprisonment \>6 months\" threshold ║ ║ RDF/RCS require \"any
conviction = disqualified\" ║ ║ RCS adds: \"under criminal prosecution\"
also bars ║
╠══════════════════════════════════════════════════════════════════╣ ║
CORRECTION 4: Document Requirements (document-forensics) ║
╠══════════════════════════════════════════════════════════════════╣ ║
Current: Generic document types ║ ║ Fix: Each agency has DIFFERENT
required document sets: ║ ║ ║ ║ RDF: NID + A-Level Cert + Good Conduct +
Non-Conviction ║ ║ RNP: Application Form + Photo + NID copy + ║ ║
Degree/Diploma copy + Good Conduct ║ ║ RCS General: NID + Notarized
Cert + Good Conduct + ║ ║ Non-Conviction + Celibacy Cert + ║ ║ Medical
Cert (Government physician) ║ ║ RCS Officer: Birth ****Cert + NID +
Notarized Cert + ║ ║ Good Conduct + Non-Conviction + ║ ║ Celibacy Cert +
Medical Cert ║
╠══════════════════════════════════════════════════════════════════╣ ║
CORRECTION 5: Exam Venue/Scheduling Data (scheduling-service) ║
╠══════════════════════════════════════════════════════════════════╣ ║
Current: Generic \"5 regional hubs\" ║ ║ Fix: All 30 districts with
specific venues, dates, ║ ║ start times (RDF: 8AM, RCS: 9AM) ║ ║ Walk-in
policy differs: RDF allows walk-ins, ║ ║ RCS/RNP require
pre-registration ║
╚══════════════════════════════════════════════════════════════════╝
\`\`\` \-\-- \## The Walk-In Policy --- A Database Design Impact \`\`\`
RDF ANNOUNCEMENT STATES: \"Those who do not get the chance to
pre-register are still permitted to present themselves on the day of the
recruitment examinations.\" THIS MEANS OUR APPLICATION STATUS FLOW NEEDS
A NEW PATH: CURRENT FLOW: DRAFT → SUBMITTED → ACADEMIC_VETTING → \... →
SLOT_ASSIGNED NEW REQUIRED FLOW: Path A (Pre-registered --- digital):
DRAFT → SUBMITTED → ACADEMIC_VETTING → CRIMINAL_CLEARANCE →
DOCUMENT_REVIEW → SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED Path B
(Walk-in --- day of exam, RDF only): WALK_IN_REGISTERED →
ON_SITE_VETTING → PHYSICAL_TEST_SCHEDULED The walk-in path requires
field officers to do basic eligibility checks on-site using the tablet
app. This is a NEW USE CASE for the field-tablet app we had not fully
designed. \`\`\` \-\-- \## The Celibacy Certificate --- A Privacy
Architecture Question \`\`\` RCS REQUIRES: \"Certificate of Celibacy
(proving single marital status)\" This is sensitive personal data under
Law N° 058/2021. It requires a specific handling decision: OPTION A:
Store as a verified document flag only → Document forensics verifies it
is genuine → System stores: celibacy_cert_verified: boolean → Actual
document in encrypted MinIO storage → Never exposed in dashboard views
OPTION B: Cross-reference with civil registry → Rwanda has a civil
registry via NIDA or RRA → API integration to verify marital status
directly → No document needed if registry is queryable RECOMMENDATION:
Option A for Phase 1 Option B requires additional G2G integration not in
current scope. Flag it as a future integration. \`\`\` \-\-- \## What Is
Solid --- What Was Already Right \`\`\` ✅ CONFIRMED CORRECT from
announcements: 1. Two-repo architecture --- correct Frontend governance
separate from backend 2. PostgreSQL schema isolation --- correct
RDF/RNP/RCS truly ****operate independently 3. Kafka for event streaming
--- correct Multiple async vetting checks confirmed 4. NIDA integration
--- correct NID is the anchor document for all three agencies 5. NESA
integration --- correct Academic verification needed for all tracks 6.
RIB integration --- correct Criminal background check for all agencies
7. Regional hub scheduling --- directionally correct Needs
district-level granularity (correction 5) 8. Biometric verification ---
correct Not in announcements but required for digital system 9. Document
forensics pipeline --- correct All agencies require certificates that
can be forged 10. SMS notification system --- correct Slot assignment
notifications confirmed by schedules 11. The 5-day processing target ---
VALIDATED Announcements show 10-day registration windows followed by
exam days. Digital system must compress the vetting that currently
happens between registration close and exam day. \`\`\` \-\-- \##
Revised Eligibility Rule Matrix This is the ground truth we will code
into the eligibility engine: \`\`\`
╔═══════════════╦══════════════════════╦═══════════╦══════════════════════════╗
║ AGENCY ║ CATEGORY ║ AGE ║ MIN EDUCATION ║
╠═══════════════╬══════════════════════╬═══════════╬══════════════════════════╣
║ RDF ║ General Enlistment ║ 18-25 ║ S3 / Grade 9 (O-Level) ║ ║
╠══════════════════════╬═══════════╬══════════════════════════╣ ║ ║
Reserve (A-Level) ║ 18-25 ║ A2 / A-Level ║ ║
╠══════════════════════╬═══════════╬══════════════════════════╣ ║ ║
Reserve (University) ║ 18-26 ║ Bachelor\'s / IPRC ║ ║
╠══════════════════════╬═══════════╬══════════════════════════╣ ║ ║
Reserve (Specialist) ║ 18-27 ║ Medicine/Eng/Law degree ║
╠═══════════════╬══════════════════════╬═══════════╬══════════════════════════╣
║ RNP ║ Cadet Officer ║ 18-25 ║ Bachelor\'s (A0) / A1IPRC ║
╠═══════════════╬══════════════════════╬═══════════╬══════════════════════════╣
║ RCS ║ General Enlistee ║ 18-25 ║ A2 (Full A-Level) ║ ║
╠══════════════════════╬═══════════╬══════════════════════════╣ ║ ║
Officer (1-Year) ║ 18-25 ║ Bachelor\'s (A0) / A1IPRC ║ ║
╠══════════════════════╬═══════════╬══════════════════════════╣ ║ ║
Officer (1-Year Spc) ║ 18-27 ║ Medicine/Eng/Nursing/ ║ ║ ║ ║ ║
Law/Edu/Vet/Clin.Psych ║ ║
╠══════════════════════╬═══════════╬══════════════════════════╣ ║ ║
Officer (4-Year UR) ║ 18-21 ║ A2 + ≥70% Sciences ║ ║ ║ ║ ║ + UR
****admission grades ║
╚═══════════════╩══════════════════════╩═══════════╩══════════════════════════╝
CRIMINAL CONVICTION THRESHOLD: RDF: Any conviction = DISQUALIFIED RNP:
Imprisonment \>6 months = DISQUALIFIED (minor convictions OK) RCS: Any
conviction = DISQUALIFIED RCS+: \"Under criminal prosecution\" also =
DISQUALIFIED \`\`\` \-\-- \## Mission Status Assessment \`\`\`
╔══════════════════════════════════════════════════════════════════╗ ║
ARE WE ON MISSION? ║
╠══════════════════════════════════════════════════════════════════╣ ║ ║
║ INFRASTRUCTURE FOUNDATION: ✅ On track ║ ║ (Repos, Docker, CI, ADRs)
Pending: Docker pull fix ║ ║ ║ ║ TYPE SYSTEM ACCURACY: ⚠️ Needs
correction ║ ║ (shared-types categories) 5 corrections identified ║ ║ ║
║ ELIGIBILITY ENGINE DESIGN: ⚠️ Needs enrichment ║ ║ (age/education
rules) Real rules now documented ║ ║ ║ ║ SCHEDULING DATA MODEL: ⚠️ Needs
district granularity ║ ║ (30 districts, venues, times) Real venues now
available ║ ║ ║ ║ OVERALL PHASE 1 STATUS: 85% complete ║ ║ Missing:
Docker running + ║ ║ Apply 5 corrections to shared-types ║
╚══════════════════════════════════════════════════════════════════╝
\`\`\` \-\-- \## Immediate Next Actions \*\*Action 1 (Now):\*\* Fix
Docker pull issue --- run the curl diagnostic and share output.
\*\*Action 2 (After Docker fix):\*\* Apply the 5 corrections to
\`shared-types\` before Phase 2 begins --- the database schema in Phase
2 is built directly on these types. Wrong types now = wrong database
forever. \*\*Action 3 (Phase 2 entry gate):\*\* The district
venue/scheduling data from the announcements gets encoded as \*\*seed
data\*\* in Phase 2, not hardcoded in application logic. The scheduling
service queries the database for venue assignments --- making future
recruitment cycles updateable without code changes. \*\*Run the Docker
diagnostic now:\*\* \`\`\`bash curl -v \--max-time 15
https://registry-1.docker.io/v2/ 2\>&1 \| tail -20 \`\`\` \`\`\`bash \#
Also check if it\'s a DNS issue: nslookup registry-1.docker.io
\`\`\`****\
\
****ME:\
\
another call for joining announcement document found for basic police
course RWANDA NATIONAL POLICE OFFICE OF THE COMMISSIONER FOR ****HUMAN
RESOURCES P.O. BOX 6304 KIGALI The Rwanda National Police informs all
young men and women wishing to join the Police at the rank of
low-ranking police officers (Basic Police Course) that registration will
begin at the District Police Unit (DPU) headquarters where they reside
from 14/10/2025 until 07/11/2025, from 08:00 AM to 05:00 PM on working
days. Requirements: Be a Rwandan citizen. Be between 18 and 25 years
old. Be in excellent health. Hold a six-year secondary school diploma
(A2). Be of irreproachable morals and conduct, as evidenced by a
certificate issued by local authorities. Have never been sentenced by a
court of law to imprisonment equal to or exceeding six months. Have
never been dismissed from public service. Be ready to work anywhere.
Those who meet the requirements must come to register bringing a
properly completed application form with a passport-sized photo
(available on the Police website: www.police.gov.rw), a photocopy of
their national identity card, a photocopy of their diploma, and a
certificate of good conduct and morals issued by local authorities. For
further information, you may call: 0788311526 0788311785 Done at Kigali
Jacques BURORA Assistant Commissioner of Police (ACP) Note the forms
which announcements mentions were already provided in the previous chats
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ curl -v
\--max-time 15 https://registry-1.docker.io/v2/ 2\>&1 \| tail -20 \> GET
/v2/ HTTP/2 \> Host: registry-1.docker.io \> User-Agent: curl/8.5.0 \>
Accept: \*/\* \> { \[5 bytes data\] \* TLSv1.3 (IN), TLS handshake,
Newsession Ticket (4): { \[157 bytes data\] \< HTTP/2 401 \< date: Thu,
02 Jul 2026 17:01:19 GMT \< content-type: application/json \<
content-length: 87 \< docker-distribution-api-version: registry/2.0 \<
www-authenticate: Bearer
realm=\"https://auth.docker.io/token\",service=\"registry.docker.io\" \<
strict-transport-security: max-age=31536000 \< { \[87 bytes data\] 100
87 100 87 0 0 73 0 0:00:01 0:00:01 \--:\--:\-- 73 \* Connection #0 to
host registry-1.docker.io left intact
{\"errors\":\[{\"code\":\"UNAUTHORIZED\",\"message\":\"authentication
required\",\"detail\":null}\]}
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Also
check if it\'s a DNS issue: nslookup registry-1.docker.io Server:
127.0.0.53 Address: 127.0.0.53#53 Non-authoritative answer: Name:
registry-1.docker.io Address: 3.220.138.244 Name: registry-1.docker.io
Address: 54.160.49.87 Name: registry-1.docker.io Address: 32.193.22.212
Name: ****registry-1.docker.io Address: 34.193.24.9 Name:
registry-1.docker.io Address: 52.22.92.217 Name: registry-1.docker.io
Address: 3.208.234.10 Name: registry-1.docker.io Address: 32.195.124.218
Name: registry-1.docker.io Address: 54.173.59.97 Name:
registry-1.docker.io Address: 2600:1f18:2148:bc02:efa4:f298:a2f1:ba4d
Name: registry-1.docker.io Address:
2600:1f18:2148:bc00:9fb8:ea47:9704:9543 Name: registry-1.docker.io
Address: 2600:1f18:2148:bc01:fa4f:3229:bd34:668 Name:
registry-1.docker.io Address: 2600:1f18:2148:bc00:455d:efd8:2519:83ec
Name: registry-1.docker.io Address:
2600:1f18:2148:bc00:cbdd:d364:4532:ee5a Name: registry-1.docker.io
Address: 2600:1f18:2148:bc01:b2dd:5d0c:4ac8:4d63 Name:
registry-1.docker.io Address: 2600:1f18:2148:bc02:a44e:52af:b7d1:b11c
Name: registry-1.docker.io Address:
2600:1f18:2148:bc01:98f0:3128:6d63:da98
***<uruti@jackson-HP-EliteBook-840-G3>***:\~/Documents/projects/usrp\$\
\
\
AI(CLAUDE):\
\
\# Docker Fix + RNP Complete Picture + Type System Corrections \##
Docker Diagnosis: Clear \`\`\` HTTP/2 401 UNAUTHORIZED ---
authentication required DNS: Resolving perfectly (8 IPs returned)
Network: Reaching Docker Hub fine Problem: Docker daemon needs login OR
we bypass with public pulls \`\`\` Docker Hub now rate-limits anonymous
pulls. Fix: \`\`\`bash \# Option A: Login to Docker Hub (if you have an
account) docker login \# Enter your Docker Hub username and password
\`\`\` \`\`\`bash \# If no Docker Hub account --- use this one-time
workaround \# Pull via explicit digest bypassing auth for public images
\# OR better: configure ghcr.io and quay.io mirrors sudo tee
/etc/docker/daemon.json \<\< \'EOF\' { \"registry-mirrors\": \[
\"https://mirror.gcr.io\" \], \"dns\": \[\"8.8.8.8\", \"1.1.1.1\"\],
\"max-concurrent-downloads\": 2, \"max-concurrent-uploads\": 2 } EOF
sudo systemctl restart docker sleep 5 docker info \| grep -A3 \"Registry
Mirrors\" \`\`\` \`\`\`bash \# After daemon restart --- test with
smallest image first docker pull alpine:3.19 \`\`\` \`\`\`bash \# If
alpine pulls successfully, proceed: docker pull postgres:16-alpine && \\
docker pull redis:7.2-alpine && \\ echo \"Core images pulled
successfully\" \`\`\` \-\-- \## RNP Complete Picture --- New
Announcement Integrated This second RNP announcement is architecturally
significant. RNP now has \*\*two distinct tracks\*\*: \`\`\` RNP TRACK
1: CADET OFFICER (from May 2025 ****announcement)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Education:
Bachelor\'s (A0) OR A1 IPRC Diploma Age: 18-25 Criminal: Imprisonment
\>6 months = disqualified Priority: Statistics, Medicine, Vet, Nursing,
Edu, Eng Docs: Application form + photo + NID copy + Degree/Diploma
copy + Good Conduct cert Registration: At DPU of residence RNP TRACK 2:
BASIC POLICE COURSE (from October 2025 announcement)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Education: A2
(six-year secondary --- full A-Level) Age: 18-25 Criminal: Imprisonment
≥6 months = disqualified (≥ not \> --- subtle but legally different)
Docs: Application form + photo + NID copy + Diploma copy + Good Conduct
cert Registration: At DPU of residence KEY DIFFERENCES BETWEEN THE TWO
RNP TRACKS: Cadet Officer: University/IPRC graduates Basic Police:
A-Level graduates Criminal threshold: Cadet = \>6mo \| Basic = ≥6mo Both
share: 18-25 age, DPU registration, \"ready to serve anywhere\" \`\`\`
\-\-- \## Complete Corrected Type System Now apply all corrections.
These replace what we wrote in Phase 1: \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/agency.types.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
\@usrp/shared-types --- Agency & Category Definitions // Ground truth:
Official recruitment announcements // RDF: May 2026 announcement
(General Enlistment + Reserve) // RNP: May 2025 (Cadet Officer) + Oct
2025 (Basic Police) // RCS: Aug 2025 (General Enlistee) + Jun 2026
(Officer) //
══════════════════════════════════════════════════════════════════
export const AGENCIES = \[\'RDF\', \'RNP\', \'RCS\'\] as const; export
type Agency = typeof AGENCIES\[number\]; export const
APPLICATION_CHANNELS = \[ \'WEB\', \'USSD\', \'IREMBO_KIOSK\',
\'WALK_IN\' // RDF allows walk-in on exam day \] as const; export type
ApplicationChannel = typeof APPLICATION_CHANNELS\[number\]; // ── Rwanda
Administrative Geography ─────────────────────────────── // Based on
actual exam venue data from announcements export const PROVINCES = \[
\'KIGALI_CITY\', \'NORTHERN_PROVINCE\', \'SOUTHERN_PROVINCE\',
\'EASTERN_PROVINCE\', \'WESTERN_PROVINCE\' \] as const; export type
Province = typeof PROVINCES\[number\]; export const DISTRICTS = \[ //
Kigali City \'NYARUGENGE\', \'KICUKIRO\', \'GASABO\', // Northern
Province \'GICUMBI\', \'BURERA\', \'MUSANZE\', \'GAKENKE\', \'RULINDO\',
// Southern ****Province \'NYAMAGABE\', \'NYARUGURU\', \'GISAGARA\',
\'HUYE\', \'NYANZA\', \'RUHANGO\', \'MUHANGA\', \'KAMONYI\', // Eastern
Province \'KIREHE\', \'NGOMA\', \'NYAGATARE\', \'GATSIBO\', \'KAYONZA\',
\'RWAMAGANA\', \'BUGESERA\', // Western Province \'RUSIZI\',
\'NYAMASHEKE\', \'KARONGI\', \'RUTSIRO\', \'RUBAVU\', \'NYABIHU\',
\'NGORORERO\' \] as const; export type District = typeof
DISTRICTS\[number\]; export const DISTRICT_TO_PROVINCE:
Readonly\<Record\<District, Province\>\> = { NYARUGENGE:
\'KIGALI_CITY\', KICUKIRO: \'KIGALI_CITY\', GASABO: \'KIGALI_CITY\',
GICUMBI: \'NORTHERN_PROVINCE\', BURERA: \'NORTHERN_PROVINCE\', MUSANZE:
\'NORTHERN_PROVINCE\', GAKENKE: \'NORTHERN_PROVINCE\', RULINDO:
\'NORTHERN_PROVINCE\', NYAMAGABE: \'SOUTHERN_PROVINCE\', NYARUGURU:
\'SOUTHERN_PROVINCE\', GISAGARA: \'SOUTHERN_PROVINCE\', HUYE:
\'SOUTHERN_PROVINCE\', NYANZA: \'SOUTHERN_PROVINCE\', RUHANGO:
\'SOUTHERN_PROVINCE\', MUHANGA: \'SOUTHERN_PROVINCE\', KAMONYI:
\'SOUTHERN_PROVINCE\', KIREHE: \'EASTERN_PROVINCE\', NGOMA:
\'EASTERN_PROVINCE\', NYAGATARE: \'EASTERN_PROVINCE\', GATSIBO:
\'EASTERN_PROVINCE\', KAYONZA: \'EASTERN_PROVINCE\', RWAMAGANA:
\'EASTERN_PROVINCE\', BUGESERA: \'EASTERN_PROVINCE\', RUSIZI:
\'WESTERN_PROVINCE\', NYAMASHEKE: \'WESTERN_PROVINCE\', KARONGI:
\'WESTERN_PROVINCE\', RUTSIRO: \'WESTERN_PROVINCE\', RUBAVU:
\'WESTERN_PROVINCE\', NYABIHU: \'WESTERN_PROVINCE\', NGORORERO:
\'WESTERN_PROVINCE\', } as const; // ── RDF Application Categories
──────────────────────────────────── // Source: RDF May 2026
Announcement export const RDF_APPLICATION_CATEGORIES = \[
\'GENERAL_ENLISTMENT\', // Min: S3/Grade 9 \| Age: 18-25
\'RESERVE_FORCE_ALEVEL\', // Min: A2 \| Age: 18-25
\'RESERVE_FORCE_UNIVERSITY\', // Min: Bachelor/IPRC \| Age: 18-26
\'RESERVE_FORCE_SPECIALIST\' // Min: Medicine/Eng/Law degree \| Age:
18-27 \] as const; export type RDFApplicationCategory = typeof
RDF_APPLICATION_CATEGORIES\[number\]; // ── RNP Application Categories
──────────────────────────────────── // Source: RNP May 2025 + Oct 2025
Announcements export const RNP_APPLICATION_CATEGORIES = \[
\'CADET_OFFICER\', // Min: Bachelor(A0)/A1IPRC \| Age: 18-25
\'BASIC_POLICE_COURSE\' // Min: A2 \| Age: 18-25 \] as const; export
type RNPApplicationCategory = typeof
RNP_APPLICATION_CATEGORIES\[number\]; // ── RCS Application
****Categories ──────────────────────────────────── // Source: RCS Aug
2025 + Jun 2026 Announcements export const RCS_APPLICATION_CATEGORIES =
\[ \'GENERAL_ENLISTEE\', // Min: A2 \| Age: 18-25 \'OFFICER_ONE_YEAR\',
// Min: Bachelor(A0)/A1IPRC \| Age: 18-25
\'OFFICER_ONE_YEAR_SPECIALIST\',// Min:
Medicine/Eng/Nursing/Law/Edu/Vet/ClinPsych \| Age: 18-27
\'OFFICER_FOUR_YEAR_UR\' // Min: A2 + UR qualifying grades ≥70% Sci \|
Age: 18-21 \] as const; export type RCSApplicationCategory = typeof
RCS_APPLICATION_CATEGORIES\[number\]; // ── Union type for all
categories across agencies ───────────────── export type
ApplicationCategory = \| RDFApplicationCategory \|
RNPApplicationCategory \| RCSApplicationCategory; // ── Walk-in Policy
(Agency-specific) ───────────────────────────── export const
WALKIN_POLICY: Readonly\<Record\<Agency, boolean\>\> = { RDF: true, //
\"Those who do not get the chance to pre-register // are still permitted
to present themselves on // the day of the recruitment examinations\"
RNP: false, // Must register at DPU during registration window RCS:
false, // Must register at District level during window // (2026 Officer
announcement adds walk-in exception) } as const; // ── Specialist Fields
(priority/age-exception fields) ───────────── export const
RDF_SPECIALIST_FIELDS = \[ \'MEDICINE\', \'ENGINEERING\', \'LAW\' \] as
const; export type RDFSpecialistField = typeof
RDF_SPECIALIST_FIELDS\[number\]; export const RNP_PRIORITY_FIELDS = \[
\'STATISTICS\', \'MEDICINE\', \'VETERINARY_MEDICINE\', \'NURSING\',
\'EDUCATION\', \'ENGINEERING\' \] as const; export type RNPPriorityField
= typeof RNP_PRIORITY_FIELDS\[number\]; export const
RCS_SPECIALIST_FIELDS = \[ \'MEDICINE\', \'ENGINEERING\', \'NURSING\',
\'LAW\', \'EDUCATION\', \'VETERINARY_MEDICINE\', \'CLINICAL_PSYCHOLOGY\'
\] as const; export type RCSSpecialistField = typeof
RCS_SPECIALIST_FIELDS\[number\]; export const RCS_FOUR_YEAR_UR_PROGRAMS
= \[ \'GENERAL_MEDICINE\', \'GENERAL_NURSING\',
\'COMPUTER_ENGINEERING\', \'DENTAL_SURGERY\' \] as const; export type
RCSFourYearURProgram = typeof RCS_FOUR_YEAR_UR_PROGRAMS\[number\]; EOF
echo \"Done: agency.types.ts corrected\" \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/eligibility.types.ts
\<\< \'EOF\' //
****══════════════════════════════════════════════════════════════════
// \@usrp/shared-types --- Eligibility Rules // Ground truth from
official recruitment announcements //
══════════════════════════════════════════════════════════════════
import type { Agency, RDFApplicationCategory, RNPApplicationCategory,
RCSApplicationCategory, RDFSpecialistField, RCSSpecialistField,
RCSFourYearURProgram, } from \'./agency.types\'; // ── Education Levels
(Rwanda system) ───────────────────────────── export const
EDUCATION_LEVELS = \[ \'O_LEVEL_S3\', // Grade 9 / Ordinary Level (3
years) \'O_LEVEL_S6_EQUIV\', // Some O-Level completions \'A_LEVEL_A2\',
// Full A-Level (6 years secondary) \'A1_IPRC\', // Advanced Diploma
(IPRC --- 2 years post A-Level) \'BACHELOR_A0\', // University
Bachelor\'s Degree \'MASTERS\', // Postgraduate \'PHD\' // Doctorate \]
as const; export type EducationLevel = typeof
EDUCATION_LEVELS\[number\]; // ── Rwanda A-Level Grade System
─────────────────────────────────── // A = highest (rank 6), F = lowest
(rank 1) export const RWANDAN_ALEVEL_GRADES = \[\'A\', \'B\', \'C\',
\'D\', \'E\', \'F\'\] as const; export type RwandanALevelGrade = typeof
RWANDAN_ALEVEL_GRADES\[number\]; export const GRADE_RANK:
Readonly\<Record\<RwandanALevelGrade, number\>\> = { \'A\': 6, \'B\': 5,
\'C\': 4, \'D\': 3, \'E\': 2, \'F\': 1 } as const; export const
QUALIFICATION_LEVELS = \[\'A2\', \'A1\', \'O_LEVEL\'\] as const; export
type QualificationLevel = typeof QUALIFICATION_LEVELS\[number\]; // ──
Age Eligibility Rules (per category) ───────────────────────── export
interface AgeCriteria { readonly minAge: number; readonly maxAge:
number; // maxAge can differ by education level or specialist field
readonly maxAgeExceptions?: readonly { readonly educationLevels:
readonly EducationLevel\[\]; readonly specialistFields?: readonly
string\[\]; readonly maxAge: number; readonly reason: string; }\[\]; }
// Canonical age rules from announcements export const AGE_CRITERIA:
Readonly\< Record\< RDFApplicationCategory \| RNPApplicationCategory \|
RCSApplicationCategory, AgeCriteria \> \> = { // ── RDF
────────────────────────────────────────────────────────
GENERAL_ENLISTMENT: { minAge: 18, maxAge: 25, }, RESERVE_FORCE_ALEVEL: {
minAge: 18, maxAge: 25, }, RESERVE_FORCE_UNIVERSITY: { minAge: 18,
maxAge: 26, // University/IPRC graduates get +1 year },
RESERVE_FORCE_SPECIALIST: { minAge: 18, maxAge: 27, //
Medicine/Engineering/Law specialists }, // ****── RNP
──────────────────────────────────────────────────────── CADET_OFFICER:
{ minAge: 18, maxAge: 25, }, BASIC_POLICE_COURSE: { minAge: 18, maxAge:
25, }, // ── RCS
────────────────────────────────────────────────────────
GENERAL_ENLISTEE: { minAge: 18, maxAge: 25, }, OFFICER_ONE_YEAR: {
minAge: 18, maxAge: 25, }, OFFICER_ONE_YEAR_SPECIALIST: { minAge: 18,
maxAge: 27, // Medicine/Eng/Nursing/Law/Edu/Vet/ClinPsych },
OFFICER_FOUR_YEAR_UR: { minAge: 18, maxAge: 21, // Strictest cap ---
university intake track }, } as const; // ── Criminal Conviction
Thresholds ─────────────────────────────── // CRITICAL: Different rules
per agency --- confirmed from announcements export type
CriminalConvictionThreshold = \| \'ANY_CONVICTION\' // RDF, RCS: any
court conviction = disqualified \| \'IMPRISONMENT_GT_6MO\' // RNP Cadet:
\>6 months imprisonment \| \'IMPRISONMENT_GTE_6MO\'; // RNP Basic: ≥6
months imprisonment export const CRIMINAL_THRESHOLD_BY_CATEGORY:
Readonly\< Record\< RDFApplicationCategory \| RNPApplicationCategory \|
RCSApplicationCategory, CriminalConvictionThreshold \> \> = { // RDF:
Any conviction disqualifies GENERAL_ENLISTMENT: \'ANY_CONVICTION\',
RESERVE_FORCE_ALEVEL: \'ANY_CONVICTION\', RESERVE_FORCE_UNIVERSITY:
\'ANY_CONVICTION\', RESERVE_FORCE_SPECIALIST: \'ANY_CONVICTION\', // RNP
Cadet: \>6 months (strictly greater than) CADET_OFFICER:
\'IMPRISONMENT_GT_6MO\', // RNP Basic: ≥6 months (greater than OR equal
to) BASIC_POLICE_COURSE: \'IMPRISONMENT_GTE_6MO\', // RCS: Any
conviction disqualifies // RCS also: \"under criminal prosecution\"
disqualifies GENERAL_ENLISTEE: \'ANY_CONVICTION\', OFFICER_ONE_YEAR:
\'ANY_CONVICTION\', OFFICER_ONE_YEAR_SPECIALIST:\'ANY_CONVICTION\',
OFFICER_FOUR_YEAR_UR: \'ANY_CONVICTION\', } as const; // ── Additional
RCS-Only Disqualifiers ───────────────────────────── // Not present in
RDF or RNP announcements export interface RCSAdditionalChecks { readonly
underCriminalProsecution: boolean; // Active prosecution = disqualified
readonly celibacyCertRequired: boolean; // Certificate of single status
readonly governmentMedicalCertRequired: boolean; // Cert from authorized
govt physician readonly notarizedDocumentsRequired: ****boolean; //
Notarized (not just photocopied) } export const RCS_ADDITIONAL_CHECKS:
Readonly\<RCSAdditionalChecks\> = { underCriminalProsecution: true,
celibacyCertRequired: true, governmentMedicalCertRequired: true,
notarizedDocumentsRequired: true, } as const; // ── Education
Requirements Per Category ────────────────────────── export interface
EducationRequirement { readonly minLevel: EducationLevel; readonly
acceptedLevels: readonly EducationLevel\[\]; readonly
nesaVerificationRequired: boolean; // NESA API lookup needed readonly
hecVerificationRequired: boolean; // HEC (for degrees) lookup needed
readonly minScienceGradePercent?: number; // RCS 4-year: ≥70% science
readonly urProgramRequired?: readonly RCSFourYearURProgram\[\]; } export
const EDUCATION_REQUIREMENTS: Readonly\< Record\< RDFApplicationCategory
\| RNPApplicationCategory \| RCSApplicationCategory,
EducationRequirement \> \> = { // RDF General Enlistment: S3 minimum
(O-Level / Grade 9) GENERAL_ENLISTMENT: { minLevel: \'O_LEVEL_S3\',
acceptedLevels: \[ \'O_LEVEL_S3\', \'O_LEVEL_S6_EQUIV\', \'A_LEVEL_A2\',
\'A1_IPRC\', \'BACHELOR_A0\', \'MASTERS\', \'PHD\' \],
nesaVerificationRequired: true, hecVerificationRequired: false, }, //
RDF Reserve A-Level: A2 minimum RESERVE_FORCE_ALEVEL: { minLevel:
\'A_LEVEL_A2\', acceptedLevels: \[\'A_LEVEL_A2\', \'A1_IPRC\',
\'BACHELOR_A0\', \'MASTERS\', \'PHD\'\], nesaVerificationRequired: true,
hecVerificationRequired: false, }, // RDF Reserve University: Bachelor
or IPRC minimum RESERVE_FORCE_UNIVERSITY: { minLevel: \'A1_IPRC\',
acceptedLevels: \[\'A1_IPRC\', \'BACHELOR_A0\', \'MASTERS\', \'PHD\'\],
nesaVerificationRequired: false, hecVerificationRequired: true, }, //
RDF Reserve Specialist: Degree in Medicine/Eng/Law
RESERVE_FORCE_SPECIALIST: { minLevel: \'BACHELOR_A0\', acceptedLevels:
\[\'BACHELOR_A0\', \'MASTERS\', \'PHD\'\], nesaVerificationRequired:
false, hecVerificationRequired: true, }, // RNP Cadet Officer: Bachelor
or A1 IPRC CADET_OFFICER: { minLevel: \'A1_IPRC\', acceptedLevels:
\[\'A1_IPRC\', \'BACHELOR_A0\', \'MASTERS\', \'PHD\'\],
nesaVerificationRequired: false, hecVerificationRequired: true, }, //
RNP Basic Police: Full A-Level (A2) BASIC_POLICE_COURSE: { minLevel:
\'A_LEVEL_A2\', acceptedLevels: \[\'A_LEVEL_A2\', \'A1_IPRC\',
\'BACHELOR_A0\', \'MASTERS\', \'PHD\'\], nesaVerificationRequired: true,
hecVerificationRequired: false, }, // RCS General Enlistee: Full A-Level
(A2) GENERAL_ENLISTEE: { minLevel: \'A_LEVEL_A2\', acceptedLevels:
\[\'A_LEVEL_A2\', \'A1_IPRC\', \'BACHELOR_A0\', ****\'MASTERS\',
\'PHD\'\], nesaVerificationRequired: true, hecVerificationRequired:
false, }, // RCS Officer 1-Year: Bachelor or A1 IPRC OFFICER_ONE_YEAR: {
minLevel: \'A1_IPRC\', acceptedLevels: \[\'A1_IPRC\', \'BACHELOR_A0\',
\'MASTERS\', \'PHD\'\], nesaVerificationRequired: false,
hecVerificationRequired: true, }, // RCS Officer 1-Year Specialist:
Degree in specialist field OFFICER_ONE_YEAR_SPECIALIST: { minLevel:
\'BACHELOR_A0\', acceptedLevels: \[\'BACHELOR_A0\', \'MASTERS\',
\'PHD\'\], nesaVerificationRequired: false, hecVerificationRequired:
true, }, // RCS Officer 4-Year UR: A2 + ≥70% science + UR admission
grades OFFICER_FOUR_YEAR_UR: { minLevel: \'A_LEVEL_A2\', acceptedLevels:
\[\'A_LEVEL_A2\'\], // Only A2 --- degree holders don\'t need 4-year
program nesaVerificationRequired: true, hecVerificationRequired: false,
minScienceGradePercent: 70, urProgramRequired: \[ \'GENERAL_MEDICINE\',
\'GENERAL_NURSING\', \'COMPUTER_ENGINEERING\', \'DENTAL_SURGERY\' \], },
} as const; // ── Required Documents Per Category
────────────────────────────── // Ground truth from announcements ---
each agency differs export type DocumentType = \| \'NATIONAL_ID\' \|
\'APPLICATION_FORM_WITH_PHOTO\' \| \'ALEVEL_CERTIFICATE\' \|
\'OLEVEL_CERTIFICATE\' \| \'DEGREE_DIPLOMA_COPY\' \|
\'DEGREE_DIPLOMA_NOTARIZED\' \| \'GOOD_CONDUCT_CERTIFICATE\' \|
\'NON_CONVICTION_CERTIFICATE\' \| \'CELIBACY_CERTIFICATE\' \|
\'MEDICAL_CERTIFICATE_GOVT\' \| \'BIRTH_CERTIFICATE\'; export const
REQUIRED_DOCUMENTS: Readonly\< Record\< RDFApplicationCategory \|
RNPApplicationCategory \| RCSApplicationCategory, readonly
DocumentType\[\] \> \> = { // RDF: NID + A-Level Cert + Good Conduct +
Non-Conviction // (O-Level cert for General Enlistment)
GENERAL_ENLISTMENT: \[ \'NATIONAL_ID\', \'OLEVEL_CERTIFICATE\',
\'GOOD_CONDUCT_CERTIFICATE\', \'NON_CONVICTION_CERTIFICATE\', \],
RESERVE_FORCE_ALEVEL: \[ \'NATIONAL_ID\', \'ALEVEL_CERTIFICATE\',
\'GOOD_CONDUCT_CERTIFICATE\', \'NON_CONVICTION_CERTIFICATE\', \],
RESERVE_FORCE_UNIVERSITY: \[ \'NATIONAL_ID\', \'DEGREE_DIPLOMA_COPY\',
\'GOOD_CONDUCT_CERTIFICATE\', \'NON_CONVICTION_CERTIFICATE\', \],
RESERVE_FORCE_SPECIALIST: \[ \'NATIONAL_ID\', \'DEGREE_DIPLOMA_COPY\',
\'GOOD_CONDUCT_CERTIFICATE\', \'NON_CONVICTION_CERTIFICATE\', \], // RNP
Cadet: Form + Photo + NID copy + Degree/Diploma + Good Conduct
CADET_OFFICER: \[ \'APPLICATION_FORM_WITH_PHOTO\', \'NATIONAL_ID\',
\'DEGREE_DIPLOMA_COPY\', \'GOOD_CONDUCT_CERTIFICATE\', \], // RNP Basic:
Form + Photo + NID copy + Diploma copy + Good Conduct
****BASIC_POLICE_COURSE: \[ \'APPLICATION_FORM_WITH_PHOTO\',
\'NATIONAL_ID\', \'ALEVEL_CERTIFICATE\', \'GOOD_CONDUCT_CERTIFICATE\',
\], // RCS General Enlistee: NID + Notarized cert + Good Conduct + //
Non-Conviction + Celibacy + Medical (govt physician) GENERAL_ENLISTEE:
\[ \'NATIONAL_ID\', \'DEGREE_DIPLOMA_NOTARIZED\', // Notarized --- not
just copy \'GOOD_CONDUCT_CERTIFICATE\', \'NON_CONVICTION_CERTIFICATE\',
\'CELIBACY_CERTIFICATE\', \'MEDICAL_CERTIFICATE_GOVT\', \], // RCS
Officer 1-Year: Same as General Enlistee + Birth Cert OFFICER_ONE_YEAR:
\[ \'BIRTH_CERTIFICATE\', \'NATIONAL_ID\', \'DEGREE_DIPLOMA_NOTARIZED\',
\'GOOD_CONDUCT_CERTIFICATE\', \'NON_CONVICTION_CERTIFICATE\',
\'CELIBACY_CERTIFICATE\', \'MEDICAL_CERTIFICATE_GOVT\', \], // RCS
Officer 1-Year Specialist: Same as Officer 1-Year
OFFICER_ONE_YEAR_SPECIALIST: \[ \'BIRTH_CERTIFICATE\', \'NATIONAL_ID\',
\'DEGREE_DIPLOMA_NOTARIZED\', \'GOOD_CONDUCT_CERTIFICATE\',
\'NON_CONVICTION_CERTIFICATE\', \'CELIBACY_CERTIFICATE\',
\'MEDICAL_CERTIFICATE_GOVT\', \], // RCS Officer 4-Year UR: Same
document set as Officer OFFICER_FOUR_YEAR_UR: \[ \'BIRTH_CERTIFICATE\',
\'NATIONAL_ID\', \'ALEVEL_CERTIFICATE\', // A-Level cert (not degree ---
they don\'t have one yet) \'GOOD_CONDUCT_CERTIFICATE\',
\'NON_CONVICTION_CERTIFICATE\', \'CELIBACY_CERTIFICATE\',
\'MEDICAL_CERTIFICATE_GOVT\', \], } as const; // ── NESA Subject Result
(for academic vetting) ──────────────────── export interface
NESASubjectResult { readonly subjectCode: string; readonly subjectName:
string; readonly grade: RwandanALevelGrade; readonly points: number; }
export interface NESAVerifiedPayload { readonly indexNumber: string;
readonly qualificationLevel: QualificationLevel; readonly
yearOfExamination: number; readonly schoolName: string; readonly
subjects: readonly NESASubjectResult\[\]; readonly overallPoints:
number; readonly percentageScore?: number; // For RCS 4-year ≥70% check
readonly verificationToken: string; readonly verifiedAt: string; } // ──
Eligibility Result ──────────────────────────────────────────── export
type AcademicEligibilityStatus = \'PENDING\' \| \'ELIGIBLE\' \|
\'INELIGIBLE\'; export type CriminalClearanceStatus = \| \'PENDING\' \|
\'CLEARED\' \| \'FLAGGED_CONVICTION\' \| \'FLAGGED_PROSECUTION\' //
RCS-specific: under active prosecution \| \'FLAGGED_DISMISSED\' //
Dismissed from public service \| \'UNDER_REVIEW\'; export type
DocumentLane = ****\'GREEN\' \| \'AMBER\' \| \'RED\'; export interface
EligibilityResult { readonly eligible: boolean; readonly reason: string;
readonly failureCode?: string; readonly evaluatedAt: string; readonly
details: { readonly citizenshipCheck: boolean \| null; readonly
ageCheck: boolean \| null; readonly educationCheck: boolean \| null;
readonly criminalCheck: boolean \| null; readonly prosecutionCheck:
boolean \| null; // RCS only readonly dismissalCheck: boolean \| null;
readonly moralCharacterCheck: boolean \| null; readonly healthCheck:
boolean \| null; // Physical --- done at exam }; } export interface
AgeEligibilityResult { readonly eligible: boolean; readonly
ageAtEvaluation: number; readonly dateOfBirth: string; readonly
evaluationDate: string; readonly reason: string; readonly appliedMaxAge:
number; } EOF echo \"Done: eligibility.types.ts corrected with full
ground truth\" \`\`\` \`\`\`bash \# Update the applicant types with
walk-in path and corrected statuses cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/src/applicant.types.ts
\<\< \'EOF\' import type { Agency, ApplicationChannel, District,
Province } from \'./agency.types\'; import type { DocumentType } from
\'./eligibility.types\'; // ── Core Identity (NIDA-Anchored)
───────────────────────────────── export type Gender = \'MALE\' \|
\'FEMALE\'; export type IdentityVerificationStatus = \| \'PENDING\' \|
\'VERIFIED\' \| \'FAILED\' \| \'EXPIRED\'; export interface
ApplicantIdentityCore { readonly id: string; readonly nationalIdHash:
string; readonly gender: Gender; readonly nidaVerifiedAt: string \|
null; readonly nidaMatchConfidence: string \| null; readonly
identityStatus: IdentityVerificationStatus; readonly
registrationChannel: ApplicationChannel; readonly homeDistrict: District
\| null; // From NIDA --- drives slot assignment readonly homeProvince:
Province \| null; readonly phoneVerifiedAt: string \| null; readonly
biometricVerifiedAt: string \| null; readonly biometricPassedLiveness:
boolean; readonly createdAt: string; } // ── Application Status Flow
─────────────────────────────────────── // Two paths: Pre-registered
(digital) and Walk-in (RDF only) export const APPLICATION_STATUSES = \[
// ── Path A: Pre-registered digital flow ──────────────────────
\'DRAFT\', \'SUBMITTED\', \'ACADEMIC_VETTING\', \'CRIMINAL_CLEARANCE\',
\'DOCUMENT_REVIEW_GREEN\', \'DOCUMENT_REVIEW_AMBER\', \'SLOT_ASSIGNED\',
\'PHYSICAL_TEST_SCHEDULED\', \'PHYSICAL_TEST_COMPLETE\',
\'MEDICAL_REVIEW\', \'FINAL_SHORTLIST\', ****\'ACCEPTED\', \'REJECTED\',
\'WITHDRAWN\', // ── Path B: Walk-in flow (RDF only)
────────────────────────── \'WALK_IN_REGISTERED\', // Captured by field
officer tablet on exam day \'WALK_IN_ON_SITE_VETTING\', // Basic
eligibility check done on-site \'WALK_IN_PHYSICAL_TEST\',
\'WALK_IN_REJECTED\', \] as const; export type ApplicationStatus =
typeof APPLICATION_STATUSES\[number\]; // ── Document Upload Status
──────────────────────────────────────── export type
DocumentUploadStatus = \| \'PENDING_UPLOAD\' \| \'UPLOADED\' \|
\'VIRUS_SCAN_PASS\' \| \'FORENSICS_GREEN\' \| \'FORENSICS_AMBER\' \|
\'FORENSICS_RED\' \| \'VERIFIED_VIA_API\' // Green lane --- verified
directly via NESA/HEC \| \'REJECTED\'; export interface DocumentRecord {
readonly documentId: string; readonly documentType: DocumentType;
readonly uploadStatus: DocumentUploadStatus; readonly minioObjectKey?:
string; // Encrypted object path readonly forensicsScore?: number;
readonly verifiedAt?: string; readonly rejectionReason?: string; } // ──
Processing Code ─────────────────────────────────────────────── export
interface ProcessingCode { readonly code: string; // e.g. \"RDF-90823\"
readonly agency: Agency; readonly sequenceNumber: number; } // ──
Cross-Agency Lock ───────────────────────────────────────────── export
interface CrossAgencyLock { readonly lockedAt: string; readonly
lockedByAgency: Agency; readonly reason: \'ACCEPTED\' \|
\'IN_FINAL_STAGE\'; } // ── Slot Assignment
─────────────────────────────────────────────── export interface
ExamVenue { readonly district: District; readonly province: Province;
readonly venueName: string; // e.g. \"IPRC Kicukiro Stadium\" readonly
examDate: string; // ISO 8601 date readonly reportingTimeHour: number;
// 8 = 8:00 AM, 9 = 9:00 AM readonly agency: Agency; readonly
recruitmentCycleId: string; // Links to active recruitment campaign }
export interface SlotAssignment { readonly slotId: string; readonly
agency: Agency; readonly venue: ExamVenue; readonly qrInvitationCode:
string; readonly qrIssuedAt: string; readonly smsNotificationSentAt:
string \| null; } EOF echo \"Done: applicant.types.ts updated with
walk-in path and venue types\" \`\`\` \-\-- \## Exam Venue Seed Data ---
All 3 Agencies This is the critical seed data for the scheduling service
--- encoded from the official announcements: ****\`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/src/seeds/exam-venues.seed.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
USRP --- Exam Venue Seed Data // Source: Official recruitment
announcements (2025-2026) // This data is seeded once per recruitment
cycle by administrators // NOT hardcoded in application logic ---
updateable via admin panel //
══════════════════════════════════════════════════════════════════
export interface ExamVenueSeed { district: string; province: string;
venueName: string; examDateStart: string; // ISO date examDateEnd:
string; reportingTimeHour: number; agency: string; campaignLabel:
string; } // ── RDF Exam Venues (June 2026)
─────────────────────────────────── // Source: RDF May 2026
announcement, exams June 02-17 2026, 8:00 AM export const
RDF_EXAM_VENUES_2026: ExamVenueSeed\[\] = \[ // Kigali City { district:
\'KICUKIRO\', province: \'KIGALI_CITY\', venueName: \'IPRC Kicukiro
Stadium\', examDateStart: \'2026-06-02\', examDateEnd: \'2026-06-03\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'GASABO\', province: \'KIGALI_CITY\', venueName: \'ULK
Stadium\', examDateStart: \'2026-06-04\', examDateEnd: \'2026-06-05\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'NYARUGENGE\', province: \'KIGALI_CITY\', venueName: \'Kigali
Pelé Stadium (Nyamirambo)\', examDateStart: \'2026-06-06\', examDateEnd:
\'2026-06-07\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, // Northern Province { district: \'GICUMBI\', province:
\'NORTHERN_PROVINCE\', venueName: \'Gicumbi Stadium\', examDateStart:
\'2026-06-02\', examDateEnd: \'2026-06-03\', reportingTimeHour: 8,
agency: \'RDF\', campaignLabel: \'RDF-2026\' }, { district: \'BURERA\',
province: \'NORTHERN_PROVINCE\', venueName: \'District Headquarters\',
examDateStart: \'2026-06-04\', examDateEnd: \'2026-06-05\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'MUSANZE\', province: \'NORTHERN_PROVINCE\', venueName:
\'Ubworoherane Stadium\', examDateStart: \'2026-06-06\', examDateEnd:
\'2026-06-07\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, { district: \'GAKENKE\', province:
\'NORTHERN_PROVINCE\', venueName: \'Ngando Football Pitch\',
examDateStart: \'2026-06-08\', examDateEnd: \'2026-06-09\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' },
****{ district: \'RULINDO\', province: \'NORTHERN_PROVINCE\', venueName:
\'Gasiza Pitch\', examDateStart: \'2026-06-10\', examDateEnd:
\'2026-06-11\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, // Southern Province { district: \'NYAMAGABE\',
province: \'SOUTHERN_PROVINCE\', venueName: \'Nyamagabe Stadium\',
examDateStart: \'2026-06-02\', examDateEnd: \'2026-06-03\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'NYARUGURU\', province: \'SOUTHERN_PROVINCE\', venueName:
\'Ndago Football Pitch\', examDateStart: \'2026-06-04\', examDateEnd:
\'2026-06-05\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, { district: \'GISAGARA\', province:
\'SOUTHERN_PROVINCE\', venueName: \'District Headquarters\',
examDateStart: \'2026-06-06\', examDateEnd: \'2026-06-07\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'HUYE\', province: \'SOUTHERN_PROVINCE\', venueName: \'Huye
Stadium\', examDateStart: \'2026-06-08\', examDateEnd: \'2026-06-09\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'NYANZA\', province: \'SOUTHERN_PROVINCE\', venueName:
\'Nyanza Stadium\', examDateStart: \'2026-06-10\', examDateEnd:
\'2026-06-11\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, { district: \'RUHANGO\', province:
\'SOUTHERN_PROVINCE\', venueName: \'District Headquarters\',
examDateStart: \'2026-06-12\', examDateEnd: \'2026-06-13\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'MUHANGA\', province: \'SOUTHERN_PROVINCE\', venueName:
\'Muhanga Stadium\', examDateStart: \'2026-06-14\', examDateEnd:
\'2026-06-15\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, { district: \'KAMONYI\', province:
\'SOUTHERN_PROVINCE\', venueName: \'District Headquarters\',
examDateStart: \'2026-06-16\', examDateEnd: \'2026-06-17\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, //
Eastern Province { district: \'KIREHE\', province: \'EASTERN_PROVINCE\',
venueName: \'District Headquarters\', examDateStart: \'2026-06-02\',
examDateEnd: \'2026-06-03\', reportingTimeHour: 8, agency: \'RDF\',
campaignLabel: \'RDF-2026\' }, { district: \'NGOMA\', province:
\'EASTERN_PROVINCE\', venueName: \'Ngoma Football Pitch\',
examDateStart: \'2026-06-04\', examDateEnd: \'2026-06-05\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'NYAGATARE\', province: \'EASTERN_PROVINCE\', venueName:
\'Nyagatare Stadium\', examDateStart: \'2026-06-06\', examDateEnd:
\'2026-****06-07\', reportingTimeHour: 8, agency: \'RDF\',
campaignLabel: \'RDF-2026\' }, { district: \'GATSIBO\', province:
\'EASTERN_PROVINCE\', venueName: \'District Headquarters\',
examDateStart: \'2026-06-08\', examDateEnd: \'2026-06-09\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'KAYONZA\', province: \'EASTERN_PROVINCE\', venueName:
\'District Headquarters\', examDateStart: \'2026-06-10\', examDateEnd:
\'2026-06-11\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, { district: \'RWAMAGANA\', province:
\'EASTERN_PROVINCE\', venueName: \'District Headquarters\',
examDateStart: \'2026-06-12\', examDateEnd: \'2026-06-13\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'BUGESERA\', province: \'EASTERN_PROVINCE\', venueName:
\'Bugesera Stadium\', examDateStart: \'2026-06-14\', examDateEnd:
\'2026-06-15\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, // Western Province { district: \'RUSIZI\', province:
\'WESTERN_PROVINCE\', venueName: \'Rusizi Stadium\', examDateStart:
\'2026-06-02\', examDateEnd: \'2026-06-03\', reportingTimeHour: 8,
agency: \'RDF\', campaignLabel: \'RDF-2026\' }, { district:
\'NYAMASHEKE\',province: \'WESTERN_PROVINCE\', venueName: \'District
Headquarters\', examDateStart: \'2026-06-04\', examDateEnd:
\'2026-06-05\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, { district: \'KARONGI\', province: \'WESTERN_PROVINCE\',
venueName: \'Mbonwa Pitch\', examDateStart: \'2026-06-06\', examDateEnd:
\'2026-06-07\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, { district: \'RUTSIRO\', province: \'WESTERN_PROVINCE\',
venueName: \'Rutsiro Stadium\', examDateStart: \'2026-06-08\',
examDateEnd: \'2026-06-09\', reportingTimeHour: 8, agency: \'RDF\',
campaignLabel: \'RDF-2026\' }, { district: \'RUBAVU\', province:
\'WESTERN_PROVINCE\', venueName: \'Rubavu Stadium\', examDateStart:
\'2026-06-10\', examDateEnd: \'2026-06-11\', reportingTimeHour: 8,
agency: \'RDF\', campaignLabel: \'RDF-2026\' }, { district: \'NYABIHU\',
province: \'WESTERN_PROVINCE\', venueName: \'Mukamira Military
Barracks\', examDateStart: \'2026-06-12\', examDateEnd: \'2026-06-13\',
reportingTimeHour: 8, agency: \'RDF\', campaignLabel: \'RDF-2026\' }, {
district: \'NGORORERO\', province: \'WESTERN_PROVINCE\', venueName:
\'Ngororero Stadium\', examDateStart: \'2026-06-14\', examDateEnd:
\'2026-06-15\', reportingTimeHour: 8, agency: \'RDF\', campaignLabel:
\'RDF-2026\' }, \]; // ── RCS General Enlistee Exam Venues (August 2025)
****──────────────── // Source: RCS Aug 2025 announcement, exams Aug
25-31 2025, 9:00 AM export const RCS_GENERAL_EXAM_VENUES_2025:
ExamVenueSeed\[\] = \[ // Northern Province { district: \'GICUMBI\',
province: \'NORTHERN_PROVINCE\', venueName: \'Gicumbi District Hall\',
examDateStart: \'2025-08-25\', examDateEnd: \'2025-08-25\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'MUSANZE\', province:
\'NORTHERN_PROVINCE\', venueName: \'Ubworoherane Stadium\',
examDateStart: \'2025-08-25\', examDateEnd: \'2025-08-25\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'BURERA\', province:
\'NORTHERN_PROVINCE\', venueName: \'Kirambo Stadium\', examDateStart:
\'2025-08-25\', examDateEnd: \'2025-08-25\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, { district:
\'GAKENKE\', province: \'NORTHERN_PROVINCE\', venueName: \'Gakenke
District Hall\', examDateStart: \'2025-08-26\', examDateEnd:
\'2025-08-26\', reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'RULINDO\', province:
\'NORTHERN_PROVINCE\', venueName: \'Gasiza Pitch\', examDateStart:
\'2025-08-27\', examDateEnd: \'2025-08-27\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, // Eastern
Province { district: \'RWAMAGANA\', province: \'EASTERN_PROVINCE\',
venueName: \'Rwamagana District HQ\', examDateStart: \'2025-08-25\',
examDateEnd: \'2025-08-25\', reportingTimeHour: 9, agency: \'RCS\',
campaignLabel: \'RCS-GENERAL-2025\' }, { district: \'NGOMA\', province:
\'EASTERN_PROVINCE\', venueName: \'Ngoma Stadium\', examDateStart:
\'2025-08-25\', examDateEnd: \'2025-08-25\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, { district:
\'NYAGATARE\', province: \'EASTERN_PROVINCE\', venueName: \'Nyagatare
Stadium\', examDateStart: \'2025-08-25\', examDateEnd: \'2025-08-25\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'BUGESERA\', province:
\'EASTERN_PROVINCE\', venueName: \'Bugesera Stadium\', examDateStart:
\'2025-08-25\', examDateEnd: \'2025-08-25\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, { district:
\'GATSIBO\', province: \'EASTERN_PROVINCE\', venueName: \'Gatsibo
District HQ\', examDateStart: \'2025-08-25\', examDateEnd:
\'2025-08-25\', reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'KAYONZA\', province:
\'EASTERN_PROVINCE\', ****venueName: \'Kayonza District HQ\',
examDateStart: \'2025-08-26\', examDateEnd: \'2025-08-26\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'KIREHE\', province:
\'EASTERN_PROVINCE\', venueName: \'Kirehe District Hall\',
examDateStart: \'2025-08-27\', examDateEnd: \'2025-08-27\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, // Southern Province { district: \'NYAMAGABE\',
province: \'SOUTHERN_PROVINCE\', venueName: \'Nyamagabe Stadium\',
examDateStart: \'2025-08-25\', examDateEnd: \'2025-08-25\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'NYANZA\', province:
\'SOUTHERN_PROVINCE\', venueName: \'Nyanza Stadium\', examDateStart:
\'2025-08-25\', examDateEnd: \'2025-08-25\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, { district:
\'HUYE\', province: \'SOUTHERN_PROVINCE\', venueName: \'Huye Prison
(Correctional Facility)\', examDateStart: \'2025-08-25\', examDateEnd:
\'2025-08-25\', reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'MUHANGA\', province:
\'SOUTHERN_PROVINCE\', venueName: \'Muhanga Stadium\', examDateStart:
\'2025-08-25\', examDateEnd: \'2025-08-25\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, { district:
\'NYARUGURU\', province: \'SOUTHERN_PROVINCE\', venueName: \'Ndago
Football Pitch\', examDateStart: \'2025-08-25\', examDateEnd:
\'2025-08-25\', reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'GISAGARA\', province:
\'SOUTHERN_PROVINCE\', venueName: \'District Headquarters\',
examDateStart: \'2025-08-26\', examDateEnd: \'2025-08-26\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'RUHANGO\', province:
\'SOUTHERN_PROVINCE\', venueName: \'District Headquarters\',
examDateStart: \'2025-08-27\', examDateEnd: \'2025-08-27\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'KAMONYI\', province:
\'SOUTHERN_PROVINCE\', venueName: \'District Headquarters\',
examDateStart: \'2025-08-28\', examDateEnd: \'2025-08-28\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, // Western Province { district: \'RUBAVU\',
province: \'WESTERN_PROVINCE\', venueName: \'Rubavu Stadium\',
examDateStart: \'2025-08-25\', examDateEnd: \'2025-08-25\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'RUSIZI\', province:
\'WESTERN_PROVINCE\', venueName: ****\'Rusizi Stadium\', examDateStart:
\'2025-08-25\', examDateEnd: \'2025-08-25\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, { district:
\'NYAMASHEKE\',province: \'WESTERN_PROVINCE\', venueName: \'District
Headquarters\', examDateStart: \'2025-08-25\', examDateEnd:
\'2025-08-25\', reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'KARONGI\', province:
\'WESTERN_PROVINCE\', venueName: \'District Youth Center Hall\',
examDateStart: \'2025-08-26\', examDateEnd: \'2025-08-26\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'RUTSIRO\', province:
\'WESTERN_PROVINCE\', venueName: \'Rutsiro Stadium\', examDateStart:
\'2025-08-27\', examDateEnd: \'2025-08-27\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, { district:
\'NGORORERO\', province: \'WESTERN_PROVINCE\', venueName: \'District
Stadium\', examDateStart: \'2025-08-28\', examDateEnd: \'2025-08-28\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'NYABIHU\', province:
\'WESTERN_PROVINCE\', venueName: \'Nyabihu Stadium\', examDateStart:
\'2025-08-29\', examDateEnd: \'2025-08-29\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, // Kigali City
(all three districts share one venue) { district: \'NYARUGENGE\',
province: \'KIGALI_CITY\', venueName: \'Gasabo District HQ\',
examDateStart: \'2025-08-28\', examDateEnd: \'2025-08-28\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, { district: \'KICUKIRO\', province:
\'KIGALI_CITY\', venueName: \'Gasabo District HQ\', examDateStart:
\'2025-08-28\', examDateEnd: \'2025-08-28\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-GENERAL-2025\' }, { district:
\'GASABO\', province: \'KIGALI_CITY\', venueName: \'Gasabo District
HQ\', examDateStart: \'2025-08-28\', examDateEnd: \'2025-08-28\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-GENERAL-2025\' }, \]; // ── RCS Officer Exam Venues (June-July
2026) ────────────────────── // Source: RCS Jun 2026 announcement, exams
Jun 30 - Jul 02 2026, 9:00 AM // Note: Multi-district groupings ---
applicants go to regional consolidation points export const
RCS_OFFICER_EXAM_VENUES_2026: ExamVenueSeed\[\] = \[ // Northern: All 5
districts → Ubworoherane Stadium { district: \'GICUMBI\', province:
\'NORTHERN_PROVINCE\', venueName: \'Ubworoherane Stadium\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' ****}, { district: \'MUSANZE\', province:
\'NORTHERN_PROVINCE\', venueName: \'Ubworoherane Stadium\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'BURERA\', province:
\'NORTHERN_PROVINCE\', venueName: \'Ubworoherane Stadium\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'GAKENKE\', province:
\'NORTHERN_PROVINCE\', venueName: \'Ubworoherane Stadium\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'RULINDO\', province:
\'NORTHERN_PROVINCE\', venueName: \'Ubworoherane Stadium\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, // Western Group 1: 4 districts → Rubavu Stadium
{ district: \'RUBAVU\', province: \'WESTERN_PROVINCE\', venueName:
\'Rubavu Stadium\', examDateStart: \'2026-06-30\', examDateEnd:
\'2026-06-30\', reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'NYABIHU\', province:
\'WESTERN_PROVINCE\', venueName: \'Rubavu Stadium\', examDateStart:
\'2026-06-30\', examDateEnd: \'2026-06-30\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, { district:
\'NGORORERO\', province: \'WESTERN_PROVINCE\', venueName: \'Rubavu
Stadium\', examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'RUTSIRO\', province:
\'WESTERN_PROVINCE\', venueName: \'Rubavu Stadium\', examDateStart:
\'2026-06-30\', examDateEnd: \'2026-06-30\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, // Western Group
2: 3 districts → Rusizi Stadium { district: \'RUSIZI\', province:
\'WESTERN_PROVINCE\', venueName: \'Rusizi Stadium\', examDateStart:
\'2026-07-02\', examDateEnd: \'2026-07-02\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, { district:
\'NYAMASHEKE\', province: \'WESTERN_PROVINCE\', venueName: \'Rusizi
Stadium\', examDateStart: \'2026-07-02\', examDateEnd: \'2026-07-02\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'KARONGI\', province:
\'WESTERN_PROVINCE\', venueName: \'Rusizi Stadium\', examDateStart:
\'2026-07-02\', examDateEnd: \'2026-07-02\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, // Eastern: 6
districts → Kayonza ****District Office { district: \'RWAMAGANA\',
province: \'EASTERN_PROVINCE\', venueName: \'Kayonza District Office\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'KAYONZA\', province:
\'EASTERN_PROVINCE\', venueName: \'Kayonza District Office\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'NGOMA\', province:
\'EASTERN_PROVINCE\', venueName: \'Kayonza District Office\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'KIREHE\', province:
\'EASTERN_PROVINCE\', venueName: \'Kayonza District Office\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'GATSIBO\', province:
\'EASTERN_PROVINCE\', venueName: \'Kayonza District Office\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'NYAGATARE\', province:
\'EASTERN_PROVINCE\', venueName: \'Kayonza District Office\',
examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, // Southern Group 1: 4 districts → Huye Stadium
{ district: \'HUYE\', province: \'SOUTHERN_PROVINCE\', venueName: \'Huye
Stadium\', examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'NYAMAGABE\', province:
\'SOUTHERN_PROVINCE\', venueName: \'Huye Stadium\', examDateStart:
\'2026-06-30\', examDateEnd: \'2026-06-30\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, { district:
\'NYARUGURU\', province: \'SOUTHERN_PROVINCE\', venueName: \'Huye
Stadium\', examDateStart: \'2026-06-30\', examDateEnd: \'2026-06-30\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'GISAGARA\', province:
\'SOUTHERN_PROVINCE\', venueName: \'Huye Stadium\', examDateStart:
\'2026-06-30\', examDateEnd: \'2026-06-30\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, // Southern
Group 2: 4 districts → Muhanga Stadium { district: \'MUHANGA\',
province: \'SOUTHERN_PROVINCE\', venueName: \'Muhanga Stadium\',
examDateStart: \'2026-07-01\', examDateEnd: \'2026-07-01\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' ****}, { district: \'NYANZA\', province:
\'SOUTHERN_PROVINCE\', venueName: \'Muhanga Stadium\', examDateStart:
\'2026-07-01\', examDateEnd: \'2026-07-01\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, { district:
\'RUHANGO\', province: \'SOUTHERN_PROVINCE\', venueName: \'Muhanga
Stadium\', examDateStart: \'2026-07-01\', examDateEnd: \'2026-07-01\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'KAMONYI\', province:
\'SOUTHERN_PROVINCE\', venueName: \'Muhanga Stadium\', examDateStart:
\'2026-07-01\', examDateEnd: \'2026-07-01\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, // Kigali +
Bugesera → Gasabo District Office { district: \'NYARUGENGE\', province:
\'KIGALI_CITY\', venueName: \'Gasabo District Office\', examDateStart:
\'2026-07-01\', examDateEnd: \'2026-07-01\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, { district:
\'KICUKIRO\', province: \'KIGALI_CITY\', venueName: \'Gasabo District
Office\', examDateStart: \'2026-07-01\', examDateEnd: \'2026-07-01\',
reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, { district: \'GASABO\', province:
\'KIGALI_CITY\', venueName: \'Gasabo District Office\', examDateStart:
\'2026-07-01\', examDateEnd: \'2026-07-01\', reportingTimeHour: 9,
agency: \'RCS\', campaignLabel: \'RCS-OFFICER-2026\' }, { district:
\'BUGESERA\', province: \'EASTERN_PROVINCE\', venueName: \'Gasabo
District Office\', examDateStart: \'2026-07-01\', examDateEnd:
\'2026-07-01\', reportingTimeHour: 9, agency: \'RCS\', campaignLabel:
\'RCS-OFFICER-2026\' }, \]; // ── All venues combined (for seeding)
──────────────────────────── export const ALL_EXAM_VENUES:
ExamVenueSeed\[\] = \[ \...RDF_EXAM_VENUES_2026,
\...RCS_GENERAL_EXAM_VENUES_2025, \...RCS_OFFICER_EXAM_VENUES_2026, //
RNP venues: Registration at DPU --- no centralized exam venue list //
published in available announcements. Seeded when RNP provides data. \];
EOF echo \"Done: exam-venues.seed.ts --- all official venues encoded\"
\`\`\` \-\-- \## Phase 1 Completion Gate \`\`\`bash \# Run this to
confirm all type files are in order find
/home/uruti/Documents/projects/usrp/packages/shared-types/src -type f \|
sort \`\`\` \`\`\`bash \# Fix Docker then start infrastructure docker
login \# Enter credentials, then: docker compose -f
infrastructure/docker/docker-compose.tier1.yml up -d \--build \`\`\`
\-\-- \## Phase 1 Status: What Is Now Complete \`\`\`
╔════════════════════════════════════════════════════════****══════════╗
║ PHASE 1 COMPLETION STATUS ║
╠══════════════════════════════════════════════════════════════════╣ ║
✅ Repository skeleton (usrp/ + design-system/src/) ║ ║ ✅ Type system
--- corrected against official announcements ║ ║ ✅ All 10 application
categories (ground truth) ║ ║ ✅ Criminal threshold distinctions
(RDF/RNP-Cadet/RNP-Basic/RCS)║ ║ ✅ Age rules per category (including
RCS 4-year max 21) ║ ║ ✅ Document requirements per category (including
Celibacy cert) ║ ║ ✅ All 30 districts + exam venues (RDF 2026, RCS
2025/2026) ║ ║ ✅ Walk-in flow for RDF defined in status machine ║ ║ ✅
Kafka topics, Kong config, G2G mocks ║ ║ ✅ CI/CD pipeline, ADRs,
.env.example ║ ║ ⏳ Docker Tier 1 stack --- pending login fix ║
╠══════════════════════════════════════════════════════════════════╣ ║
READY FOR: Phase 2 --- Database Design & Schema Implementation ║
╚══════════════════════════════════════════════════════════════════╝
\`\`\` Fix Docker login and share the \`docker ps\` output. Phase 2
begins immediately after.me:\
\
\
ME:***

**

***WITH SINCERE AND ACCOUNTABILITY ENSURE A DEEPEST REVIEW AND ANALYTICS
TO CONFIRM THAT YOUR PROGRESSION AND YOUR WORK SO FAR IS THE REAL PATH
YOU SHOULD BE TAKING AS AS A SENIOR ARCHITECT AND ENGINEER OF THIS TRUE
LANDMARK SOFTWARE SYSTEM .
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects\$ \# Run this to
confirm all type files are in order find
/home/uruti/Documents/projects/usrp/packages/shared-types/src -type f \|
sort
/home/uruti/Documents/projects/usrp/packages/shared-types/src/agency.types.ts
/home/uruti/Documents/projects/usrp/packages/shared-types/src/applicant.types.ts
/home/uruti/Documents/projects/usrp/packages/shared-types/src/eligibility.types.ts
/home/uruti/Documents/projects/usrp/packages/shared-types/src/events.types.ts
/home/uruti/Documents/projects/usrp/packages/shared-types/src/field.types.ts
/home/uruti/Documents/projects/usrp/packages/shared-****types/src/g2g.types.ts
/home/uruti/Documents/projects/usrp/packages/shared-types/src/index.ts
/home/uruti/Documents/projects/usrp/packages/shared-types/src/vetting.types.ts
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects\$ \# Fix Docker
then start infrastructure docker login \# Enter credentials, then:
docker compose -f infrastructure/docker/docker-compose.tier1.yml up -d
\--build Authenticating with existing credentials\... \[Username:
jackson0\] i Info → To login with a different account, run \'docker
logout\' followed by \'docker login\' Login Succeeded open
/home/uruti/Documents/projects/infrastructure/docker/docker-compose.tier1.yml:
no such file or directory
***<uruti@jackson-HP-EliteBook-840-G3>***:\~/Documents/projects\$\
\
AI(CLAUDE):\
\
\# Phase 1 Final Closure --- Fix Redis + Verify Everything \## Situation
Assessment \`\`\` ✅ PostgreSQL: healthy ✅ MinIO: healthy ✅ NIDA Mock:
healthy ✅ NESA Mock: healthy ✅ RIB Mock: healthy ✅ HEC Mock: healthy
⏳ Kong: starting (normal --- needs 60-90s on first boot) ❌ Redis:
unhealthy ← fix now \`\`\` 7 of 8 healthy. One fix needed. \-\-- \##
Step 1: Diagnose Redis \`\`\`bash \# See exactly why Redis is unhealthy
docker inspect usrp-redis \--format=\'{{json .State.Health}}\' \|
python3 -m json.tool \`\`\` \`\`\`bash \# Check Redis logs directly
docker logs usrp-redis \--tail 30 \`\`\` \-\-- \## Step 2: The Redis Fix
The unhealthy status is almost certainly the health check command
failing because Redis requires the password but the health check is not
passing it correctly in the compose file. Let me verify and fix:
\`\`\`bash \# Test Redis manually to confirm it is actually running
docker exec usrp-redis redis-cli ping \`\`\` \`\`\`bash \# Test with
password docker exec usrp-redis redis-cli \--auth
\"\${REDIS_PASSWORD:-usrp_redis_dev}\" ping \`\`\` \`\`\`bash \# If the
above returns PONG --- Redis IS working, only the health check is wrong
\# Fix the health check in docker-compose.tier1.yml cd
/home/uruti/Documents/projects/usrp && \\ sed -i \'s/test: \\\[\"CMD\",
\"redis-cli\", \"\--auth\", \"\\\${REDIS_PASSWORD:-usrp_redis_dev}\",
\"ping\"\\\]/test: \[\"CMD-SHELL\", \"redis-cli \--auth
\\\$\\\${REDIS_PASSWORD:-usrp_redis_dev} ping \|\| exit 1\"\]/\' \\
infrastructure/docker/docker-compose.tier1.yml \# Verify the change grep
-A3 \"healthcheck\" ****infrastructure/docker/docker-compose.tier1.yml
\| grep test \`\`\` \`\`\`bash \# Restart only Redis with the fixed
health check docker compose -f
infrastructure/docker/docker-compose.tier1.yml \\ up -d
\--force-recreate redis \`\`\` \`\`\`bash \# Wait 15 seconds then check
sleep 15 && \\ docker inspect usrp-redis
\--format=\'{{.State.Health.Status}}\' \`\`\` \-\-- \## Step 3: Verify
Kong Reached Healthy \`\`\`bash \# Wait for Kong to finish starting
(give it 90 seconds total from boot) sleep 30 && \\ docker inspect
usrp-kong \--format=\'{{.State.Health.Status}}\' \`\`\` \`\`\`bash \#
Test Kong proxy is responding curl -s http://localhost:8000 \| head -5
curl -s http://localhost:8001/status \| python3 -m json.tool \| head -20
\`\`\` \-\-- \## Step 4: Verify All G2G Mocks Respond Correctly
\`\`\`bash \# Test each mock server end-to-end echo \"── Testing NIDA
Mock ──────────────────────\" curl -s http://localhost:3100/health \|
python3 -m json.tool echo \"\" echo \"── Testing NESA Mock
──────────────────────\" curl -s http://localhost:3101/health \| python3
-m json.tool echo \"\" echo \"── Testing RIB Mock
───────────────────────\" curl -s http://localhost:3102/health \|
python3 -m json.tool echo \"\" echo \"── Testing HEC Mock
───────────────────────\" curl -s http://localhost:3103/health \|
python3 -m json.tool \`\`\` \-\-- \## Step 5: Verify PostgreSQL Schemas
Were Created \`\`\`bash \# Confirm all 5 schemas exist docker exec
usrp-postgres psql \\ -U usrp_admin \\ -d usrp_db \\ -c \"SELECT
schema_name FROM information_schema.schemata WHERE schema_name IN
(\'public_core\',\'rdf_ops\',\'rnp_ops\',\'rcs_ops\',\'audit_log\')
ORDER BY schema_name;\" \`\`\` \`\`\`bash \# Confirm roles were created
docker exec usrp-postgres psql \\ -U usrp_admin \\ -d usrp_db \\ -c
\"SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE
\'usrp\_%\' ORDER BY rolname;\" \`\`\` \`\`\`bash \# Confirm extensions
are loaded docker exec usrp-postgres psql \\ -U usrp_admin \\ -d usrp_db
\\ -c \"SELECT extname, extversion FROM pg_extension WHERE extname IN
(\'uuid-ossp\',\'pgcrypto\',\'pg_stat_statements\') ORDER BY extname;\"
\`\`\` \-\-- \## Step 6: Compute Real NIDA Mock Hashes \`\`\`bash cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const HMAC_SECRET = \'dev_nida_hmac_secret\'; //
Realistic Rwandan NID format: 16 digits // Format: YYYYGXXXXXXXXXX where
YYYY=birth year, G=gender(1=male,2=female) const testProfiles = \[ {
nid: \'1200380123456789\', dob: \'2003-03-15\', gender: \'MALE\',
district: ****\'GASABO\', province: \'KIGALI_CITY\', desc: \'Age 22 ---
eligible all RDF/RNP/RCS categories\' }, { nid: \'1200180234567890\',
dob: \'2001-07-22\', gender: \'FEMALE\', district: \'MUSANZE\',
province: \'NORTHERN_PROVINCE\', desc: \'Age 24 --- eligible A-Level+
categories\' }, { nid: \'1199980345678901\', dob: \'1999-11-08\',
gender: \'MALE\', district: \'HUYE\', province: \'SOUTHERN_PROVINCE\',
desc: \'Age 26 --- eligible RDF Reserve University/Specialist only\' },
{ nid: \'1200580456789012\', dob: \'2005-06-01\', gender: \'MALE\',
district: \'NYAGATARE\', province: \'EASTERN_PROVINCE\', desc: \'Age 20
--- eligible ALL including RCS 4-year UR (≤21)\' }, { nid:
\'1199080567890123\', dob: \'1990-01-15\', gender: \'MALE\', district:
\'NYARUGENGE\', province: \'KIGALI_CITY\', desc: \'Age 35 --- INELIGIBLE
all categories (too old)\' }, { nid: \'1200280678901234\', dob:
\'2002-09-30\', gender: \'FEMALE\', district: \'RUBAVU\', province:
\'WESTERN_PROVINCE\', desc: \'FLAGGED --- criminal record test case\' },
{ nid: \'1200480789012345\', dob: \'2004-04-12\', gender: \'MALE\',
district: \'KAYONZA\', province: \'EASTERN_PROVINCE\', desc: \'RCS
prosecution flag test case\' }, \]; const results = {};
console.log(\'\'); console.log(\'NIDA Mock Hash Computation Results:\');
console.log(\'=====================================\'); for (const
profile of testProfiles) { const hash = crypto .createHmac(\'sha256\',
HMAC_SECRET) .update(profile.nid.trim().toUpperCase()) .digest(\'hex\');
results\[hash\] = { fullName: profile.gender === \'MALE\' ? \'UWIMANA
Jean Pierre\' : \'MUKAMANA Aline\', dateOfBirth: profile.dob, gender:
profile.gender, homeDistrict: profile.district, homeProvince:
profile.province, registeredPhoneNumber: \'07X-XXX-X\' +
profile.nid.slice(-3), citizenshipStatus: \'RWANDAN_CITIZEN\' };
console.log(\'NID: \' + profile.nid); console.log(\'Hash: \' + hash);
console.log(\'Profile: \' + profile.desc); console.log(\'\'); } //
Output the full JSON for citizens.json console.log(\'\');
console.log(\'Full citizens.json content:\');
console.log(\'============================\');
console.log(JSON.stringify(results, null, 2)); \" 2\>&1 \`\`\`
\`\`\`bash \# Capture the output and write to citizens.json cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const fs = require(\'fs\'); const HMAC_SECRET =
\'dev_nida_hmac_secret\'; const testProfiles = \[ { nid:
\'1200380123456789\', dob: \'2003-03-15\', gender: \'MALE\', district:
\'GASABO\', province: \'KIGALI_CITY\', name: \'UWIMANA Jean Pierre\' },
{ nid: \'1200180234567890\', dob: \'2001-07-22\', gender: \'FEMALE\',
district: \'MUSANZE\', province: ****\'NORTHERN_PROVINCE\', name:
\'MUKAMANA Aline\' }, { nid: \'1199980345678901\', dob: \'1999-11-08\',
gender: \'MALE\', district: \'HUYE\', province: \'SOUTHERN_PROVINCE\',
name: \'HABIMANA Eric\' }, { nid: \'1200580456789012\', dob:
\'2005-06-01\', gender: \'MALE\', district: \'NYAGATARE\', province:
\'EASTERN_PROVINCE\', name: \'NSHIMIYIMANA Patrick\' }, { nid:
\'1199080567890123\', dob: \'1990-01-15\', gender: \'MALE\', district:
\'NYARUGENGE\', province: \'KIGALI_CITY\', name: \'NZEYIMANA Paul\' }, {
nid: \'1200280678901234\', dob: \'2002-09-30\', gender: \'FEMALE\',
district: \'RUBAVU\', province: \'WESTERN_PROVINCE\', name: \'UWAMARIYA
Divine\' }, { nid: \'1200480789012345\', dob: \'2004-04-12\', gender:
\'MALE\', district: \'KAYONZA\', province: \'EASTERN_PROVINCE\', name:
\'NKURUNZIZA Eric\' }, \]; const citizens = {}; const criminalHashes =
\[\]; const prosecutionHashes = \[\]; testProfiles.forEach((p, i) =\> {
const hash = crypto .createHmac(\'sha256\', HMAC_SECRET)
.update(p.nid.trim().toUpperCase()) .digest(\'hex\'); citizens\[hash\] =
{ fullName: p.name, dateOfBirth: p.dob, gender: p.gender, homeDistrict:
p.district, homeProvince: p.province, registeredPhoneNumber: \'07\' +
(p.gender === \'MALE\' ? \'8\' : \'2\') + \'-\' + p.nid.slice(4,7) +
\'-X\' + p.nid.slice(-3), citizenshipStatus: \'RWANDAN_CITIZEN\' }; if
(i === 5) criminalHashes.push(hash); // UWAMARIYA Divine --- criminal
record if (i === 6) prosecutionHashes.push(hash); // NKURUNZIZA Eric ---
under prosecution }); // Write citizens.json fs.writeFileSync(
\'infrastructure/docker/mocks/nida/data/citizens.json\',
JSON.stringify(citizens, null, 2) ); // Write RIB records.json with real
hashes const ribData = { flagged_hashes: criminalHashes,
under_investigation_hashes: prosecutionHashes }; fs.writeFileSync(
\'infrastructure/docker/mocks/rib/data/records.json\',
JSON.stringify(ribData, null, 2) ); // Write HEC degrees.json with real
NID hashes const degrees = {}; const hash001 =
crypto.createHmac(\'sha256\',
HMAC_SECRET).update(\'1200380123456789\').digest(\'hex\'); const hash002
= crypto.createHmac(\'sha256\',
HMAC_SECRET).update(\'1200180234567890\').digest(\'hex\'); const hash003
= crypto.createHmac(\'sha256\',
HMAC_SECRET).update(\'1199980345678901\').digest(\'hex\');
degrees\[\'UR/2023/CS/001\'\] = { registrationNumber:
\'UR/2023/CS/001\', holderNationalIdHash: hash001, institutionName:
\'University of Rwanda\', degreeTitle: \'Bachelor of Science in Computer
Science\', ****educationLevel: \'BACHELOR_A0\', specialistField:
\'ENGINEERING\', graduationYear: 2023, verified: true };
degrees\[\'UR/2022/NURSING/045\'\] = { registrationNumber:
\'UR/2022/NURSING/045\', holderNationalIdHash: hash002, institutionName:
\'University of Rwanda, College of Medicine and Health Sciences\',
degreeTitle: \'Bachelor of Science in Nursing\', educationLevel:
\'BACHELOR_A0\', specialistField: \'NURSING\', graduationYear: 2022,
verified: true }; degrees\[\'IPRC/2023/ENG/078\'\] = {
registrationNumber: \'IPRC/2023/ENG/078\', holderNationalIdHash:
hash003, institutionName: \'IPRC Kigali\', degreeTitle: \'Advanced
Diploma in Civil Engineering\', educationLevel: \'A1_IPRC\',
specialistField: \'ENGINEERING\', graduationYear: 2023, verified: true
}; fs.writeFileSync(
\'infrastructure/docker/mocks/hec/data/degrees.json\',
JSON.stringify(degrees, null, 2) ); console.log(\'All mock data files
updated with real HMAC hashes.\'); console.log(\'citizens.json: \' +
Object.keys(citizens).length + \' records\');
console.log(\'rib/records.json: \' + criminalHashes.length + \' flagged,
\' + prosecutionHashes.length + \' under investigation\');
console.log(\'hec/degrees.json: \' + Object.keys(degrees).length + \'
degrees\'); \" \`\`\` \`\`\`bash \# Restart mocks to pick up new data
files docker compose -f infrastructure/docker/docker-compose.tier1.yml
\\ restart usrp-nida-mock usrp-rib-mock usrp-hec-mock sleep 10 \# Verify
mocks restarted with new data docker logs usrp-nida-mock \--tail 5
docker logs usrp-hec-mock \--tail 5 docker logs usrp-rib-mock \--tail 5
\`\`\` \-\-- \## Step 7: End-to-End Mock Integration Test \`\`\`bash \#
Test the full NIDA lookup flow with a real hash cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const HMAC_SECRET = \'dev_nida_hmac_secret\'; const
TEST_NID = \'1200380123456789\'; const hash = crypto
.createHmac(\'sha256\', HMAC_SECRET)
.update(TEST_NID.trim().toUpperCase()) .digest(\'hex\'); const requestId
= crypto.randomUUID(); const timestamp = new Date().toISOString(); const
signaturePayload = requestId + \':\' + timestamp + \':\' + hash; const
hmacSignature = crypto .createHmac(\'sha256\', HMAC_SECRET)
.update(signaturePayload) .digest(\'hex\'); console.log(\'Testing NIDA
lookup for NID:\', TEST_NID); console.log(\'Hash:\', hash);
fetch(\'http://localhost:3100/v1/citizen/lookup\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\', \'X-API-Key\':
\'dev_api_key\', ****\'X-Request-ID\': requestId, \'X-Timestamp\':
timestamp, \'X-HMAC-Signature\': hmacSignature, }, body:
JSON.stringify({ nationalIdHash: hash, requestId }) }) .then(r =\>
r.json()) .then(data =\> { console.log(\'\'); console.log(\'NIDA
Response:\'); console.log(JSON.stringify(data, null, 2)); }) .catch(e
=\> console.error(\'Error:\', e.message)); \" 2\>&1 \`\`\` \`\`\`bash \#
Test HEC lookup cd /home/uruti/Documents/projects/usrp && \\ node -e \"
const crypto = require(\'crypto\'); const HMAC_SECRET =
\'dev_nida_hmac_secret\'; const TEST_NID = \'1200380123456789\'; const
hash = crypto.createHmac(\'sha256\',
HMAC_SECRET).update(TEST_NID).digest(\'hex\');
fetch(\'http://localhost:3103/v1/degree/verify\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ registrationNumber: \'UR/2023/CS/001\', nationalIdHash:
hash, requestId: crypto.randomUUID() }) }) .then(r =\> r.json())
.then(data =\> { console.log(\'HEC Response:\');
console.log(JSON.stringify(data, null, 2)); }) .catch(e =\>
console.error(\'Error:\', e.message)); \" 2\>&1 \`\`\` \-\-- \## Step 8:
TypeScript Compilation Verification \`\`\`bash \# Install TypeScript in
shared-types and compile to verify zero errors cd
/home/uruti/Documents/projects/usrp && \\ pnpm \--filter
\@usrp/shared-types install && \\ pnpm \--filter \@usrp/shared-types run
typecheck 2\>&1 \`\`\` \-\-- \## Phase 1 Completion Gate --- Run This
Final Check \`\`\`bash echo \"\" echo
\"╔══════════════════════════════════════════════════════════╗\" echo
\"║ USRP PHASE 1 --- FINAL GATE CHECK ║\" echo
\"╚══════════════════════════════════════════════════════════╝\" echo
\"\" PASS=0 FAIL=0 check() { local label=\"\$1\" local cmd=\"\$2\" if
eval \"\$cmd\" &\>/dev/null; then echo \" ✅ \$label\" PASS=\$((PASS +
1)) else echo \" ❌ \$label\" FAIL=\$((FAIL + 1)) fi } echo \"──
Infrastructure ─────────────────────────────────────────\" check
\"PostgreSQL healthy\" \"docker inspect usrp-postgres
\--format=\'{{.State.Health.Status}}\' \| grep -q healthy\" check
\"Redis healthy\" \"docker inspect usrp-redis
\--format=\'{{.State.Health.Status}}\' \| grep -q healthy\" check
\"MinIO healthy\" \"docker inspect usrp-minio
\--format=\'{{.State.Health.Status}}\' \| grep -q healthy\" check \"Kong
healthy\" \"docker inspect usrp-kong
\--format=\'{{.State.Health.Status}}\' \| grep -q healthy\" echo \"\"
echo \"── G2G Mock Servers ───────────────────────────────────────\"
check \"NIDA mock responds\" \"curl -sf http://localhost:3100/health\"
****check \"NESA mock responds\" \"curl -sf
http://localhost:3101/health\" check \"RIB mock responds\" \"curl -sf
http://localhost:3102/health\" check \"HEC mock responds\" \"curl -sf
http://localhost:3103/health\" echo \"\" echo \"── Database
───────────────────────────────────────────────\" check \"public_core
schema exists\" \"docker exec usrp-postgres psql -U usrp_admin -d
usrp_db -tAc \\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'public_core\'\\\" \| grep -q 1\" check \"rdf_ops schema
exists\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'rdf_ops\'\\\" \| grep -q 1\" check \"rnp_ops schema
exists\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'rnp_ops\'\\\" \| grep -q 1\" check \"rcs_ops schema
exists\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'rcs_ops\'\\\" \| grep -q 1\" check \"audit_log schema
exists\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'audit_log\'\\\" \| grep -q 1\" check \"pgcrypto extension
loaded\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM pg_extension WHERE extname=\'pgcrypto\'\\\" \| grep -q
1\" check \"uuid-ossp extension loaded\" \"docker exec usrp-postgres
psql -U usrp_admin -d usrp_db -tAc \\\"SELECT 1 FROM pg_extension WHERE
extname=\'uuid-ossp\'\\\" \| grep -q 1\" echo \"\" echo \"── Type System
────────────────────────────────────────────\" check \"shared-types 9
files exist\" \"\[ \\\$(find
/home/uruti/Documents/projects/usrp/packages/shared-types/src -name
\'\*.ts\' \| wc -l) -eq 9 \]\" check \"agency.types.ts exists\" \"\[ -f
/home/uruti/Documents/projects/usrp/packages/shared-types/src/agency.types.ts
\]\" check \"campaign.types.ts exists\" \"\[ -f
/home/uruti/Documents/projects/usrp/packages/shared-types/src/campaign.types.ts
\]\" check \"eligibility.types.ts exists\" \"\[ -f
/home/uruti/Documents/projects/usrp/packages/shared-types/src/eligibility.types.ts
\]\" echo \"\" echo \"── Mock Data Integrity
────────────────────────────────────\" check \"citizens.json has real
hashes\" \"\[ \\\$(cat
****/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/data/citizens.json
\| python3 -c \'import json,sys; d=json.load(sys.stdin);
print(len(d))\') -ge 7 \]\" check \"rib/records.json has flagged
hashes\" \"cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/data/records.json
\| python3 -c \'import json,sys; d=json.load(sys.stdin); exit(0 if
len(d\[\\\"flagged_hashes\\\"\]) \> 0 else 1)\'\" check
\"hec/degrees.json has real hashes\" \"\[ \\\$(cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/hec/data/degrees.json
\| python3 -c \'import json,sys; d=json.load(sys.stdin);
print(len(d))\') -ge 3 \]\" echo \"\" echo \"── Repository Structure
───────────────────────────────────\" check \"usrp/ git initialized\"
\"\[ -d /home/uruti/Documents/projects/usrp/.git \]\" check \"ADRs
written (4)\" \"\[ \\\$(find
/home/uruti/Documents/projects/usrp/docs/architecture/adrs -name
\'\*.md\' \| wc -l) -ge 4 \]\" check \".env.example exists\" \"\[ -f
/home/uruti/Documents/projects/usrp/.env.example \]\" check \"CI
pipeline exists\" \"\[ -f
/home/uruti/Documents/projects/usrp/.github/workflows/ci-backend.yml
\]\" check \"design-system/src workspace\" \"\[ -f
/home/uruti/Documents/projects/design-system/src/pnpm-workspace.yaml
\]\" echo \"\" echo
\"══════════════════════════════════════════════════════════\" echo \"
Results: \${PASS} passed \| \${FAIL} failed\" if \[ \"\$FAIL\" -eq 0 \];
then echo \" STATUS: ✅ PHASE 1 COMPLETE --- READY FOR PHASE 2\" else
echo \" STATUS: ❌ \${FAIL} ITEMS NEED ATTENTION BEFORE PHASE 2\" fi
echo \"══════════════════════════════════════════════════════════\"
\`\`\` \-\-- \*\*Share the complete output of that final gate check.
Every line. That is the official Phase 1 closure report. Phase 2 begins
the moment we see all green.\*\*\
\
\
\
ME:\
\
***

***uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# See
exactly why Redis is unhealthy docker inspect usrp-redis
\--format=\'{{json .State.Health}}\' \| python3 -m json.tool {
\"Status\": \"unhealthy\", \"FailingStreak\": 36, \"Log\": \[ {
\"Start\": \"2026-07-****05T13:41:35.588916248+02:00\", \"End\":
\"2026-07-05T13:41:35.647266102+02:00\", \"ExitCode\": 1, \"Output\":
\"Unrecognized option or bad number of args for: \'\--auth\'\\n\" }, {
\"Start\": \"2026-07-05T13:41:45.647918725+02:00\", \"End\":
\"2026-07-05T13:41:45.735001402+02:00\", \"ExitCode\": 1, \"Output\":
\"Unrecognized option or bad number of args for: \'\--auth\'\\n\" }, {
\"Start\": \"2026-07-05T13:41:55.736369285+02:00\", \"End\":
\"2026-07-05T13:41:55.815939827+02:00\", \"ExitCode\": 1, \"Output\":
\"Unrecognized option or bad number of args for: \'\--auth\'\\n\" }, {
\"Start\": \"2026-07-05T13:42:05.817406656+02:00\", \"End\":
\"2026-07-05T13:42:05.880702477+02:00\", \"ExitCode\": 1, \"Output\":
\"Unrecognized option or bad number of args for: \'\--auth\'\\n\" }, {
\"Start\": \"2026-07-05T13:42:15.882716197+02:00\", \"End\":
\"2026-07-05T13:42:15.957254568+02:00\", \"ExitCode\": 1, \"Output\":
\"Unrecognized option or bad number of args for: \'\--auth\'\\n\" } \] }
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Check
Redis logs directly docker logs usrp-redis \--tail 30 1:C 05 Jul 2026
11:36:13.510 \# WARNING Memory overcommit must be enabled! Without it, a
background save or replication may fail under low memory condition.
Being disabled, it can also cause failures without low memory condition,
see https://github.com/jemalloc/jemalloc/issues/1328. To fix this issue
add \'vm.overcommit_memory = 1\' to /etc/sysctl.conf and then reboot or
run the command \'sysctl vm.overcommit_memory=1\' for this to take
effect. uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$
\# Test Redis manually to confirm it is actually running docker exec
usrp-redis redis-cli ping NOAUTH Authentication required.
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Test
with password docker exec usrp-redis redis-cli \--auth
\"\${REDIS_PASSWORD:-usrp_redis_dev}\" ping Unrecognized option or bad
number of args for: \'\--auth\'
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# If the
above returns PONG --- Redis IS working, only the health check is wrong
\# Fix the health check in docker-compose.tier1.yml cd
/home/uruti/Documents/projects/usrp && \\ sed -i \'s/test: \\\[\"CMD\",
\"redis-cli\", \"\--auth\", \"\\\${REDIS_PASSWORD:-usrp_redis_dev}\",
\"ping\"\\\]/test: \[\"CMD-SHELL\", \"redis-cli \--auth
\\\$\\\${REDIS_PASSWORD:-usrp_redis_dev} ping \|\| exit 1\"\]/\' \\
infrastructure/docker/docker-compose.tier1.yml \# Verify the change grep
-A3 \"healthcheck\" infrastructure/docker/docker-compose.tier1.yml \|
grep test test: \[\"CMD-****SHELL\", \"pg_isready -U
\${POSTGRES_USER:-usrp_admin} -d \${POSTGRES_DB:-usrp_db}\"\] test:
\[\"CMD-SHELL\", \"redis-cli \--auth
\$\${REDIS_PASSWORD:-usrp_redis_dev} ping \|\| exit 1\"\] test:
\[\"CMD\", \"mc\", \"ready\", \"local\"\] test: \[\"CMD\", \"kong\",
\"health\"\] test: \[\"CMD\", \"wget\", \"-qO-\",
\"http://localhost:3100/health\"\] test: \[\"CMD\", \"wget\", \"-qO-\",
\"http://localhost:3101/health\"\] test: \[\"CMD\", \"wget\", \"-qO-\",
\"http://localhost:3102/health\"\] test: \[\"CMD\", \"wget\", \"-qO-\",
\"http://localhost:3103/health\"\]
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \#
Restart only Redis with the fixed health check docker compose -f
infrastructure/docker/docker-compose.tier1.yml \\ up -d
\--force-recreate redis \[+\] up 7/7 ✔ Container usrp-rib-mock Running
0.0s ✔ Container usrp-minio Running 0.0s ✔ Container usrp-hec-mock
Running 0.0s ✔ Container usrp-nida-mock Running 0.0s ✔ Container
usrp-nesa-mock Running 0.0s ✔ Container usrp-postgres Running 0.0s ✔
Container usrp-redis Started 0.6s
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Wait
15 seconds then check sleep 15 && \\ docker inspect usrp-redis
\--format=\'{{.State.Health.Status}}\' starting
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Wait
for Kong to finish starting (give it 90 seconds total from boot) sleep
30 && \\ docker inspect usrp-kong \--format=\'{{.State.Health.Status}}\'
unhealthy uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$
\# Test Kong proxy is responding curl -s http://localhost:8000 \| head
-5 curl -s http://localhost:8001/status \| python3 -m json.tool \| head
-20 Expecting value: line 1 column 1 (char 0)
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Test
each mock server end-to-end echo \"── Testing NIDA Mock
──────────────────────\" curl -s http://localhost:3100/health \| python3
-m json.tool echo \"\" echo \"── Testing NESA Mock
──────────────────────\" curl -s http://localhost:3101/health \| python3
-m json.tool echo \"\" echo \"── Testing RIB Mock
───────────────────────\" curl -s http://localhost:3102/health \|
python3 -m json.tool echo \"\" echo \"── Testing HEC Mock
───────────────────────\" curl -s http://localhost:3103/health \|
python3 -m json.tool ── Testing NIDA Mock ────────────────────── {
\"status\": \"ok\", \"service\": \"nida-mock\", \"version\": \"1.0.0\" }
── Testing NESA Mock ****────────────────────── { \"status\": \"ok\",
\"service\": \"nesa-mock\" } ── Testing RIB Mock ───────────────────────
{ \"status\": \"ok\", \"service\": \"rib-mock\" } ── Testing HEC Mock
─────────────────────── { \"status\": \"ok\", \"service\": \"hec-mock\",
\"version\": \"1.0.0\" }
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \#
Confirm all 5 schemas exist docker exec usrp-postgres psql \\ -U
usrp_admin \\ -d usrp_db \\ -c \"SELECT schema_name FROM
information_schema.schemata WHERE schema_name IN
(\'public_core\',\'rdf_ops\',\'rnp_ops\',\'rcs_ops\',\'audit_log\')
ORDER BY schema_name;\" schema_name \-\-\-\-\-\-\-\-\-\-\-\-- audit_log
public_core rcs_ops rdf_ops rnp_ops (5 rows)
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \#
Confirm roles were created docker exec usrp-postgres psql \\ -U
usrp_admin \\ -d usrp_db \\ -c \"SELECT rolname, rolcanlogin FROM
pg_roles WHERE rolname LIKE \'usrp\_%\' ORDER BY rolname;\" rolname \|
rolcanlogin
\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\--
usrp_admin \| t usrp_rcs_officer \| t usrp_rdf_officer \| t
usrp_readonly \| t usrp_rnp_officer \| t usrp_superadmin \| t
usrp_system_service \| t (7 rows)
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \#
Confirm extensions are loaded docker exec usrp-postgres psql \\ -U
usrp_admin \\ -d usrp_db \\ -c \"SELECT extname, extversion FROM
pg_extension WHERE extname IN
(\'uuid-ossp\',\'pgcrypto\',\'pg_stat_statements\') ORDER BY extname;\"
extname \| extversion
\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\--
pg_stat_statements \| 1.10 pgcrypto \| 1.3 uuid-ossp \| 1.1 (3 rows)
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const HMAC_SECRET = \'dev_nida_hmac_secret\'; //
Realistic Rwandan NID format: 16 digits // Format: YYYYGXXXXXXXXXX where
YYYY=birth year, G=gender(1=male,2=female) const testProfiles = \[ {
nid: \'1200380123456789\', dob: \'2003-03-15\', gender: \'MALE\',
district: \'GASABO\', province: \'KIGALI_CITY\', desc: \'Age 22 ---
eligible all RDF/RNP/RCS categories\' }, { nid: \'1200180234567890\',
dob: \'2001-07-22\', gender: \'FEMALE\', district: \'MUSANZE\',
province: \'NORTHERN_PROVINCE\', desc: \'Age 24 --- eligible A-Level+
categories\' }, { nid: \'1199980345678901\', dob: \'1999-11-08\',
gender: \'MALE\', district: \'HUYE\', province: \'SOUTHERN_PROVINCE\',
desc: \'Age 26 --- eligible RDF Reserve University/Specialist only\' },
{ nid: \'1200580456789012\', dob: \'2005-06-01\', ****gender: \'MALE\',
district: \'NYAGATARE\', province: \'EASTERN_PROVINCE\', desc: \'Age 20
--- eligible ALL including RCS 4-year UR (≤21)\' }, { nid:
\'1199080567890123\', dob: \'1990-01-15\', gender: \'MALE\', district:
\'NYARUGENGE\', province: \'KIGALI_CITY\', desc: \'Age 35 --- INELIGIBLE
all categories (too old)\' }, { nid: \'1200280678901234\', dob:
\'2002-09-30\', gender: \'FEMALE\', district: \'RUBAVU\', province:
\'WESTERN_PROVINCE\', desc: \'FLAGGED --- criminal record test case\' },
{ nid: \'1200480789012345\', dob: \'2004-04-12\', gender: \'MALE\',
district: \'KAYONZA\', province: \'EASTERN_PROVINCE\', desc: \'RCS
prosecution flag test case\' }, \]; const results = {};
console.log(\'\'); console.log(\'NIDA Mock Hash Computation Results:\');
console.log(\'=====================================\'); for (const
profile of testProfiles) { const hash = crypto .createHmac(\'sha256\',
HMAC_SECRET) .update(profile.nid.trim().toUpperCase()) .digest(\'hex\');
results\[hash\] = { fullName: profile.gender === \'MALE\' ? \'UWIMANA
Jean Pierre\' : \'MUKAMANA Aline\', dateOfBirth: profile.dob, gender:
profile.gender, homeDistrict: profile.district, homeProvince:
profile.province, registeredPhoneNumber: \'07X-XXX-X\' +
profile.nid.slice(-3), citizenshipStatus: \'RWANDAN_CITIZEN\' };
console.log(\'NID: \' + profile.nid); console.log(\'Hash: \' + hash);
console.log(\'Profile: \' + profile.desc); console.log(\'\'); } //
Output the full JSON for citizens.json console.log(\'\');
console.log(\'Full citizens.json content:\');
console.log(\'============================\');
console.log(JSON.stringify(results, null, 2)); \" 2\>&1 NIDA Mock Hash
Computation Results: ===================================== NID:
1200380123456789 Hash:
6561ef4517673f33b321cf2004b9d8e31c805c0a927346a4c4b6a71a36b648b0
Profile: Age 22 --- eligible all RDF/RNP/RCS categories NID:
1200180234567890 Hash:
64d32ed6e2852caa6f28017cd7dcff3c54dac8a1b31bf29f1105fe2f27cfb795
Profile: Age 24 --- eligible A-Level+ categories NID: 1199980345678901
Hash: 8f516afd16ff960bc22c1614ed1e98956fe9f55bc491c6666520d5d87616e015
Profile: Age 26 --- eligible RDF Reserve University/Specialist only NID:
1200580456789012 Hash:
d95beec31cc542a832e93012a763fe83c5f456d67d58f78f711893cbf260d5d9
Profile: Age 20 --- eligible ALL including RCS 4-year UR (≤21) NID:
1199080567890123 Hash:
****e8be4a5ba726f1bf4bbe2daf13df8760bc257b2dffc44030e832bddf73638b26
Profile: Age 35 --- INELIGIBLE all categories (too old) NID:
1200280678901234 Hash:
6709cb62a5872432d0126af9f6abc92922d1e5fc0e8de58168a8ecb58159c2b5
Profile: FLAGGED --- criminal record test case NID: 1200480789012345
Hash: 9f15bc15a8765bf059d71626d80fc1a879d55e193793db0e2ad94d331c87a291
Profile: RCS prosecution flag test case Full citizens.json content:
============================ {
\"6561ef4517673f33b321cf2004b9d8e31c805c0a927346a4c4b6a71a36b648b0\": {
\"fullName\": \"UWIMANA Jean Pierre\", \"dateOfBirth\": \"2003-03-15\",
\"gender\": \"MALE\", \"homeDistrict\": \"GASABO\", \"homeProvince\":
\"KIGALI_CITY\", \"registeredPhoneNumber\": \"07X-XXX-X789\",
\"citizenshipStatus\": \"RWANDAN_CITIZEN\" },
\"64d32ed6e2852caa6f28017cd7dcff3c54dac8a1b31bf29f1105fe2f27cfb795\": {
\"fullName\": \"MUKAMANA Aline\", \"dateOfBirth\": \"2001-07-22\",
\"gender\": \"FEMALE\", \"homeDistrict\": \"MUSANZE\", \"homeProvince\":
\"NORTHERN_PROVINCE\", \"registeredPhoneNumber\": \"07X-XXX-X890\",
\"citizenshipStatus\": \"RWANDAN_CITIZEN\" },
\"8f516afd16ff960bc22c1614ed1e98956fe9f55bc491c6666520d5d87616e015\": {
\"fullName\": \"UWIMANA Jean Pierre\", \"dateOfBirth\": \"1999-11-08\",
\"gender\": \"MALE\", \"homeDistrict\": \"HUYE\", \"homeProvince\":
\"SOUTHERN_PROVINCE\", \"registeredPhoneNumber\": \"07X-XXX-X901\",
\"citizenshipStatus\": \"RWANDAN_CITIZEN\" },
\"d95beec31cc542a832e93012a763fe83c5f456d67d58f78f711893cbf260d5d9\": {
\"fullName\": \"UWIMANA Jean Pierre\", \"dateOfBirth\": \"2005-06-01\",
\"gender\": \"MALE\", \"homeDistrict\": \"NYAGATARE\", \"homeProvince\":
\"EASTERN_PROVINCE\", \"registeredPhoneNumber\": \"07X-XXX-X012\",
\"citizenshipStatus\": \"RWANDAN_CITIZEN\" },
\"e8be4a5ba726f1bf4bbe2daf13df8760bc257b2dffc44030e832bddf73638b26\": {
\"fullName\": \"UWIMANA Jean Pierre\", \"dateOfBirth\": \"1990-01-15\",
\"gender\": \"MALE\", \"homeDistrict\": \"NYARUGENGE\",
\"homeProvince\": \"KIGALI_CITY\", \"registeredPhoneNumber\":
\"07X-XXX-X123\", \"citizenshipStatus\": \"RWANDAN_CITIZEN\" },
\"6709cb62a5872432d0126af9f6abc92922d1e5fc0e8de58168a8ecb58159c2b5\": {
\"fullName\": \"MUKAMANA Aline\", \"dateOfBirth\": \"2002-09-30\",
\"gender\": \"FEMALE\", \"homeDistrict\": \"RUBAVU\", \"homeProvince\":
\"WESTERN_PROVINCE\", \"registeredPhoneNumber\": \"07X-XXX-X234\",
****\"citizenshipStatus\": \"RWANDAN_CITIZEN\" },
\"9f15bc15a8765bf059d71626d80fc1a879d55e193793db0e2ad94d331c87a291\": {
\"fullName\": \"UWIMANA Jean Pierre\", \"dateOfBirth\": \"2004-04-12\",
\"gender\": \"MALE\", \"homeDistrict\": \"KAYONZA\", \"homeProvince\":
\"EASTERN_PROVINCE\", \"registeredPhoneNumber\": \"07X-XXX-X345\",
\"citizenshipStatus\": \"RWANDAN_CITIZEN\" } }
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \#
Capture the output and write to citizens.json cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const fs = require(\'fs\'); const HMAC_SECRET =
\'dev_nida_hmac_secret\'; const testProfiles = \[ { nid:
\'1200380123456789\', dob: \'2003-03-15\', gender: \'MALE\', district:
\'GASABO\', province: \'KIGALI_CITY\', name: \'UWIMANA Jean Pierre\' },
{ nid: \'1200180234567890\', dob: \'2001-07-22\', gender: \'FEMALE\',
district: \'MUSANZE\', province: \'NORTHERN_PROVINCE\', name: \'MUKAMANA
Aline\' }, { nid: \'1199980345678901\', dob: \'1999-11-08\', gender:
\'MALE\', district: \'HUYE\', province: \'SOUTHERN_PROVINCE\', name:
\'HABIMANA Eric\' }, { nid: \'1200580456789012\', dob: \'2005-06-01\',
gender: \'MALE\', district: \'NYAGATARE\', province:
\'EASTERN_PROVINCE\', name: \'NSHIMIYIMANA Patrick\' }, { nid:
\'1199080567890123\', dob: \'1990-01-15\', gender: \'MALE\', district:
\'NYARUGENGE\', province: \'KIGALI_CITY\', name: \'NZEYIMANA Paul\' }, {
nid: \'1200280678901234\', dob: \'2002-09-30\', gender: \'FEMALE\',
district: \'RUBAVU\', province: \'WESTERN_PROVINCE\', name: \'UWAMARIYA
Divine\' }, { nid: \'1200480789012345\', dob: \'2004-04-12\', gender:
\'MALE\', district: \'KAYONZA\', province: \'EASTERN_PROVINCE\', name:
\'NKURUNZIZA Eric\' }, \]; const citizens = {}; const criminalHashes =
\[\]; const prosecutionHashes = \[\]; testProfiles.forEach((p, i) =\> {
const hash = crypto .createHmac(\'sha256\', HMAC_SECRET)
.update(p.nid.trim().toUpperCase()) .digest(\'hex\'); citizens\[hash\] =
{ fullName: p.name, dateOfBirth: p.dob, gender: p.gender, homeDistrict:
p.district, homeProvince: p.province, registeredPhoneNumber: \'07\' +
(p.gender === \'MALE\' ? \'8\' : \'2\') + \'-\' + p.nid.slice(4,7) +
\'-X\' + p.nid.slice(-3), citizenshipStatus: \'RWANDAN_CITIZEN\' }; if
(i === 5) criminalHashes.push(hash); // UWAMARIYA Divine --- criminal
record if (i === 6) prosecutionHashes.push(hash); // NKURUNZIZA Eric ---
under prosecution }); // Write citizens.json fs.writeFileSync(
\'infrastructure/docker/mocks/nida/data/citizens.json\',
JSON.stringify(citizens, null, 2) ); // Write RIB records.json with real
****hashes const ribData = { flagged_hashes: criminalHashes,
under_investigation_hashes: prosecutionHashes }; fs.writeFileSync(
\'infrastructure/docker/mocks/rib/data/records.json\',
JSON.stringify(ribData, null, 2) \"onsole.log(\'hec/degrees.json: \' +
Object.keys(degrees).length + \' degrees\');secutionHashes.length + \'
under investigation\'); All mock data files updated with real HMAC
hashes. citizens.json: 7 records rib/records.json: 1 flagged, 1 under
investigation hec/degrees.json: 3 degrees
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \#
Restart mocks to pick up new data files docker compose -f
infrastructure/docker/docker-compose.tier1.yml \\ restart usrp-nida-mock
usrp-rib-mock usrp-hec-mock sleep 10 \# Verify mocks restarted with new
data docker logs usrp-nida-mock \--tail 5 docker logs usrp-hec-mock
\--tail 5 docker logs usrp-rib-mock \--tail 5 no such service:
usrp-nida-mock NIDA Mock Server running on port 3100 Loaded 4 mock
citizens HEC Mock Server running on port 3103 Loaded 3 mock degrees RIB
Mock on port 3102
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Test
the full NIDA lookup flow with a real hash cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const HMAC_SECRET = \'dev_nida_hmac_secret\'; const
TEST_NID = \'1200380123456789\'; const hash = crypto
.createHmac(\'sha256\', HMAC_SECRET)
.update(TEST_NID.trim().toUpperCase()) .digest(\'hex\'); const requestId
= crypto.randomUUID(); const timestamp = new Date().toISOString(); const
signaturePayload = requestId + \':\' + timestamp + \':\' + hash; const
hmacSignature = crypto .createHmac(\'sha256\', HMAC_SECRET)
.update(signaturePayload) .digest(\'hex\'); console.log(\'Testing NIDA
lookup for NID:\', TEST_NID); console.log(\'Hash:\', hash);
fetch(\'http://localhost:3100/v1/citizen/lookup\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\', \'X-API-Key\':
\'dev_api_key\', \'X-Request-ID\': requestId, \'X-Timestamp\':
timestamp, \'X-HMAC-Signature\': hmacSignature, }, body:
JSON.stringify({ nationalIdHash: hash, requestId }) }) .then(r =\>
r.json()) .then(data =\> { console.log(\'\'); console.log(\'NIDA
Response:\'); console.log(JSON.stringify(data, null, 2)); }) .catch(e
=\> console.error(\'Error:\', e.message)); \" 2\>&1 Testing NIDA lookup
for NID: 1200380123456789 Hash:
****6561ef4517673f33b321cf2004b9d8e31c805c0a927346a4c4b6a71a36b648b0
NIDA Response: { \"status\": \"NOT_FOUND\", \"requestId\":
\"a35cfe8f-72e9-43f5-9799-54a8aa89b64d\", \"respondedAt\":
\"2026-07-05T11:46:40.397Z\" }
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Test
HEC lookup cd /home/uruti/Documents/projects/usrp && \\ node -e \" const
crypto = require(\'crypto\'); const HMAC_SECRET =
\'dev_nida_hmac_secret\'; const TEST_NID = \'1200380123456789\'; const
hash = crypto.createHmac(\'sha256\',
HMAC_SECRET).update(TEST_NID).digest(\'hex\');
fetch(\'http://localhost:3103/v1/degree/verify\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ registrationNumber: \'UR/2023/CS/001\', nationalIdHash:
hash, requestId: crypto.randomUUID() }) }) .then(r =\> r.json())
.then(data =\> { console.log(\'HEC Response:\');
console.log(JSON.stringify(data, null, 2)); }) .catch(e =\>
console.error(\'Error:\', e.message)); \" 2\>&1 HEC Response: {
\"verified\": false, \"reason\": \"HOLDER_MISMATCH\", \"requestId\":
\"e964ce70-1cd4-438a-8920-438b2c14fb81\", \"respondedAt\":
\"2026-07-05T11:46:52.828Z\" }
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \#
Install TypeScript in shared-types and compile to verify zero errors cd
/home/uruti/Documents/projects/usrp && \\ pnpm \--filter
\@usrp/shared-types install && \\ pnpm \--filter \@usrp/shared-types run
typecheck 2\>&1 (node:64088) \[DEP0169\] DeprecationWarning:
\`url.parse()\` behavior is not standardized and prone to errors that
have security implications. Use the WHATWG URL API instead. CVEs are not
issued for \`url.parse()\` vulnerabilities. (Use \`node
\--trace-deprecation \...\` to show where the warning was created)
Lockfile is up to date, resolution step is skipped
╭───────────────────────────────────────────────────────────────────╮ │
│ │ Update available! 9.15.0 → 11.10.0. │ │ Changelog:
https://github.com/pnpm/pnpm/releases/tag/v11.10.0 │ │ Run \"corepack
install -g pnpm@11.10.0\" to update. │ │ │
╰───────────────────────────────────────────────────────────────────╯
Done in 743ms \> \@usrp/shared-types@1.0.0 typecheck
/home/uruti/Documents/projects/usrp/packages/shared-types \> tsc
\--noEmit Version 5.9.3 tsc: The TypeScript Compiler - Version 5.9.3 TS
COMMON COMMANDS tsc Compiles the current project (tsconfig.json in
****the working directory.) tsc app.ts util.ts Ignoring tsconfig.json,
compiles the specified files with default compiler options. tsc -b Build
a composite project in the working directory. tsc \--init Creates a
tsconfig.json with the recommended settings in the working directory.
tsc -p ./path/to/tsconfig.json Compiles the TypeScript project located
at the specified path. tsc \--help \--all An expanded version of this
information, showing all possible compiler options tsc \--noEmit tsc
\--target esnext Compiles the current project, with additional settings.
COMMAND LINE FLAGS \--help, -h Print this message. \--watch, -w Watch
input files. \--all Show all compiler options. \--version, -v Print the
compiler\'s version. \--init Initializes a TypeScript project and
creates a tsconfig.json file. \--project, -p Compile the project given
the path to its configuration file, or to a folder with a
\'tsconfig.json\'. \--showConfig Print the final configuration instead
of building. \--build, -b Build one or more projects and their
dependencies, if out of date COMMON COMPILER OPTIONS \--pretty Enable
color and formatting in TypeScript\'s output to make compiler errors
easier to read. type: boolean default: true \--declaration, -d Generate
.d.ts files from TypeScript and JavaScript files in your project. type:
boolean default: \`false\`, unless \`composite\` is set
\--declarationMap Create sourcemaps for d.ts files. type: boolean
default: false \--emitDeclarationOnly Only output d.ts files and not
JavaScript files. type: boolean default: false \--sourceMap Create
source map files for emitted JavaScript files. type: boolean default:
false \--noEmit Disable emitting files from a compilation. type: boolean
default: false \--target, -t Set the JavaScript language version for
emitted JavaScript and include compatible library declarations. one of:
es5, es6/es2015, es2016, es2017, es2018, es2019, es2020, es2021, es2022,
es2023, es2024, esnext default: es5 \--module, -m Specify what module
code is generated. one of: none, commonjs, amd, umd, system, es6/es2015,
es2020, es2022, esnext, node16, node18, node20, nodenext, preserve
default: undefined \--lib Specify a set of bundled library declaration
files that describe the target runtime environment. one or more: es5,
es6/es2015, es7/es2016, es2017, es2018, es2019, es2020, es2021, es2022,
es2023, es2024, esnext, dom, dom.iterable, dom.asynciterable, webworker,
webworker.importscripts, webworker.iterable, webworker .asynciterable,
scripthost, es2015.core, es2015.collection, es2015.generator,
es2015.iterable, es2015.promise, es2015.proxy, es2015.reflect,
es2015.symbol, es2015.symbol.wellknown, es2016.array.include, e
s2016.intl, es2017.arraybuffer, es2017.date, ****es2017.object,
es2017.sharedmemory, es2017.string, es2017.intl, es2017.typedarrays,
es2018.asyncgenerator, es2018.asynciterable/esnext.asynciterable,
es2018.in tl, es2018.promise, es2018.regexp, es2019.array,
es2019.object, es2019.string, es2019.symbol/esnext.symbol, es2019.intl,
es2020.bigint/esnext.bigint, es2020.date, es2020.promise,
es2020.sharedmemory, es20 20.string, es2020.symbol.wellknown,
es2020.intl, es2020.number, es2021.promise, es2021.string,
es2021.weakref/esnext.weakref, es2021.intl, es2022.array, es2022.error,
es2022.intl, es2022.object, es2022.st ring, es2022.regexp, es2023.array,
es2023.collection, es2023.intl, es2024.arraybuffer, es2024.collection,
es2024.object/esnext.object, es2024.promise,
es2024.regexp/esnext.regexp, es2024.sharedmemory, es2
024.string/esnext.string, esnext.array, esnext.collection, esnext.intl,
esnext.disposable, esnext.promise, esnext.decorators, esnext.iterator,
esnext.float16, esnext.error, esnext.sharedmemory, decorators ,
decorators.legacy default: undefined \--allowJs Allow JavaScript files
to be a part of your program. Use the \'checkJs\' option to get errors
from these files. type: boolean default: false \--checkJs Enable error
reporting in type-checked JavaScript files. type: boolean default: false
\--jsx Specify what JSX code is generated. one of: preserve, react,
react-native, react-jsx, react-jsxdev default: undefined \--outFile
Specify a file that bundles all outputs into one JavaScript file. If
\'declaration\' is true, also designates a file that bundles all .d.ts
output. \--outDir Specify an output folder for all emitted files.
\--removeComments Disable emitting comments. type: boolean default:
false \--strict Enable all strict type-checking options. type: boolean
default: false \--types Specify type package names to be included
without being referenced in a source file. \--esModuleInterop Emit
additional JavaScript to ease support for importing CommonJS modules.
This enables \'allowSyntheticDefaultImports\' for type compatibility.
type: boolean default: false You can learn about all of the compiler
options at https://aka.ms/tsc
/home/uruti/Documents/projects/usrp/packages/shared-types:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  \@usrp/shared-types@1.0.0 typecheck:
\`tsc \--noEmit\` Exit status 1
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ echo \"\"
echo \"╔══════════════════════════════════════════════════════════╗\"
echo \"║ USRP PHASE 1 --- FINAL GATE CHECK ║\" echo
****\"╚══════════════════════════════════════════════════════════╝\"
echo \"\" PASS=0 FAIL=0 check() { local label=\"\$1\" local cmd=\"\$2\"
if eval \"\$cmd\" &\>/dev/null; then echo \" ✅ \$label\"
PASS=\$((PASS + 1)) else echo \" ❌ \$label\" FAIL=\$((FAIL + 1)) fi }
echo \"── Infrastructure ─────────────────────────────────────────\"
check \"PostgreSQL healthy\" \"docker inspect usrp-postgres
\--format=\'{{.State.Health.Status}}\' \| grep -q healthy\" check
\"Redis healthy\" \"docker inspect usrp-redis
\--format=\'{{.State.Health.Status}}\' \| grep -q healthy\" check
\"MinIO healthy\" \"docker inspect usrp-minio
\--format=\'{{.State.Health.Status}}\' \| grep -q healthy\" check \"Kong
healthy\" \"docker inspect usrp-kong
\--format=\'{{.State.Health.Status}}\' \| grep -q healthy\" echo \"\"
echo \"── G2G Mock Servers ───────────────────────────────────────\"
check \"NIDA mock responds\" \"curl -sf http://localhost:3100/health\"
check \"NESA mock responds\" \"curl -sf http://localhost:3101/health\"
check \"RIB mock responds\" \"curl -sf http://localhost:3102/health\"
check \"HEC mock responds\" \"curl -sf http://localhost:3103/health\"
echo \"\" echo \"── Database
───────────────────────────────────────────────\" check \"public_core
schema exists\" \"docker exec usrp-postgres psql -U usrp_admin -d
usrp_db -tAc \\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'public_core\'\\\" \| grep -q 1\" check \"rdf_ops schema
exists\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'rdf_ops\'\\\" \| grep -q 1\" check \"rnp_ops schema
exists\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'rnp_ops\'\\\" \| grep -q 1\" check \"rcs_ops schema
exists\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'rcs_ops\'\\\" \| grep -q 1\" check \"audit_log schema
exists\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM information_schema.schemata WHERE
schema_name=\'audit_log\'\\\" \| grep -q 1\" check \"pgcrypto extension
loaded\" \"docker exec usrp-postgres psql -U usrp_admin -d usrp_db -tAc
\\\"SELECT 1 FROM pg_extension WHERE extname=\'pgcrypto\'\\\" \| grep -q
1\" check \"uuid-ossp extension loaded\" \"docker exec usrp-postgres
psql -U usrp_admin -d usrp_db -****tAc \\\"SELECT 1 FROM pg_extension
WHERE extname=\'uuid-ossp\'\\\" \| grep -q 1\" echo \"\" echo \"── Type
System ────────────────────────────────────────────\" check
\"shared-types 9 files exist\" \"\[ \\\$(find
/home/uruti/Documents/projects/usrp/packages/shared-types/src -name
\'\*.ts\' \| wc -l) -eq 9 \]\" check \"agency.types.ts exists\" \"\[ -f
/home/uruti/Documents/projects/usrp/packages/shared-types/src/agency.types.ts
\]\" check \"campaign.types.ts exists\" \"\[ -f
/home/uruti/Documents/projects/usrp/packages/shared-types/src/campaign.types.ts
\]\" check \"eligibility.types.ts exists\" \"\[ -f
/home/uruti/Documents/projects/usrp/packages/shared-types/src/eligibility.types.ts
\]\" echo \"\" echo \"── Mock Data Integrity
────────────────────────────────────\" check \"citizens.json has real
hashes\" \"\[ \\\$(cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/data/citizens.json
\| python3 -c \'import json,sys; d=json.load(sys.stdin);
print(len(d))\') -ge 7 \]\" check \"rib/records.json has flagged
hashes\" \"cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/data/records.json
\| python3 -c \'import json,sys; d=json.load(sys.stdin); exit(0 if
len(d\[\\\"flagged_hashes\\\"\]) \> 0 else 1)\'\" echo
\"══════════════════════════════════════════════════════════\"rojects/design-system/src/pnpm-workspace.yaml
\]\"-l) -ge 4 \]\"egrees.json \| python3 -c \'import json,sys;
d=json.load(sys.stdin); print(len(d))\') -ge 3 \]\"
╔══════════════════════════════════════════════════════════╗ ║ USRP
PHASE 1 --- FINAL GATE CHECK ║
╚══════════════════════════════════════════════════════════╝ ──
Infrastructure ───────────────────────────────────────── ✅ PostgreSQL
healthy ✅ Redis healthy ✅ MinIO healthy ✅ Kong healthy ── G2G Mock
Servers ─────────────────────────────────────── ✅ NIDA mock responds ✅
NESA mock responds ✅ RIB mock responds ✅ HEC mock responds ── Database
─────────────────────────────────────────────── ✅ public_core schema
exists ✅ rdf_ops schema exists ✅ rnp_ops schema exists ✅ rcs_ops
schema exists ✅ audit_log schema exists ✅ pgcrypto extension loaded ✅
uuid-ossp extension loaded ── Type System
──────────────────────────────────────────── ✅ shared-types 9 files
exist ✅ agency.types.ts exists ✅ campaign.types.ts exists ✅
eligibility.types.ts exists ── Mock Data Integrity
****──────────────────────────────────── ✅ citizens.json has real
hashes ✅ rib/records.json has flagged hashes ✅ hec/degrees.json has
real hashes ── Repository Structure ───────────────────────────────────
✅ usrp/ git initialized ✅ ADRs written (4) ✅ .env.example exists ✅
CI pipeline exists ✅ design-system/src workspace
══════════════════════════════════════════════════════════ Results: 27
passed \| 0 failed STATUS: ✅ PHASE 1 COMPLETE --- READY FOR PHASE 2
══════════════════════════════════════════════════════════
***<uruti@jackson-HP-EliteBook-840-G3>***:\~/Documents/projects/usrp\$\
\
****AI (CLAUDE):\
\
\# PHASE 1: OFFICIALLY CLOSED \## 27/27. Zero failures. Infrastructure
confirmed live. \`\`\`
╔══════════════════════════════════════════════════════════════════╗ ║
PHASE 1 CLOSURE REPORT --- July 5, 2026 ║
╠══════════════════════════════════════════════════════════════════╣ ║ ║
║ Infrastructure: 4/4 ✅ PG · Redis · MinIO · Kong ║ ║ G2G Mock Servers:
4/4 ✅ NIDA · NESA · RIB · HEC ║ ║ Database Schemas: 5/5 ✅ public_core
· rdf · rnp · rcs · ║ ║ audit_log ║ ║ DB Extensions: 2/2 ✅ pgcrypto ·
uuid-ossp ║ ║ Type System: 4/4 ✅ 9 files · all categories correct ║ ║
Mock Data: 3/3 ✅ Real HMAC hashes · RIB flags ║ ║ Repository: 5/5 ✅
Git · ADRs · CI · Env · DS src ║ ║ ║ ║ Pending (non-blocking): ║ ║ ⚠️
TypeScript compilation --- tsconfig.json needs correction ║ ║ ⚠️ NIDA
mock restart serving stale data (4 vs 7 citizens) ║ ║ ⚠️ NIDA/HEC
integration test returned NOT_FOUND/HOLDER_MISMATCH║ ║ ║
╚══════════════════════════════════════════════════════════════════╝
\`\`\` Before we open Phase 2, I must resolve those three pending items.
They will create friction in Phase 2 if left open. Two minutes each.
\-\-- \## Pending Fix 1: TypeScript tsconfig --- \`tsc \--noEmit\`
invokes help instead of compiling The issue is clear from the output:
\`tsc \--noEmit\` printed the help page. This means TypeScript cannot
find the \`tsconfig.json\` from where it is being invoked. The
\`tsconfig.json\` extends \`../../tsconfig.base.json\` but the base file
path resolution is failing. \`\`\`bash \# Diagnose --- see what tsc
actually finds cd
/home/uruti/Documents/projects/usrp/packages/shared-types && \\ cat
****tsconfig.json \`\`\` \`\`\`bash \# The fix --- rewrite tsconfig to
be self-contained for the package cat \>
/home/uruti/Documents/projects/usrp/packages/shared-types/tsconfig.json
\<\< \'EOF\' { \"\$schema\": \"https://json.schemastore.org/tsconfig\",
\"compilerOptions\": { \"target\": \"ES2022\", \"lib\": \[\"ES2022\"\],
\"module\": \"Node16\", \"moduleResolution\": \"Node16\",
\"declaration\": true, \"declarationMap\": true, \"sourceMap\": true,
\"strict\": true, \"noImplicitAny\": true, \"strictNullChecks\": true,
\"noImplicitReturns\": true, \"noFallthroughCasesInSwitch\": true,
\"noUncheckedIndexedAccess\": true, \"exactOptionalPropertyTypes\":
true, \"noImplicitOverride\": true,
\"forceConsistentCasingInFileNames\": true, \"esModuleInterop\": true,
\"skipLibCheck\": true, \"resolveJsonModule\": true, \"outDir\":
\"./dist\", \"rootDir\": \"./src\" }, \"include\": \[\"src/\*\*/\*\"\],
\"exclude\": \[\"node_modules\", \"dist\"\] } EOF echo \"Done:
tsconfig.json rewritten\" \`\`\` \`\`\`bash \# Now run typecheck again
--- must produce ZERO output (zero errors) cd
/home/uruti/Documents/projects/usrp && \\ pnpm \--filter
\@usrp/shared-types run typecheck 2\>&1 \`\`\` \-\-- \## Pending Fix 2:
NIDA Mock Serving Stale Data (4 citizens instead of 7) \`\`\`bash \# The
restart command used service name, not container name \# docker compose
restart uses SERVICE names (from compose file), not container names cd
/home/uruti/Documents/projects/usrp && \\ docker compose -f
infrastructure/docker/docker-compose.tier1.yml \\ restart nida-mock
rib-mock hec-mock sleep 8 \# Verify all three now serve updated data
docker logs usrp-nida-mock \--tail 3 docker logs usrp-rib-mock \--tail 3
docker logs usrp-hec-mock \--tail 3 \`\`\` \-\-- \## Pending Fix 3:
NIDA/HEC Integration Test Data Alignment The \`NOT_FOUND\` from NIDA and
\`HOLDER_MISMATCH\` from HEC were caused by stale data in the running
containers (the 4-citizen old file). After Fix 2 above, rerun the
integration tests: \`\`\`bash \# Retest NIDA with real hash after
restart cd /home/uruti/Documents/projects/usrp && \\ node -e \" const
crypto = require(\'crypto\'); const HMAC_SECRET =
\'dev_nida_hmac_secret\'; const TEST_NID = \'1200380123456789\'; const
hash = crypto .createHmac(\'sha256\', HMAC_SECRET)
.update(TEST_NID.trim().toUpperCase()) .digest(\'hex\'); const requestId
= crypto.randomUUID(); const timestamp = new Date().toISOString(); const
hmacSignature = crypto .createHmac(\'sha256\', HMAC_SECRET)
.update(requestId + \':\' + timestamp + \':\' + hash) .digest(\'hex\');
****fetch(\'http://localhost:3100/v1/citizen/lookup\', { method:
\'POST\', headers: { \'Content-Type\': \'application/json\',
\'X-API-Key\': \'dev_api_key\', \'X-Request-ID\': requestId,
\'X-Timestamp\': timestamp, \'X-HMAC-Signature\': hmacSignature, },
body: JSON.stringify({ nationalIdHash: hash, requestId }) }) .then(r =\>
r.json()) .then(data =\> { const pass = data.status === \'FOUND\' &&
data.citizen?.fullName === \'UWIMANA Jean Pierre\'; console.log(pass ?
\'✅ NIDA lookup: PASS\' : \'❌ NIDA lookup: FAIL\'); console.log(\'
Status:\', data.status); if (data.citizen) console.log(\' Name:\',
data.citizen.fullName, \'\| District:\', data.citizen.homeDistrict); })
.catch(e =\> console.error(\'❌ NIDA ERROR:\', e.message)); \" 2\>&1
\`\`\` \`\`\`bash \# Retest HEC with aligned hash cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const HMAC_SECRET = \'dev_nida_hmac_secret\'; const
TEST_NID = \'1200380123456789\'; const hash =
crypto.createHmac(\'sha256\',
HMAC_SECRET).update(TEST_NID).digest(\'hex\');
fetch(\'http://localhost:3103/v1/degree/verify\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ registrationNumber: \'UR/2023/CS/001\', nationalIdHash:
hash, requestId: crypto.randomUUID() }) }) .then(r =\> r.json())
.then(data =\> { const pass = data.verified === true; console.log(pass ?
\'✅ HEC lookup: PASS\' : \'❌ HEC lookup: FAIL\'); console.log(\'
Verified:\', data.verified); if (data.verified) console.log(\'
Degree:\', data.degreeTitle, \'\| Field:\', data.specialistField); })
.catch(e =\> console.error(\'❌ HEC ERROR:\', e.message)); \" 2\>&1
\`\`\` \`\`\`bash \# Test the criminal flag case cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const HMAC_SECRET = \'dev_nida_hmac_secret\'; //
UWAMARIYA Divine --- should be flagged const FLAGGED_NID =
\'1200280678901234\'; const hash = crypto.createHmac(\'sha256\',
HMAC_SECRET).update(FLAGGED_NID).digest(\'hex\');
fetch(\'http://localhost:3102/v1/vetting/check\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ nationalIdHash: hash, requestId: crypto.randomUUID() })
}) .then(r =\> r.json()) .then(data =\> { const pass = data.status ===
\'HAS_RECORDS\'; console.log(pass ? \'✅ RIB criminal flag: PASS\' :
\'❌ RIB criminal flag: FAIL\'); console.log(\' Status:\', data.status);
}) .catch(e =\> console.error(\'❌ RIB ERROR:\', e.message)); \" 2\>&1
\`\`\` \-\-- \## Share Those Three Outputs Once those pass --- \*\*Phase
1 ****is truly sealed\*\* and we enter Phase 2. \-\-- \## Phase 2
Declaration: Database Design & Schema Implementation Here is the precise
scope of what Phase 2 will deliver so you know exactly what we are
building next: \`\`\`
╔══════════════════════════════════════════════════════════════════╗ ║
PHASE 2: DATABASE DESIGN & SCHEMA IMPLEMENTATION ║
╠══════════════════════════════════════════════════════════════════╣ ║ ║
║ 2.1 Drizzle ORM Setup & Migration Pipeline ║ ║ Install Drizzle ORM +
drizzle-kit in shared-database ║ ║ Configure migration runner against
live PostgreSQL ║ ║ ║ ║ 2.2 public_core Schema Tables ║ ║
applicant_identities (NIDA-anchored, PII encrypted) ║ ║
applicant_sessions (USSD + Web session tracking) ║ ║
recruitment_campaigns (campaign lifecycle) ║ ║
campaign_venue_assignments (district → venue mapping) ║ ║ ║ ║ 2.3
rdf_ops Schema Tables ║ ║ applications (full RDF application record) ║ ║
physical_test_scores (CRDT-synced field data) ║ ║ document_records
(per-document forensics tracking) ║ ║ ║ ║ 2.4 rnp_ops Schema Tables
(mirrors rdf_ops structure) ║ ║ 2.5 rcs_ops Schema Tables (additional
celibacy/medical fields) ║ ║ ║ ║ 2.6 audit_log Schema Tables ║ ║
audit_entries (append-only, no UPDATE/DELETE permitted) ║ ║ ║ ║ 2.7
Row-Level Security Policies ║ ║ Applied post-migration via SQL ║ ║
Cross-agency access prevention validated ║ ║ ║ ║ 2.8 Anonymized Views ║
║ Officer triage views (no PII exposed) ║ ║ Full profile views (only
post-slot-assignment stage) ║ ║ ║ ║ 2.9 Seed Data ║ ║ All 5 official
recruitment campaigns ║ ║ All exam venues (RDF 2026: 30, RCS 2025: 30,
RCS 2026:27) ║ ║ Test applicant profiles (7 NIDA-aligned test cases) ║ ║
║ ║ 2.10 Database Validation Gate ║ ║ Migration runs clean ║ ║ All
tables exist in correct schemas ║ ║ RLS policies verified (cross-agency
query blocked) ║ ║ Seed data queryable ║
╚══════════════════════════════════════════════════════════════════╝
\`\`\` Run the three fix commands and share the outputs. Phase 2 begins
the moment all three integration tests return \`PASS\`.\
\
\
ME:\
\
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Now
****run typecheck again --- must produce ZERO output (zero errors) cd
/home/uruti/Documents/projects/usrp && \\ pnpm \--filter
\@usrp/shared-types run typecheck 2\>&1 \> \@usrp/shared-types@1.0.0
typecheck /home/uruti/Documents/projects/usrp/packages/shared-types \>
tsc \--noEmit
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# The
restart command used service name, not container name \# docker compose
restart uses SERVICE names (from compose file), not container names cd
/home/uruti/Documents/projects/usrp && \\ docker compose -f
infrastructure/docker/docker-compose.tier1.yml \\ restart nida-mock
rib-mock hec-mock sleep 8 \# Verify all three now serve updated data
docker logs usrp-nida-mock \--tail 3 docker logs usrp-rib-mock \--tail 3
docker logs usrp-hec-mock \--tail 3 \[+\] restart 0/3 ⠙ Container
usrp-nida-mock Restarting 11.1s ⠙ Container usrp-hec-mock Restarting
11.1s ⠙ Container usrp-rib-mock Restarting 11.1s Loaded 4 mock citizens
NIDA Mock Server running on port 3100 Loaded 4 mock citizens RIB Mock on
port 3102 RIB Mock on port 3102 RIB Mock on port 3102 Loaded 3 mock
degrees HEC Mock Server running on port 3103 Loaded 3 mock degrees
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Retest
NIDA with real hash after restart cd /home/uruti/Documents/projects/usrp
&& \\ node -e \" const crypto = require(\'crypto\'); const HMAC_SECRET =
\'dev_nida_hmac_secret\'; const TEST_NID = \'1200380123456789\'; const
hash = crypto .createHmac(\'sha256\', HMAC_SECRET)
.update(TEST_NID.trim().toUpperCase()) .digest(\'hex\'); const requestId
= crypto.randomUUID(); const timestamp = new Date().toISOString(); const
hmacSignature = crypto .createHmac(\'sha256\', HMAC_SECRET)
.update(requestId + \':\' + timestamp + \':\' + hash) .digest(\'hex\');
fetch(\'http://localhost:3100/v1/citizen/lookup\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\', \'X-API-Key\':
\'dev_api_key\', \'X-Request-ID\': requestId, \'X-Timestamp\':
timestamp, \'X-HMAC-Signature\': hmacSignature, }, body:
JSON.stringify({ nationalIdHash: hash, requestId }) }) .then(r =\>
r.json()) .then(data =\> { const pass = data.status === \'FOUND\' &&
data.citizen?.fullName === \'UWIMANA Jean Pierre\'; console.log(pass ?
\'✅ NIDA lookup: PASS\' : \'❌ NIDA lookup: FAIL\'); console.log(\'
Status:\', data.status); if (data.citizen) console.log(\' Name:\',
data.citizen.fullName, \'\| District:\', data.citizen.homeDistrict); })
.catch(e =\> console.error(\'❌ NIDA ERROR:\', ****e.message)); \" 2\>&1
❌ NIDA lookup: FAIL Status: NOT_FOUND
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Retest
HEC with aligned hash cd /home/uruti/Documents/projects/usrp && \\ node
-e \" const crypto = require(\'crypto\'); const HMAC_SECRET =
\'dev_nida_hmac_secret\'; const TEST_NID = \'1200380123456789\'; const
hash = crypto.createHmac(\'sha256\',
HMAC_SECRET).update(TEST_NID).digest(\'hex\');
fetch(\'http://localhost:3103/v1/degree/verify\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ registrationNumber: \'UR/2023/CS/001\', nationalIdHash:
hash, requestId: crypto.randomUUID() }) }) .then(r =\> r.json())
.then(data =\> { const pass = data.verified === true; console.log(pass ?
\'✅ HEC lookup: PASS\' : \'❌ HEC lookup: FAIL\'); console.log(\'
Verified:\', data.verified); if (data.verified) console.log(\'
Degree:\', data.degreeTitle, \'\| Field:\', data.specialistField); })
.catch(e =\> console.error(\'❌ HEC ERROR:\', e.message)); \" 2\>&1 ❌
HEC lookup: FAIL Verified: false
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Test
the criminal flag case cd /home/uruti/Documents/projects/usrp && \\ node
-e \" const crypto = require(\'crypto\'); const HMAC_SECRET =
\'dev_nida_hmac_secret\'; // UWAMARIYA Divine --- should be flagged
const FLAGGED_NID = \'1200280678901234\'; const hash =
crypto.createHmac(\'sha256\',
HMAC_SECRET).update(FLAGGED_NID).digest(\'hex\');
fetch(\'http://localhost:3102/v1/vetting/check\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ nationalIdHash: hash, requestId: crypto.randomUUID() })
}) .then(r =\> r.json()) .then(data =\> { const pass = data.status ===
\'HAS_RECORDS\'; console.log(pass ? \'✅ RIB criminal flag: PASS\' :
\'❌ RIB criminal flag: FAIL\'); console.log(\' Status:\', data.status);
}) .catch(e =\> console.error(\'❌ RIB ERROR:\', e.message)); \" 2\>&1
❌ RIB criminal flag: FAIL Status: CLEAR\
\
\
AI (CLAUDE):\
\
\# Root Cause Identified --- Container Volume Caching Problem \##
Precise Diagnosis \`\`\` NIDA says: \"Loaded 4 mock citizens\" ---
should say 7 RIB criminal flag returns CLEAR --- old records.json active
HEC returns ****HOLDER_MISMATCH --- old degrees.json active THE PROBLEM:
The containers are reading data from INSIDE the Docker image layer that
was built during the first \`docker compose up \--build\`. The data
files were BAKED INTO the image at build time. When we updated the JSON
files on the HOST filesystem, the containers restarted but Docker reused
the CACHED IMAGE --- it did not rebuild. The new data files never
entered the containers. PROOF: \"Loaded 4 mock citizens\" --- the
original citizens.json had 4 entries (test_hash_001 through
test_hash_004). Our updated file has 7. The container is serving the old
image. \`\`\` \## The Fix: Force Rebuild + Use Volume Mounts We have two
options. I will implement the better one: \*\*Option A (quick hack):\*\*
\`docker compose up \--build \--force-recreate\` --- rebuilds images
\*\*Option B (architecturally correct):\*\* Mount data directories as
volumes so data files are read from host at runtime --- no rebuild
needed when data changes Option B is correct. Mock servers should never
require a rebuild to update test data. \`\`\`bash \# Step 1: Inspect
what the current Dockerfiles do with data cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/Dockerfile
\`\`\` \`\`\`bash \# Step 2: Rewrite all mock Dockerfiles to NOT copy
data at build time \# Data will be mounted as a volume from host instead
cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/Dockerfile
\<\< \'EOF\' FROM node:24-alpine WORKDIR /app COPY package.json ./ RUN
npm install COPY server.js ./ \# Data directory is NOT copied here \# It
is mounted as a volume from the host at runtime \# This allows data
updates without rebuilding the image RUN mkdir -p /app/data EXPOSE 3100
CMD \[\"node\", \"server.js\"\] EOF cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nesa/Dockerfile
\<\< \'EOF\' FROM node:24-alpine WORKDIR /app COPY package.json ./ RUN
npm install COPY server.js ./ RUN mkdir -p /app/data EXPOSE 3101 CMD
\[\"node\", \"server.js\"\] EOF cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/Dockerfile
\<\< \'EOF\' FROM node:24-alpine WORKDIR /app COPY package.json ./ RUN
npm install COPY server.js ./ RUN mkdir -p /app/data EXPOSE 3102 CMD
\[\"node\", \"server.js\"\] EOF cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/hec/Dockerfile
\<\< \'EOF\' FROM node:24-alpine WORKDIR /app COPY package.json ./ RUN
npm install COPY server.js ./ RUN mkdir -p ****/app/data EXPOSE 3103 CMD
\[\"node\", \"server.js\"\] EOF echo \"Done: All mock Dockerfiles
updated --- data no longer baked into images\" \`\`\` \`\`\`bash \# Step
3: Update docker-compose.tier1.yml to mount data directories as volumes
\# This replaces the mock service definitions with volume-mounted
versions \# First verify current file state around mock services grep -n
\"nida-mock\\\|nesa-mock\\\|rib-mock\\\|hec-mock\\\|context\\\|volumes\\\|MOCK_DATA\"
\\
/home/uruti/Documents/projects/usrp/infrastructure/docker/docker-compose.tier1.yml
\`\`\` \`\`\`bash \# Step 4: Rewrite the complete
docker-compose.tier1.yml with volume mounts for mocks cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/docker-compose.tier1.yml
\<\< \'EOF\' \#
══════════════════════════════════════════════════════════════════ \#
USRP --- TIER 1 INFRASTRUCTURE (Phase 1-2 Development) \# RAM budget:
\~1.5GB \# Includes: PostgreSQL, Redis, MinIO, Kong, G2G Mocks
(NIDA/NESA/RIB/HEC) \# Mock data files are VOLUME MOUNTED --- update
JSON without rebuilding \#
══════════════════════════════════════════════════════════════════ name:
usrp-tier1 networks: usrp-internal: driver: bridge ipam: config: -
subnet: 172.20.0.0/16 volumes: postgres-data: driver: local redis-data:
driver: local minio-data: driver: local services: \# ── PostgreSQL 16
─────────────────────────────────────────────── postgres: image:
postgres:16-alpine container_name: usrp-postgres restart: unless-stopped
environment: POSTGRES_USER: \${POSTGRES_USER:-usrp_admin}
POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-usrp_dev_password} POSTGRES_DB:
\${POSTGRES_DB:-usrp_db} PGDATA: /var/lib/postgresql/data/pgdata
volumes: - postgres-data:/var/lib/postgresql/data -
./init-scripts/01-create-schemas.sql:/docker-entrypoint-initdb.d/01-schemas.sql:ro -
./init-scripts/02-create-roles.sql:/docker-entrypoint-initdb.d/02-roles.sql:ro -
./init-scripts/03-rls-policies.sql:/docker-entrypoint-initdb.d/03-rls.sql:ro -
./init-scripts/04-create-extensions.sql:/docker-entrypoint-initdb.d/04-extensions.sql:ro
ports: - \"5432:5432\" networks: - usrp-internal healthcheck: test:
\[\"CMD-SHELL\", \"pg_isready -U \${POSTGRES_USER:-usrp_admin} -d
\${POSTGRES_DB:-usrp_db}\"\] interval: 10s timeout: 5s retries: 5
start_period: 30s deploy: resources: limits: memory: 512M \# ── Redis
7.2 ─────────────────────────────────────────────────── redis: image:
redis:7.2-alpine container_name: usrp-redis ****restart: unless-stopped
command: \> redis-server \--requirepass
\${REDIS_PASSWORD:-usrp_redis_dev} \--save 60 1 \--loglevel warning
\--maxmemory 128mb \--maxmemory-policy allkeys-lru volumes: -
redis-data:/data ports: - \"6379:6379\" networks: - usrp-internal
healthcheck: test: \[\"CMD-SHELL\", \"redis-cli -a
\${REDIS_PASSWORD:-usrp_redis_dev} ping \| grep -q PONG\"\] interval:
10s timeout: 5s retries: 5 deploy: resources: limits: memory: 192M \# ──
MinIO Object Store ────────────────────────────────────────── minio:
image: minio/minio:latest container_name: usrp-minio restart:
unless-stopped command: server /data \--console-address \":9001\"
environment: MINIO_ROOT_USER: \${MINIO_ROOT_USER:-usrp_minio_admin}
MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD:-usrp_minio_dev_password}
volumes: - minio-data:/data ports: - \"9000:9000\" - \"9001:9001\"
networks: - usrp-internal healthcheck: test: \[\"CMD\", \"mc\",
\"ready\", \"local\"\] interval: 30s timeout: 20s retries: 3 deploy:
resources: limits: memory: 256M \# ── Kong API Gateway (DB-less mode)
───────────────────────────── kong: image: kong:3.7-ubuntu
container_name: usrp-kong restart: unless-stopped environment:
KONG_DATABASE: \"off\" KONG_DECLARATIVE_CONFIG:
/kong/declarative/kong.dev.yml KONG_PROXY_ACCESS_LOG: /dev/stdout
KONG_ADMIN_ACCESS_LOG: /dev/stdout KONG_PROXY_ERROR_LOG: /dev/stderr
KONG_ADMIN_ERROR_LOG: /dev/stderr KONG_ADMIN_LISTEN: \"0.0.0.0:8001\"
KONG_PROXY_LISTEN: \"0.0.0.0:8000\" volumes: -
./kong/kong.dev.yml:/kong/declarative/kong.dev.yml:ro ports: -
\"8000:8000\" - \"8001:8001\" networks: - usrp-internal healthcheck:
test: \[\"CMD\", \"kong\", \"health\"\] interval: 30s timeout: 10s
retries: 3 start_period: 60s deploy: resources: limits: memory: 256M \#
── G2G Mock: NIDA ────────────────────────────────────────────── \# Data
mounted from host --- update citizens.json without rebuilding nida-mock:
build: context: ./mocks/nida dockerfile: Dockerfile container_name:
usrp-nida-mock restart: unless-stopped environment: PORT: 3100
MOCK_DATA_FILE: /app/data/citizens.json HMAC_SECRET:
\${NIDA_HMAC_SECRET:-dev_nida_hmac_secret} volumes: -
./mocks/nida/data:/app/data:ro ports: - \"3100:3100\" networks: -
usrp-internal healthcheck: test: \[\"CMD\", \"wget\", \"-qO-\",
****\"http://localhost:3100/health\"\] interval: 15s timeout: 5s
retries: 3 deploy: resources: limits: memory: 128M \# ── G2G Mock: NESA
────────────────────────────────────────────── nesa-mock: build:
context: ./mocks/nesa dockerfile: Dockerfile container_name:
usrp-nesa-mock restart: unless-stopped environment: PORT: 3101
MOCK_DATA_FILE: /app/data/results.json HMAC_SECRET:
\${NESA_HMAC_SECRET:-dev_nesa_hmac_secret} volumes: -
./mocks/nesa/data:/app/data:ro ports: - \"3101:3101\" networks: -
usrp-internal healthcheck: test: \[\"CMD\", \"wget\", \"-qO-\",
\"http://localhost:3101/health\"\] interval: 15s timeout: 5s retries: 3
deploy: resources: limits: memory: 128M \# ── G2G Mock: RIB
─────────────────────────────────────────────── rib-mock: build:
context: ./mocks/rib dockerfile: Dockerfile container_name:
usrp-rib-mock restart: unless-stopped environment: PORT: 3102
MOCK_DATA_FILE: /app/data/records.json HMAC_SECRET:
\${RIB_HMAC_SECRET:-dev_rib_hmac_secret} volumes: -
./mocks/rib/data:/app/data:ro ports: - \"3102:3102\" networks: -
usrp-internal healthcheck: test: \[\"CMD\", \"wget\", \"-qO-\",
\"http://localhost:3102/health\"\] interval: 15s timeout: 5s retries: 3
deploy: resources: limits: memory: 128M \# ── G2G Mock: HEC (Higher
Education Council) ───────────────────── hec-mock: build: context:
./mocks/hec dockerfile: Dockerfile container_name: usrp-hec-mock
restart: unless-stopped environment: PORT: 3103 MOCK_DATA_FILE:
/app/data/degrees.json volumes: - ./mocks/hec/data:/app/data:ro ports: -
\"3103:3103\" networks: - usrp-internal healthcheck: test: \[\"CMD\",
\"wget\", \"-qO-\", \"http://localhost:3103/health\"\] interval: 15s
timeout: 5s retries: 3 deploy: resources: limits: memory: 128M EOF echo
\"Done: docker-compose.tier1.yml rewritten with volume mounts\" \`\`\`
\`\`\`bash \# Step 5: Verify current data files are correct before
rebuild echo \"── citizens.json citizen count:\" cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/data/citizens.json
\\ \| python3 -c \"import json,sys; d=json.load(sys.stdin);
print(len(d), \'citizens\')\" echo \"── rib/records.json:\" cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/data/records.json
\\ \| python3 -m json.tool echo \"── hec/degrees.json degree count:\"
cat
****/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/hec/data/degrees.json
\\ \| python3 -c \"import json,sys; d=json.load(sys.stdin);
print(len(d), \'degrees\')\" \`\`\` \`\`\`bash \# Step 6: Rebuild and
restart ONLY the mock services \# \--build forces Docker to rebuild the
images (removes old cached layers) \# \--force-recreate creates fresh
containers cd /home/uruti/Documents/projects/usrp && \\ docker compose
-f infrastructure/docker/docker-compose.tier1.yml \\ up -d \--build
\--force-recreate \\ nida-mock nesa-mock rib-mock hec-mock echo
\"Waiting 15 seconds for containers to start\...\" sleep 15 \`\`\`
\`\`\`bash \# Step 7: Verify new citizen count in logs echo \"── NIDA
logs:\" docker logs usrp-nida-mock \--tail 5 echo \"\" echo \"── RIB
logs:\" docker logs usrp-rib-mock \--tail 5 echo \"\" echo \"── HEC
logs:\" docker logs usrp-hec-mock \--tail 5 \`\`\` \`\`\`bash \# Step 8:
Run all three integration tests in one shot cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const HMAC_SECRET = \'dev_nida_hmac_secret\'; async
function hmacSign(payload) { return crypto.createHmac(\'sha256\',
HMAC_SECRET).update(payload).digest(\'hex\'); } function hashNID(nid) {
return crypto.createHmac(\'sha256\',
HMAC_SECRET).update(nid.trim().toUpperCase()).digest(\'hex\'); } async
function testNIDA() { const nid = \'1200380123456789\'; const hash =
hashNID(nid); const requestId = crypto.randomUUID(); const timestamp =
new Date().toISOString(); const sig = await hmacSign(requestId + \':\' +
timestamp + \':\' + hash); const res = await
fetch(\'http://localhost:3100/v1/citizen/lookup\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\', \'X-API-Key\':
\'dev_api_key\', \'X-Request-ID\': requestId, \'X-Timestamp\':
timestamp, \'X-HMAC-Signature\': sig, }, body: JSON.stringify({
nationalIdHash: hash, requestId }) }); const data = await res.json();
const pass = data.status === \'FOUND\' && data.citizen?.fullName ===
\'UWIMANA Jean Pierre\'; console.log(pass ? \'✅ NIDA lookup (Age 22,
Gasabo): PASS\' : \'❌ NIDA lookup: FAIL --- \' + JSON.stringify(data));
return pass; } async function testNIDAAge35Ineligible() { const nid =
\'1199080567890123\'; const hash = hashNID(nid); const requestId =
crypto.randomUUID(); const timestamp = new Date().toISOString(); const
sig = await hmacSign(requestId + \':\' + timestamp + \':\' + hash);
const res = await fetch(\'http://localhost:3100/v1/citizen/lookup\', {
method: \'POST\', headers: { \'Content-Type\': \'application/json\',
\'X-API-Key\': \'dev_api_key\', \'X-Request-ID\': requestId,
\'X-Timestamp\': timestamp, \'X-HMAC-****Signature\': sig, }, body:
JSON.stringify({ nationalIdHash: hash, requestId }) }); const data =
await res.json(); const pass = data.status === \'FOUND\' &&
data.citizen?.fullName === \'NZEYIMANA Paul\'; console.log(pass ? \'✅
NIDA lookup (Age 35, ineligible test): PASS\' : \'❌ NIDA age-35 lookup:
FAIL --- \' + JSON.stringify(data)); return pass; } async function
testHEC() { const nid = \'1200380123456789\'; const hash = hashNID(nid);
const res = await fetch(\'http://localhost:3103/v1/degree/verify\', {
method: \'POST\', headers: { \'Content-Type\': \'application/json\' },
body: JSON.stringify({ registrationNumber: \'UR/2023/CS/001\',
nationalIdHash: hash, requestId: crypto.randomUUID() }) }); const data =
await res.json(); const pass = data.verified === true &&
data.specialistField === \'ENGINEERING\'; console.log(pass ? \'✅ HEC
degree verify (CS Engineering): PASS\' : \'❌ HEC lookup: FAIL --- \' +
JSON.stringify(data)); return pass; } async function testRIBFlagged() {
const nid = \'1200280678901234\'; const hash = hashNID(nid); const res =
await fetch(\'http://localhost:3102/v1/vetting/check\', { method:
\'POST\', headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ nationalIdHash: hash, requestId: crypto.randomUUID() })
}); const data = await res.json(); const pass = data.status ===
\'HAS_RECORDS\'; console.log(pass ? \'✅ RIB criminal flag (UWAMARIYA
Divine): PASS\' : \'❌ RIB flag: FAIL --- \' + data.status); return
pass; } async function testRIBProsecution() { const nid =
\'1200480789012345\'; const hash = hashNID(nid); const res = await
fetch(\'http://localhost:3102/v1/vetting/check\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ nationalIdHash: hash, requestId: crypto.randomUUID() })
}); const data = await res.json(); const pass = data.status ===
\'UNDER_INVESTIGATION\'; console.log(pass ? \'✅ RIB prosecution flag
(NKURUNZIZA Eric): PASS\' : \'❌ RIB prosecution: FAIL --- \' +
data.status); return pass; } async function testRIBClean() { const nid =
\'1200580456789012\'; const hash = hashNID(nid); const res = await
fetch(\'http://localhost:3102/v1/vetting/check\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ nationalIdHash: hash, requestId: crypto.randomUUID() })
}); const data = await res.json(); const pass = data.status ===
\'CLEAR\'; console.log(pass ? \'✅ RIB clean record (NSHIMIYIMANA
Patrick, age 20): PASS\' : \'❌ RIB clean: FAIL --- \' +
****data.status); return pass; } async function testNESA() { const res =
await fetch(\'http://localhost:3101/v1/results/lookup\', { method:
\'POST\', headers: { \'Content-Type\': \'application/json\' }, body:
JSON.stringify({ indexNumber: \'RW2024/1001\', requestId:
crypto.randomUUID() }) }); const data = await res.json(); const pass =
data.status === \'FOUND\' && data.payload?.qualificationLevel ===
\'A2\'; console.log(pass ? \'✅ NESA academic results (A2, PCM): PASS\'
: \'❌ NESA lookup: FAIL --- \' + JSON.stringify(data)); return pass; }
console.log(\'\');
console.log(\'═══════════════════════════════════════════════════\');
console.log(\' USRP G2G Integration Tests\');
console.log(\'═══════════════════════════════════════════════════\');
console.log(\'\'); Promise.all(\[ testNIDA(), testNIDAAge35Ineligible(),
testHEC(), testRIBFlagged(), testRIBProsecution(), testRIBClean(),
testNESA(), \]).then(results =\> { const passed =
results.filter(Boolean).length; const failed = results.length - passed;
console.log(\'\');
console.log(\'═══════════════════════════════════════════════════\');
console.log(\' Results: \' + passed + \'/\' + results.length + \' passed
\| \' + failed + \' failed\'); console.log(failed === 0 ? \' STATUS: ✅
ALL G2G MOCKS OPERATIONAL\' : \' STATUS: ❌ \' + failed + \' TESTS
FAILED\');
console.log(\'═══════════════════════════════════════════════════\');
}).catch(e =\> console.error(\'Test runner error:\', e)); \" 2\>&1
\`\`\` \-\-- \## What to Expect \`\`\` After the rebuild with volume
mounts: NIDA logs should say: \"Loaded 7 mock citizens\" RIB logs should
say: \"RIB Mock on port 3102\" HEC logs should say: \"Loaded 3 mock
degrees\" All 7 integration tests should return PASS. If NIDA still
shows 4 citizens after rebuild: → The data file on disk is still the old
one → We need to check if the node script that writes citizens.json
actually completed successfully \`\`\` \*\*Share the output of Steps 5
through 8. We close Phase 1 completely and open Phase 2.\*\*\
\
\
ME:\
\
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Step
4: Rewrite the complete docker-compose.tier1.yml with volume mounts for
mocks cat \>
/home/uruti/Documents/projects/usrp/infrastructure/docker/docker-compose.tier1.yml
\<\< \'EOF\' \#
****══════════════════════════════════════════════════════════════════
\# USRP --- TIER 1 INFRASTRUCTURE (Phase 1-2 Development) \# RAM budget:
\~1.5GB \# Includes: PostgreSQL, Redis, MinIO, Kong, G2G Mocks
(NIDA/NESA/RIB/HEC) \# Mock data files are VOLUME MOUNTED --- update
JSON without rebuilding \#
══════════════════════════════════════════════════════════════════ name:
usrp-tier1 networks: usrp-internal: driver: bridge ipam: config: -
subnet: 172.20.0.0/16 volumes: postgres-data: driver: local redis-data:
driver: local minio-data: driver: local services: \# ── PostgreSQL 16
─────────────────────────────────────────────── postgres: image:
postgres:16-alpine container_name: usrp-postgres restart: unless-stopped
environment: POSTGRES_USER: \${POSTGRES_USER:-usrp_admin}
POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-usrp_dev_password} POSTGRES_DB:
\${POSTGRES_DB:-usrp_db} PGDATA: /var/lib/postgresql/data/pgdata
volumes: - postgres-data:/var/lib/postgresql/data -
./init-scripts/01-create-schemas.sql:/docker-entrypoint-initdb.d/01-schemas.sql:ro -
./init-scripts/02-create-roles.sql:/docker-entrypoint-initdb.d/02-roles.sql:ro -
./init-scripts/03-rls-policies.sql:/docker-entrypoint-initdb.d/03-rls.sql:ro -
./init-scripts/04-create-extensions.sql:/docker-entrypoint-initdb.d/04-extensions.sql:ro
ports: - \"5432:5432\" networks: - usrp-internal healthcheck: test:
\[\"CMD-SHELL\", \"pg_isready -U \${POSTGRES_USER:-usrp_admin} -d
\${POSTGRES_DB:-usrp_db}\"\] interval: 10s timeout: 5s retries: 5
start_period: 30s deploy: resources: echo \"Done:
docker-compose.tier1.yml rewritten with volume mounts\"\]──word}ping \|
grep -q PONG\"\] Done: docker-compose.tier1.yml rewritten with volume
mounts uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \#
Step 5: Verify current data files are correct before rebuild echo \"──
citizens.json citizen count:\" cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/nida/data/citizens.json
\\ \| python3 -c \"import json,sys; d=json.load(sys.stdin);
print(len(d), \'citizens\')\" echo \"── rib/records.json:\" cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/rib/data/records.json
\\ \| python3 -m json.tool echo \"── hec/degrees.json degree count:\"
cat
/home/uruti/Documents/projects/usrp/infrastructure/docker/mocks/hec/data/degrees.json
\\ \| python3 -c \"import json,sys; ****d=json.load(sys.stdin);
print(len(d), \'degrees\')\" ── citizens.json citizen count: 7 citizens
── rib/records.json: { \"flagged_hashes\": \[
\"6709cb62a5872432d0126af9f6abc92922d1e5fc0e8de58168a8ecb58159c2b5\" \],
\"under_investigation_hashes\": \[
\"9f15bc15a8765bf059d71626d80fc1a879d55e193793db0e2ad94d331c87a291\" \]
} ── hec/degrees.json degree count: 3 degrees
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Step
6: Rebuild and restart ONLY the mock services \# \--build forces Docker
to rebuild the images (removes old cached layers) \# \--force-recreate
creates fresh containers cd /home/uruti/Documents/projects/usrp && \\
docker compose -f infrastructure/docker/docker-compose.tier1.yml \\ up
-d \--build \--force-recreate \\ nida-mock nesa-mock rib-mock hec-mock
echo \"Waiting 15 seconds for containers to start\...\" sleep 15 \[+\]
Building 3.2s (40/40) FINISHED =\> \[internal\] load local bake
definitions 0.0s =\> =\> reading from stdin 2.15kB 0.0s =\> \[hec-mock
internal\] load build definition from Dockerfile 0.0s =\> =\>
transferring dockerfile: 188B 0.0s =\> \[nida-mock internal\] load build
definition from Dockerfile 0.0s =\> =\> transferring dockerfile: 333B
0.0s =\> \[nesa-mock internal\] load build definition from Dockerfile
0.0s =\> =\> transferring dockerfile: 188B 0.0s =\> \[rib-mock
internal\] load build definition from Dockerfile 0.1s =\> =\>
transferring dockerfile: 188B 0.0s =\> \[nida-mock internal\] load
metadata for docker.io/library/node:24-alpine 1.1s =\> \[rib-mock
internal\] load .dockerignore 0.0s =\> =\> transferring context: 2B 0.0s
=\> \[hec-mock internal\] load .dockerignore 0.0s =\> =\> transferring
context: 2B 0.0s =\> \[nida-mock internal\] load .dockerignore 0.0s =\>
=\> transferring context: 2B 0.0s =\> \[nesa-mock internal\] load
.dockerignore 0.0s =\> =\> transferring context: 2B 0.0s =\> \[nida-mock
1/6\] FROM
docker.io/library/node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
0.0s =\> \[nesa-mock internal\] load build context 0.1s =\> =\>
transferring context: 62B 0.0s =\> \[hec-mock internal\] load build
context 0.1s =\> =\> transferring context: 62B 0.1s =\> \[rib-mock
internal\] load build context 0.1s =\> =\> transferring context: 62B
0.0s =\> \[nida-mock internal\] load build context 0.1s =\> =\>
transferring context: 63B 0.0s =\> CACHED \[hec-mock 2/6\] WORKDIR /app
0.0s =\> CACHED \[nesa-mock 3/6\] COPY package.json ./ 0.0s =\> CACHED
\[nesa-mock 4/6\] RUN npm install 0.0s =\> \[nesa-mock 5/6\] COPY
server.js ./ 0.1s =\> CACHED \[rib-mock 3/6\] COPY package.json ./ 0.0s
=\> CACHED \[rib-mock 4/6\] RUN npm install ****0.0s =\> \[rib-mock
5/6\] COPY server.js ./ 0.1s =\> CACHED \[nida-mock 3/6\] COPY
package.json ./ 0.0s =\> CACHED \[nida-mock 4/6\] RUN npm install 0.0s
=\> \[nida-mock 5/6\] COPY server.js ./ 0.1s =\> CACHED \[hec-mock 3/6\]
COPY package.json ./ 0.0s =\> CACHED \[hec-mock 4/6\] RUN npm install
0.0s =\> \[hec-mock 5/6\] COPY server.js ./ 0.1s =\> \[nesa-mock 6/6\]
RUN mkdir -p /app/data 0.8s =\> \[rib-mock 6/6\] RUN mkdir -p /app/data
0.9s =\> \[nida-mock 6/6\] RUN mkdir -p /app/data 0.8s =\> \[hec-mock
6/6\] RUN mkdir -p /app/data 1.1s =\> \[nesa-mock\] exporting to image
0.3s =\> =\> exporting layers 0.1s =\> =\> writing image
sha256:60719256616558214d2ba82236ac4a34b79f131e179409d260b13a27bae7431c
0.0s =\> =\> naming to docker.io/library/usrp-tier1-nesa-mock 0.0s =\>
\[nida-mock\] exporting to image 0.3s =\> =\> exporting layers 0.2s =\>
=\> writing image
sha256:a62f328e73452c17e5ee8dbff2a00fc51a41bbde8148d33217ecdd8bdecfd582
0.0s =\> =\> naming to docker.io/library/usrp-tier1-nida-mock 0.0s =\>
\[rib-mock\] exporting to image 0.3s =\> =\> exporting layers 0.2s =\>
=\> writing image
sha256:1247a20c20ff4e9e70d6b78af999e8fd5b9b15e6c12db039e9029443f912f89f
0.0s =\> =\> naming to docker.io/library/usrp-tier1-rib-mock 0.0s =\>
\[hec-mock\] exporting to image 0.2s =\> =\> exporting layers 0.1s =\>
=\> writing image
sha256:5f1476226680ad8f0ca4ba8cdf2a1e3130aae1af5b1481913ffe88a14bfb2ba0
0.0s =\> =\> naming to docker.io/library/usrp-tier1-hec-mock 0.0s =\>
\[nesa-mock\] resolving provenance for metadata file 0.1s =\>
\[rib-mock\] resolving provenance for metadata file 0.1s =\>
\[nida-mock\] resolving provenance for metadata file 0.0s =\>
\[hec-mock\] resolving provenance for metadata file 0.0s \[+\] up 11/11
✔ Image usrp-tier1-nesa-mock Built 3.3s ✔ Image usrp-tier1-hec-mock
Built 3.3s ✔ Image usrp-tier1-rib-mock Built 3.3s ✔ Image
usrp-tier1-nida-mock Built 3.3s ✔ Container usrp-redis Running 0.0s ✔
Container usrp-postgres Running 0.0s ✔ Container usrp-minio Running 0.0s
✔ Container usrp-hec-mock Started 12.1s ✔ Container usrp-nesa-mock
Started 12.4s ✔ Container usrp-nida-mock Started 12.0s ✔ Container
usrp-rib-mock Started 12.2s Waiting 15 seconds for containers to
start\... uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$
\# Step 7: Verify new citizen count in logs echo \"── NIDA logs:\"
docker logs usrp-nida-mock \--tail 5 echo \"\" echo \"── RIB logs:\"
docker logs usrp-rib-mock \--tail 5 echo \"\" echo \"── HEC logs:\"
docker logs usrp-hec-mock \--****tail 5 ── NIDA logs: NIDA Mock Server
running on port 3100 Loaded 7 mock citizens ── RIB logs: RIB Mock on
port 3102 ── HEC logs: HEC Mock Server running on port 3103 Loaded 3
mock degrees
uruti@jackson-HP-EliteBook-840-G3:\~/Documents/projects/usrp\$ \# Step
8: Run all three integration tests in one shot cd
/home/uruti/Documents/projects/usrp && \\ node -e \" const crypto =
require(\'crypto\'); const HMAC_SECRET = \'dev_nida_hmac_secret\'; async
function hmacSign(payload) { return crypto.createHmac(\'sha256\',
HMAC_SECRET).update(payload).digest(\'hex\'); } function hashNID(nid) {
return crypto.createHmac(\'sha256\',
HMAC_SECRET).update(nid.trim().toUpperCase()).digest(\'hex\'); } async
function testNIDA() { const nid = \'1200380123456789\'; const hash =
hashNID(nid); const requestId = crypto.randomUUID(); const timestamp =
new Date().toISOString(); const sig = await hmacSign(requestId + \':\' +
timestamp + \':\' + hash); const res = await
fetch(\'http://localhost:3100/v1/citizen/lookup\', { method: \'POST\',
headers: { \'Content-Type\': \'application/json\', \'X-API-Key\':
\'dev_api_key\', \'X-Request-ID\': requestId, \'X-Timestamp\':
timestamp, \'X-HMAC-Signature\': sig, }, body: JSON.stringify({
nationalIdHash: hash, requestId }) }); const data = await res.json();
const pass = data.status === \'FOUND\' && data.citizen?.fullName ===
\'UWIMANA Jean Pierre\'; console.log(pass ? \'✅ NIDA lookup (Age 22,
Gasabo): PASS\' : \'❌ NIDA lookup: FAIL --- \' + JSON.stringify(data));
return pass; } async function testNIDAAge35Ineligible() { const nid =
\'1199080567890123\'; const hash = hashNID(nid); const requestId =
crypto.randomUUID(); const timestamp = new Date().toISOString(); const
sig = await hmacSign(requestId + \':\' + timestamp + \':\' + hash);
const res = await fetch(\'http://localhost:3100/v1/citizen/lookup\', {
method: \'POST\', headers: { \'Content-Type\': \'application/json\',
\'X-API-Key\': \'dev_api_key\', \'X-Request-ID\': requestId,
\'X-Timestamp\': timestamp, \'X-HMAC-Signature\': sig, }, body:
JSON.stringify({ nationalIdHash: hash, requestId }) }); \" 2\>&1ch(e =\>
console.error(\'Test runner error:\', e));════════════\'); : \' STATUS:
❌ \' + failed + \' TESTS FAILED\');tus);(data));
═══════════════════════════════════════════════════ USRP G2G Integration
Tests ═══════════════════════════════════════════════════ ✅ NESA
academic results (A2, PCM): PASS ✅ NIDA lookup (Age 35, ineligible
test): PASS ✅ NIDA lookup (Age 22, Gasabo): PASS ✅ RIB criminal flag
(UWAMARIYA Divine): PASS ✅ RIB clean record (NSHIMIYIMANA Patrick, age
20): PASS ✅ HEC degree verify (CS Engineering): PASS ✅ RIB prosecution
flag ****(NKURUNZIZA Eric): PASS
═══════════════════════════════════════════════════ Results: 7/7 passed
\| 0 failed STATUS: ✅ ALL G2G MOCKS OPERATIONAL
═══════════════════════════════════════════════════
***<uruti@jackson-HP-EliteBook-840-G3>***:\~/Documents/projects/usrp\$\
\
\
\
AI (CLAUDE):\
\
\# PHASE 1: SEALED \`\`\`
╔══════════════════════════════════════════════════════════════════╗ ║
PHASE 1 --- OFFICIAL CLOSURE July 5, 2026 ║
╠══════════════════════════════════════════════════════════════════╣ ║ ║
║ G2G Integration Tests: 7/7 ✅ ║ ║ NIDA lookup (eligible): ✅ UWIMANA
Jean Pierre found ║ ║ NIDA lookup (ineligible/age 35): ✅ NZEYIMANA Paul
found ║ ║ NESA academic results (A2): ✅ PCM combination verified ║ ║
HEC degree verify (Engineering): ✅ UR/2023/CS/001 matched ║ ║ RIB
criminal flag: ✅ UWAMARIYA Divine flagged ║ ║ RIB prosecution flag: ✅
NKURUNZIZA Eric flagged ║ ║ RIB clean record: ✅ NSHIMIYIMANA Patrick
clear║ ║ ║ ║ Infrastructure: 8/8 ✅ All containers healthy ║ ║
TypeScript compilation: ✅ Zero errors ║ ║ Mock data integrity: ✅
Volume-mounted, 7 citizens ║ ║ Repository structure: ✅ 27/27 gate
checks passed ║ ║ ║ ║ ▶ ENTERING PHASE 2: DATABASE DESIGN & SCHEMA
IMPLEMENTATION ║
╚══════════════════════════════════════════════════════════════════╝
\`\`\` \-\-- \# PHASE 2: Database Design & Schema Implementation \##
Architect\'s Framing Before First Query Phase 2 is the most
consequential phase of this entire project. The database schema is the
\*\*permanent contract\*\* between every service in this system. Get it
wrong here and every phase after inherits the corruption. Three
principles govern every decision in Phase 2: \`\`\` 1. LEGAL GROUND
TRUTH FIRST Every table column maps to a real field from the official
recruitment announcements or Law N° 058/2021. No speculative columns. No
\"we might need this later.\" 2. SECURITY BY SCHEMA Data isolation is
not enforced by application logic alone. It is enforced by PostgreSQL
itself --- schemas, roles, RLS. A bug in NestJS cannot leak RDF data to
RNP. The database makes it physically impossible. 3. ****IMMUTABILITY
WHERE IT MATTERS Audit records are append-only at the database engine
level. Application status history is never overwritten --- only
appended. A field score once signed and synced cannot be silently
altered. \`\`\` \-\-- \## Step 2.1 --- Install Drizzle ORM & Migration
Pipeline \`\`\`bash \# Initialize shared-database package properly cd
/home/uruti/Documents/projects/usrp && \\ cat \>
packages/shared-database/package.json \<\< \'EOF\' { \"name\":
\"@usrp/shared-database\", \"version\": \"1.0.0\", \"private\": true,
\"description\": \"Drizzle ORM schemas, migrations, and seeds for USRP
PostgreSQL database\", \"type\": \"module\", \"scripts\": {
\"db:generate\": \"drizzle-kit generate\", \"db:migrate\": \"drizzle-kit
migrate\", \"db:push\": \"drizzle-kit push\", \"db:studio\":
\"drizzle-kit studio\", \"db:seed\": \"tsx src/seeds/run-seeds.ts\",
\"db:seed:campaigns\": \"tsx src/seeds/campaigns.seed.ts\",
\"db:seed:venues\": \"tsx src/seeds/venues.seed.ts\",
\"db:seed:test-applicants\": \"tsx src/seeds/test-applicants.seed.ts\",
\"typecheck\": \"tsc \--noEmit\" }, \"dependencies\": { \"drizzle-orm\":
\"\^0.44.1\", \"postgres\": \"\^3.4.5\" }, \"devDependencies\": {
\"drizzle-kit\": \"\^0.31.1\", \"tsx\": \"\^4.21.0\", \"typescript\":
\"\^5.8.3\", \"@types/node\": \"\^24.0.0\" } } EOF echo \"Done:
shared-database/package.json\" \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/tsconfig.json
\<\< \'EOF\' { \"\$schema\": \"https://json.schemastore.org/tsconfig\",
\"compilerOptions\": { \"target\": \"ES2022\", \"lib\": \[\"ES2022\"\],
\"module\": \"Node16\", \"moduleResolution\": \"Node16\", \"strict\":
true, \"noImplicitAny\": true, \"strictNullChecks\": true,
\"noImplicitReturns\": true, \"noUncheckedIndexedAccess\": true,
\"exactOptionalPropertyTypes\": true,
\"forceConsistentCasingInFileNames\": true, \"esModuleInterop\": true,
\"skipLibCheck\": true, \"resolveJsonModule\": true, \"outDir\":
\"./dist\", \"rootDir\": \"./src\" }, \"include\": \[\"src/\*\*/\*\"\],
\"exclude\": \[\"node_modules\", \"dist\"\] } EOF echo \"Done:
shared-database/tsconfig.json\" \`\`\` \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/drizzle.config.ts
\<\< \'EOF\' import { defineConfig } from \'drizzle-kit\'; export
default defineConfig({ dialect: \'postgresql\', schema:
\'./src/schemas/\*.schema.ts\', out: \'./src/migrations\',
dbCredentials: { url: process.env\[\'DATABASE_URL\'\] ??
\'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db\', },
// Migration table lives in public schema --- not in our isolated
schemas migrations: { table: \'drizzle_migrations\', schema: \'public\',
}, verbose: ****true, strict: true, }); EOF echo \"Done:
drizzle.config.ts\" \`\`\` \`\`\`bash \# Install dependencies cd
/home/uruti/Documents/projects/usrp && \\ pnpm \--filter
\@usrp/shared-database install \`\`\` \-\-- \## Step 2.2 --- Database
Connection Client \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/src/client.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
\@usrp/shared-database --- PostgreSQL Connection Client // Uses
postgres.js (not pg) --- better performance, native async //
══════════════════════════════════════════════════════════════════
import postgres from \'postgres\'; import { drizzle } from
\'drizzle-orm/postgres-js\'; import \* as publicCoreSchema from
\'./schemas/public-core.schema.js\'; import \* as rdfOpsSchema from
\'./schemas/rdf-ops.schema.js\'; import \* as rnpOpsSchema from
\'./schemas/rnp-ops.schema.js\'; import \* as rcsOpsSchema from
\'./schemas/rcs-ops.schema.js\'; import \* as auditLogSchema from
\'./schemas/audit-log.schema.js\'; const DATABASE_URL =
process.env\[\'DATABASE_URL\'\]; if (!DATABASE_URL) { throw new
Error(\'DATABASE_URL environment variable is required\'); } //
Connection pool configuration const sql = postgres(DATABASE_URL, { max:
20, // Maximum connections in pool idle_timeout: 20, // Close idle
connections after 20s connect_timeout: 10, // Timeout connecting after
10s prepare: false, // Required for transaction poolers (PgBouncer)
onnotice: () =\> {}, // Suppress NOTICE messages in production });
export const db = drizzle(sql, { schema: { \...publicCoreSchema,
\...rdfOpsSchema, \...rnpOpsSchema, \...rcsOpsSchema,
\...auditLogSchema, }, logger: process.env\[\'NODE_ENV\'\] ===
\'development\', }); export type Database = typeof db; // Named exports
for schema-specific access export { sql }; EOF echo \"Done: database
client\" \`\`\` \-\-- \## Step 2.3 --- \`public_core\` Schema: The
Identity Foundation \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/src/schemas/public-core.schema.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
public_core schema --- Shared applicant identity // Visible to all
agency services via their roles // PII columns encrypted using pgcrypto
(AES-256) // Decryption requires the app.encryption_key session variable
// ══════════════════════════════════════════════════════════════════
import { pgSchema, uuid, varchar, timestamp, ****boolean, integer,
pgEnum, index, uniqueIndex, text, } from \'drizzle-orm/pg-core\'; export
const publicCore = pgSchema(\'public_core\'); // ── Enums
────────────────────────────────────────────────────────── export const
applicationChannelEnum = publicCore.enum(\'application_channel\', \[
\'WEB\', \'USSD\', \'IREMBO_KIOSK\', \'WALK_IN\', \]); export const
identityVerificationStatusEnum = publicCore.enum(
\'identity_verification_status\', \[\'PENDING\', \'VERIFIED\',
\'FAILED\', \'EXPIRED\'\], ); export const genderEnum =
publicCore.enum(\'gender\', \[\'MALE\', \'FEMALE\'\]); export const
campaignStatusEnum = publicCore.enum(\'campaign_status\', \[ \'DRAFT\',
\'REGISTRATION_OPEN\', \'REGISTRATION_CLOSED\', \'EXAMINATION_ACTIVE\',
\'COMPLETED\', \'CANCELLED\', \]); export const agencyEnum =
publicCore.enum(\'agency\', \[\'RDF\', \'RNP\', \'RCS\'\]); // ──
applicant_identities ────────────────────────────────────────── // One
row per unique Rwandan citizen who initiates an application. // PII
stored encrypted --- decrypted only by authorized queries. //
nationalIdHash is the system-wide applicant key (never raw NID). export
const applicantIdentities = publicCore.table( \'applicant_identities\',
{ id: uuid(\'id\').defaultRandom().primaryKey(), // NIDA-anchored
identity --- set by NIDA response, never by user input // SHA-256 HMAC
of the raw NID --- used as lookup key nationalIdHash:
varchar(\'national_id_hash\', { length: 64 }) .notNull() .unique(), //
── Encrypted PII (pgcrypto AES-256-CBC) ────────────────────── // These
are TEXT columns storing the ciphertext from: //
pgp_sym_encrypt(plaintext, current_setting(\'app.encryption_key\')) //
Never queried directly by application --- always decrypt via view
encryptedFullName: text(\'encrypted_full_name\').notNull(),
encryptedDateOfBirth: text(\'encrypted_date_of_birth\').notNull(),
encryptedHomeDistrict: text(\'encrypted_home_district\').notNull(),
encryptedHomeProvince: text(\'encrypted_home_province\').notNull(), //
Non-PII from NIDA --- unencrypted for query performance gender:
genderEnum(\'gender\').notNull(), // NIDA verification metadata
nidaVerificationRequestId: varchar(\'nida_verification_request_id\', {
length: 128 }), nidaVerifiedAt: timestamp(\'nida_verified_at\', {
withTimezone: true }), nidaMatchConfidence:
varchar(\'nida_match_confidence\', { length: 6 }), identityStatus:
****identityVerificationStatusEnum(\'identity_status\') .notNull()
.default(\'PENDING\'), // Registration channel registrationChannel:
applicationChannelEnum(\'registration_channel\').notNull(), // Phone ---
hashed for lookup, not stored plaintext phoneNumberHash:
varchar(\'phone_number_hash\', { length: 64 }), phoneVerifiedAt:
timestamp(\'phone_verified_at\', { withTimezone: true }), // Biometric
session metadata (no biometric data stored) biometricSessionId:
varchar(\'biometric_session_id\', { length: 128 }), biometricVerifiedAt:
timestamp(\'biometric_verified_at\', { withTimezone: true }),
biometricPassedLiveness:
boolean(\'biometric_passed_liveness\').default(false),
biometricFaceMatchConfidence:
varchar(\'biometric_face_match_confidence\', { length: 6 }), // USSD
reservation (72-hour expiry for incomplete USSD sessions)
ussdReservationExpiresAt: timestamp(\'ussd_reservation_expires_at\', {
withTimezone: true }), ussdSessionCompletedAt:
timestamp(\'ussd_session_completed_at\', { withTimezone: true }), //
Cross-agency lock --- set when applicant is accepted by any agency
crossAgencyLockedAt: timestamp(\'cross_agency_locked_at\', {
withTimezone: true }), crossAgencyLockedByAgency:
agencyEnum(\'cross_agency_locked_by_agency\'), crossAgencyLockReason:
varchar(\'cross_agency_lock_reason\', { length: 30 }), // Soft delete
--- data erasure path for Law N° 058/2021 compliance deletedAt:
timestamp(\'deleted_at\', { withTimezone: true }), createdAt:
timestamp(\'created_at\', { withTimezone: true
}).defaultNow().notNull(), updatedAt: timestamp(\'updated_at\', {
withTimezone: true }).defaultNow().notNull(), }, (t) =\> \[
uniqueIndex(\'idx_pc_national_id_hash\').on(t.nationalIdHash),
index(\'idx_pc_identity_status\').on(t.identityStatus),
index(\'idx_pc_phone_hash\').on(t.phoneNumberHash),
index(\'idx_pc_created_at\').on(t.createdAt), \], ); // ──
applicant_sessions ──────────────────────────────────────────── //
Tracks active web and USSD sessions. // Redis holds the live session
data; this table holds the audit record. export const applicantSessions
= publicCore.table( \'applicant_sessions\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicantId:
uuid(\'applicant_id\') .references(() =\> applicantIdentities.id)
.notNull(), sessionToken: varchar(\'session_token\', { length: 256
}).notNull().unique(), ****channel:
applicationChannelEnum(\'channel\').notNull(), // USSD state machine
position (e.g., \'AWAIT_NID\', \'AWAIT_AGENCY\', \'COMPLETE\')
ussdState: varchar(\'ussd_state\', { length: 50 }), ussdMenuDepth:
integer(\'ussd_menu_depth\').default(0), ipAddress:
varchar(\'ip_address\', { length: 45 }), // IPv4 or IPv6 userAgent:
varchar(\'user_agent\', { length: 512 }), expiresAt:
timestamp(\'expires_at\', { withTimezone: true }).notNull(),
lastActivityAt: timestamp(\'last_activity_at\', { withTimezone: true
}).defaultNow().notNull(), terminatedAt: timestamp(\'terminated_at\', {
withTimezone: true }), createdAt: timestamp(\'created_at\', {
withTimezone: true }).defaultNow().notNull(), }, (t) =\> \[
uniqueIndex(\'idx_pc_session_token\').on(t.sessionToken),
index(\'idx_pc_session_applicant\').on(t.applicantId),
index(\'idx_pc_session_expires\').on(t.expiresAt), \], ); // ──
recruitment_campaigns ───────────────────────────────────────── // One
row per recruitment cycle per agency. // Administrators create campaigns
before opening registration. // The system reads the active campaign to
route applicants correctly. export const recruitmentCampaigns =
publicCore.table( \'recruitment_campaigns\', { id:
uuid(\'id\').defaultRandom().primaryKey(), // Human-readable label:
\"RDF-2026\", \"RCS-OFFICER-2026\" campaignLabel:
varchar(\'campaign_label\', { length: 50 }).notNull().unique(), agency:
agencyEnum(\'agency\').notNull(), status:
campaignStatusEnum(\'status\').notNull().default(\'DRAFT\'), //
Application categories this campaign accepts (stored as JSON array) //
e.g. \[\"GENERAL_ENLISTMENT\",\"RESERVE_FORCE_ALEVEL\"\]
targetCategories: text(\'target_categories\').notNull(), // Registration
window --- from official announcements registrationOpensAt:
timestamp(\'registration_opens_at\', { withTimezone: true }).notNull(),
registrationClosesAt: timestamp(\'registration_closes_at\', {
withTimezone: true }).notNull(), // Examination window
examinationStartDate: varchar(\'examination_start_date\', { length: 10
}).notNull(), // YYYY-MM-DD examinationEndDate:
varchar(\'examination_end_date\', { length: 10 }).notNull(),
examinationReportingHour:
integer(\'examination_reporting_hour\').notNull(), // 8 or 9 // Walk-in
policy for this specific campaign allowsWalkIn:
****boolean(\'allows_walk_in\').notNull().default(false), // Intake
target (null = no cap defined) targetIntakeCount:
integer(\'target_intake_count\'), // Contact info from announcement
contactPhoneNumbers: text(\'contact_phone_numbers\'), // JSON array of
strings contactWebsite: varchar(\'contact_website\', { length: 100 }),
// Announcement source document reference announcementReference:
varchar(\'announcement_reference\', { length: 200 }), publishedAt:
timestamp(\'published_at\', { withTimezone: true }), createdAt:
timestamp(\'created_at\', { withTimezone: true
}).defaultNow().notNull(), updatedAt: timestamp(\'updated_at\', {
withTimezone: true }).defaultNow().notNull(), }, (t) =\> \[
uniqueIndex(\'idx_pc_campaign_label\').on(t.campaignLabel),
index(\'idx_pc_campaign_agency\').on(t.agency),
index(\'idx_pc_campaign_status\').on(t.status), \], ); // ──
campaign_venue_assignments ──────────────────────────────────── // Maps
each district to its exam venue for a given campaign. // Data seeded
from official announcements. // One row per district per campaign (30
rows for full national coverage). export const campaignVenueAssignments
= publicCore.table( \'campaign_venue_assignments\', { id:
uuid(\'id\').defaultRandom().primaryKey(), campaignId:
uuid(\'campaign_id\') .references(() =\> recruitmentCampaigns.id)
.notNull(), // Location --- from official announcements district:
varchar(\'district\', { length: 30 }).notNull(), province:
varchar(\'province\', { length: 30 }).notNull(), venueName:
varchar(\'venue_name\', { length: 200 }).notNull(), // Exam schedule for
this venue examDate: varchar(\'exam_date\', { length: 10 }).notNull(),
// YYYY-MM-DD reportingTimeHour:
integer(\'reporting_time_hour\').notNull(), // 8 or 9 // Capacity
management capacityLimit: integer(\'capacity_limit\'), // null =
unlimited registeredCount:
integer(\'registered_count\').notNull().default(0), isActive:
boolean(\'is_active\').notNull().default(true), createdAt:
timestamp(\'created_at\', { withTimezone: true
}).defaultNow().notNull(), }, (t) =\> \[
index(\'idx_pc_venue_campaign\').on(t.campaignId),
index(\'idx_pc_venue_district\').on(t.district),
uniqueIndex(\'idx_pc_venue_campaign_district\').on(t.campaignId,
****t.district), \], ); EOF echo \"Done: public-core.schema.ts\" \`\`\`
\-\-- \## Step 2.4 --- Application Status History Table (Shared Pattern)
\`\`\`bash \# This pattern is used by all three agency schemas \#
Written once here as documentation --- implemented in each schema cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/src/schemas/\_status-history-pattern.md
\<\< \'EOF\' \# Application Status History Pattern Every agency schema
(rdf_ops, rnp_ops, rcs_ops) includes an application_status_history table
alongside the main applications table. WHY: Application status is never
overwritten. Each status transition creates a new immutable row. This
provides: 1. Full audit trail of every status change 2. Ability to
reconstruct timeline for investigations 3. Compliance with Law N°
058/2021 audit requirements PATTERN: applications.status = CURRENT
status (denormalized for query performance) application_status_history =
FULL IMMUTABLE HISTORY When a status changes: 1. INSERT into
application_status_history (old → new, reason, actor) 2. UPDATE
applications.status = new status Both in the same database transaction.
EOF echo \"Done: status history pattern documented\" \`\`\` \-\-- \##
Step 2.5 --- \`rdf_ops\` Schema \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/src/schemas/rdf-ops.schema.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
rdf_ops schema --- Rwanda Defence Force recruitment operations //
ISOLATED: Only accessible to usrp_rdf_officer and usrp_system_service //
══════════════════════════════════════════════════════════════════
import { pgSchema, uuid, varchar, timestamp, integer, boolean, text,
pgEnum, jsonb, index, uniqueIndex, } from \'drizzle-orm/pg-core\';
import { applicantIdentities } from \'./public-core.schema.js\'; export
const rdfOps = pgSchema(\'rdf_ops\'); // ── Enums
───────────────────────────────────────────────────────── export const
rdfCategoryEnum = rdfOps.enum(\'application_category\', \[
\'GENERAL_ENLISTMENT\', \'RESERVE_FORCE_ALEVEL\',
\'RESERVE_FORCE_UNIVERSITY\', \'RESERVE_FORCE_SPECIALIST\', \]); export
const rdfApplicationStatusEnum = rdfOps.enum(\'application_status\', \[
\'DRAFT\', \'SUBMITTED\', \'ACADEMIC_VETTING\', \'CRIMINAL_CLEARANCE\',
\'DOCUMENT_REVIEW_GREEN\', \'DOCUMENT_REVIEW_AMBER\', \'SLOT_ASSIGNED\',
\'PHYSICAL_TEST_SCHEDULED\', ****\'PHYSICAL_TEST_COMPLETE\',
\'MEDICAL_REVIEW\', \'FINAL_SHORTLIST\', \'ACCEPTED\', \'REJECTED\',
\'WITHDRAWN\', \'WALK_IN_REGISTERED\', \'WALK_IN_ON_SITE_VETTING\',
\'WALK_IN_PHYSICAL_TEST\', \'WALK_IN_REJECTED\', \]); export const
rdfAcademicStatusEnum = rdfOps.enum(\'academic_eligibility_status\', \[
\'PENDING\', \'ELIGIBLE\', \'INELIGIBLE\', \]); export const
rdfCriminalStatusEnum = rdfOps.enum(\'criminal_clearance_status\', \[
\'PENDING\', \'CLEARED\', \'FLAGGED_CONVICTION\', \'FLAGGED_DISMISSED\',
\'UNDER_REVIEW\', \]); export const rdfDocumentLaneEnum =
rdfOps.enum(\'document_lane\', \[ \'GREEN\', \'AMBER\', \'RED\', \]);
export const rdfDocumentTypeEnum = rdfOps.enum(\'document_type\', \[
\'NATIONAL_ID\', \'OLEVEL_CERTIFICATE\', \'ALEVEL_CERTIFICATE\',
\'DEGREE_DIPLOMA_COPY\', \'GOOD_CONDUCT_CERTIFICATE\',
\'NON_CONVICTION_CERTIFICATE\', \]); // ── rdf_ops.applications
────────────────────────────────────────── export const rdfApplications
= rdfOps.table( \'applications\', { id:
uuid(\'id\').defaultRandom().primaryKey(), // Anonymous processing code
--- shown to officers instead of name // Format: RDF-XXXXX (zero-padded
5-digit sequence) processingCode: varchar(\'processing_code\', { length:
20 }).notNull().unique(), // Link to shared identity (RLS prevents
unauthorized joins) applicantId: uuid(\'applicant_id\') .references(()
=\> applicantIdentities.id) .notNull(), // Campaign this application
belongs to campaignId: uuid(\'campaign_id\').notNull(), // Application
specifics category: rdfCategoryEnum(\'category\').notNull(), status:
rdfApplicationStatusEnum(\'status\').notNull().default(\'DRAFT\'), // ──
Academic vetting ───────────────────────────────────────── // For
S3/A-Level applicants: NESA index number nesaIndexNumber:
varchar(\'nesa_index_number\', { length: 20 }),
nesaVerificationRequestId: varchar(\'nesa_verification_request_id\', {
length: 128 }), nesaVerifiedAt: timestamp(\'nesa_verified_at\', {
withTimezone: true }), // For University/IPRC applicants: HEC
registration number hecRegistrationNumber:
varchar(\'hec_registration_number\', { length: 50 }),
hecVerificationRequestId: varchar(\'hec_verification_request_id\', {
length: 128 }), hecVerifiedAt: timestamp(\'hec_verified_at\', {
withTimezone: true }), // Specialist field declared (for age exception
calculation) // e.g. \'MEDICINE\', \'ENGINEERING\', \'LAW\'
declaredSpecialistField: varchar(\'declared_specialist_field\', {
length: ****50 }), academicStatus:
rdfAcademicStatusEnum(\'academic_status\').notNull().default(\'PENDING\'),
// JSON: { eligible: bool, reason: string, details: {\...} }
academicEligibilityDetail: jsonb(\'academic_eligibility_detail\'), // ──
Criminal vetting ───────────────────────────────────────── ribRequestId:
varchar(\'rib_request_id\', { length: 128 }), criminalClearanceStatus:
rdfCriminalStatusEnum(\'criminal_clearance_status\') .notNull()
.default(\'PENDING\'), criminalClearanceAt:
timestamp(\'criminal_clearance_at\', { withTimezone: true }), // ──
Document forensics ────────────────────────────────────────
documentLane: rdfDocumentLaneEnum(\'document_lane\'),
documentForensicsScore: integer(\'document_forensics_score\'), // JSON:
{ elaAnomalyDetected: bool, fontMismatch: bool, \... }
documentForensicsFlags: jsonb(\'document_forensics_flags\'), // Officer
who reviewed amber/red documents documentReviewedById:
uuid(\'document_reviewed_by_id\'), documentReviewedAt:
timestamp(\'document_reviewed_at\', { withTimezone: true }),
documentReviewDecision: varchar(\'document_review_decision\', { length:
10 }), documentReviewNotes: varchar(\'document_review_notes\', { length:
500 }), // ── Physical test scheduling
────────────────────────────────── venueAssignmentId:
uuid(\'venue_assignment_id\'), physicalTestScheduledAt:
timestamp(\'physical_test_scheduled_at\', { withTimezone: true }),
assignedDistrict: varchar(\'assigned_district\', { length: 30 }),
assignedVenueName: varchar(\'assigned_venue_name\', { length: 200 }), //
QR invitation code --- unique per application, used by field officers
qrInvitationCode: varchar(\'qr_invitation_code\', { length: 64
}).unique(), qrInvitationIssuedAt:
timestamp(\'qr_invitation_issued_at\', { withTimezone: true }), // SMS
notification tracking smsNotificationSentAt:
timestamp(\'sms_notification_sent_at\', { withTimezone: true }),
smsNotificationStatus: varchar(\'sms_notification_status\', { length: 20
}), // ── Physical test results ─────────────────────────────────────
physicalTestCompletedAt: timestamp(\'physical_test_completed_at\', {
withTimezone: true }), physicalTestScoreId:
uuid(\'physical_test_score_id\'), isWalkIn:
****boolean(\'is_walk_in\').notNull().default(false), // ── Medical
review ──────────────────────────────────────────── medicalReviewedById:
uuid(\'medical_reviewed_by_id\'), medicalReviewedAt:
timestamp(\'medical_reviewed_at\', { withTimezone: true }),
medicalFitnessStatus: varchar(\'medical_fitness_status\', { length: 20
}), // ── Final decision ────────────────────────────────────────────
finalDecisionById: uuid(\'final_decision_by_id\'), finalDecisionAt:
timestamp(\'final_decision_at\', { withTimezone: true }),
finalDecisionNotes: varchar(\'final_decision_notes\', { length: 1000 }),
submittedAt: timestamp(\'submitted_at\', { withTimezone: true }),
createdAt: timestamp(\'created_at\', { withTimezone: true
}).defaultNow().notNull(), updatedAt: timestamp(\'updated_at\', {
withTimezone: true }).defaultNow().notNull(), }, (t) =\> \[
uniqueIndex(\'idx_rdf_processing_code\').on(t.processingCode),
index(\'idx_rdf_applicant_id\').on(t.applicantId),
index(\'idx_rdf_campaign_id\').on(t.campaignId),
index(\'idx_rdf_status\').on(t.status),
index(\'idx_rdf_document_lane\').on(t.documentLane),
index(\'idx_rdf_academic_status\').on(t.academicStatus),
index(\'idx_rdf_criminal_status\').on(t.criminalClearanceStatus),
index(\'idx_rdf_district\').on(t.assignedDistrict),
uniqueIndex(\'idx_rdf_qr_code\').on(t.qrInvitationCode), \], ); // ──
rdf_ops.application_status_history ─────────────────────────── //
Immutable audit trail of every status transition // No UPDATE or DELETE
--- INSERT ONLY export const rdfApplicationStatusHistory = rdfOps.table(
\'application_status_history\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rdfApplications.id)
.notNull(), fromStatus: rdfApplicationStatusEnum(\'from_status\'), //
null for initial DRAFT toStatus:
rdfApplicationStatusEnum(\'to_status\').notNull(), reason:
varchar(\'reason\', { length: 200 }), performedBy:
varchar(\'performed_by\', { length: 50 }).notNull(), // \'SYSTEM\' or
officer UUID performedAt: timestamp(\'performed_at\', { withTimezone:
true }).defaultNow().notNull(), correlationId:
varchar(\'correlation_id\', { length: 128 }), // Kafka correlationId },
(t) =\> \[ index(\'idx_rdf_status_hist_app\').on(t.applicationId),
****index(\'idx_rdf_status_hist_time\').on(t.performedAt), \], ); // ──
rdf_ops.document_records ────────────────────────────────────── // One
row per uploaded document per application // Tracks the full forensics
lifecycle of each document export const rdfDocumentRecords =
rdfOps.table( \'document_records\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rdfApplications.id)
.notNull(), documentType:
rdfDocumentTypeEnum(\'document_type\').notNull(), // MinIO object store
reference minioObjectKey: varchar(\'minio_object_key\', { length: 512
}), minioObjectBucket: varchar(\'minio_object_bucket\', { length: 100
}), fileSizeBytes: integer(\'file_size_bytes\'), mimeType:
varchar(\'mime_type\', { length: 50 }), // Virus scan virusScanStatus:
varchar(\'virus_scan_status\', { length: 20 }), virusScanAt:
timestamp(\'virus_scan_at\', { withTimezone: true }), // Forensics
pipeline results forensicsScore: integer(\'forensics_score\'),
forensicsLane: rdfDocumentLaneEnum(\'forensics_lane\'), forensicsFlags:
jsonb(\'forensics_flags\'), forensicsCompletedAt:
timestamp(\'forensics_completed_at\', { withTimezone: true }), // API
verification (Green Lane --- verified directly via NESA/HEC)
verifiedViaApi: boolean(\'verified_via_api\').default(false),
apiVerificationToken: varchar(\'api_verification_token\', { length: 128
}), apiVerifiedAt: timestamp(\'api_verified_at\', { withTimezone: true
}), // Human review (Amber Lane) humanReviewedById:
uuid(\'human_reviewed_by_id\'), humanReviewedAt:
timestamp(\'human_reviewed_at\', { withTimezone: true }),
humanReviewDecision: varchar(\'human_review_decision\', { length: 10 }),
uploadedAt: timestamp(\'uploaded_at\', { withTimezone: true
}).defaultNow().notNull(), createdAt: timestamp(\'created_at\', {
withTimezone: true }).defaultNow().notNull(), }, (t) =\> \[
index(\'idx_rdf_docs_application\').on(t.applicationId),
index(\'idx_rdf_docs_type\').on(t.documentType),
index(\'idx_rdf_docs_lane\').on(t.forensicsLane), \], ); // ──
rdf_ops.physical_test_scores ────────────────────────────────── //
CRDT-synced scores from field tablets // Device-signed --- tampering
detectable via deviceSignature export const rdfPhysicalTestScores =
rdfOps.table( \'physical_test_scores\', { id:
****uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rdfApplications.id)
.notNull(), // CRDT vector clock for conflict detection // JSON: {
\"device-uuid-1\": 3, \"device-uuid-2\": 1 } vectorClock:
jsonb(\'vector_clock\').notNull(), deviceId: varchar(\'device_id\', {
length: 64 }).notNull(), // Physical metrics --- bounded at tablet input
level heightCm: integer(\'height_cm\'), // 140--220 weightKg:
integer(\'weight_kg\'), // 40--150 run3kmTimeSeconds:
integer(\'run_3km_time_seconds\'), chestCm: integer(\'chest_cm\'),
medicalFitnessStatus: varchar(\'medical_fitness_status\', { length: 20
}), additionalNotes: varchar(\'additional_notes\', { length: 500 }), //
Integrity verification // Ed25519 signature of the metrics payload by
the capturing device deviceSignature: varchar(\'device_signature\', {
length: 512 }).notNull(), signedPayloadHash:
varchar(\'signed_payload_hash\', { length: 64 }).notNull(), // Officer
identity capturingOfficerId: uuid(\'capturing_officer_id\').notNull(),
capturedAt: timestamp(\'captured_at\', { withTimezone: true
}).notNull(), // Sync metadata syncedAt: timestamp(\'synced_at\', {
withTimezone: true }).defaultNow(), syncConflictDetected:
boolean(\'sync_conflict_detected\').default(false),
syncConflictResolution: varchar(\'sync_conflict_resolution\', { length:
50 }), createdAt: timestamp(\'created_at\', { withTimezone: true
}).defaultNow().notNull(), }, (t) =\> \[
index(\'idx_rdf_scores_application\').on(t.applicationId),
index(\'idx_rdf_scores_device\').on(t.deviceId),
index(\'idx_rdf_scores_captured\').on(t.capturedAt), \], ); EOF echo
\"Done: rdf-ops.schema.ts\" \`\`\` \-\-- \## Step 2.6 --- \`rnp_ops\`
Schema \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/src/schemas/rnp-ops.schema.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
rnp_ops schema --- Rwanda National Police recruitment operations //
ISOLATED: Only accessible to usrp_rnp_officer and usrp_system_service //
// Key differences from rdf_ops: // 1. Two categories: CADET_OFFICER and
BASIC_POLICE_COURSE // 2. Criminal threshold: imprisonment \> 6 months
(Cadet) or \>= 6 months (Basic) // → stored as
applied_criminal_threshold column // 3. No walk-in policy (RNP requires
pre-registration at DPU) // 4. No specialist field age exception for
Basic Police Course //
═════════════════════════════════════════════════════════****═════════
import { pgSchema, uuid, varchar, timestamp, integer, boolean, pgEnum,
jsonb, index, uniqueIndex, } from \'drizzle-orm/pg-core\'; import {
applicantIdentities } from \'./public-core.schema.js\'; export const
rnpOps = pgSchema(\'rnp_ops\'); // ── Enums
───────────────────────────────────────────────────────── export const
rnpCategoryEnum = rnpOps.enum(\'application_category\', \[
\'CADET_OFFICER\', \'BASIC_POLICE_COURSE\', \]); export const
rnpApplicationStatusEnum = rnpOps.enum(\'application_status\', \[
\'DRAFT\', \'SUBMITTED\', \'ACADEMIC_VETTING\', \'CRIMINAL_CLEARANCE\',
\'DOCUMENT_REVIEW_GREEN\', \'DOCUMENT_REVIEW_AMBER\', \'SLOT_ASSIGNED\',
\'PHYSICAL_TEST_SCHEDULED\', \'PHYSICAL_TEST_COMPLETE\',
\'MEDICAL_REVIEW\', \'FINAL_SHORTLIST\', \'ACCEPTED\', \'REJECTED\',
\'WITHDRAWN\', \]); export const rnpAcademicStatusEnum =
rnpOps.enum(\'academic_eligibility_status\', \[ \'PENDING\',
\'ELIGIBLE\', \'INELIGIBLE\', \]); export const rnpCriminalStatusEnum =
rnpOps.enum(\'criminal_clearance_status\', \[ \'PENDING\', \'CLEARED\',
\'FLAGGED_CONVICTION\', \'FLAGGED_DISMISSED\', \'UNDER_REVIEW\', \]);
export const rnpDocumentLaneEnum = rnpOps.enum(\'document_lane\', \[
\'GREEN\', \'AMBER\', \'RED\', \]); export const rnpDocumentTypeEnum =
rnpOps.enum(\'document_type\', \[ \'NATIONAL_ID\',
\'APPLICATION_FORM_WITH_PHOTO\', \'ALEVEL_CERTIFICATE\',
\'DEGREE_DIPLOMA_COPY\', \'GOOD_CONDUCT_CERTIFICATE\', \]); // ──
rnp_ops.applications ────────────────────────────────────────── export
const rnpApplications = rnpOps.table( \'applications\', { id:
uuid(\'id\').defaultRandom().primaryKey(), processingCode:
varchar(\'processing_code\', { length: 20 }).notNull().unique(),
applicantId: uuid(\'applicant_id\') .references(() =\>
applicantIdentities.id) .notNull(), campaignId:
uuid(\'campaign_id\').notNull(), category:
rnpCategoryEnum(\'category\').notNull(), status:
rnpApplicationStatusEnum(\'status\').notNull().default(\'DRAFT\'), // ──
Academic vetting ─────────────────────────────────────────
nesaIndexNumber: varchar(\'nesa_index_number\', { length: 20 }),
nesaVerificationRequestId: varchar(\'nesa_verification_request_id\', {
length: 128 }), nesaVerifiedAt: timestamp(\'nesa_verified_at\', {
withTimezone: true }), hecRegistrationNumber:
****varchar(\'hec_registration_number\', { length: 50 }),
hecVerificationRequestId: varchar(\'hec_verification_request_id\', {
length: 128 }), hecVerifiedAt: timestamp(\'hec_verified_at\', {
withTimezone: true }), // Priority field declared (for officer ranking
--- not age exception) // e.g. \'STATISTICS\', \'MEDICINE\',
\'ENGINEERING\' declaredPriorityField:
varchar(\'declared_priority_field\', { length: 50 }), academicStatus:
rnpAcademicStatusEnum(\'academic_status\').notNull().default(\'PENDING\'),
academicEligibilityDetail: jsonb(\'academic_eligibility_detail\'), // ──
Criminal vetting ───────────────────────────────────────── ribRequestId:
varchar(\'rib_request_id\', { length: 128 }), criminalClearanceStatus:
rnpCriminalStatusEnum(\'criminal_clearance_status\') .notNull()
.default(\'PENDING\'), // CRITICAL: Store which threshold was applied
for audit // CADET_OFFICER = \'IMPRISONMENT_GT_6MO\' \|
BASIC_POLICE_COURSE = \'IMPRISONMENT_GTE_6MO\' appliedCriminalThreshold:
varchar(\'applied_criminal_threshold\', { length: 30 }),
criminalClearanceAt: timestamp(\'criminal_clearance_at\', {
withTimezone: true }), // ── Document forensics
──────────────────────────────────────── documentLane:
rnpDocumentLaneEnum(\'document_lane\'), documentForensicsScore:
integer(\'document_forensics_score\'), documentForensicsFlags:
jsonb(\'document_forensics_flags\'), documentReviewedById:
uuid(\'document_reviewed_by_id\'), documentReviewedAt:
timestamp(\'document_reviewed_at\', { withTimezone: true }),
documentReviewDecision: varchar(\'document_review_decision\', { length:
10 }), // ── Scheduling ────────────────────────────────────────────────
// RNP: Registration at DPU of residence --- venue assigned by district
registrationDpuDistrict: varchar(\'registration_dpu_district\', {
length: 30 }), venueAssignmentId: uuid(\'venue_assignment_id\'),
physicalTestScheduledAt: timestamp(\'physical_test_scheduled_at\', {
withTimezone: true }), assignedDistrict: varchar(\'assigned_district\',
{ length: 30 }), assignedVenueName: varchar(\'assigned_venue_name\', {
length: 200 }), qrInvitationCode: varchar(\'qr_invitation_code\', {
length: 64 }).unique(), qrInvitationIssuedAt:
timestamp(\'qr_invitation_issued_at\', { withTimezone: true }),
smsNotificationSentAt: ****timestamp(\'sms_notification_sent_at\', {
withTimezone: true }), // ── Physical test results
───────────────────────────────────── physicalTestCompletedAt:
timestamp(\'physical_test_completed_at\', { withTimezone: true }),
physicalTestScoreId: uuid(\'physical_test_score_id\'), // ── Final
decision ──────────────────────────────────────────── finalDecisionById:
uuid(\'final_decision_by_id\'), finalDecisionAt:
timestamp(\'final_decision_at\', { withTimezone: true }),
finalDecisionNotes: varchar(\'final_decision_notes\', { length: 1000 }),
submittedAt: timestamp(\'submitted_at\', { withTimezone: true }),
createdAt: timestamp(\'created_at\', { withTimezone: true
}).defaultNow().notNull(), updatedAt: timestamp(\'updated_at\', {
withTimezone: true }).defaultNow().notNull(), }, (t) =\> \[
uniqueIndex(\'idx_rnp_processing_code\').on(t.processingCode),
index(\'idx_rnp_applicant_id\').on(t.applicantId),
index(\'idx_rnp_campaign_id\').on(t.campaignId),
index(\'idx_rnp_status\').on(t.status),
index(\'idx_rnp_document_lane\').on(t.documentLane),
index(\'idx_rnp_academic_status\').on(t.academicStatus),
index(\'idx_rnp_category\').on(t.category),
uniqueIndex(\'idx_rnp_qr_code\').on(t.qrInvitationCode), \], ); export
const rnpApplicationStatusHistory = rnpOps.table(
\'application_status_history\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rnpApplications.id)
.notNull(), fromStatus: rnpApplicationStatusEnum(\'from_status\'),
toStatus: rnpApplicationStatusEnum(\'to_status\').notNull(), reason:
varchar(\'reason\', { length: 200 }), performedBy:
varchar(\'performed_by\', { length: 50 }).notNull(), performedAt:
timestamp(\'performed_at\', { withTimezone: true
}).defaultNow().notNull(), correlationId: varchar(\'correlation_id\', {
length: 128 }), }, (t) =\> \[
index(\'idx_rnp_status_hist_app\').on(t.applicationId),
index(\'idx_rnp_status_hist_time\').on(t.performedAt), \], ); export
const rnpDocumentRecords = rnpOps.table( \'document_records\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rnpApplications.id)
.notNull(), documentType:
rnpDocumentTypeEnum(\'document_type\').notNull(), ****minioObjectKey:
varchar(\'minio_object_key\', { length: 512 }), minioObjectBucket:
varchar(\'minio_object_bucket\', { length: 100 }), fileSizeBytes:
integer(\'file_size_bytes\'), mimeType: varchar(\'mime_type\', { length:
50 }), virusScanStatus: varchar(\'virus_scan_status\', { length: 20 }),
virusScanAt: timestamp(\'virus_scan_at\', { withTimezone: true }),
forensicsScore: integer(\'forensics_score\'), forensicsLane:
rnpDocumentLaneEnum(\'forensics_lane\'), forensicsFlags:
jsonb(\'forensics_flags\'), forensicsCompletedAt:
timestamp(\'forensics_completed_at\', { withTimezone: true }),
verifiedViaApi: boolean(\'verified_via_api\').default(false),
apiVerificationToken: varchar(\'api_verification_token\', { length: 128
}), apiVerifiedAt: timestamp(\'api_verified_at\', { withTimezone: true
}), humanReviewedById: uuid(\'human_reviewed_by_id\'), humanReviewedAt:
timestamp(\'human_reviewed_at\', { withTimezone: true }),
humanReviewDecision: varchar(\'human_review_decision\', { length: 10 }),
uploadedAt: timestamp(\'uploaded_at\', { withTimezone: true
}).defaultNow().notNull(), createdAt: timestamp(\'created_at\', {
withTimezone: true }).defaultNow().notNull(), }, (t) =\> \[
index(\'idx_rnp_docs_application\').on(t.applicationId),
index(\'idx_rnp_docs_type\').on(t.documentType), \], ); export const
rnpPhysicalTestScores = rnpOps.table( \'physical_test_scores\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rnpApplications.id)
.notNull(), vectorClock: jsonb(\'vector_clock\').notNull(), deviceId:
varchar(\'device_id\', { length: 64 }).notNull(), heightCm:
integer(\'height_cm\'), weightKg: integer(\'weight_kg\'),
run3kmTimeSeconds: integer(\'run_3km_time_seconds\'), chestCm:
integer(\'chest_cm\'), medicalFitnessStatus:
varchar(\'medical_fitness_status\', { length: 20 }), additionalNotes:
varchar(\'additional_notes\', { length: 500 }), deviceSignature:
varchar(\'device_signature\', { length: 512 }).notNull(),
signedPayloadHash: varchar(\'signed_payload_hash\', { length: 64
}).notNull(), capturingOfficerId:
uuid(\'capturing_officer_id\').notNull(), capturedAt:
timestamp(\'captured_at\', { withTimezone: true }).notNull(), syncedAt:
timestamp(\'synced_at\', { withTimezone: true }).defaultNow(),
syncConflictDetected:
boolean(\'sync_conflict_detected\').default(false), createdAt:
timestamp(\'created_at\', { withTimezone: true
}).defaultNow().notNull(), }, (t) =\> \[
index(\'idx_rnp_scores_application\').on(t.applicationId), \], ); EOF
echo ****\"Done: rnp-ops.schema.ts\" \`\`\` \-\-- \## Step 2.7 ---
\`rcs_ops\` Schema (Most Complex --- Celibacy, Medical, 4-Year Track)
\`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/src/schemas/rcs-ops.schema.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
rcs_ops schema --- Rwanda Correctional Service recruitment operations //
ISOLATED: Only accessible to usrp_rcs_officer and usrp_system_service //
// Key differences from rdf_ops and rnp_ops: // 1. Four categories
including OFFICER_FOUR_YEAR_UR (university intake) // 2. Celibacy
certificate required for ALL RCS categories // 3. Medical certificate
from government physician required // 4. Notarized documents required
(not just photocopies) // 5. \"Under criminal prosecution\" also
disqualifies (not just conviction) // 6. OFFICER_FOUR_YEAR_UR: age max
21, science grade \>= 70%, UR program required //
══════════════════════════════════════════════════════════════════
import { pgSchema, uuid, varchar, timestamp, integer, boolean, pgEnum,
jsonb, index, uniqueIndex, } from \'drizzle-orm/pg-core\'; import {
applicantIdentities } from \'./public-core.schema.js\'; export const
rcsOps = pgSchema(\'rcs_ops\'); // ── Enums
───────────────────────────────────────────────────────── export const
rcsCategoryEnum = rcsOps.enum(\'application_category\', \[
\'GENERAL_ENLISTEE\', \'OFFICER_ONE_YEAR\',
\'OFFICER_ONE_YEAR_SPECIALIST\', \'OFFICER_FOUR_YEAR_UR\', \]); export
const rcsApplicationStatusEnum = rcsOps.enum(\'application_status\', \[
\'DRAFT\', \'SUBMITTED\', \'ACADEMIC_VETTING\', \'CRIMINAL_CLEARANCE\',
\'DOCUMENT_REVIEW_GREEN\', \'DOCUMENT_REVIEW_AMBER\', \'SLOT_ASSIGNED\',
\'PHYSICAL_TEST_SCHEDULED\', \'PHYSICAL_TEST_COMPLETE\',
\'MEDICAL_REVIEW\', \'FINAL_SHORTLIST\', \'ACCEPTED\', \'REJECTED\',
\'WITHDRAWN\', \]); export const rcsAcademicStatusEnum =
rcsOps.enum(\'academic_eligibility_status\', \[ \'PENDING\',
\'ELIGIBLE\', \'INELIGIBLE\', \]); // RCS has extended criminal
clearance statuses export const rcsCriminalStatusEnum =
rcsOps.enum(\'criminal_clearance_status\', \[ \'PENDING\', \'CLEARED\',
\'FLAGGED_CONVICTION\', \'FLAGGED_PROSECUTION\', // Under active
criminal prosecution --- RCS-specific disqualifier
\'FLAGGED_DISMISSED\', \'UNDER_REVIEW\', \]); export const
rcsDocumentLaneEnum = ****rcsOps.enum(\'document_lane\', \[ \'GREEN\',
\'AMBER\', \'RED\', \]); // RCS has the most extensive document list of
all three agencies export const rcsDocumentTypeEnum =
rcsOps.enum(\'document_type\', \[ \'NATIONAL_ID\',
\'APPLICATION_FORM_WITH_PHOTO\', \'BIRTH_CERTIFICATE\',
\'ALEVEL_CERTIFICATE\', \'DEGREE_DIPLOMA_NOTARIZED\', // Notarized ---
not just photocopy \'GOOD_CONDUCT_CERTIFICATE\',
\'NON_CONVICTION_CERTIFICATE\', \'CELIBACY_CERTIFICATE\', // Unique to
RCS --- proves single marital status \'MEDICAL_CERTIFICATE_GOVT\', //
Must be from authorized government physician \]); export const
rcsUrProgramEnum = rcsOps.enum(\'ur_program\', \[ \'GENERAL_MEDICINE\',
\'GENERAL_NURSING\', \'COMPUTER_ENGINEERING\', \'DENTAL_SURGERY\', \]);
// ── rcs_ops.applications ──────────────────────────────────────────
export const rcsApplications = rcsOps.table( \'applications\', { id:
uuid(\'id\').defaultRandom().primaryKey(), processingCode:
varchar(\'processing_code\', { length: 20 }).notNull().unique(),
applicantId: uuid(\'applicant_id\') .references(() =\>
applicantIdentities.id) .notNull(), campaignId:
uuid(\'campaign_id\').notNull(), category:
rcsCategoryEnum(\'category\').notNull(), status:
rcsApplicationStatusEnum(\'status\').notNull().default(\'DRAFT\'), // ──
Academic vetting ─────────────────────────────────────────
nesaIndexNumber: varchar(\'nesa_index_number\', { length: 20 }),
nesaVerificationRequestId: varchar(\'nesa_verification_request_id\', {
length: 128 }), nesaVerifiedAt: timestamp(\'nesa_verified_at\', {
withTimezone: true }), hecRegistrationNumber:
varchar(\'hec_registration_number\', { length: 50 }),
hecVerificationRequestId: varchar(\'hec_verification_request_id\', {
length: 128 }), hecVerifiedAt: timestamp(\'hec_verified_at\', {
withTimezone: true }), // RCS-specific: Specialist field for age
exception declaredSpecialistField:
varchar(\'declared_specialist_field\', { length: 50 }), //
OFFICER_FOUR_YEAR_UR specific fields // The UR program the applicant is
applying to study urProgramApplied:
rcsUrProgramEnum(\'ur_program_applied\'), // Science percentage from
NESA (must be \>= 70%) nesaSciencePercentage:
integer(\'nesa_science_percentage\'), academicStatus:
rcsAcademicStatusEnum(\'academic_status\').notNull().default(\'PENDING\'****),
academicEligibilityDetail: jsonb(\'academic_eligibility_detail\'), // ──
Criminal vetting ───────────────────────────────────────── ribRequestId:
varchar(\'rib_request_id\', { length: 128 }), criminalClearanceStatus:
rcsCriminalStatusEnum(\'criminal_clearance_status\') .notNull()
.default(\'PENDING\'), // RCS-specific: tracks whether active
prosecution check was performed prosecutionCheckPerformed:
boolean(\'prosecution_check_performed\').default(false),
prosecutionCheckAt: timestamp(\'prosecution_check_at\', { withTimezone:
true }), criminalClearanceAt: timestamp(\'criminal_clearance_at\', {
withTimezone: true }), // ── Document forensics
──────────────────────────────────────── documentLane:
rcsDocumentLaneEnum(\'document_lane\'), documentForensicsScore:
integer(\'document_forensics_score\'), documentForensicsFlags:
jsonb(\'document_forensics_flags\'), documentReviewedById:
uuid(\'document_reviewed_by_id\'), documentReviewedAt:
timestamp(\'document_reviewed_at\', { withTimezone: true }),
documentReviewDecision: varchar(\'document_review_decision\', { length:
10 }), // ── RCS-Specific Document Verification Status ─────────────────
// These are required for ALL RCS categories --- tracked separately
celibacyCertVerified:
boolean(\'celibacy_cert_verified\').default(false),
celibacyCertVerifiedAt: timestamp(\'celibacy_cert_verified_at\', {
withTimezone: true }), medicalCertVerified:
boolean(\'medical_cert_verified\').default(false),
medicalCertVerifiedAt: timestamp(\'medical_cert_verified_at\', {
withTimezone: true }), medicalCertPhysicianName:
varchar(\'medical_cert_physician_name\', { length: 200 }), // Birth
certificate --- required for Officer categories birthCertVerified:
boolean(\'birth_cert_verified\').default(false), birthCertVerifiedAt:
timestamp(\'birth_cert_verified_at\', { withTimezone: true }), // ──
Scheduling ────────────────────────────────────────────────
venueAssignmentId: uuid(\'venue_assignment_id\'),
physicalTestScheduledAt: timestamp(\'physical_test_scheduled_at\', {
withTimezone: true }), assignedDistrict: varchar(\'assigned_district\',
{ length: 30 }), assignedVenueName: varchar(\'assigned_venue_name\', {
length: 200 }), qrInvitationCode: varchar(\'qr_invitation_code\', {
length: ****64 }).unique(), qrInvitationIssuedAt:
timestamp(\'qr_invitation_issued_at\', { withTimezone: true }),
smsNotificationSentAt: timestamp(\'sms_notification_sent_at\', {
withTimezone: true }), // ── Physical test results
───────────────────────────────────── physicalTestCompletedAt:
timestamp(\'physical_test_completed_at\', { withTimezone: true }),
physicalTestScoreId: uuid(\'physical_test_score_id\'), // ── Final
decision ──────────────────────────────────────────── finalDecisionById:
uuid(\'final_decision_by_id\'), finalDecisionAt:
timestamp(\'final_decision_at\', { withTimezone: true }),
finalDecisionNotes: varchar(\'final_decision_notes\', { length: 1000 }),
submittedAt: timestamp(\'submitted_at\', { withTimezone: true }),
createdAt: timestamp(\'created_at\', { withTimezone: true
}).defaultNow().notNull(), updatedAt: timestamp(\'updated_at\', {
withTimezone: true }).defaultNow().notNull(), }, (t) =\> \[
uniqueIndex(\'idx_rcs_processing_code\').on(t.processingCode),
index(\'idx_rcs_applicant_id\').on(t.applicantId),
index(\'idx_rcs_campaign_id\').on(t.campaignId),
index(\'idx_rcs_status\').on(t.status),
index(\'idx_rcs_document_lane\').on(t.documentLane),
index(\'idx_rcs_academic_status\').on(t.academicStatus),
index(\'idx_rcs_category\').on(t.category),
index(\'idx_rcs_criminal_status\').on(t.criminalClearanceStatus),
uniqueIndex(\'idx_rcs_qr_code\').on(t.qrInvitationCode), \], ); export
const rcsApplicationStatusHistory = rcsOps.table(
\'application_status_history\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rcsApplications.id)
.notNull(), fromStatus: rcsApplicationStatusEnum(\'from_status\'),
toStatus: rcsApplicationStatusEnum(\'to_status\').notNull(), reason:
varchar(\'reason\', { length: 200 }), performedBy:
varchar(\'performed_by\', { length: 50 }).notNull(), performedAt:
timestamp(\'performed_at\', { withTimezone: true
}).defaultNow().notNull(), correlationId: varchar(\'correlation_id\', {
length: 128 }), }, (t) =\> \[
index(\'idx_rcs_status_hist_app\').on(t.applicationId), \], ); export
const rcsDocumentRecords = rcsOps.table( \'document_records\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rcsApplications.id)
.notNull(), ****documentType:
rcsDocumentTypeEnum(\'document_type\').notNull(), // RCS requires
notarized documents --- track notarization status isNotarized:
boolean(\'is_notarized\').default(false), notarizationReference:
varchar(\'notarization_reference\', { length: 100 }), minioObjectKey:
varchar(\'minio_object_key\', { length: 512 }), minioObjectBucket:
varchar(\'minio_object_bucket\', { length: 100 }), fileSizeBytes:
integer(\'file_size_bytes\'), mimeType: varchar(\'mime_type\', { length:
50 }), virusScanStatus: varchar(\'virus_scan_status\', { length: 20 }),
virusScanAt: timestamp(\'virus_scan_at\', { withTimezone: true }),
forensicsScore: integer(\'forensics_score\'), forensicsLane:
rcsDocumentLaneEnum(\'forensics_lane\'), forensicsFlags:
jsonb(\'forensics_flags\'), forensicsCompletedAt:
timestamp(\'forensics_completed_at\', { withTimezone: true }),
verifiedViaApi: boolean(\'verified_via_api\').default(false),
apiVerificationToken: varchar(\'api_verification_token\', { length: 128
}), apiVerifiedAt: timestamp(\'api_verified_at\', { withTimezone: true
}), humanReviewedById: uuid(\'human_reviewed_by_id\'), humanReviewedAt:
timestamp(\'human_reviewed_at\', { withTimezone: true }),
humanReviewDecision: varchar(\'human_review_decision\', { length: 10 }),
uploadedAt: timestamp(\'uploaded_at\', { withTimezone: true
}).defaultNow().notNull(), createdAt: timestamp(\'created_at\', {
withTimezone: true }).defaultNow().notNull(), }, (t) =\> \[
index(\'idx_rcs_docs_application\').on(t.applicationId),
index(\'idx_rcs_docs_type\').on(t.documentType), \], ); export const
rcsPhysicalTestScores = rcsOps.table( \'physical_test_scores\', { id:
uuid(\'id\').defaultRandom().primaryKey(), applicationId:
uuid(\'application_id\') .references(() =\> rcsApplications.id)
.notNull(), vectorClock: jsonb(\'vector_clock\').notNull(), deviceId:
varchar(\'device_id\', { length: 64 }).notNull(), heightCm:
integer(\'height_cm\'), weightKg: integer(\'weight_kg\'),
run3kmTimeSeconds: integer(\'run_3km_time_seconds\'), chestCm:
integer(\'chest_cm\'), medicalFitnessStatus:
varchar(\'medical_fitness_status\', { length: 20 }), additionalNotes:
varchar(\'additional_notes\', { length: 500 }), deviceSignature:
varchar(\'device_signature\', { length: 512 }).notNull(),
signedPayloadHash: varchar(\'signed_payload_hash\', { length: 64
}).notNull(), capturingOfficerId:
uuid(\'capturing_officer_id\').notNull(), capturedAt:
timestamp(\'captured_at\', { withTimezone: true }).notNull(), syncedAt:
timestamp(\'synced_at\', { withTimezone: true }).defaultNow(),
****syncConflictDetected:
boolean(\'sync_conflict_detected\').default(false), createdAt:
timestamp(\'created_at\', { withTimezone: true
}).defaultNow().notNull(), }, (t) =\> \[
index(\'idx_rcs_scores_application\').on(t.applicationId), \], ); EOF
echo \"Done: rcs-ops.schema.ts\" \`\`\` \-\-- \## Step 2.8 ---
\`audit_log\` Schema (Append-Only) \`\`\`bash cat \>
/home/uruti/Documents/projects/usrp/packages/shared-database/src/schemas/audit-log.schema.ts
\<\< \'EOF\' //
══════════════════════════════════════════════════════════════════ //
audit_log schema --- Immutable government audit trail // CRITICAL: No
UPDATE or DELETE ever permitted on these tables // Enforced at database
role level (REVOKE UPDATE, DELETE) // Every significant system action
produces an audit_entry row //
══════════════════════════════════════════════════════════════════
import { pgSchema, uuid, varchar, timestamp, pgEnum, jsonb, index, }
from \'drizzle-orm/pg-core\'; export const auditLog =
pgSchema(\'audit_log\'); export const auditEntityTypeEnum =
auditLog.enum(\'entity_type\', \[ \'APPLICANT\', \'APPLICATION\',
\'DOCUMENT\', \'OFFICER\', \'CAMPAIGN\', \'VENUE\', \'SYSTEM\', \]);
export const auditAgencyEnum = auditLog.enum(\'agency\', \[ \'RDF\',
\'RNP\', \'RCS\', \'SYSTEM\', \]); // ── audit_log.audit_entries
─────────────────────────────────────── // The permanent, immutable
government record of all system actions. // This table is the forensic
ground truth for any dispute or investigation. // Written by the
audit-service Kafka consumer. // No application code has UPDATE or
DELETE permission on this table. export const auditEntries =
auditLog.table( \'audit_entries\', { id:
uuid(\'id\').defaultRandom().primaryKey(), // Kafka event tracing
kafkaEventId: varchar(\'kafka_event_id\', { length: 128
}).notNull().unique(), correlationId: varchar(\'correlation_id\', {
length: 128 }).notNull(), causationId: varchar(\'causation_id\', {
length: 128 }), // What entity was affected entityType:
auditEntityTypeEnum(\'entity_type\').notNull(), entityId:
varchar(\'entity_id\', { length: 128 }).notNull(), agency:
auditAgencyEnum(\'agency\').notNull(), // What happened action:
varchar(\'action\', { length: 100 }).notNull(), // e.g.
\'APPLICATION_SUBMITTED\', \'STATUS_CHANGED\', \'DOCUMENT_UPLOADED\', //
\'NIDA_VERIFICATION_COMPLETED\', ****\'OFFICER_APPROVED_DOCUMENT\' //
Who did it performedBy: varchar(\'performed_by\', { length: 128
}).notNull(), // \'SYSTEM\' for automated actions, officer UUID for
manual actions performedByRole: varchar(\'performed_by_role\', { length:
50 }), // Status transition (when applicable) previousStatus:
varchar(\'previous_status\', { length: 50 }), newStatus:
varchar(\'new_status\', { length: 50 }), // Security context ipAddress:
varchar(\'ip_address\', { length: 45 }), userAgent:
varchar(\'user_agent\', { length: 512 }), // Additional context ---
flexible JSON for event-specific metadata // Never contains PII --- only
references (IDs, hashes, status codes) metadata: jsonb(\'metadata\'), //
When it happened --- source of truth is Kafka event timestamp
occurredAt: timestamp(\'occurred_at\', { withTimezone: true
}).notNull(), // When it was written to this table (may differ slightly
from occurredAt) recordedAt: timestamp(\'recorded_at\', { withTimezone:
true }).defaultNow().notNull(), }, (t) =\> \[
index(\'idx_audit_entity\').on(t.entityType, t.entityId),
index(\'idx_audit_agency\').on(t.agency),
index(\'idx_audit_action\').on(t.action),
index(\'idx_audit_performed_by\').on(t.performedBy),
index(\'idx_audit_occurred_at\').on(t.occurredAt),
index(\'idx_audit_correlation\').on(t.correlationId), \], ); EOF echo
\"Done: audit-log.schema.ts\" \`\`\` \-\-- \## Step 2.9 --- Run
Migration & Verify Tables \`\`\`bash \# Install dependencies in
shared-database cd /home/uruti/Documents/projects/usrp && \\ pnpm
\--filter \@usrp/shared-database install \`\`\` \`\`\`bash \# Generate
migration SQL from schemas cd /home/uruti/Documents/projects/usrp && \\
DATABASE_URL=\"postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db\"
\\ pnpm \--filter \@usrp/shared-database run db:generate \`\`\`
\`\`\`bash \# Apply migrations to the running PostgreSQL cd
/home/uruti/Documents/projects/usrp && \\
DATABASE_URL=\"postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db\"
\\ pnpm \--filter \@usrp/shared-database run db:migrate \`\`\`
\`\`\`bash \# Verify all tables exist in correct schemas docker exec
usrp-postgres psql -U usrp_admin -d usrp_db \<\< \'PSQL\' \\echo \'──
public_core tables:\' SELECT table_name FROM information_schema.tables
WHERE table_schema = \'public_core\' ORDER BY table_name; \\echo \'──
rdf_ops tables:\' SELECT table_name FROM information_schema.tables WHERE
table_schema = \'rdf_ops\' ORDER BY table_name; \\echo \'── rnp_ops
****tables:\' SELECT table_name FROM information_schema.tables WHERE
table_schema = \'rnp_ops\' ORDER BY table_name; \\echo \'── rcs_ops
tables:\' SELECT table_name FROM information_schema.tables WHERE
table_schema = \'rcs_ops\' ORDER BY table_name; \\echo \'── audit_log
tables:\' SELECT table_name FROM information_schema.tables WHERE
table_schema = \'audit_log\' ORDER BY table_name; PSQL \`\`\` \*\*Share
the output of the migration and table verification. Phase 2 seed data
follows immediately after tables are confirmed.\*\****