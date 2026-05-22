# BU MotoSpace PRD for TestSprite

วันที่เอกสาร: 2026-05-22
วัตถุประสงค์: เอกสารนี้จัดทำเพื่อใช้เป็น Product Requirement Document สำหรับ TestSprite เพื่อสร้างและจัดลำดับ test cases ของระบบ BU MotoSpace โดยเน้น feature scope, user roles, workflows, validation rules, edge cases, security requirements และ acceptance criteria ที่ตรวจสอบได้

## 1. Product Overview

BU MotoSpace เป็นเว็บแอปสำหรับบริหารจัดการทะเบียนรถจักรยานยนต์ภายในมหาวิทยาลัยกรุงเทพ ระบบรองรับการลงทะเบียนรถโดยนักศึกษา/บุคลากร, การตรวจสอบและอนุมัติทะเบียนโดยเจ้าหน้าที่, การบันทึกและตรวจสอบรายการกระทำผิดกฎ, การจัดการกฎ/ประเภทความผิด/บทลงโทษ, รายงานผู้เข้าข่ายเรียกพบ, การจัดการผู้ใช้และหน่วยงาน, รวมถึงการนำเข้า-ส่งออกและลบข้อมูลตามสิทธิ์ผู้ดูแลระบบ

ระบบพัฒนาเป็น Node.js/Express, EJS templates, MariaDB, Tailwind CSS และใช้ session-based authentication

## 2. Goals

- ให้ผู้ใช้สาธารณะลงทะเบียนรถจักรยานยนต์ได้อย่างถูกต้อง พร้อมแนบหลักฐานภาพ
- ให้เจ้าหน้าที่ตรวจสอบทะเบียนและบันทึกรายงานการกระทำผิดได้
- ให้หัวหน้างานหรือผู้ดูแลระบบอนุมัติ/ปฏิเสธทะเบียนและรายงานการกระทำผิดได้
- ให้ระบบคำนวณผู้เข้าข่ายเรียกพบจากจำนวนครั้งการกระทำผิดตามประเภทกฎ
- ให้ผู้ดูแลระบบจัดการผู้ใช้ หน่วยงาน กฎ ข้อมูลนำเข้า/ส่งออก และข้อมูลที่ต้องลบได้
- ให้ข้อมูลส่วนบุคคลและไฟล์ภาพถูกป้องกันด้วยสิทธิ์การเข้าถึง, signed URL, CSRF protection และ session timeout

## 3. Non-goals

- ไม่ครอบคลุม mobile native app
- ไม่ครอบคลุม payment หรือค่าปรับออนไลน์
- ไม่ครอบคลุมการยืนยันตัวตนผ่าน SSO ภายนอก
- ไม่ครอบคลุม notification ผ่านอีเมล/SMS
- ไม่ครอบคลุม OCR อ่านป้ายทะเบียนอัตโนมัติ

## 4. User Roles

| Role | Description | Primary Access |
| --- | --- | --- |
| Public user | นักศึกษา/บุคลากรที่ยังไม่ login | หน้า `/register` สำหรับลงทะเบียนรถ |
| Officer | เจ้าหน้าที่ทั่วไป | บันทึก/แจ้งรายการกระทำผิด, ดูรายการที่เกี่ยวข้อง |
| Head | หัวหน้างาน | Dashboard, อนุมัติทะเบียน, ตรวจสอบรายงานความผิด, จัดการกฎ, รายงานเรียกพบ |
| Superadmin | ผู้ดูแลระบบสูงสุด | ทุกสิทธิ์ของ Head และจัดการผู้ใช้ หน่วยงาน ข้อมูล import/export/delete |

## 5. Permission Matrix

| Feature | Public | Officer | Head | Superadmin |
| --- | --- | --- | --- | --- |
| Submit motorcycle registration | Yes | No | No | No |
| Login/logout | No | Yes | Yes | Yes |
| View dashboard | No | No | Yes | Yes |
| Review registrations | No | No | Yes | Yes |
| Approve/reject registration | No | No | Yes | Yes |
| Manage registration vehicles | No | No | Yes | Yes |
| Create violation report | No | Yes | Yes | Yes |
| Confirm/reject violation report | No | No | Yes | Yes |
| Manage rules, violation types, penalties | No | No | Yes | Yes |
| Manage summons/reports | No | No | Yes | Yes |
| Manage users | No | No | No | Yes |
| Manage departments | No | No | No | Yes |
| Import/export/delete datasets | No | No | No | Yes |
| Access protected uploaded images | No | Authenticated only with valid signed URL | Authenticated only with valid signed URL | Authenticated only with valid signed URL |

## 6. Test Environment Assumptions

- Default app base URL: `http://localhost:3000`; use the `APP_PORT` value when the test environment overrides the port
- Database: MariaDB database named `bu_motospace`
- First boot creates a default superadmin if no admin exists
- Development default credentials may be `admin` / `admin123` unless overridden by environment variables
- In production, `SESSION_SECRET` and `IMAGE_SECRET` must be at least 32 characters
- In development, reCAPTCHA validation is skipped
- Upload limit is 10 MB per file
- Supported public registration image formats: JPEG, JPG, PNG, WebP, HEIC, HEIF
- Supported import formats: CSV, XLS, XLSX
- Supported summons document formats: PDF, DOC, DOCX, JPEG, PNG, WebP, HEIC, HEIF

## 7. Core Data Entities

| Entity | Purpose | Key Statuses / Fields |
| --- | --- | --- |
| `admins` | Staff accounts | `role`: officer, head, superadmin; `is_active` |
| `departments` | Staff departments | unique `department_name` |
| `registrations` | Owner registration and first vehicle compatibility record | `status`: pending, approved, rejected; soft delete fields |
| `vehicles` | One or more motorcycles per owner | `status`: pending, approved, rejected; unique normalized plate |
| `rules` | Regulation items | active/inactive, linked violation type and penalty type |
| `violation_types` | Grouping of rule severity/category | `type_code`, `max_violations`, active/inactive |
| `penalty_types` | Penalty category | active/inactive |
| `violation_reports` | Report awaiting review | `status`: pending, confirmed, rejected |
| `violations` | Confirmed violation history | soft delete fields |
| `summons_appointments` | Meeting/appointment records | appointment code, schedule, attached document |
| `data_deletion_logs` | Snapshot logs for data deletion | soft/hard deletion audit data |
| `image_hashes` | Image fingerprint search support | registration image hashes |
| `app_sessions` | Persistent session store | session expiry |

## 8. Functional Requirements

### 8.1 Public Registration

Route group: `/register`

#### Requirements

- Public users can open the registration form without login
- User type must be either `student` or `staff`
- Student ID must be exactly 10 digits
- Staff ID must be exactly 6 alphanumeric characters
- Phone number must be exactly 10 digits
- First name, last name, ID number, phone, license plate, province, ID card photo, motorcycle photo, and plate photo are required
- User can optionally register a second motorcycle in the same submission
- When second vehicle is selected, second license plate, second province, second motorcycle photo, and second plate photo are required
- Duplicate license plates must be rejected using normalized plate comparison
- The same owner identity cannot be reused with a different first/last name
- Submission must pass CSRF validation
- Submission must pass bot protections: honeypot, rate limit, and reCAPTCHA in non-development environments
- Successful registration creates a pending registration and pending vehicle record

#### Acceptance Criteria

- Valid single-vehicle registration redirects back with success message and creates `pending` data
- Valid two-vehicle registration creates one owner registration with two vehicle records
- Missing required fields do not create database records and show validation feedback
- Invalid student/staff ID formats are rejected
- Invalid phone format is rejected
- Duplicate plate in the database is rejected
- Same plate repeated for vehicle 1 and vehicle 2 is rejected
- Invalid or missing CSRF token returns a 403 flow/error message
- More than 5 POST submissions from the same IP within 15 minutes are rate-limited

#### Suggested TestSprite Scenarios

- Submit valid student registration with one vehicle
- Submit valid staff registration with two vehicles
- Submit registration with missing ID card image
- Submit registration with invalid student ID length
- Submit registration with invalid staff ID characters/length
- Submit registration with 9-digit phone number
- Submit duplicate plate after a prior successful submission
- Submit second vehicle with same plate as first vehicle
- Submit image larger than 10 MB and expect upload failure
- Submit unsupported file type as motorcycle photo
- Submit without CSRF token and expect rejection

### 8.2 Authentication and Session Management

Route group: `/auth`

#### Requirements

- Authenticated users login with username/password
- Only active admins can login
- Passwords are verified by bcrypt
- Invalid username and invalid password show the same generic error
- Session ID is regenerated after successful login
- Officer login redirects to `/violations`
- Head and superadmin login redirect to `/dashboard`
- Logout must be POST-only for actual session destruction
- GET `/auth/logout` must not destroy a logged-in session
- Idle authenticated sessions expire after 1 hour of inactivity
- Login attempts are rate-limited to 10 attempts per 15 minutes per IP

#### Acceptance Criteria

- Valid active officer can login and lands on the violations page
- Valid active head/superadmin can login and lands on dashboard
- Inactive user cannot login
- Incorrect username/password does not reveal which field is wrong
- POST logout destroys session and clears session cookie
- Protected routes redirect unauthenticated users to login
- Expired session redirects to `/auth/session-expired` for browser requests

#### Suggested TestSprite Scenarios

- Login as superadmin with valid credentials
- Login as officer and verify redirect target
- Login with wrong password and verify generic error
- Attempt protected dashboard without login
- POST logout after login and verify next protected route redirects to login
- GET `/auth/logout` while logged in and verify user remains authenticated
- Simulate missing/expired session on authenticated route

### 8.3 Dashboard

Route group: `/dashboard`

#### Requirements

- Dashboard is accessible only to Head and Superadmin
- Dashboard shows summary counts for total registrations, pending registrations, approved registrations, total violations, pending violation reports, summons candidates, student count, and staff count
- Dashboard lists recent pending registrations
- Dashboard lists pending violation reports
- Dashboard includes monthly registration data for the last 6 months
- Dashboard includes top violated rules

#### Acceptance Criteria

- Officer cannot access dashboard
- Head and Superadmin can access dashboard
- Counts update after creating registrations, confirming violation reports, and creating summons records
- Dashboard still renders with zero-value fallback if query failure occurs

#### Suggested TestSprite Scenarios

- Login as head and verify dashboard widgets exist
- Login as officer and attempt `/dashboard`
- Create pending registration and verify pending count changes
- Create pending violation report and verify pending report count changes

### 8.4 Registration Review and Management

Route group: `/registrations`

#### Requirements

- Only Head and Superadmin can review and manage registrations
- Registration list supports status filters including pending, approved, rejected, deleted/all where available
- Registration search supports owner ID, name, license plate, and normalized plate matching
- Detail page shows owner information, vehicle information, uploaded images, violation history, reports, and summons records
- Head/Superadmin can approve or reject pending registration/vehicle records
- Rejection requires notes/reason where UI asks for one
- Head/Superadmin can edit registration data and vehicle data
- Head/Superadmin can soft-delete and restore registrations
- Vehicle status synchronization updates registration status:
  - Any public vehicle pending means registration is pending
  - Any public vehicle rejected means registration is rejected
  - All public vehicles approved means registration is approved
- New vehicle plate must be unique after normalization

#### Acceptance Criteria

- Pending registration can be approved and appears as approved
- Pending registration can be rejected and appears as rejected
- Vehicle approval/rejection updates the effective owner registration status
- Deleted registration no longer appears in active lists
- Restored registration reappears in active lists
- Duplicate vehicle plate cannot be added
- Search works with spaces removed from plate input
- Protected images display only for authenticated users through signed image URL

#### Suggested TestSprite Scenarios

- Filter registrations by pending status
- Approve a pending registration
- Reject a pending registration with note
- Add a second vehicle to an existing owner
- Edit vehicle plate to a duplicate plate and expect validation error
- Soft-delete a registration and verify it disappears from active view
- Restore a deleted registration
- Search by owner full name
- Search by plate with and without spaces

### 8.5 Violation Reporting by Officers

Route group: `/violations`

#### Requirements

- Authenticated officers, heads, and superadmins can open violation reporting/list pages
- Only approved active registrations can be selected for new violation reports
- A new officer submission creates a `violation_reports` record with `pending` status rather than immediately creating a confirmed violation history record
- Submission requires valid registration and active rule
- Optional evidence photo can be uploaded
- Evidence upload follows image upload constraints
- List supports search, rule filter, pagination, top violators, and top violated rules
- Head/Superadmin can edit or delete reported entries according to current route permissions

#### Acceptance Criteria

- Officer can submit a report against an approved registration
- Report appears in pending review list
- Officer cannot submit against a non-existent registration or invalid rule
- Evidence image is stored only when valid
- Search and pagination keep results stable

#### Suggested TestSprite Scenarios

- Login as officer and create a violation report for an approved registration
- Attempt to report violation for pending registration
- Attempt to submit with missing rule
- Attach valid evidence photo
- Attach unsupported evidence file type
- Verify pending report appears under review workflow

### 8.6 Violation Report Review

Route group: `/violation-reports`

#### Requirements

- Head/Superadmin can list pending, confirmed, rejected, and all reports
- Head/Superadmin can view report details
- Head/Superadmin can confirm pending or rejected reports
- Confirming a report creates a confirmed `violations` record and links it to `violation_reports.violation_id`
- Head/Superadmin can reject pending or confirmed reports; rejected reports cannot be rejected again
- Review note is optional when rejecting; if a confirmed report is rejected without a note, the linked violation uses a default delete reason
- Rejecting a confirmed report soft-deletes the linked confirmed violation and clears the report link
- A report cannot be confirmed if the owner has already reached the max violation count for the relevant rule/type since the last summons reset
- Edited confirmed reports must keep linked violation history synchronized

#### Acceptance Criteria

- Pending report can be confirmed and becomes confirmed
- Confirmed report creates exactly one confirmed violation record
- Confirmed report can be rejected and linked violation is soft-deleted
- A rejected report can be confirmed again if still within allowed count
- Review actions require Head/Superadmin role
- Officer cannot confirm or reject reports

#### Suggested TestSprite Scenarios

- Confirm pending violation report as head
- Reject pending violation report as head
- Reject confirmed report and verify linked violation no longer appears in active history
- Attempt confirm as officer and expect access denial
- Create reports until max violations is reached and verify next confirmation is blocked
- Edit a confirmed report and verify linked violation data updates

### 8.7 Rules, Violation Types, and Penalty Types

Route group: `/rules`

#### Requirements

- Only Head and Superadmin can manage rules
- System supports three management tabs: rules, violation types, penalty types
- Violation type requires name and optional type code
- Type code must be uppercase alphanumeric, 2-10 characters, normalized without `IR-`
- Violation type has `max_violations`, defaulting to 3 when invalid/empty
- Penalty type requires name
- Rule requires rule name
- Rule can link to active violation type and active penalty type
- Toggle actions deactivate/activate records without losing historical references
- Deleting a violation type or penalty type used by rules deactivates it instead of hard-deleting it
- Deleting an unused violation type or penalty type hard-deletes it
- Destroying a rule permanently removes it only through the explicit destroy route

#### Acceptance Criteria

- Add/edit/toggle violation type works for valid data
- Invalid violation type code is rejected
- Add/edit/toggle penalty type works for valid data
- Add/edit/toggle rule works for valid data
- Rule creation rejects inactive or missing required type selections where required
- Historical violations remain readable when rules/types are deactivated

#### Suggested TestSprite Scenarios

- Create violation type with code `MIN`
- Create violation type with invalid code `@!`
- Edit violation type max violations
- Create penalty type
- Create rule linked to active type and penalty
- Toggle rule inactive and verify it no longer appears as active selection
- Delete a used violation type and verify it is deactivated instead of breaking rules

### 8.8 Summons and Reports

Route group: `/reports`

#### Requirements

- Only Head and Superadmin can access reports
- Main reports page supports registration/violation summaries and CSV export
- Summons report lists owners whose confirmed violations reach the configured threshold for a rule/type since the last summons reset
- Summons confirmation creates a `summons_appointments` record
- Summons appointment code format is `MEET-YYYYMMDD-NNN`
- Appointment schedule must be a valid `datetime-local` value
- Optional written document can be attached using supported document/image formats
- Creating a summons acts as a reset point for future threshold calculations

#### Acceptance Criteria

- Owner appears in summons candidates after reaching max violations
- Owner no longer appears for that same type after summons appointment is created
- Invalid appointment datetime is rejected
- Appointment code is generated uniquely
- Export endpoints return downloadable CSV files

#### Suggested TestSprite Scenarios

- Create enough confirmed violations to trigger summons candidate
- Confirm summons appointment with valid datetime
- Confirm summons with invalid datetime and expect error
- Upload valid PDF summons document
- Upload unsupported summons document file
- Export summons report CSV

### 8.9 User Management

Route group: `/users`

#### Requirements

- Only Superadmin can manage users
- Superadmin can create users with username, password, full name, role, optional email, phone, and department
- Valid roles are `officer`, `head`, `superadmin`
- Usernames must be unique
- Superadmin can update user profile and optionally reset password
- Superadmin can deactivate and restore users
- Superadmin cannot deactivate or delete their own account
- Hard delete is available for other users through explicit delete route

#### Acceptance Criteria

- Superadmin can create officer/head/superadmin accounts
- Duplicate username is rejected
- Non-superadmin cannot access user management
- Deactivated user cannot login
- Current user cannot deactivate/delete self

#### Suggested TestSprite Scenarios

- Create new officer user
- Create duplicate username
- Update user role from officer to head
- Deactivate user and verify login fails
- Attempt self-deactivation as superadmin
- Login as head and attempt `/users`

### 8.10 Department Management

Route group: `/departments`

#### Requirements

- Only Superadmin can manage departments
- Department name is required and unique
- Department can include optional description
- Department cannot be deleted while assigned to users

#### Acceptance Criteria

- Superadmin can create department
- Duplicate department name is rejected
- Department assigned to a user cannot be deleted
- Unassigned department can be deleted

#### Suggested TestSprite Scenarios

- Create department
- Create duplicate department
- Assign user to department, then attempt delete department
- Delete unassigned department

### 8.11 Data Import, Export, and Deletion Management

Route group: `/data`

#### Requirements

- Only Superadmin can access data management
- Export supports registrations and violations datasets
- Import registrations supports CSV, XLS, XLSX
- Import row count is limited by `MAX_IMPORT_ROWS`, default 5000
- Import skips rows that fail validation or duplicate constraints and reports imported/skipped counts
- Data management supports active, deleted, and all views
- Soft delete by registration date range requires both start and end date
- Soft delete cascades logical deletion to related violations, reports, and summons records
- Hard delete of soft-deleted rows requires typing `DELETE`
- Deletion snapshots are saved to `data_deletion_logs`

#### Acceptance Criteria

- Superadmin can export active registrations
- Import without a file is rejected
- Import unsupported file type is rejected
- Import more than max rows is rejected
- Soft delete requires date range and reason
- Hard delete requires confirmation text `DELETE`
- Non-superadmin cannot access data management

#### Suggested TestSprite Scenarios

- Export registrations CSV
- Export violations CSV
- Import valid CSV template
- Import unsupported TXT file
- Import CSV with duplicate plate and verify skipped count
- Attempt soft delete without date range
- Soft delete selected date range and verify records move to deleted view
- Attempt hard delete without typing `DELETE`
- Hard delete soft-deleted records with correct confirmation

### 8.12 Protected Images and Upload Handling

Route group: `/img/:encoded`, upload middleware

#### Requirements

- Uploaded private images are stored outside `public`
- Direct `/uploads` access is blocked
- Protected images are served only through signed URL endpoint
- Signed URL requires authenticated admin session
- Signed URL requires valid HMAC signature and unexpired `exp`
- Uploads use randomized filenames
- HEIC/HEIF images are converted to JPEG
- JPEG/PNG/WebP images are resized to max 1200px per side without enlargement
- Invalid upload type cleans up uploaded temp files where possible

#### Acceptance Criteria

- Unauthenticated request to `/img/...` redirects to login or is rejected
- Signed image URL with invalid signature is rejected
- Signed image URL after expiry is rejected
- Direct `/uploads/...` URL is forbidden
- Valid image upload is stored and can later be viewed through signed URL by authenticated admin

#### Suggested TestSprite Scenarios

- Attempt direct `/uploads/motorcycles/example.jpg`
- Attempt signed image URL while logged out
- Attempt signed image URL with modified `sig`
- Upload HEIC image and verify workflow accepts it
- Upload large JPEG and verify registration still succeeds

## 9. Cross-cutting Security Requirements

- All state-changing requests must require CSRF token
- Multipart form routes must apply CSRF verification after multer parses form data
- Session cookies must be HTTP-only
- Production session cookies must be secure when `NODE_ENV=production`
- Production must reject weak/missing `SESSION_SECRET` and `IMAGE_SECRET`
- Content Security Policy must allow only required trusted sources
- Login should protect against brute force and username enumeration
- Registration should protect against spam through honeypot, rate limiting, and reCAPTCHA
- Sensitive uploaded documents/images must not be publicly accessible
- Role-based access control must consistently protect routes
- Soft deletion should preserve auditability and avoid accidental data loss

## 10. Error Handling Requirements

- User-facing validation failures should show flash error messages and avoid creating partial records
- Upload/image processing errors should redirect back to the form with a clear error
- CSRF mismatch should return 403 behavior and tell the user to reload/retry
- Unexpected server errors during public registration should not expose stack traces
- Database transaction failures should roll back partial writes
- Deletion operations should log snapshots before destructive changes

## 11. Important Edge Cases

- Same owner ID with different owner name
- Same license plate with different spacing or casing
- Two vehicles in one registration using identical plate
- Vehicle-level rejection while owner has another approved vehicle
- Confirming a violation report after max violation threshold has been reached
- Rejecting a report that already created a confirmed violation
- Editing a confirmed report after linked violation exists
- Soft-deleted registrations with related violations/reports/summons
- Inactive rules/types used by historical records
- Session expiration during a multipart form submission
- Browser refresh/resubmit after successful POST
- Import file containing duplicate plates, missing required columns, or too many rows

## 12. Test Data Recommendations

Use deterministic test data so TestSprite can assert exact behavior:

| Data Type | Example |
| --- | --- |
| Student owner | user_type `student`, id `6600000001`, name `Test Student One`, phone `0812345678` |
| Staff owner | user_type `staff`, id `STF001`, name `Test Staff One`, phone `0899999999` |
| License plate 1 | `1กก 1234` province `กรุงเทพมหานคร` |
| License plate 2 | `2ขข 5678` province `ปทุมธานี` |
| Officer | username `officer_test`, role `officer` |
| Head | username `head_test`, role `head` |
| Superadmin | username `admin`, role `superadmin` |
| Violation type | `Minor Test`, code `MIN`, max violations `3` |
| Penalty type | `Warning Test` |
| Rule | `ไม่สวมหมวกกันน็อก Test` |

## 13. High-priority End-to-End Test Flows

### Flow A: Registration to Approval

1. Public user submits valid student registration with required photos
2. Head logs in
3. Head opens pending registrations
4. Head views registration detail
5. Head approves registration/vehicle
6. Registration appears in approved list
7. Approved owner appears as selectable target in violation reporting

### Flow B: Officer Report to Confirmed Violation

1. Officer logs in
2. Officer creates violation report for approved owner and active rule
3. Head logs in
4. Head opens pending violation reports
5. Head confirms report
6. Report status becomes confirmed
7. Confirmed violation appears in violation history

### Flow C: Max Violations to Summons

1. Create/confirm repeated violations for the same owner and violation type until threshold is reached
2. Head opens summons report
3. Owner appears as summons candidate
4. Head creates summons appointment with valid datetime
5. Owner is reset for that violation type after appointment creation

### Flow D: Security and Access Control

1. Logged-out user attempts `/dashboard`, `/registrations`, `/users`, `/data`
2. Officer attempts Head/Superadmin-only pages
3. Head attempts Superadmin-only pages
4. Invalid CSRF token is submitted to a POST route
5. Direct `/uploads` access is attempted
6. Signed image URL is tampered with

### Flow E: Data Lifecycle

1. Superadmin exports registrations
2. Superadmin imports valid CSV
3. Superadmin soft-deletes registrations by date range
4. Deleted records appear in deleted view
5. Deletion snapshots exist
6. Superadmin hard-deletes soft-deleted data with `DELETE` confirmation

## 14. Test Priorities

| Priority | Area | Reason |
| --- | --- | --- |
| P0 | Authentication, RBAC, CSRF | Prevent unauthorized access and state changes |
| P0 | Public registration validation | Main entry point and highest public exposure |
| P0 | Registration approval and vehicle status sync | Core operational workflow |
| P0 | Violation report confirmation/rejection | Determines official violation history |
| P1 | Summons threshold and reset behavior | Critical business rule |
| P1 | Protected image access | PDPA/privacy requirement |
| P1 | Data deletion lifecycle | High-risk destructive operations |
| P2 | Dashboard/report exports | Operational visibility |
| P2 | Rule/type/penalty management | Configuration workflow |
| P2 | Department management | Admin support workflow |

## 15. Out-of-scope for Initial Automated Tests

- Visual pixel-perfect comparisons
- Email/SMS notification behavior
- Production-only HTTPS deployment behavior beyond cookie/security assertions
- Load testing beyond basic pagination/import limits
- Browser compatibility matrix beyond one Chromium-based browser unless TestSprite is configured otherwise
