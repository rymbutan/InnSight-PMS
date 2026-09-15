-- InnSight PMS — Phase 1 service databases
-- Database-per-service pattern. Runs once on first Postgres volume init.

CREATE DATABASE innsight_inventory;     -- Room Inventory Service
CREATE DATABASE innsight_stay;          -- Check-In/Check-Out Service
CREATE DATABASE innsight_folio;         -- Folio / Billing Service
CREATE DATABASE innsight_guest;         -- Guest Profile Service
CREATE DATABASE innsight_maintenance;   -- Maintenance Service
CREATE DATABASE innsight_auth;          -- Auth / Users / Roles Service
CREATE DATABASE innsight_reservation;   -- Reservation / Booking Service
CREATE DATABASE innsight_audit;         -- Night Audit / Business Day Service
CREATE DATABASE innsight_reports;       -- Reports Service
CREATE DATABASE innsight_messaging;     -- Staff Direct Messaging Service
