-- ============================================================
-- Migration: Bugfixes (Issues #3, #2)
-- Datum: 2026-04-15
-- Ausführen mit: mysql -u USER -p DB_NAME < migrate-bugfixes.sql
-- ============================================================

-- Fix #3: Expiry-Notification-Deduplication
-- Merkt sich wann die letzte Ablauf-Mail für eine Lizenz gesendet wurde.
-- NULL = noch keine Mail gesendet (oder nach Verlängerung zurückgesetzt).
ALTER TABLE licenses
  ADD COLUMN IF NOT EXISTS expiry_notified_at DATETIME NULL DEFAULT NULL
  COMMENT 'Zeitpunkt der letzten Ablauf-Benachrichtigung. NULL = noch nicht benachrichtigt.';

-- Fix #2: must_change_password (falls Spalte noch fehlt)
-- Sollte bereits existieren, sicherheitshalber idempotent.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS must_change_password TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '1 = Kunde muss Passwort beim naechsten Login aendern.';

SELECT 'Migration erfolgreich abgeschlossen.' AS status;
