CREATE TABLE IF NOT EXISTS openings (
  code  TEXT NOT NULL,      -- ISRS/RIS-index code van de brug (NDW)
  sid   TEXT,               -- OpenPilot-id, bv. B1504
  start TEXT NOT NULL,      -- ISO-tijd open
  end   TEXT,               -- ISO-tijd dicht
  src   TEXT,               -- NDW-bron (BMS01, ODS01, …)
  PRIMARY KEY (code, start)
);
CREATE INDEX IF NOT EXISTS openings_sid ON openings (sid, start);
