# Tools Reference (129)

Full reference for all ERPNext MCP tools. See [README](../README.md) for
overview.

Every `limit` is a page length of at least 1, and anything below that is
rejected rather than repaired. ERPNext reads a page length of 0 as "no `LIMIT`
clause": on the reference instance `limit_page_length=0` returns all 2235
`Account` rows while `limit_page_length=5` returns 5. So `limit: 0.5` - a
request for at most one document - would otherwise come back with the whole
DocType. Fractions above 1 are truncated the way Frappe truncates them, so the
limit asked for and the limit applied stay the same number.

## Identity (2) → doclist-viewer

| Tool              | DocType       | Operations                                                                                |
| ----------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `erpnext_whoami`  | User/Employee | Caller's User id, full name, roles, linked Employee, and `identity_mode`                  |
| `erpnext_my_work` | six doctypes  | Open ToDos, tasks, projects, leave applications, expense claims, timesheets (per section) |

`erpnext_whoami` takes no arguments and resolves the caller itself. Its `roles`,
`employee` and `employee_lookup` fields distinguish "empty" from "withheld", so
read them before telling anyone they hold no roles or have no HR record.

## Setup (3)

| Tool                     | DocType | Operations                                     |
| ------------------------ | ------- | ---------------------------------------------- |
| `erpnext_user_list`      | User    | List assignable users (enabled System Users)   |
| `erpnext_company_list`   | Company | List companies                                 |
| `erpnext_company_create` | Company | Create (name, abbr, currency, country, domain) |

## Sales (17) → doclist-viewer / invoice-viewer

| Tool                           | DocType       | Operations                                   |
| ------------------------------ | ------------- | -------------------------------------------- |
| `erpnext_customer_list`        | Customer      | List + filters (group, territory, disabled)  |
| `erpnext_customer_get`         | Customer      | Get by name                                  |
| `erpnext_customer_create`      | Customer      | Create (name, group, territory, email, type) |
| `erpnext_customer_update`      | Customer      | Update fields                                |
| `erpnext_sales_order_list`     | Sales Order   | List + filters (customer, status, dates)     |
| `erpnext_sales_order_get`      | Sales Order   | Get with line items                          |
| `erpnext_sales_order_create`   | Sales Order   | Create (customer + items + delivery_date)    |
| `erpnext_sales_order_update`   | Sales Order   | Update (delivery_date, items)                |
| `erpnext_sales_order_submit`   | Sales Order   | Submit (Draft → To Deliver and Bill)         |
| `erpnext_sales_order_cancel`   | Sales Order   | Cancel                                       |
| `erpnext_sales_invoice_list`   | Sales Invoice | List + filters                               |
| `erpnext_sales_invoice_get`    | Sales Invoice | Get with line items                          |
| `erpnext_sales_invoice_create` | Sales Invoice | Create (customer + items + dates)            |
| `erpnext_sales_invoice_submit` | Sales Invoice | Submit (Draft → Unpaid)                      |
| `erpnext_quotation_list`       | Quotation     | List + filters (party, status)               |
| `erpnext_quotation_get`        | Quotation     | Get with line items                          |
| `erpnext_quotation_create`     | Quotation     | Create (Customer/Lead + items)               |

## Inventory (10) → doclist-viewer / stock-viewer

| Tool                         | DocType            | Operations                                                         |
| ---------------------------- | ------------------ | ------------------------------------------------------------------ |
| `erpnext_item_list`          | Item               | List + filters (group, stock flag, disabled)                       |
| `erpnext_item_get`           | Item               | Get by name/code                                                   |
| `erpnext_item_create`        | Item               | Create (code, name, group, uom, rate)                              |
| `erpnext_item_update`        | Item               | Update fields                                                      |
| `erpnext_stock_balance`      | Bin                | Stock balances by item/warehouse                                   |
| `erpnext_stock_ledger_list`  | Stock Ledger Entry | Read recent non-cancelled rows for one required item and warehouse |
| `erpnext_warehouse_list`     | Warehouse          | List + filters (company, type)                                     |
| `erpnext_stock_entry_list`   | Stock Entry        | List + filters (type, dates)                                       |
| `erpnext_stock_entry_get`    | Stock Entry        | Get with item details                                              |
| `erpnext_stock_entry_create` | Stock Entry        | Create (type + items + warehouses)                                 |

`erpnext_stock_ledger_list` requires `item_code` (Item ID or name, resolved
server-side) and `warehouse` (exact warehouse ID). `limit` is an integer from 1
to 20, default 5. It returns `{data: rows}` with `name`, `item_code`,
`warehouse`, `posting_date`, `posting_time`, `voucher_type`, `voucher_no`,
`actual_qty`, `qty_after_transaction`, and `stock_uom`, ordered by posting date,
posting time, then name descending. Cancelled rows are excluded. The tool uses
normal ERPNext read permissions and works with only the `inventory` category;
permission errors never fall back to site-wide Stock Entries or generic
operations. It has no standalone viewer binding.

## Purchasing (11) → doclist-viewer / invoice-viewer

| Tool                              | DocType            | Operations                                    |
| --------------------------------- | ------------------ | --------------------------------------------- |
| `erpnext_supplier_list`           | Supplier           | List + filters (group, type, disabled)        |
| `erpnext_supplier_get`            | Supplier           | Get by name                                   |
| `erpnext_supplier_create`         | Supplier           | Create (name, group, type, country, currency) |
| `erpnext_purchase_order_list`     | Purchase Order     | List + filters (supplier, status, dates)      |
| `erpnext_purchase_order_get`      | Purchase Order     | Get with line items                           |
| `erpnext_purchase_order_create`   | Purchase Order     | Create (supplier + items + schedule_date)     |
| `erpnext_purchase_invoice_list`   | Purchase Invoice   | List + filters                                |
| `erpnext_purchase_invoice_get`    | Purchase Invoice   | Get with line items                           |
| `erpnext_purchase_receipt_list`   | Purchase Receipt   | List + filters                                |
| `erpnext_purchase_receipt_get`    | Purchase Receipt   | Get with received items                       |
| `erpnext_supplier_quotation_list` | Supplier Quotation | List + filters                                |

## Accounting (8) → doclist-viewer

| Tool                           | DocType                    | Operations                                                                                                                       |
| ------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `erpnext_account_list`         | Account                    | Chart of accounts + filters (root_type, is_group, disabled)                                                                      |
| `erpnext_journal_entry_list`   | Journal Entry              | List + filters (voucher_type, dates)                                                                                             |
| `erpnext_journal_entry_get`    | Journal Entry              | Get with accounts                                                                                                                |
| `erpnext_journal_entry_create` | Journal Entry              | Create (voucher_type + balanced accounts)                                                                                        |
| `erpnext_payment_entry_list`   | Payment Entry              | List + filters (type, party, dates)                                                                                              |
| `erpnext_payment_entry_get`    | Payment Entry              | Get with references                                                                                                              |
| `erpnext_gl_entry_list`        | GL Entry                   | Read posted ledger rows by account, party, voucher, company and dates; cancelled rows excluded by default                        |
| `erpnext_financial_report`     | Standard financial reports | Read an allowlisted ERPNext report under caller permissions; returns columns, rows and summary without queuing a Prepared Report |

## HR (15) → doclist-viewer

| Tool                               | DocType                       | Operations                                                                                                                                                               |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `erpnext_employee_list`            | Employee                      | List + filters (department, status, company)                                                                                                                             |
| `erpnext_employee_get`             | Employee                      | Get by ID                                                                                                                                                                |
| `erpnext_attendance_list`          | Attendance                    | List + filters (employee, status, dates)                                                                                                                                 |
| `erpnext_leave_application_list`   | Leave Application             | List + filters                                                                                                                                                           |
| `erpnext_leave_application_get`    | Leave Application             | Get by name                                                                                                                                                              |
| `erpnext_leave_application_create` | Leave Application             | Create (employee, type, dates, reason)                                                                                                                                   |
| `erpnext_salary_slip_list`         | Salary Slip                   | List + filters (employee, status, dates)                                                                                                                                 |
| `erpnext_salary_slip_get`          | Salary Slip                   | Get with earnings/deductions                                                                                                                                             |
| `erpnext_payroll_entry_list`       | Payroll Entry                 | List + filters (company, status)                                                                                                                                         |
| `erpnext_expense_claim_list`       | Expense Claim                 | List + filters                                                                                                                                                           |
| `erpnext_expense_claim_create`     | Expense Claim                 | Create (employee + expenses[])                                                                                                                                           |
| `erpnext_leave_balance`            | Leave Allocation              | Get allocations by employee                                                                                                                                              |
| `erpnext_employee_checkin_list`    | Employee Checkin              | Read raw punches by employee, log type and date range                                                                                                                    |
| `erpnext_attendance_day_get`       | Attendance / Employee Checkin | Read one employee-day, shift, punches and repair blockers; requires hvg_workspace                                                                                        |
| `erpnext_attendance_day_fix`       | Attendance / Employee Checkin | Mutate one employee-day: add/correct punches and rebuild Attendance; cancelling a submitted record requires confirm_cancel_attendance; reason and hvg_workspace required |

## Project (9) → doclist-viewer

| Tool                     | DocType   | Operations                                           |
| ------------------------ | --------- | ---------------------------------------------------- |
| `erpnext_project_list`   | Project   | List + filters (status, company)                     |
| `erpnext_project_get`    | Project   | Get by name                                          |
| `erpnext_project_create` | Project   | Create (name, status, dates, budget, company)        |
| `erpnext_task_list`      | Task      | List + filters (project, status, priority)           |
| `erpnext_task_get`       | Task      | Get with dependencies                                |
| `erpnext_task_create`    | Task      | Create + native assignment (assignees, ToDo details) |
| `erpnext_task_update`    | Task      | Update + native assignment (assignees, ToDo details) |
| `erpnext_timesheet_list` | Timesheet | List + filters (employee, project, status)           |
| `erpnext_timesheet_get`  | Timesheet | Get with time log details                            |

## Delivery (5) → doclist-viewer

| Tool                           | DocType       | Operations                                      |
| ------------------------------ | ------------- | ----------------------------------------------- |
| `erpnext_delivery_note_list`   | Delivery Note | List + filters (customer, status, dates)        |
| `erpnext_delivery_note_get`    | Delivery Note | Get with delivered items                        |
| `erpnext_delivery_note_create` | Delivery Note | Create (customer + items + against_sales_order) |
| `erpnext_shipment_list`        | Shipment      | List + filters (status, carrier, dates)         |
| `erpnext_shipment_get`         | Shipment      | Get with parcels                                |

## Manufacturing (7) → doclist-viewer

| Tool                        | DocType    | Operations                                      |
| --------------------------- | ---------- | ----------------------------------------------- |
| `erpnext_bom_list`          | BOM        | List + filters (item, is_active, is_default)    |
| `erpnext_bom_get`           | BOM        | Get with raw materials + operations             |
| `erpnext_work_order_list`   | Work Order | List + filters (production_item, status, dates) |
| `erpnext_work_order_get`    | Work Order | Get with operations + materials                 |
| `erpnext_work_order_create` | Work Order | Create (production_item, bom_no, qty, dates)    |
| `erpnext_job_card_list`     | Job Card   | List + filters (work_order, status, operation)  |
| `erpnext_job_card_get`      | Job Card   | Get with time logs + material transfers         |

## CRM (8) → doclist-viewer

| Tool                       | DocType     | Operations                                   |
| -------------------------- | ----------- | -------------------------------------------- |
| `erpnext_lead_list`        | Lead        | List + filters (status, lead_owner, source)  |
| `erpnext_lead_get`         | Lead        | Get by name                                  |
| `erpnext_lead_create`      | Lead        | Create (name, company, email, phone, source) |
| `erpnext_opportunity_list` | Opportunity | List + filters (status, owner, party)        |
| `erpnext_opportunity_get`  | Opportunity | Get with items + competitors                 |
| `erpnext_contact_list`     | Contact     | List + filters (company, status)             |
| `erpnext_contact_get`      | Contact     | Get by name                                  |
| `erpnext_campaign_list`    | Campaign    | List + filters (campaign_type)               |

## Assets (8) → doclist-viewer

| Tool                             | DocType           | Operations                                            |
| -------------------------------- | ----------------- | ----------------------------------------------------- |
| `erpnext_asset_list`             | Asset             | List + filters (status, category, location)           |
| `erpnext_asset_get`              | Asset             | Get with depreciation + maintenance                   |
| `erpnext_asset_create`           | Asset             | Create (name, category, company, purchase_date, cost) |
| `erpnext_asset_movement_list`    | Asset Movement    | List + filters (purpose, dates)                       |
| `erpnext_asset_movement_get`     | Asset Movement    | Get with assets moved                                 |
| `erpnext_asset_maintenance_list` | Asset Maintenance | List + filters                                        |
| `erpnext_asset_maintenance_get`  | Asset Maintenance | Get with maintenance tasks                            |
| `erpnext_asset_category_list`    | Asset Category    | List all categories                                   |

## Generic Operations (12) → doclist-viewer

| Tool                      | Operation | Notes                                             |
| ------------------------- | --------- | ------------------------------------------------- |
| `erpnext_calendar_events` | List      | Calendar range, repeating events expanded         |
| `erpnext_doc_create`      | Create    | Any DocType — essential for master data setup     |
| `erpnext_doc_get`         | Get       | Any document by DocType + name                    |
| `erpnext_doc_list`        | List      | Any DocType with fields, filters, limit, order_by |
| `erpnext_doc_update`      | Update    | Partial patch — pass only fields to change        |
| `erpnext_doc_delete`      | Delete    | Draft documents only                              |
| `erpnext_doc_submit`      | Submit    | Any submittable document                          |
| `erpnext_doc_cancel`      | Cancel    | Any submitted document                            |
| `erpnext_doc_assign`      | Assign    | Native assignment (ToDo + notification) to users  |
| `erpnext_doc_unassign`    | Unassign  | Remove one user's native assignment               |
| `erpnext_file_upload`     | Upload    | Attach base64 data as a native File               |
| `erpnext_method_call`     | Call      | Any allowlisted whitelisted method by dotted path |

`erpnext_file_upload` requires `file_name`, `content_base64`,
`attached_to_doctype`, and `attached_to_name`; `attached_to_field` is optional.
Files are private by default (`is_private: false` makes them public), accept no
local path or URL, are capped at 10 MiB decoded by default (override with
positive-integer-byte `ERPNEXT_MAX_UPLOAD_BYTES`), require write permission on
the DocType, and return native `File` metadata.

`erpnext_calendar_events` takes `start` (`YYYY-MM-DD`), optional `end`, optional
`user`, and optional `limit`. It goes through the same call the ERPNext calendar
uses, so a repeating event comes back once per occurrence in the range. Every
row carries `is_recurring` (read from the stored `repeat_this_event` column, so
it holds on any ERPNext build) and, when ERPNext supplies it, `recurring_from`
(the stored master's start). A plain `erpnext_doc_list` on `Event` cannot do
this: it returns the single stored row.

Rows are sorted by `starts_on` (ties broken by `name`) before `limit` cuts the
page, so "the next N events" really is the next N. ERPNext does not sort its
answer: it appends every expansion of a repeating master in that master's own
position, so the raw array arrives in per-master blocks. `start` and `end` must
be dates that exist - `2026-02-31` matches the `YYYY-MM-DD` shape but silently
rolls into March, so it is rejected rather than sent. A non-array answer from
ERPNext is an error, never an empty calendar.

Both ends of the range are **inclusive** - ERPNext compares with
`date(starts_on) BETWEEN date(start) AND date(end)` and expands occurrences
while `target_date <= end` - so `end` defaults to `start` plus six days, which
is a seven-day week rather than eight days. The range is capped at 366 days:
recurrence expansion runs server-side and walks day by day for Daily and Weekly
events, so a multi-year window materialises thousands of rows in ERPNext before
`limit` can cut anything.

Scope is the caller's own calendar: open events that are Public, owned by them,
or shared with them through DocShare. Participation alone does not make an event
visible - the visibility clause in Frappe's `get_events` is
`event_type='Public' OR owner=<user> OR EXISTS(DocShare)`, and the
`Event Participants` table is joined only when a caller-supplied `filters`
argument mentions it, which this tool never sends. The result is therefore the
shared calendar rather than a complete personal schedule. Passing `user` reads
someone else's calendar; ERPNext allows it only for a caller holding read
permission on the `Event` DocType, which is a role-level check rather than a
grant from the person whose calendar it is.

`erpnext_method_call` reaches business endpoints that no typed tool wraps,
including custom-app methods that are the only supported way to change a field
the document API refuses to write directly (a `validate` hook that blocks the
field, an `on_update` guard, a permlevel). It takes `method` (dotted path),
optional `args`, optional `http_method` (`POST` by default; `GET` only for
methods whitelisted read-only), and optional `invalidate` (`{doctype, name}`):
pass that last one whenever the method mutates a document, or a later read may
be served a stale cache entry.

Every call runs as the API key's own ERPNext user, so a method that user may not
call still fails at the server. `ERPNEXT_METHOD_ALLOWLIST` narrows the tool
further when you want it to: it accepts exact dotted paths, `prefix.*` patterns,
or a bare `*`, and unset it imposes no restriction of its own. Setting it is
worth it when an agent should reach only a few named endpoints, since the key
carries its user's full permissions and the allowlist is then the only thing
keeping a prompt-injected agent away from the rest. Method paths are validated
against `[A-Za-z0-9_.]` before the URL is built no matter how the allowlist is
configured, so a crafted `method` can never append a query string or traverse to
another endpoint.

```json
{
  "method": "my_app.api.update_task_meta",
  "args": { "task": "TASK-2026-00001", "meta": "sku: ABC-1" },
  "invalidate": { "doctype": "Task", "name": "TASK-2026-00001" }
}
```

## Discovery (1)

| Tool                     | DocType | Operations                                  |
| ------------------------ | ------- | ------------------------------------------- |
| `erpnext_doctype_fields` | any     | Field schema of a DocType, permission-gated |

`erpnext_doctype_fields` answers "what does this DocType actually store?" before
a `_list`, `_get`, or `erpnext_doc_update` call has to guess. It takes
`doctype`, optional `search` (substring on fieldname and label), and optional
`include_hidden`. Each field comes back with `fieldname`, `label`, `fieldtype`,
`options` (the target DocType for a Link, the choices for a Select), `reqd`,
`read_only`, `in_list_view`, `permlevel`, `description`, `is_standard`, and
`queryable`; layout-only fieldtypes (Section Break, Column Break, Tab Break,
Fold, Heading, HTML, Button) are dropped. The document header reports `module`,
`is_single`, `is_virtual`, `is_child_table`, `is_submittable`, `is_tree`, and
`title_field`.

`queryable` is `false` for every field of a Single DocType. A Single has no
table of its own - `System Settings` stores its values as rows in `tabSingles` -
so its fields are readable but can never appear in a `filters` or `order_by`
clause. Reading it as "the field does not exist" is the opposite of the truth,
which is why it is a flag on the field rather than an omission.

A virtual DocType gets the same `false`, for the same missing table: its rows
are produced by a Python controller, so whether a filter or an `order_by` is
honoured is that controller's decision and nothing in the metadata can promise
it. Twenty of them exist on the reference instance (`RQ Job`, `Recorder`,
`System Health Report`, ...).

The answer opens with the seven columns Frappe stores on every DocType - `name`,
`owner`, `creation`, `modified`, `modified_by`, `docstatus`, `idx` - marked
`is_standard: true`, plus `parent`, `parentfield`, and `parenttype` when the
DocType is a child table. No form declares them, so the metadata endpoint does
not list them, yet they are real columns and they are the ones a caller reaches
for first: `owner` to ask "mine", `modified` to ask "recent", `docstatus` to
tell a draft from a submitted document. Omitting them made the tool answer "no
such field" for a field that exists. `include_hidden` does not apply to them
(they are not hidden form fields; they are columns no form declared), but
`search` does. `doctype` is deliberately absent: it is in Frappe's
`default_fields` tuple but is attached in memory rather than stored, so
filtering or sorting on it fails at the database.

Reading a sample document is not a substitute: it shows only the fields that
happen to be filled in, without labels, types, or link targets.

The underlying Frappe metadata endpoint performs no permission check of its own,
so the tool asks ERPNext first (`frappe.client.has_permission`) and fails with a
permission error when the caller cannot read the DocType.

For a child table the question is asked about a parent instead. A child DocType
carries no role permissions of its own, so
`has_permission('Sales Invoice
Item', 'read')` answers false for every account
except Administrator - measured on a live instance - and gating on it would have
refused the schema to every real user. The tool resolves the DocTypes that own
the child (the ones carrying a Table or Table MultiSelect field pointing at it)
and passes as soon as the caller can read any of them; when none is readable,
the error names them.

That list comes from enumerating the DocTypes that declare the Table field, not
from `getdoctype`. Frappe's `with_parent` helper is built on
`frappe.db.get_value`, so it returns exactly one owner and which one is
arbitrary: `Sales Taxes and Charges` is owned by six DocTypes on the reference
instance and the endpoint names only `Quotation`, so a caller who can read
`Sales Invoice` would have been refused.

A Table field can be declared in two places, and both are read. `DocField` holds
the ones shipped in a DocType's own definition; `Custom Field` holds the ones
added through Customize Form or by an app's installer, keyed by `dt` rather than
`parent`. `DocField` alone is not enough: on the reference instance it carries
559 Table rows against 4 in `Custom Field`, but those 4 are the only owner their
child has, so `Department Approver` and `Designation Skill` resolved to no owner
at all and were refused for every account including Administrator.

Enumeration is not a permission hole - `frappe.client.get_list` applies DocType
permissions like any other list - but an account may be able to read one source
and not the other. A source that refuses is skipped, and the refusal names that
source specifically, so the caller is not sent to ask for a permission they
already hold. The fallback to the single arbitrary owner from `getdoctype` is
reached whenever a source refused **and** no enumerated owner turned out
readable - not only when both sources refused. Requiring both denied the
ordinary case: a standard child table declares its owner in `DocField` alone, so
an account that may read `Custom Field` but not `DocField` enumerated an empty
list, never met the stricter condition, and was refused while `getdoctype` would
have named the parent it could read all along. The fallback still runs last,
after every enumerated owner has been probed, so one arbitrary name can never
decide a verdict the full list disagrees with. Either gap is flagged in the
refusal, which says the list may be partial rather than presenting one name as
the complete set of owners.

`permlevel` above 0 marks a field governed by a separate role permission, which
can be absent from documents even when the DocType itself is readable.

## Kanban (2) → kanban-viewer

| Tool                       | Description                                                         |
| -------------------------- | ------------------------------------------------------------------- |
| `erpnext_kanban_get_board` | Get a normalized kanban board for `Task`, `Opportunity`, or `Issue` |
| `erpnext_kanban_move_card` | Execute a validated card move with business error handling          |

## Analytics (17) → chart-viewer / kpi-viewer / funnel-viewer

Monetary analytics accept optional `company`. It may be omitted only when
exactly one Company is visible to the caller. With several visible companies,
pass its exact name; with none, request Company access. Reading the company's
`default_currency` is required. Permission failures and missing currency are
reported, not replaced with a guessed currency or zero. Refresh requests retain
the resolved company, including when the initial call omitted it. P&L retains
its existing report-based currency source and company permissions.

Revenue uses recorded `base_grand_total`, `base_amount`, and
`base_opportunity_amount`, not today's exchange rate. Stock values are
restricted through `Warehouse.company`, and child rows through their parent
documents. Outstanding, overdue, and AR aging use the standard Accounts
Receivable report in company currency, only positive Sales Invoice balances.
Distinct account balances are added, but invoice counts use distinct voucher
IDs. Report totals and non-invoice vouchers are excluded. The report is run
synchronously with `ignore_prepared_report: true`, so it does not create a
Prepared Report.

All three receivable tools resolve the site date once per call through the
existing timezone lookup (including its UTC fallback when unavailable). The
report snapshot, overdue comparison, and aging day boundaries use that same date
even if the request finishes after midnight.

Gross profit/margin remain estimates from current Bin valuation, not historical
ledger gross profit. They multiply valuation rate by `stock_qty`; missing costs
raise an error. Price-vs-quantity accepts only the selected selling price in the
company currency and the item's verified stock UOM. Missing/mismatched currency
or UOM raises an error; it never silently converts or falls back on bad data.
Its quantity axis is stock quantity. The stock fallback applies only when no
selling-price/order points exist.

Pure stock-quantity and order-count tools retain their existing scope. Funnel
Lead counts still cover all visible Leads; subsequent stages belong to the
selected company. Radar values remain normalized 0-100; its money dimensions
name the currency without treating count dimensions as money.

Analytics count/sum/ranking inputs are read to completion before aggregation and
only then cut to the requested top N. This includes document and child rows, Bin
rows across warehouses, item-group membership, selling prices, and all four
independent funnel stages. Funnel ratios still compare independent sets, not a
cohort of linked conversions. Public list tools keep their own pagination
unchanged.

Complete list reads use pages of 1,000, the existing explicit sort (otherwise
`modified desc`), and a `name asc` tie-breaker. Offsets increase by 1,000; an
exact multiple requires one final empty page. Invalid/oversized pages, missing
or repeated names, permission failures and later-page failures raise errors,
never a prefix total or a zero fallback. A read accepts at most 100,000 rows and
1,000 page requests. All complete document/child/Bin reads within one company
analytics context share those budgets, including concurrent radar reads and
separate ownership-filter chunks. Standalone stock inputs, order count windows,
Item Price and Lead reads each have the same per-read limits. Parent and
Warehouse discovery separately retains its 100,000-name guard and 1,000-name
pages, preserving company and document-status filters; Warehouse discovery is
reused only within the current context. Accounts Receivable is one synchronous
report, with a 100,000-row response guard and no local slicing.

These are successive reads during the tool call, not an atomic transaction or an
as-of snapshot. Existing client cache TTLs also apply. `generatedAt`, where
present, is output-generation time, not proof that all pages share a database
snapshot. Concurrent inserts, deletes or updates can move rows between pages;
duplicate detection catches some changes but cannot detect every omission. Use
authoritative ERPNext reports for reconciliation and rerun charts when
underlying data is changing. Draft filters are unchanged.

### Analytics date windows

Finite windows capture `siteToday` once per tool call, before reading their
pages. Calendar arithmetic and `YYYY-MM` buckets do not depend on the MCP host's
timezone. Date bounds include both endpoints; Lead `creation` is a Datetime and
uses an exclusive midnight upper bound so the whole final day is included,
including fractional seconds.

| Tool                                     | Field                                                                                   | Bounds                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `erpnext_kpi_revenue`                    | Sales Order `transaction_date` (Date)                                                   | First day five months before the current site month through today; current MTD compared with the full previous month |
| `erpnext_revenue_trend`                  | Sales Order `transaction_date` (Date)                                                   | First day of the requested N-month window through today, for total and customer series                               |
| `erpnext_kpi_orders`                     | Sales Order `transaction_date` (Date), not `creation`                                   | Current month start through today; comparison uses previous month start through its final day                        |
| `erpnext_sales_funnel`, finite periods   | Lead `creation` (Datetime); Opportunity/Quotation/Sales Order `transaction_date` (Date) | Month/quarter/year start through today; Lead uses `[start 00:00:00, tomorrow 00:00:00)`                              |
| `erpnext_sales_funnel`, `all` or omitted | No date filter                                                                          | Existing all-time population, including future-dated records; no unnecessary timezone lookup                         |
| `erpnext_kpi_outstanding`                | Accounts Receivable `report_date`                                                       | Existing report as of site today, unchanged                                                                          |
| `erpnext_kpi_overdue`                    | Report `report_date` and `due_date` (Date)                                              | Existing report as of site today, then strict `due_date < today`, unchanged                                          |
| `erpnext_ar_aging`                       | Report `report_date` and `due_date` (Date)                                              | Existing report and aging buckets use the same site-day snapshot, unchanged                                          |
| `erpnext_profit_loss`                    | ERPNext report date range                                                               | Existing separate full-month report contract, unchanged                                                              |

MTD, trend and finite funnel periods exclude future-dated documents. `all` is
not an as-of-today window. The existing site-timezone fallback remains in place:
System Settings when readable, then the defaults-based timezone method, then
UTC. The fallback is not an authoritative site-timezone guarantee. These bounds
do not turn successive reads into an atomic database snapshot.

Ownership IDs are split by encoded request-target length (6,000 bytes for the
API path and query, leaving headroom for a proxy prefix). A single ID plus the
other query fields that cannot fit raises an error instead of being omitted.
Complete reads include the page fields, tie-breaker and worst-case offset in
that budget, paginate every chunk, and preserve the global numeric/timestamp
ordering without slicing the input. Estimated gross-margin cost still uses the
first positive Bin valuation in that ordered set. Equal sort values retain chunk
order, then server order within the chunk. Radar's automatic four-row selection
and the price chart's raw Bin fallback remain presentation/scope limits, not
claims of whole-site totals; they keep the prior global top-N chunk merge. Their
selected radar items are subsequently aggregated fully.

The Item stock-UOM lookup for price-vs-quantity uses the same 6,000-byte request
budget, including fields, filters, order and limit. Every requested Item must be
returned exactly once in its own chunk; missing, duplicate or unrelated rows
raise an error. A failed chunk never produces a partial chart or stock fallback.
The lookup rejects more than 100,000 requested IDs or 1,000 encoded chunks
before sending requests.

| Tool                        | Viewer | Description                                           |
| --------------------------- | ------ | ----------------------------------------------------- |
| `erpnext_stock_chart`       | chart  | Bar chart of stock levels by item/warehouse           |
| `erpnext_sales_chart`       | chart  | Revenue by customer, item, or status (bar/donut)      |
| `erpnext_revenue_trend`     | chart  | Monthly revenue trend (line/area, per customer)       |
| `erpnext_order_breakdown`   | chart  | Orders by customer/status (stacked-bar/pie/donut)     |
| `erpnext_revenue_vs_orders` | chart  | Revenue bars + order count line (dual axis)           |
| `erpnext_stock_treemap`     | chart  | Stock value treemap by item or warehouse              |
| `erpnext_product_radar`     | chart  | Radar comparing items (stock, value, orders, revenue) |
| `erpnext_price_vs_qty`      | chart  | Scatter: selling price vs quantity ordered            |
| `erpnext_ar_aging`          | chart  | AR aging buckets (0-30, 31-60, 61-90, 90+ days)       |
| `erpnext_gross_profit`      | chart  | Revenue bars + margin % line by item/customer         |
| `erpnext_profit_loss`       | chart  | P&L: income vs expenses per month + net profit        |
| `erpnext_kpi_revenue`       | kpi    | Revenue MTD with delta vs previous month + sparkline  |
| `erpnext_kpi_outstanding`   | kpi    | Outstanding receivables (count + total)               |
| `erpnext_kpi_orders`        | kpi    | Orders this month with delta vs last month            |
| `erpnext_kpi_gross_margin`  | kpi    | Gross margin % based on valuation rates               |
| `erpnext_kpi_overdue`       | kpi    | Overdue invoices count + value                        |
| `erpnext_sales_funnel`      | funnel | Lead → Opportunity → Quotation → Order funnel         |
