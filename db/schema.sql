-- Milestone 1: Atomic Unit Storage
CREATE TABLE IF NOT EXISTS units (
    -- PK is a 32-bit hacsh (Hex string)
    id VARCHAR(32) PRIMARY KEY,
    label TEXT NOT NULL,
    -- JSONB allows for the partial merges designed in #26
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);