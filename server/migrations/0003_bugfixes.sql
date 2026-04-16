-- Fix #3: Expiry-Notification-Deduplication
ALTER TABLE licenses
  ADD COLUMN expiry_notified_at DATETIME NULL DEFAULT NULL
  COMMENT 'Zeitpunkt der letzten Ablauf-Benachrichtigung. NULL = noch nicht benachrichtigt.';

-- Fix #2: must_change_password (falls Spalte noch fehlt)
ALTER TABLE customers
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '1 = Kunde muss Passwort beim naechsten Login aendern.';
